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

const KERNEL_MCP_NAME = 'kernel';
const KERNEL_TOOL_NAME = 'python_run';
/** Cursor surfaces MCP tools as `<server>-<tool>` in events. */
const KERNEL_MCP_TOOL_LABEL = `${KERNEL_MCP_NAME}-${KERNEL_TOOL_NAME}`;

interface CursorHistory {
  /** Renderable narration of this turn — used as a context preamble on later cells. */
  userPrompt: string;
  assistantText: string;
  toolNarrations: string[];
}

/**
 * Cursor `agent -p` backend.
 *
 * Cursor's session store is a content-addressed SQLite blob graph (see
 * ~/.cursor/chats/<workspace>/<sid>/store.db), so unlike Claude we can't
 * write a seed JSONL on disk to splice prior turns. Instead we run each cell
 * as a fresh `--resume <new-sid>` session and embed prior included turns as a
 * context preamble in the prompt text — same trick the Claude backend uses for
 * Python cells, applied uniformly here.
 *
 * For the in-extension python kernel: cursor doesn't accept an inline
 * --mcp-config flag, so we write/merge an entry under a stable name into
 * ~/.cursor/mcp.json pointing at our bundled python_mcp_server.py with bridge
 * URL/token env vars. `--approve-mcps` skips the approval prompt in headless
 * mode.
 */
export class CursorBackend implements NotebookBackend {
  readonly id = 'cursor' as const;
  private _bridge: KernelBridge | undefined;
  private _mcpInstalled = false;

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
    const sessionId = crypto.randomUUID();

    const bridge = await this._getBridge(input.repl);
    const bridgeToken = bridge.register();

    try {
      this._ensureMcpRegistered(bridge.port, bridgeToken);
    } catch (err) {
      await sink.appendWarning(`Could not register kernel MCP: ${(err as Error).message}`);
    }

    const cliModel = mapModel(input.model);
    // Intentionally omit --stream-partial-output: with it, each token-ish delta
    // arrives as its own `assistant` event, and the renderer wraps each one in
    // a separate bordered box. Without it cursor emits one consolidated
    // assistant event per turn, which renders as a single clean box.
    const args = ['-p', '--output-format', 'stream-json', '--force', '--approve-mcps'];
    if (cliModel) args.push('--model', cliModel);
    args.push('--resume', sessionId);

    const preamble = input.isExcluded ? '' : buildContextPreamble(input.priorRuns);
    const fullPrompt = (preamble ? preamble + '\n\n' : '') + buildPromptText(input.prompt);
    args.push(fullPrompt);

    let proc: ChildProcessWithoutNullStreams | undefined;
    let cancelSub: vscode.Disposable | undefined;

    try {
      proc = spawn('agent', args, { cwd, env: process.env });
    } catch (err) {
      result.errored = true;
      await sink.appendError(`Failed to spawn cursor agent: ${(err as Error).message}`);
      bridge.unregister(bridgeToken);
      return result;
    }

    cancelSub = input.cancellationToken.onCancellationRequested(() => {
      result.cancelled = true;
      proc?.kill('SIGINT');
    });

    let stderr = '';
    let sawAssistantText = false;
    const toolNarrations: string[] = [];

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
        const handled = await this._handleEvent(event, sink, result, toolNarrations);
        if (handled.sawAssistantText) sawAssistantText = true;
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

      if (!sawAssistantText && result.answerText) {
        await sink.appendAssistantText(result.answerText);
      }

