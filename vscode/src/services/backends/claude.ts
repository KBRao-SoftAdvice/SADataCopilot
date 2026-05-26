import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as readline from 'readline';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
  NotebookBackend,
  PromptRunInput,
  PromptRunResult,
  PromptStreamSink,
  CellRunRecord,
  ToolResultBlock,
} from './types';
import { SUPPRESS_RESULT_TOOLS } from './render';

const KERNEL_RUN_TOOL = 'mcp__kernel__python_run';
const HIDDEN_TOOLS = new Set(['ToolSearch']);

interface ClaudeMessage {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: ClaudeUsage;
    [k: string]: unknown;
  };
  isMeta?: boolean;
  [k: string]: unknown;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeHistory {
  /** Raw JSONL message records from the prior turn — replayed verbatim into a
   * future synthetic session file with parentUuid re-linked across the gap. */
  messages: ClaudeMessage[];
  userMessage: string;
  assistantMessage: string;
}

/**
 * Claude `-p` backend.
 *
 * Mirrors the approach used in browser/server.py:
 *   1. Build a synthetic `~/.claude/projects/<safe_cwd>/<sid>.jsonl` from
 *      prior included turns (Python cells get synthesized into a user/assistant
 *      pair so Claude sees the same context).
 *   2. Spawn `claude -p --resume <sid> --output-format stream-json --verbose`
 *      with an MCP config that points at our bundled python_mcp_server.py,
 *      which will call back into the in-extension HTTP bridge to run code in
 *      the live PythonRepl.
 *   3. Stream events through PromptStreamSink.
 *   4. After completion, read the final session JSONL back, capture this
 *      turn's new messages, and clean up the on-disk session file. Replay on
 *      the next cell.
 */
export class ClaudeBackend implements NotebookBackend {
  readonly id = 'claude' as const;
  private _bridge: KernelBridge | undefined;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  async runPromptTurn(input: PromptRunInput, sink: PromptStreamSink): Promise<PromptRunResult> {
    const result: PromptRunResult = {
      answerText: '',
      errored: false,
      cancelled: false,
      modelUsed: input.model,
      contextWindow: 200000,
      usage: {},
    };

    const cwd = input.cwd || os.homedir();
    const projectDir = getProjectDir(cwd);
    const sessionId = crypto.randomUUID();
    const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);

    // 1. Build seed JSONL from prior included turns
    const seeded = !input.isExcluded && this._buildSession(input, sessionId, cwd);
    if (seeded) {
      fs.writeFileSync(sessionPath, seeded.lines.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
    }

    // 2. Bridge for python_run
    const bridge = await this._getBridge(input.repl);
    const bridgeToken = bridge.register();

    const mcpServerPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'python_mcp_server.py').fsPath;
    const pythonBin = process.env.CLAUDE_NOTEBOOK_PYTHON || process.env.PYTHON || 'python3';
    const mcpConfig = {
      mcpServers: {
        kernel: {
          command: pythonBin,
          args: [mcpServerPath],
          env: {
            KERNEL_BRIDGE_URL: `http://127.0.0.1:${bridge.port}`,
            KERNEL_BRIDGE_TOKEN: bridgeToken,
          },
        },
      },
    };

