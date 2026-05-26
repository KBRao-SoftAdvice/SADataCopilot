import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  CopilotClient,
  approveAll,
  defineTool,
  type CopilotSession,
  type SessionEvent,
} from '@github/copilot-sdk';

// The SDK declares this type internally but doesn't re-export it from the
// package root. Mirror the literal union here so we don't have to dig into
// dist/types.js, which webpack would refuse to resolve.
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
import { z } from 'zod';
import {
  NotebookBackend,
  PromptRunInput,
  PromptRunResult,
  PromptStreamSink,
  CellRunRecord,
  ToolResultBlock,
} from './types';
import { SUPPRESS_RESULT_TOOLS } from './render';

const KERNEL_TOOL_NAME = 'python_run';
const COPILOT_VERSION = '1.0.50';
const SQLITE_BIN = '/usr/bin/sqlite3';
const VALID_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(['medium', 'high', 'xhigh']);

interface CopilotEventRecord {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId: string | null;
}

interface CopilotHistory {
  /** Events captured from this turn's events.jsonl tail; replayed verbatim into future seeds. */
  events: CopilotEventRecord[];
  /** Compact summary for the SQLite turns table. */
  userMessage: string;
  assistantMessage: string;
}

/**
 * Copilot backend.
 *
 * Mirrors the Claude approach: per-cell fresh session id, synthesize the
 * `events.jsonl` and matching SQLite rows from prior included cells, resume,
 * stream, capture this turn's new events, and clean up. Verified empirically
 * with /Users/keshavkl/Desktop/copilot-sdk-test/test_synthetic_session.mjs —
 * a synthetic events.jsonl + turns row was correctly loaded and a planted
 * magic word recalled.
 */
export class CopilotBackend implements NotebookBackend {
  readonly id = 'copilot' as const;
  private _client: CopilotClient | undefined;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  async runPromptTurn(input: PromptRunInput, sink: PromptStreamSink): Promise<PromptRunResult> {
    const client = await this._getClient();
    const sessionId = crypto.randomUUID();
    const model = pickModel(input.model);
    // GPT-5.5 supports reasoning effort; mini does not. Pass undefined for mini
    // so the SDK doesn't reject it against capability checks.
    const reasoningEffort =
      model === 'gpt-5.5' ? pickReasoningEffort(input.reasoningEffort) : undefined;
    const result: PromptRunResult = {
      answerText: '',
      errored: false,
      cancelled: false,
      modelUsed: model,
      contextWindow: 0,
      usage: {},
    };

    const repl = input.repl;
    const pythonRunTool = defineTool(KERNEL_TOOL_NAME, {
      description:
        'Run Python code in the notebook kernel and return stdout/stderr. ' +
        'Variables defined in user cells are visible; side effects persist.',
      parameters: z.object({
        code: z.string().describe('Python source to execute in the kernel'),
      }),
      handler: async ({ code }) => {
        let output = '';
        const cancelToken = new vscode.CancellationTokenSource();
        try {
          await repl.run(code, async (_name, text) => { output += text; }, cancelToken.token);
        } finally {
          cancelToken.dispose();
        }
        return output;
      },
      skipPermission: true,
    });

    const seededIds = await this._prepareSession(sessionId, model, input);
    let session: CopilotSession | undefined;
    let cancelSub: vscode.Disposable | undefined;

    try {
      session = await client.resumeSession(sessionId, {
        model,
        reasoningEffort,
        tools: [pythonRunTool],
        onPermissionRequest: approveAll,
        workingDirectory: input.cwd,
        streaming: true,
      });
      cancelSub = input.cancellationToken.onCancellationRequested(() => {
        result.cancelled = true;
        session?.abort().catch(() => { /* ignore */ });
      });

      result.contextWindow = await this._getContextWindow(client, model);

      const promptText = input.isExcluded ? input.prompt : buildPromptText(input.prompt);
      const toolNameById = new Map<string, string>();

      const eventHandler = async (event: SessionEvent): Promise<void> => {
        try {
          await this._handleEvent(event, sink, toolNameById, result);
        } catch {
          // never let render errors abort the stream
        }
      };
      const unsubscribe = session.on(eventHandler);

      try {
        const finalAssistant = await session.sendAndWait({ prompt: promptText }, 600_000);
        if (finalAssistant && !result.answerText) {
          result.answerText = finalAssistant.data.content;
          await sink.appendAssistantText(finalAssistant.data.content);
        }
      } finally {
        unsubscribe();
      }
    } catch (err) {
      result.errored = true;
      if (!input.cancellationToken.isCancellationRequested) {
        await sink.appendError(String(err));
      }
    } finally {
      cancelSub?.dispose();
      if (session) {
        try { await session.disconnect(); } catch { /* ignore */ }
      }
    }

    if (input.cancellationToken.isCancellationRequested) result.cancelled = true;

    // Capture this turn's new events for replay on the next cell.
    try {
      const newEvents = readNewEvents(sessionId, seededIds);
      result.history = {
        events: newEvents,
        userMessage: input.prompt,
        assistantMessage: result.answerText,
      } satisfies CopilotHistory;
    } catch {
      result.history = {
        events: [],
        userMessage: input.prompt,
        assistantMessage: result.answerText,
      } satisfies CopilotHistory;
    }

    // Always cleanup this run's on-disk state. We rebuild from scratch each run.
    await this._cleanup(client, sessionId).catch(() => { /* ignore */ });

    return result;
  }