      result.history = {
        userPrompt: input.prompt,
        assistantText: result.answerText,
        toolNarrations,
      } satisfies CursorHistory;
    } catch (err) {
      result.errored = true;
      if (!input.cancellationToken.isCancellationRequested) {
        await sink.appendError(String(err));
      }
    } finally {
      cancelSub?.dispose();
      bridge.unregister(bridgeToken);
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

  private _ensureMcpRegistered(port: number, _token: string): void {
    // Always rewrite — the bridge port is stable for the extension's lifetime
    // but a different one each launch, so we keep it in sync.
    const cfgPath = path.join(os.homedir(), '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

    let existing: { mcpServers?: Record<string, unknown> } = {};
    try {
      if (fs.existsSync(cfgPath)) {
        existing = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      }
    } catch {
      // malformed — start fresh, but keep the file path. Better than crashing.
    }
    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    const mcpServerPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'python_mcp_server.py').fsPath;
    const pythonBin = process.env.CLAUDE_NOTEBOOK_PYTHON || process.env.PYTHON || 'python3';
    servers[KERNEL_MCP_NAME] = {
      command: pythonBin,
      args: [mcpServerPath],
      env: {
        KERNEL_BRIDGE_URL: `http://127.0.0.1:${port}`,
        KERNEL_BRIDGE_TOKEN: _token,
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify({ ...existing, mcpServers: servers }, null, 2), 'utf-8');
    this._mcpInstalled = true;
  }

  private async _handleEvent(
    event: Record<string, unknown>,
    sink: PromptStreamSink,
    result: PromptRunResult,
    toolNarrations: string[]
  ): Promise<{ sawAssistantText?: boolean }> {
    const etype = String(event.type || '');

    if (etype === 'system') {
      const subtype = String(event.subtype || '');
      if (subtype === 'init') {
        const model = typeof event.model === 'string' ? event.model : '';
        if (model) result.modelUsed = model;
        // Avoid inferring the context window from the reported model ID — the
        // CLI may surface a parent default whose name contains `1m` even for
        // the cell-selected model. The seed 200k default is correct for the
        // models we expose through the picker.
      }
      return {};
    }

    if (etype === 'assistant') {
      const msg = (event.message as Record<string, unknown> | undefined) || {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      let sawText = false;
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue;
        const block = raw as Record<string, unknown>;
        if (block.type !== 'text') continue;
        const text = String(block.text || '');
        if (!text) continue;
        sawText = true;
        result.answerText += text;
        await sink.appendAssistantText(text);
      }
      return { sawAssistantText: sawText };
    }

    if (etype === 'tool_call') {
      const subtype = String(event.subtype || '');
      const tcRaw = event.tool_call as Record<string, unknown> | undefined;
      if (!tcRaw) return {};
      // tool_call envelope keys are typed: shellToolCall, readToolCall, editToolCall,
      // grepToolCall, globToolCall, mcpToolCall, ...
      const variantKey = Object.keys(tcRaw)[0] || '';
      const variant = (tcRaw[variantKey] as Record<string, unknown>) || {};
      const args = (variant.args as Record<string, unknown>) || {};

      if (subtype === 'started') {
        await this._renderToolStart(variantKey, args, sink, toolNarrations);
        return {};
      }
      if (subtype === 'completed') {
        await this._renderToolComplete(variantKey, args, variant.result, sink, toolNarrations);
        return {};
      }
      return {};
    }

    if (etype === 'result') {
      const usage = event.usage as Record<string, number> | undefined;
      if (usage) accumulateUsage(result, usage);
      const cost = Number(event.total_cost_usd || 0);
      if (cost > 0) result.usage.costUsd = (result.usage.costUsd || 0) + cost;
      const duration = Number(event.duration_ms || 0);
      if (duration > 0) result.usage.durationMs = (result.usage.durationMs || 0) + duration;
      // Cursor's `result.result` is the consolidated final assistant text.
      // Falls back when partials weren't emitted.
      if (!result.answerText && typeof event.result === 'string') {
        result.answerText = event.result;
      }
      return {};
    }

    return {};
  }

  private async _renderToolStart(
    variantKey: string,
    args: Record<string, unknown>,
    sink: PromptStreamSink,
    narrations: string[]
  ): Promise<void> {
    switch (variantKey) {
      case 'shellToolCall': {
        const command = String(args.command || '');
        const description = String(args.description || '');
        await sink.appendToolUse('Bash', { command, description });
        narrations.push(`Bash: ${command}`);
        return;
      }
      case 'readToolCall': {
        const file_path = String(args.path || '');
        await sink.appendToolUse('Read', { file_path });
        narrations.push(`Read: ${file_path}`);
        return;
      }
      case 'editToolCall': {
        const file_path = String(args.path || '');
        const content = typeof args.streamContent === 'string' ? args.streamContent : '';
        // Cursor's edit covers both create and edit. Show as Write since we
        // get the full file content; the result includes a diffString if it
        // was a real edit.
        await sink.appendToolUse('Write', { file_path, content });
        narrations.push(`Write: ${file_path}`);
        return;
      }
      case 'grepToolCall': {
        const pattern = String(args.pattern || '');
        const grepPath = String(args.path || '');
        await sink.appendToolUse('Grep', { pattern, path: grepPath });
        narrations.push(`Grep: ${pattern}${grepPath ? ` in ${grepPath}` : ''}`);
        return;
      }
      case 'globToolCall': {
        const pattern = String(args.globPattern || '');
        const target = String(args.targetDirectory || '');
        await sink.appendToolUse('Glob', { pattern, path: target });
        narrations.push(`Glob: ${pattern}${target ? ` in ${target}` : ''}`);
        return;
      }
      case 'mcpToolCall': {
        const providerToolLabel = String(args.name || '');
        const inner = (args.args as Record<string, unknown>) || {};
        if (providerToolLabel === KERNEL_MCP_TOOL_LABEL) {
          const code = typeof inner.code === 'string' ? inner.code : JSON.stringify(inner);
          await sink.appendPythonRun(code);
          narrations.push(`Python: ${truncateOneLine(code)}`);
        } else {
          await sink.appendToolUse(providerToolLabel || 'mcpTool', inner);
          narrations.push(`Tool: ${providerToolLabel}`);
        }
        return;
      }
      default: {
        // Unknown variant — show generically so we don't silently drop it.
        const fallbackName = variantKey.replace(/ToolCall$/, '');
        await sink.appendToolUse(fallbackName || 'tool', args);
        narrations.push(`Tool: ${fallbackName}`);
      }
    }
  }

  private async _renderToolComplete(
    variantKey: string,
    args: Record<string, unknown>,
    rawResult: unknown,
    sink: PromptStreamSink,
    _narrations: string[]
  ): Promise<void> {
    void args;
    const success = isRecord(rawResult) && isRecord(rawResult.success) ? rawResult.success : null;
    const error = isRecord(rawResult) && isRecord(rawResult.error) ? rawResult.error : null;

    switch (variantKey) {
      case 'shellToolCall': {
        if (!success) return;
        const stdout = String(success.stdout || '');
        const stderr = String(success.stderr || '');
        const exitCode = typeof success.exitCode === 'number' ? success.exitCode : undefined;
        const text = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
        await sink.appendToolResult([{ type: 'terminal', text, exitCode }]);
        return;
      }
      case 'readToolCall': {
        // Read result is suppressed (file content shown via the call itself
        // is enough for the user; the model still has the full content).
        if (SUPPRESS_RESULT_TOOLS.has('Read')) return;
        if (success && typeof success.content === 'string') {
          await sink.appendToolResult(success.content);
        }
        return;
      }
      case 'editToolCall': {
        if (success && typeof success.diffString === 'string' && success.diffString.trim()) {
          await sink.appendToolResult([{ type: 'diff', text: success.diffString }]);
        }
        return;
      }
      case 'grepToolCall': {
        if (!success) return;
        const pretty = formatGrepResult(success);
        if (pretty) await sink.appendToolResult(pretty);
        return;
      }
      case 'globToolCall': {
        if (!success) return;
        const files = Array.isArray(success.files) ? success.files : [];
        const total = typeof success.totalFiles === 'number' ? success.totalFiles : files.length;
        const text = files.length === 0
          ? '(no matches)'
          : files.map((f) => String(f)).join('\n') + (total > files.length ? `\n... (${total} total)` : '');
        await sink.appendToolResult(text);
        return;
      }
      case 'mcpToolCall': {
        if (!success) {
          if (error) await sink.appendError(JSON.stringify(error));
          return;
        }
        const blocks = extractCursorMcpResultBlocks(success.content);
        if (blocks.length > 0) {
          await sink.appendToolResult(blocks);
        } else {
          const fallback = stringifyContent(success.content);
          if (fallback) await sink.appendToolResult(fallback);
        }
        return;
      }
      default: {
        if (success) await sink.appendToolResult(stringifyContent(success));
        else if (error) await sink.appendError(stringifyContent(error));
      }
    }
  }
}

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

function mapModel(_model: string): string {
  // Cursor backend always runs against Composer 2.5 — the cell-level
  // Sonnet/Opus picker is ignored when this backend is selected.
  return 'composer-2.5';
}

function buildContextPreamble(priorRuns: CellRunRecord[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < priorRuns.length; i++) {
    const record = priorRuns[i];
    if (!record.included) continue;
    if (record.kind === 'python') {
      if (!record.source.trim()) continue;
      blocks.push(
        `[Python cell ${i + 1}]\n` +
        '```python\n' + record.source + '\n```\n' +
        'Output:\n```\n' + (record.output || '(no output)') + '\n```'
      );
    } else if (record.kind === 'prompt') {
      const history = record.history as CursorHistory | undefined;
      if (!history) continue;
      const parts: string[] = [`[Prompt cell ${i + 1}]\nUser: ${history.userPrompt}`];
      if (history.toolNarrations?.length) {
        parts.push('Tools used: ' + history.toolNarrations.join('; '));
      }
      if (history.assistantText) {
        parts.push('Assistant: ' + truncateOneLine(history.assistantText, 600));
      }
      blocks.push(parts.join('\n'));
    }
  }
  if (!blocks.length) return '';
  return (
    '<notebook_context>\n' +
    'You are continuing a Jupyter notebook session. Earlier cells in this notebook ' +
    'have already run; here is what happened, in order. Treat this as established ' +
    'context — do not redo work, but you can refer back to it.\n\n' +
    blocks.join('\n\n') +
    '\n</notebook_context>'
  );
}

function buildPromptText(prompt: string): string {
  const preamble =
    'You are answering inside a notebook prompt cell. To work with Python, ' +
    `call the kernel-${KERNEL_TOOL_NAME} MCP tool: it executes code in the live ` +
    "notebook kernel and returns stdout/stderr. The kernel shares the same " +
    "namespace as the user's Python cells, so variables defined earlier are " +
    'available. Side effects persist — prefer non-mutating queries unless the ' +
    'user explicitly asks you to change state.';
  return preamble + '\n\n' + prompt;
}

// Composer 2.5 prices, per cursor.com/docs/account/pricing (USD per token).
// We compute cost locally because cursor doesn't include total_cost_usd in
// the result event for Composer.
const COMPOSER_PRICE = {
  input: 0.50 / 1_000_000,
  output: 2.50 / 1_000_000,
  cacheRead: 0.20 / 1_000_000,
};

function accumulateUsage(result: PromptRunResult, usage: Record<string, number>): void {
  const inTok = Number(usage.inputTokens || 0);
  const outTok = Number(usage.outputTokens || 0);
  const cacheRead = Number(usage.cacheReadTokens || 0);
  const cacheWrite = Number(usage.cacheWriteTokens || 0);
  result.usage.inputTokens = (result.usage.inputTokens || 0) + inTok;
  result.usage.outputTokens = (result.usage.outputTokens || 0) + outTok;
  result.usage.cacheReadTokens = (result.usage.cacheReadTokens || 0) + cacheRead;
  result.usage.cacheCreationTokens = (result.usage.cacheCreationTokens || 0) + cacheWrite;
  result.usage.totalInputForContext =
    (result.usage.inputTokens || 0)
    + (result.usage.cacheReadTokens || 0)
    + (result.usage.cacheCreationTokens || 0);
  const cost =
    inTok * COMPOSER_PRICE.input +
    outTok * COMPOSER_PRICE.output +
    cacheRead * COMPOSER_PRICE.cacheRead;
  result.usage.costUsd = (result.usage.costUsd || 0) + cost;
}

function extractCursorMcpResultBlocks(content: unknown): ToolResultBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ToolResultBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    // Cursor wraps MCP results as { text: { text: "..." } } in observed events.
    if (isRecord(item.text) && typeof item.text.text === 'string') {
      out.push({ type: 'text', text: item.text.text });
    } else if (item.type === 'text' && typeof item.text === 'string') {
      out.push({ type: 'text', text: item.text });
    } else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      out.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    }
  }
  return out;
}

function formatGrepResult(success: Record<string, unknown>): string {
  const wsResults = success.workspaceResults as Record<string, unknown> | undefined;
  if (!wsResults) return '';
  const out: string[] = [];
  for (const wsKey of Object.keys(wsResults)) {
    const ws = wsResults[wsKey] as Record<string, unknown>;
    const content = ws?.content as Record<string, unknown> | undefined;
    const matches = (content?.matches as unknown[]) || [];
    for (const fm of matches) {
      if (!isRecord(fm)) continue;
      const file = String(fm.file || '');
      const lineMatches = Array.isArray(fm.matches) ? fm.matches : [];
      for (const lm of lineMatches) {
        if (!isRecord(lm)) continue;
        const lineNumber = lm.lineNumber;
        const lineContent = String(lm.content || '');
        out.push(`${file}:${lineNumber}: ${lineContent}`);
      }
    }
  }
  return out.length ? out.join('\n') : '(no matches)';
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncateOneLine(value: string, max = 80): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}