    const cellModel = (input.model || 'sonnet').toLowerCase();
    const args = ['-p'];
    if (cellModel === 'sonnet' || cellModel === 'opus') args.push('--model', cellModel);
    args.push(
      // --bare disables CLAUDE.md auto-discovery, auto-memory, hooks,
      // plugin sync, LSP, background prefetches, and skill auto-load. Without
      // it, every cell run pulls tens of thousands of tokens of ambient
      // context from the user's project tree, which we don't want for
      // notebook prompts (the cell's prior runs are the conversation).
      '--bare',
      '--output-format', 'stream-json', '--verbose',
      '--mcp-config', JSON.stringify(mcpConfig),
      '--strict-mcp-config',
      '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', KERNEL_RUN_TOOL
    );
    if (seeded) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId);
    const fullPrompt = input.isExcluded ? input.prompt : buildPromptText(input.prompt);
    args.push(fullPrompt);

    let proc: ChildProcessWithoutNullStreams | undefined;
    let resultSessionId: string = sessionId;
    let cancelSub: vscode.Disposable | undefined;

    try {
      proc = spawn('claude', args, { cwd, env: process.env });
    } catch (err) {
      result.errored = true;
      await sink.appendError(`Failed to spawn claude: ${(err as Error).message}`);
      bridge.unregister(bridgeToken);
      cleanupSession(sessionPath);
      return result;
    }

    cancelSub = input.cancellationToken.onCancellationRequested(() => {
      result.cancelled = true;
      proc?.kill('SIGINT');
    });

    const toolNameById = new Map<string, string>();
    let sawAssistantText = false;
    let stderr = '';

    try {
      const stdoutLines = readline.createInterface({ input: proc.stdout });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

      for await (const rawLine of stdoutLines) {
        const line = rawLine.trim();
        if (!line) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const handled = await this._handleEvent(event, sink, toolNameById, result);
        if (handled.sawAssistantText) sawAssistantText = true;
        if (handled.sessionId) resultSessionId = handled.sessionId;
      }

      const exit = await new Promise<number>((resolve) => {
        if (!proc) { resolve(-1); return; }
        if (proc.exitCode !== null) { resolve(proc.exitCode); return; }
        proc.on('close', (code) => resolve(code ?? -1));
      });

      if (exit !== 0 && stderr.trim() && !input.cancellationToken.isCancellationRequested) {
        await sink.appendError(stderr.slice(0, 1000));
        result.errored = true;
      }

      // Surface a final assistant text from `result` events that didn't already
      // come through `assistant` (rare, but the Python kernel handles it).
      if (!sawAssistantText && result.answerText) {
        await sink.appendAssistantText(result.answerText);
      }

      // Capture this turn's messages for replay on the next cell.
      try {
        const turnMessages = extractLastTurnMessages(resultSessionId, input.prompt, cwd);
        result.history = {
          messages: turnMessages,
          userMessage: input.prompt,
          assistantMessage: result.answerText,
        } satisfies ClaudeHistory;
      } catch {
        result.history = {
          messages: [],
          userMessage: input.prompt,
          assistantMessage: result.answerText,
        } satisfies ClaudeHistory;
      }
    } catch (err) {
      result.errored = true;
      if (!input.cancellationToken.isCancellationRequested) {
        await sink.appendError(String(err));
      }
    } finally {
      cancelSub?.dispose();
      bridge.unregister(bridgeToken);
      cleanupSession(sessionPath);
      // If the resume produced a different session id (claude rotates ids on
      // resume), clean that up too.
      if (resultSessionId !== sessionId) {
        cleanupSession(path.join(projectDir, `${resultSessionId}.jsonl`));
      }
    }

    if (input.cancellationToken.isCancellationRequested) result.cancelled = true;
    return result;
  }

  async dispose(): Promise<void> {
    if (this._bridge) {
      this._bridge.dispose();
      this._bridge = undefined;
    }
  }

  private async _getBridge(repl: PromptRunInput['repl']): Promise<KernelBridge> {
    if (this._bridge) {
      this._bridge.bind(repl);
      return this._bridge;
    }
    this._bridge = await KernelBridge.start(repl);
    return this._bridge;
  }

  private _buildSession(
    input: PromptRunInput,
    sessionId: string,
    cwd: string
  ): { lines: ClaudeMessage[] } | null {
    const lines: ClaudeMessage[] = [
      {
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId,
      } as ClaudeMessage,
    ];
    let lastUuid: string | null = null;
    let any = false;

    for (let i = 0; i < input.priorRuns.length; i++) {
      const record = input.priorRuns[i];
      if (!record.included) continue;
      if (record.kind === 'python') {
        if (!record.source.trim()) continue;
        const userText = synthesizePythonNarration(i, record);
        const assistantText = '(noted — Python state recorded)';
        lastUuid = appendSyntheticTurn(lines, lastUuid, userText, assistantText, sessionId, cwd);
        any = true;
      } else if (record.kind === 'prompt') {
        const history = record.history as ClaudeHistory | undefined;
        if (!history?.messages?.length) continue;
        for (let j = 0; j < history.messages.length; j++) {
          const m = history.messages[j];
          const cloned: ClaudeMessage = { ...m };
          cloned.sessionId = sessionId;
          if (j === 0 && lastUuid && cloned.uuid) {
            cloned.parentUuid = lastUuid;
          }
          if (cloned.uuid) lastUuid = cloned.uuid;
          lines.push(cloned);
        }
        any = true;
      }
    }

    if (!any) return null;
    lines.push({
      type: 'last-prompt',
      leafUuid: lastUuid || '',
      sessionId,
    } as ClaudeMessage);
    return { lines };
  }

  private async _handleEvent(
    event: Record<string, unknown>,
    sink: PromptStreamSink,
    toolNameById: Map<string, string>,
    result: PromptRunResult
  ): Promise<{ sawAssistantText?: boolean; sessionId?: string }> {
    const etype = String(event.type || '');
    if (etype === 'system') {
      const model = typeof event.model === 'string' ? event.model : '';
      if (model) result.modelUsed = model;
      // Don't infer the context window from the model ID — the Claude CLI
      // sometimes reports a parent default (e.g. `…opus-4-7[1m]`) regardless
      // of the per-turn `--model` flag, which would falsely advertise 1M
      // headroom on a Sonnet/Opus cell. The seed default (200k) is correct
      // for the cell-selectable Sonnet/Opus models.
      return {};
    }
    if (etype === 'assistant') {
      const msg = (event.message as Record<string, unknown> | undefined) || {};
      const content = Array.isArray(msg.content)
        ? msg.content
        : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
      let sawText = false;
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue;
        const block = raw as Record<string, unknown>;
        const btype = String(block.type || '');
        if (btype === 'text') {
          const text = String(block.text || '');
          if (text) {
            sawText = true;
            result.answerText += text;
            await sink.appendAssistantText(text);
          }
        } else if (btype === 'tool_use') {
          const name = String(block.name || 'unknown');
          const id = String(block.id || '');
          if (id) toolNameById.set(id, name);
          if (HIDDEN_TOOLS.has(name)) continue;
          const inp = (block.input as unknown) || {};
          if (name === KERNEL_RUN_TOOL) {
            const code = isRecord(inp) && typeof inp.code === 'string'
              ? inp.code
              : JSON.stringify(inp, null, 2);
            await sink.appendPythonRun(code);
          } else {
            await sink.appendToolUse(name, inp);
          }
        } else if (btype === 'thinking') {
          const text = String(block.thinking || block.text || '');
          if (text) await sink.appendReasoning(text);
        }
      }
      const usage = msg.usage as ClaudeUsage | undefined;
      if (usage) accumulateUsage(result, usage);
      return { sawAssistantText: sawText };
    }
    if (etype === 'user') {
      const msg = (event.message as Record<string, unknown> | undefined) || {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue;
        const block = raw as Record<string, unknown>;
        if (block.type !== 'tool_result') continue;
        const tid = String(block.tool_use_id || '');
        const calledName = toolNameById.get(tid) || '';
        if (HIDDEN_TOOLS.has(calledName)) continue;
        if (SUPPRESS_RESULT_TOOLS.has(calledName)) continue;
        const blocks = extractClaudeResultBlocks(block.content);
        if (blocks.length > 0) {
          await sink.appendToolResult(blocks);
        } else {
          const text = stringifyContent(block.content);
          if (text) await sink.appendToolResult(text);
        }
      }
      return {};
    }
    if (etype === 'result') {
      const cost = Number(event.total_cost_usd || 0);
      if (cost > 0) result.usage.costUsd = (result.usage.costUsd || 0) + cost;
      const duration = Number(event.duration_ms || 0);
      if (duration > 0) result.usage.durationMs = (result.usage.durationMs || 0) + duration;
      const usage = (event.usage as ClaudeUsage | undefined);
      if (usage) accumulateUsage(result, usage);
      const sid = typeof event.session_id === 'string' ? event.session_id : '';
      // If no streamed assistant text fired, fall back to the result text
      // claude emits at the end.
      if (!result.answerText && typeof event.result === 'string') {
        result.answerText = event.result;
      }
      return sid ? { sessionId: sid } : {};
    }
    return {};
  }
}