  async dispose(): Promise<void> {
    if (this._client) {
      try { await this._client.stop(); } catch { /* ignore */ }
      this._client = undefined;
    }
  }

  private async _getClient(): Promise<CopilotClient> {
    if (this._client) return this._client;
    // Use default Copilot credentials (the CLI's stored auth) when GITHUB_TOKEN
    // is not explicitly set. Passing undefined lets the SDK pick that path up.
    const gitHubToken = process.env.GITHUB_TOKEN;
    // Two issues when spawning Copilot's CLI from a VS Code extension host:
    //   1. process.execPath is the Electron Helper. With ELECTRON_RUN_AS_NODE=1
    //      it executes JS, but process.versions.electron stays set, which puts
    //      commander.js (used by the Copilot CLI) into "electron mode" — that
    //      treats argv[1] as a positional, which the CLI then rejects with
    //      "too many arguments. Expected 0 arguments but got 1.".
    //   2. We can't call `cli` directly because the SDK only spawns via
    //      process.execPath.
    // Workaround: spawn a small shim (resources/copilot-cli-shim.js) which
    // strips the electron signal and forwards to the real CLI via dynamic
    // import. The shim picks up the real CLI path from COPILOT_CLI_REAL_PATH.
    const shimPath = vscode.Uri.joinPath(
      this._extensionUri,
      'resources',
      'copilot-cli-shim.js'
    ).fsPath;
    const realCliPath = resolveCopilotCli();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      COPILOT_CLI_REAL_PATH: realCliPath,
    };
    this._client = new CopilotClient({
      gitHubToken,
      logLevel: 'error',
      env,
      cliPath: shimPath,
    });
    await this._client.start();
    return this._client;
  }

  /**
   * Build events.jsonl + insert SQLite rows for the new sessionId. Returns
   * the set of event IDs we wrote so we can later distinguish them from
   * events the agent appended during the actual run.
   */
  private async _prepareSession(
    sessionId: string,
    model: string,
    input: PromptRunInput
  ): Promise<Set<string>> {
    const cwd = input.cwd || process.cwd();
    const sessionDir = path.join(copilotHome(), 'session-state', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const seeded: CopilotEventRecord[] = [];
    let lastId: string | null = null;
    const now = (): string => new Date().toISOString();

    // session.start
    const startId = crypto.randomUUID();
    seeded.push({
      type: 'session.start',
      data: {
        sessionId,
        version: 1,
        producer: 'copilot-agent',
        copilotVersion: COPILOT_VERSION,
        startTime: now(),
        selectedModel: model,
        context: { cwd, gitRoot: cwd, hostType: 'github' },
        alreadyInUse: false,
        remoteSteerable: false,
      },
      id: startId,
      timestamp: now(),
      parentId: null,
    });
    lastId = startId;

    // system.message — minimal; tool definitions are registered separately.
    const systemId = crypto.randomUUID();
    seeded.push({
      type: 'system.message',
      data: {
        role: 'system',
        content: 'You are a helpful assistant inside a notebook. Answer the user concisely and use tools when appropriate.',
      },
      id: systemId,
      timestamp: now(),
      parentId: lastId,
    });
    lastId = systemId;

    // SQLite turns rows for prior cells. We insert one (user_message,
    // assistant_response) pair per included prompt cell. Python cells are
    // synthesized into a similar pair so the model sees the same context as
    // under Claude's backend.
    const turnsRows: Array<{ user: string; assistant: string }> = [];

    if (!input.isExcluded) {
      for (let i = 0; i < input.priorRuns.length; i++) {
        const record = input.priorRuns[i];
        if (!record.included) continue;
        if (record.kind === 'python') {
          if (!record.source.trim()) continue;
          const userText = synthesizePythonNarration(i, record);
          const assistantText = '(noted — Python state recorded)';
          const newLastId = appendSyntheticTurn(seeded, lastId, userText, assistantText, model);
          lastId = newLastId;
          turnsRows.push({ user: userText, assistant: assistantText });
        } else if (record.kind === 'prompt') {
          const history = record.history as CopilotHistory | undefined;
          if (!history?.events?.length) continue;
          // Replay the captured events verbatim, rewriting the FIRST event's
          // parentId to chain into our running lastId. Subsequent events in
          // the turn already point at preceding events from the same turn,
          // which we keep intact.
          for (let j = 0; j < history.events.length; j++) {
            const ev = history.events[j];
            const cloned: CopilotEventRecord = {
              type: ev.type,
              data: ev.data,
              id: ev.id,
              timestamp: ev.timestamp,
              parentId: j === 0 ? lastId : ev.parentId,
            };
            seeded.push(cloned);
            lastId = ev.id;
          }
          turnsRows.push({
            user: history.userMessage,
            assistant: history.assistantMessage,
          });
        }
      }
    }

    const eventsPath = path.join(sessionDir, 'events.jsonl');
    fs.writeFileSync(
      eventsPath,
      seeded.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8'
    );

    // SQLite: insert a sessions row and one turns row per replayed turn so
    // the CLI's resume path sees consistent metadata.
    const sql: string[] = [];
    sql.push(
      `INSERT OR REPLACE INTO sessions (id, cwd, host_type, created_at, updated_at) ` +
      `VALUES (${quote(sessionId)}, ${quote(cwd)}, 'github', datetime('now'), datetime('now'));`
    );
    for (let i = 0; i < turnsRows.length; i++) {
      const r = turnsRows[i];
      sql.push(
        `INSERT INTO turns (session_id, turn_index, user_message, assistant_response) ` +
        `VALUES (${quote(sessionId)}, ${i}, ${quote(r.user)}, ${quote(r.assistant)});`
      );
    }
    try {
      execFileSync(SQLITE_BIN, [storeDbPath()], { input: sql.join('\n'), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(`Failed to write Copilot session metadata to SQLite: ${(err as Error).message}`);
    }

    return new Set(seeded.map((e) => e.id));
  }

  private async _cleanup(client: CopilotClient, sessionId: string): Promise<void> {
    // SDK delete first so the CLI releases any handles.
    try { await client.deleteSession(sessionId); } catch { /* ignore */ }
    // Then ensure the on-disk state is gone, even if deleteSession was a no-op.
    try {
      const dir = path.join(copilotHome(), 'session-state', sessionId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
    try {
      const sql =
        `DELETE FROM turns WHERE session_id = ${quote(sessionId)};\n` +
        `DELETE FROM session_files WHERE session_id = ${quote(sessionId)};\n` +
        `DELETE FROM session_refs WHERE session_id = ${quote(sessionId)};\n` +
        `DELETE FROM checkpoints WHERE session_id = ${quote(sessionId)};\n` +
        `DELETE FROM sessions WHERE id = ${quote(sessionId)};`;
      execFileSync(SQLITE_BIN, [storeDbPath()], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { /* ignore */ }
  }

  private async _handleEvent(
    event: SessionEvent,
    sink: PromptStreamSink,
    toolNameById: Map<string, string>,
    result: PromptRunResult
  ): Promise<void> {
    switch (event.type) {
      case 'assistant.message': {
        const text = event.data.content || '';
        if (text) {
          result.answerText += text;
          await sink.appendAssistantText(text);
        }
        break;
      }
      case 'tool.execution_start': {
        const name = event.data.toolName;
        const id = event.data.toolCallId;
        toolNameById.set(id, name);
        const args = event.data.arguments || {};
        if (name === KERNEL_TOOL_NAME) {
          const code = typeof (args as { code?: unknown }).code === 'string'
            ? (args as { code: string }).code
            : JSON.stringify(args, null, 2);
          await sink.appendPythonRun(code);
        } else {
          await sink.appendToolUse(name, args);
        }
        break;
      }
      case 'tool.execution_complete': {
        const id = event.data.toolCallId;
        const calledName = id ? toolNameById.get(id) || '' : '';
        if (!SUPPRESS_RESULT_TOOLS.has(calledName)) {
          const blocks = extractToolResultBlocks(event.data.result);
          if (blocks.length > 0) {
            await sink.appendToolResult(blocks);
          } else {
            const text = extractToolResultText(event.data.result);
            if (text) await sink.appendToolResult(text);
          }
        }
        if (event.data.error) {
          await sink.appendError(event.data.error.message || String(event.data.error));
        }
        break;
      }
      case 'assistant.reasoning': {
        const text = (event.data as { content?: unknown }).content;
        if (typeof text === 'string' && text.trim()) {
          await sink.appendReasoning(text);
        }
        break;
      }
      case 'assistant.intent': {
        const text = (event.data as { intent?: unknown }).intent;
        if (typeof text === 'string' && text.trim()) {
          await sink.appendIntent(text);
        }
        break;
      }
      case 'permission.requested': {
        const req = ((event.data as unknown) as { permissionRequest?: Record<string, unknown> }).permissionRequest || {};
        const kind = String((req as { kind?: unknown }).kind || 'unknown');
        const summary = formatPermissionSummary(kind, req);
        await sink.appendPermission(kind, summary);
        break;
      }
      case 'session.compaction_start': {
        await sink.appendCompaction('Compacting conversation history…');
        break;
      }
      case 'session.compaction_complete': {
        const data = event.data as {
          success?: boolean;
          messagesRemoved?: number;
          tokensRemoved?: number;
          preCompactionTokens?: number;
          postCompactionTokens?: number;
          error?: string;
        };
        if (data.success === false) {
          await sink.appendError(`Compaction failed: ${data.error || 'unknown error'}`);
        } else {
          const parts = [
            data.messagesRemoved ? `${data.messagesRemoved} messages removed` : '',
            data.tokensRemoved ? `${formatTokens(data.tokensRemoved)} tokens removed` : '',
            data.preCompactionTokens && data.postCompactionTokens
              ? `${formatTokens(data.preCompactionTokens)} → ${formatTokens(data.postCompactionTokens)}`
              : '',
          ].filter(Boolean);
          await sink.appendCompaction(parts.join(' · ') || 'Compaction complete');
        }
        break;
      }
      case 'subagent.started': {
        const data = event.data as { agentDisplayName?: string; agentName?: string; model?: string };
        const name = data.agentDisplayName || data.agentName || 'subagent';
        const body = data.model ? `started · model: ${data.model}` : 'started';
        await sink.appendSubagent(`Subagent: ${name}`, body);
        break;
      }
      case 'subagent.completed': {
        const data = event.data as {
          agentDisplayName?: string;
          agentName?: string;
          totalTokens?: number;
          totalToolCalls?: number;
          durationMs?: number;
        };
        const name = data.agentDisplayName || data.agentName || 'subagent';
        const parts = [
          data.totalTokens ? `${formatTokens(data.totalTokens)} tokens` : '',
          data.totalToolCalls ? `${data.totalToolCalls} tool calls` : '',
          data.durationMs ? `${(data.durationMs / 1000).toFixed(1)}s` : '',
        ].filter(Boolean);
        await sink.appendSubagent(`Subagent: ${name} — completed`, parts.join(' · ') || 'completed');
        break;
      }
      case 'subagent.failed': {
        const data = event.data as { agentDisplayName?: string; agentName?: string; error?: string };
        const name = data.agentDisplayName || data.agentName || 'subagent';
        await sink.appendSubagent(`Subagent: ${name} — failed`, data.error || 'unknown error');
        break;
      }
      case 'session.warning': {
        const data = event.data as { warningType?: string; message?: string; url?: string };
        const text = [data.warningType, data.message, data.url].filter(Boolean).join(' — ');
        if (text) await sink.appendWarning(text);
        break;
      }
      case 'session.info': {
        // Most session.info events are routine bookkeeping (timing, snapshot,
        // config). Surface only the user-meaningful ones.
        const data = event.data as { infoType?: string; message?: string; tip?: string };
        const surfaceTypes = new Set(['notification', 'context_window', 'mcp', 'auth', 'model']);
        if (data.infoType && surfaceTypes.has(data.infoType) && data.message) {
          await sink.appendInfo(data.tip ? `${data.message}\n${data.tip}` : data.message);
        }
        break;
      }
      case 'session.shutdown': {
        const data = (event.data as unknown) as {
          codeChanges?: { filesModified?: string[]; linesAdded?: number; linesRemoved?: number };
          totalPremiumRequests?: number;
        };
        const cc = data.codeChanges || {};
        const filesCount = Array.isArray(cc.filesModified) ? cc.filesModified.length : 0;
        if (filesCount || cc.linesAdded || cc.linesRemoved || data.totalPremiumRequests) {
          result.footer = {
            filesModified: filesCount,
            linesAdded: cc.linesAdded,
            linesRemoved: cc.linesRemoved,
            totalPremiumRequests: data.totalPremiumRequests,
          };
        }
        break;
      }
      case 'assistant.usage': {
        const data = event.data;
        result.usage.inputTokens = (result.usage.inputTokens || 0) + (data.inputTokens || 0);
        result.usage.outputTokens = (result.usage.outputTokens || 0) + (data.outputTokens || 0);
        result.usage.cacheReadTokens = (result.usage.cacheReadTokens || 0) + (data.cacheReadTokens || 0);
        result.usage.cacheCreationTokens = (result.usage.cacheCreationTokens || 0) + (data.cacheWriteTokens || 0);
        result.usage.totalInputForContext =
          (result.usage.inputTokens || 0)
          + (result.usage.cacheReadTokens || 0)
          + (result.usage.cacheCreationTokens || 0);
        if (typeof data.cost === 'number' && data.cost > 0) {
          result.usage.costUsd = (result.usage.costUsd || 0) + data.cost;
        } else {
          const incremental = estimateCostUsd(result.modelUsed, {
            inputTokens: data.inputTokens || 0,
            outputTokens: data.outputTokens || 0,
            cacheReadTokens: data.cacheReadTokens || 0,
            cacheWriteTokens: data.cacheWriteTokens || 0,
          });
          if (incremental > 0) {
            result.usage.costUsd = (result.usage.costUsd || 0) + incremental;
          }
        }
        if (typeof data.duration === 'number') {
          result.usage.durationMs = (result.usage.durationMs || 0) + data.duration;
        }
        break;
      }
      case 'session.error': {
        const msg = event.data.message || 'Copilot session error';
        await sink.appendError(msg);
        result.errored = true;
        break;
      }
      default:
        break;
    }
  }

  private async _getContextWindow(client: CopilotClient, modelId: string): Promise<number> {
    try {
      const models = await client.listModels();
      const info = models.find((m) => m.id === modelId);
      if (info?.capabilities?.limits?.max_context_window_tokens) {
        return info.capabilities.limits.max_context_window_tokens;
      }
    } catch {
      // ignore
    }
    return 200000;
  }
}

/**
 * The @github/copilot package's exports field doesn't expose index.js or
 * package.json, so a normal require.resolve fails and webpack's static
 * analyzer also rejects it. Walk up from this file looking for
 * node_modules/@github/copilot/index.js — same lookup the SDK does internally.
 */
function resolveCopilotCli(): string {
  const start = __dirname;
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', '@github', 'copilot', 'index.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate @github/copilot/index.js starting from ${start}. ` +
    'Is the @github/copilot package installed?'
  );
}

/**
 * Per-million-token USD prices for the Copilot-served models we expose. Used
 * as a fallback when the SDK's `assistant.usage` event arrives without a
 * `cost` field (the Copilot CLI does not always populate it for first-party
 * models when running under default credentials).
 *
 * gpt-5-mini sourced from OpenAI's published API rates (mirrored on
 * artificialanalysis.ai/models/gpt-5-mini, openrouter.ai/openai/gpt-5-mini,
 * helicone.ai/llm-cost/provider/openai/model/gpt-5-mini).
 *
 * gpt-5.5 is not yet listed on openai.com directly; rates here come from
 * artificialanalysis.ai/models/gpt-5-5 and openrouter.ai/openai/gpt-5.5.
 * Update once OpenAI publishes official numbers.
 */
const COPILOT_MODEL_PRICES_PER_MTOK: Record<string, {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}> = {
  'gpt-5-mini': { input: 0.25, output: 2.00, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5.5':    { input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 5.00 },
};

function estimateCostUsd(
  modelId: string | undefined,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }
): number {
  if (!modelId) return 0;
  const price = COPILOT_MODEL_PRICES_PER_MTOK[modelId];
  if (!price) return 0;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = tokens;
  return (
    (inputTokens * price.input
      + outputTokens * price.output
      + cacheReadTokens * price.cacheRead
      + cacheWriteTokens * price.cacheWrite)
    / 1_000_000
  );
}

function copilotHome(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
}

function storeDbPath(): string {
  return path.join(copilotHome(), 'session-store.db');
}

function quote(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * Append a synthetic user/assistant turn (used for prior Python cells, which
 * never actually had an LLM response). Keeps the events.jsonl chain valid by
 * threading parentId through the four events.
 */
function appendSyntheticTurn(
  seeded: CopilotEventRecord[],
  startParentId: string | null,
  userText: string,
  assistantText: string,
  model: string
): string {
  const now = (): string => new Date().toISOString();
  const interactionId = crypto.randomUUID();

  const userId = crypto.randomUUID();
  seeded.push({
    type: 'user.message',
    data: {
      content: userText,
      attachments: [],
      supportedNativeDocumentMimeTypes: [],
      interactionId,
    },
    id: userId,
    timestamp: now(),
    parentId: startParentId,
  });

  const turnStartId = crypto.randomUUID();
  seeded.push({
    type: 'assistant.turn_start',
    data: { turnId: '0', interactionId },
    id: turnStartId,
    timestamp: now(),
    parentId: userId,
  });

  const assistantMessageId = crypto.randomUUID();
  seeded.push({
    type: 'assistant.message',
    data: {
      messageId: assistantMessageId,
      model,
      content: assistantText,
      toolRequests: [],
      interactionId,
      turnId: '0',
      outputTokens: 8,
    },
    id: assistantMessageId,
    timestamp: now(),
    parentId: turnStartId,
  });

  const turnEndId = crypto.randomUUID();
  seeded.push({
    type: 'assistant.turn_end',
    data: { turnId: '0' },
    id: turnEndId,
    timestamp: now(),
    parentId: assistantMessageId,
  });

  return turnEndId;
}

function synthesizePythonNarration(index: number, record: CellRunRecord): string {
  return (
    `Python cell ${index + 1} (executed in this notebook):\n` +
    '```python\n' + record.source + '\n```\n' +
    'Output:\n```\n' + (record.output || '(no output)') + '\n```'
  );
}

/**
 * Read events.jsonl after the run, return events whose IDs are NOT in the
 * pre-seeded set — i.e. those produced by this turn.
 */
function readNewEvents(sessionId: string, seededIds: Set<string>): CopilotEventRecord[] {
  const eventsPath = path.join(copilotHome(), 'session-state', sessionId, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf-8');
  const out: CopilotEventRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as CopilotEventRecord;
      if (!ev || typeof ev !== 'object') continue;
      if (!ev.id || seededIds.has(ev.id)) continue;
      // Skip session.shutdown — it's session-lifecycle metadata, not turn content.
      if (ev.type === 'session.shutdown') continue;
      out.push(ev);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Resolve the cell's `model` string to a Copilot model id. Defaults to mini. */
function pickModel(value: string | undefined): 'gpt-5-mini' | 'gpt-5.5' {
  return value === 'gpt-5.5' ? 'gpt-5.5' : 'gpt-5-mini';
}

/**
 * Translate the cell-level reasoning-effort hint into the SDK's
 * ReasoningEffort. Falls back to 'medium' for missing or unrecognised inputs.
 */
function pickReasoningEffort(value: string | undefined): ReasoningEffort {
  const normalised = (value || '').toLowerCase();
  if (VALID_EFFORTS.has(normalised as ReasoningEffort)) {
    return normalised as ReasoningEffort;
  }
  return 'medium';
}

function buildPromptText(prompt: string): string {
  const preamble =
    'You are answering inside a notebook prompt cell. To work with Python, ' +
    'use the python_run tool: it executes code in the live notebook kernel ' +
    'and returns stdout/stderr to you. The kernel shares the same namespace ' +
    "as the user's Python cells, so variables like `df` defined earlier " +
    'are available. Use python_run whenever you need to inspect data, ' +
    'check shapes/values, or compute something to reason about. Side ' +
    'effects persist — prefer non-mutating queries unless the user ' +
    'explicitly asks you to change state.';
  return preamble + '\n\n' + prompt;
}

function extractToolResultBlocks(result: unknown): ToolResultBlock[] {
  // Prefer the structured `contents[]` array — it's what gives us images,
  // terminal output with exit codes, and resource links. Fall back to plain
  // text via extractToolResultText elsewhere.
  if (!result || typeof result !== 'object') return [];
  const contents = (result as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return [];
  const out: ToolResultBlock[] = [];
  for (const raw of contents) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const type = item.type;
    if (type === 'text' && typeof item.text === 'string') {
      out.push({ type: 'text', text: item.text });
    } else if (type === 'terminal' && typeof item.text === 'string') {
      out.push({
        type: 'terminal',
        text: item.text,
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
      });
    } else if (type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      out.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    } else if (type === 'resource_link' && typeof item.uri === 'string') {
      out.push({
        type: 'resource_link',
        uri: item.uri,
        title: typeof item.title === 'string' ? item.title : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
      });
    } else if (type === 'resource' && item.resource && typeof item.resource === 'object') {
      const r = item.resource as Record<string, unknown>;
      if (typeof r.uri === 'string') {
        out.push({
          type: 'resource',
          uri: r.uri,
          mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
          text: typeof r.text === 'string' ? r.text : undefined,
        });
      }
    }
  }
  return out;
}

function formatPermissionSummary(kind: string, req: Record<string, unknown>): string {
  // Mirror the permission.kind enum so the user sees the relevant fields per
  // request type, not a JSON dump.
  switch (kind) {
    case 'shell':
      return String(req.fullCommandText || req.intention || '(shell command)');
    case 'write':
      return [req.fileName, req.intention].filter(Boolean).join(' — ') || '(file write)';
    case 'read':
      return [req.path, req.intention].filter(Boolean).join(' — ') || '(file read)';
    case 'mcp':
      return [req.serverName, req.toolName].filter(Boolean).join(': ') || '(mcp tool)';
    case 'url':
      return [req.url, req.intention].filter(Boolean).join(' — ') || '(url fetch)';
    case 'memory':
      return [req.action, req.fact].filter(Boolean).join(': ') || '(memory)';
    case 'custom-tool':
      return String(req.toolName || req.toolDescription || '(custom tool)');
    case 'hook':
      return String(req.toolName || req.hookMessage || '(hook)');
    case 'extension-management':
      return [req.operation, req.extensionName].filter(Boolean).join(': ') || '(extension)';
    case 'extension-permission-access': {
      const caps = Array.isArray(req.capabilities) ? (req.capabilities as unknown[]).join(', ') : '';
      return [req.extensionName, caps].filter(Boolean).join(' — ') || '(extension permissions)';
    }
    default:
      return JSON.stringify(req, null, 2);
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function extractToolResultText(result: unknown): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as {
      textResultForLlm?: unknown;
      detailedContent?: unknown;
      content?: unknown;
    };
    if (typeof r.textResultForLlm === 'string') return r.textResultForLlm;
    if (typeof r.detailedContent === 'string') return r.detailedContent;
    if (typeof r.content === 'string') return r.content;
    if (Array.isArray(r.content)) {
      const parts: string[] = [];
      for (const item of r.content) {
        if (item && typeof item === 'object') {
          const t = (item as { text?: unknown }).text;
          if (typeof t === 'string') parts.push(t);
        }
      }
      if (parts.length) return parts.join('\n');
    }
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}