/** Localhost HTTP bridge that lets the spawned MCP child run code in the
 * extension's PythonRepl. Started lazily on first use, reused across cells. */
class KernelBridge {
  private _server: http.Server;
  private _tokens = new Set<string>();
  private _repl: PromptRunInput['repl'];
  port: number;

  private constructor(server: http.Server, port: number, repl: PromptRunInput['repl']) {
    this._server = server;
    this.port = port;
    this._repl = repl;
  }

  static async start(repl: PromptRunInput['repl']): Promise<KernelBridge> {
    return new Promise<KernelBridge>((resolve, reject) => {
      const server = http.createServer();
      let bridge: KernelBridge | undefined;
      server.on('request', (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run') {
          res.statusCode = 404; res.end(); return;
        }
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!bridge || !bridge._tokens.has(token)) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        let raw = '';
        req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf-8'); });
        req.on('end', () => {
          let body: { code?: unknown };
          try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
          const code = typeof body.code === 'string' ? body.code : '';
          let output = '';
          const cancel = new vscode.CancellationTokenSource();
          bridge!._repl.run(code, async (_name, text) => { output += text; }, cancel.token)
            .then(({ ok }) => {
              cancel.dispose();
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok, output }));
            })
            .catch((err: Error) => {
              cancel.dispose();
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, output: err.message }));
            });
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('bridge: failed to determine port'));
          return;
        }
        bridge = new KernelBridge(server, addr.port, repl);
        resolve(bridge);
      });
    });
  }

  /** Update the REPL the bridge dispatches to. The controller creates one repl
   * per notebook, so when cells from a different notebook execute we need to
   * point at the live one — not the one we captured on first start. */
  bind(repl: PromptRunInput['repl']): void {
    this._repl = repl;
  }

  register(): string {
    const token = crypto.randomBytes(24).toString('hex');
    this._tokens.add(token);
    return token;
  }

  unregister(token: string): void {
    this._tokens.delete(token);
  }

  dispose(): void {
    try { this._server.close(); } catch { /* ignore */ }
    this._tokens.clear();
  }
}

function getProjectDir(cwd: string): string {
  // Claude's session store keys directories by replacing slashes with dashes.
  const safe = cwd.replace(/\//g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupSession(sessionPath: string): void {
  try { if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath); } catch { /* ignore */ }
}

function appendSyntheticTurn(
  lines: ClaudeMessage[],
  startParentUuid: string | null,
  userText: string,
  assistantText: string,
  sessionId: string,
  cwd: string
): string {
  // Mirror the JSONL shape browser/server.py emits. Claude only checks the
  // parentUuid linkage and message shape, so minimal fields suffice.
  const ts = new Date().toISOString();
  const userUuid = crypto.randomUUID();
  lines.push({
    type: 'user',
    uuid: userUuid,
    parentUuid: startParentUuid,
    sessionId,
    timestamp: ts,
    isSidechain: false,
    permissionMode: 'default',
    userType: 'external',
    entrypoint: 'sdk-cli',
    cwd,
    version: '2.1.143',
    gitBranch: 'HEAD',
    message: { role: 'user', content: userText },
  } as ClaudeMessage);

  const assistantUuid = crypto.randomUUID();
  lines.push({
    type: 'assistant',
    uuid: assistantUuid,
    parentUuid: userUuid,
    sessionId,
    timestamp: ts,
    isSidechain: false,
    message: {
      model: 'claude-opus-4-6',
      id: `msg_synth_${assistantUuid.slice(0, 8)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: Math.max(1, Math.floor(assistantText.length / 4)) },
    },
  } as ClaudeMessage);

  return assistantUuid;
}

function synthesizePythonNarration(index: number, record: CellRunRecord): string {
  return (
    `Python cell ${index + 1} (executed in this notebook):\n` +
    '```python\n' + record.source + '\n```\n' +
    'Output:\n```\n' + (record.output || '(no output)') + '\n```'
  );
}

function extractLastTurnMessages(sessionId: string, prompt: string, cwd: string): ClaudeMessage[] {
  const projectDir = getProjectDir(cwd);
  const fpath = path.join(projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(fpath)) return [];
  const raw = fs.readFileSync(fpath, 'utf-8');
  const all: ClaudeMessage[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      all.push(JSON.parse(t) as ClaudeMessage);
    } catch {
      // skip
    }
  }
  // Find the user message that opened this turn — the last user message whose
  // content ends with the user's prompt. (Claude wraps the prompt in some
  // preamble text.) Fallback: scan from the end and take the last non-meta
  // user message.
  let turnStart = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.type !== 'user' || m.isMeta) continue;
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (typeof content === 'string' && content.endsWith(prompt)) {
      turnStart = i;
      break;
    }
    if (turnStart === -1) turnStart = i;
  }
  if (turnStart === -1) return [];
  const out: ClaudeMessage[] = [];
  for (const m of all.slice(turnStart)) {
    if (m.type === 'last-prompt') continue;
    // The CLI re-attaches its own tool/skill/MCP blobs on every session;
    // replaying our captured copies into the next turn's seed inflates the
    // input by tens of thousands of cached tokens (and confuses cache hits).
    // The CLI will re-emit fresh attachments for the resumed session.
    if (m.type === 'attachment') continue;
    out.push(m);
  }
  return out;
}

function accumulateUsage(result: PromptRunResult, usage: ClaudeUsage): void {
  result.usage.inputTokens = (result.usage.inputTokens || 0) + (usage.input_tokens || 0);
  result.usage.outputTokens = (result.usage.outputTokens || 0) + (usage.output_tokens || 0);
  result.usage.cacheReadTokens = (result.usage.cacheReadTokens || 0) + (usage.cache_read_input_tokens || 0);
  result.usage.cacheCreationTokens = (result.usage.cacheCreationTokens || 0) + (usage.cache_creation_input_tokens || 0);
  result.usage.totalInputForContext =
    (result.usage.inputTokens || 0)
    + (result.usage.cacheReadTokens || 0)
    + (result.usage.cacheCreationTokens || 0);
}

function extractClaudeResultBlocks(content: unknown): ToolResultBlock[] {
  // Claude tool results are either a string or an array of {type:'text'|'image', ...}.
  // Map them onto the same ToolResultBlock variants Copilot uses.
  if (!Array.isArray(content)) return [];
  const out: ToolResultBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      out.push({ type: 'text', text: item.text });
    } else if (item.type === 'image' && typeof item.source === 'object' && item.source) {
      const src = item.source as Record<string, unknown>;
      if (typeof src.data === 'string' && typeof src.media_type === 'string') {
        out.push({ type: 'image', data: src.data, mimeType: src.media_type });
      }
    }
  }
  return out;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const t = (item as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    if (parts.length) return parts.join('\n');
  }
  return JSON.stringify(content, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
