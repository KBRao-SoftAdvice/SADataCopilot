import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStateService } from './sessionState';
import { PythonRepl } from './pythonRepl';
import { OutputInterceptor } from './outputInterceptor';
import { KernelBridge } from './kernelBridge';
import { isPromptCell, getPromptModel } from '../providers/cellStatusBar';
import { METADATA_INCLUDED, METADATA_TOOL_CELL } from '../constants';

const KERNEL_MCP_NAME = 'kernel';
const KERNEL_RUN_TOOL = `mcp__${KERNEL_MCP_NAME}__python_run`;

type CellRunKind = 'python' | 'prompt';

interface CellRunRecord {
  cellUri: string;
  kind: CellRunKind;
  source: string;
  output: string;
  included: boolean;
  // For prompt cells: the JSONL message records this turn contributed (user + assistant chain).
  messages?: SessionMessage[];
}

type SessionMessage = Record<string, unknown> & { uuid?: string; parentUuid?: string | null };

const CODE_TOOLS = new Set(['Bash', 'Edit', 'Write']);

export class ClaudeNotebookController implements vscode.Disposable {
  private readonly _controller: vscode.NotebookController;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _runsByNotebook = new Map<string, Map<string, CellRunRecord>>();
  private readonly _pythonByNotebook = new Map<string, PythonRepl>();
  private readonly _bridge = new KernelBridge();
  private _executionOrder = 1;
  private _totalCost = 0;
  private _opusCost = 0;
  private _sonnetCost = 0;
  private _lastInputTokens = 0;
  private _contextWindow = 200000;
  private _model = '';

  constructor(
    private readonly _sessionState: SessionStateService,
    private readonly _interceptor: OutputInterceptor,
    private readonly _extensionUri: vscode.Uri
  ) {
    this._controller = vscode.notebooks.createNotebookController(
      'claude-notebook-controller',
      'jupyter-notebook',
      'Claude Notebook'
    );
    this._controller.supportedLanguages = ['python', 'claude-prompt', 'markdown', 'plaintext', 'shellscript', 'diff'];
    this._controller.description = 'Routes notebook cells to Python or Claude';
    this._controller.detail = 'Code cells run as Python; + Prompt cells run through Claude Code.';
    this._controller.executeHandler = (cells, notebook) => this._executeAll(cells, notebook);
  }

  reset(): void {
    this._runsByNotebook.clear();
    for (const repl of this._pythonByNotebook.values()) repl.dispose();
    this._pythonByNotebook.clear();
    this._totalCost = 0;
    this._opusCost = 0;
    this._sonnetCost = 0;
    this._lastInputTokens = 0;
    this._model = '';
    this._publishSessionState();
  }

  dispose(): void {
    for (const repl of this._pythonByNotebook.values()) repl.dispose();
    this._pythonByNotebook.clear();
    this._bridge.dispose();
    this._controller.dispose();
    this._disposables.forEach((d) => d.dispose());
  }

  private _getPythonRepl(notebook: vscode.NotebookDocument): PythonRepl {
    const key = notebook.uri.toString();
    let repl = this._pythonByNotebook.get(key);
    if (!repl) {
      const python = process.env.CLAUDE_NOTEBOOK_PYTHON || process.env.PYTHON || 'python3';
      repl = new PythonRepl(python, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      this._pythonByNotebook.set(key, repl);
    }
    return repl;
  }

  private async _executeAll(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    for (const cell of cells) {
      await this._executeCell(cell, notebook);
    }
  }

  private async _executeCell(cell: vscode.NotebookCell, notebook: vscode.NotebookDocument): Promise<void> {
    const execution = this._controller.createNotebookCellExecution(cell);
    execution.executionOrder = this._executionOrder++;
    execution.start(Date.now());
    await execution.clearOutput();

    try {
      if (cell.metadata?.[METADATA_TOOL_CELL] === true) {
        await this._appendHtml(execution, '<div style="color:#64748b;font-size:12px">Tool cells are display-only.</div>');
        execution.end(true, Date.now());
        return;
      }

      if (isPromptCell(cell)) {
        await this._executePromptCell(cell, notebook, execution);
      } else {
        await this._executePythonCell(cell, notebook, execution);
      }
    } catch (error) {
      await this._appendHtml(execution, `<div style="color:#ef4444;padding:6px">Error: ${escapeHtml(String(error))}</div>`);
      execution.end(false, Date.now());
    }
  }

  private async _executePythonCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    execution: vscode.NotebookCellExecution
  ): Promise<void> {
    const code = cell.document.getText();
    if (!code.trim()) {
      this._recordRun(notebook, cell, 'python', code, '', true);
      execution.end(true, Date.now());
      return;
    }

    const repl = this._getPythonRepl(notebook);
    let outputText = '';
    const { ok, cancelled } = await repl.run(
      code,
      async (name, text) => {
        outputText += text;
        const item = name === 'stderr'
          ? vscode.NotebookCellOutputItem.stderr(text)
          : vscode.NotebookCellOutputItem.stdout(text);
        await execution.appendOutput(new vscode.NotebookCellOutput([item]));
      },
      execution.token
    );

    this._recordRun(notebook, cell, 'python', code, outputText, true);
    this._publishSessionState(notebook);
    execution.end(ok && !cancelled, Date.now());
  }

  private _buildPromptText(prompt: string): string {
    const preamble =
      'You are answering inside a notebook prompt cell. To work with Python, ' +
      'use the python_run tool: it executes code in the live notebook kernel ' +
      'and returns stdout/stderr to you. The kernel shares the same namespace ' +
      'as the user\'s Python cells, so variables like `df` defined earlier ' +
      'are available. Use python_run whenever you need to inspect data, ' +
      'check shapes/values, or compute something to reason about. Side ' +
      'effects persist — prefer non-mutating queries unless the user ' +
      'explicitly asks you to change state.';
    return preamble + '\n\n' + prompt;
  }

  private async _executePromptCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    execution: vscode.NotebookCellExecution
  ): Promise<void> {
    const prompt = stripClaudeMagic(cell.document.getText());
    if (!prompt.trim()) {
      this._recordRun(notebook, cell, 'prompt', prompt, '', cell.metadata?.[METADATA_INCLUDED] !== false);
      execution.end(true, Date.now());
      return;
    }

    const model = getPromptModel(cell);
    const args = ['-p'];
    if (model === 'sonnet' || model === 'opus') {
      args.push('--model', model);
    }

    // Bring up the localhost bridge and register a one-time token bound to
    // this notebook's REPL so the spawned claude can route python_run calls
    // back here. Token is unregistered in `finally` below.
    const bridgeInfo = await this._bridge.start();
    const repl = this._getPythonRepl(notebook);
    const bridgeToken = this._bridge.register({ repl });

    const mcpServerScript = vscode.Uri.joinPath(this._extensionUri, 'mcp', 'pythonServer.js').fsPath;
    const mcpConfig = {
      mcpServers: {
        [KERNEL_MCP_NAME]: {
          command: process.execPath, // VS Code's bundled Node — present on all platforms
          args: [mcpServerScript],
          env: {
            KERNEL_BRIDGE_URL: bridgeInfo.url,
            KERNEL_BRIDGE_TOKEN: bridgeToken,
          },
        },
      },
    };

    args.push(
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', JSON.stringify(mcpConfig),
      '--strict-mcp-config',
      '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', KERNEL_RUN_TOOL
    );

    // If the current cell is excluded, run it in isolation: fresh session, no
    // upstream history. Otherwise, build a fresh session JSONL from prior
    // included prompt cells' stored messages so this run sees only the
    // upstream history. (Claude rejects --resume against an empty conversation,
    // so we use --session-id when no history is built.)
    const isExcluded = cell.metadata?.[METADATA_INCLUDED] === false;
    let sessionId: string;
    if (isExcluded) {
      sessionId = crypto.randomUUID();
      args.push('--session-id', sessionId);
    } else {
      const prepared = await this._prepareSessionForCell(notebook, cell);
      sessionId = prepared.sessionId;
      if (prepared.hasHistory) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
    }
    args.push(isExcluded ? prompt : this._buildPromptText(prompt));

    let answerText = '';
    let sawAssistantText = false;
    let finalUsage: Record<string, number> = {};
    let finalDuration = 0;
    let resultSessionId = '';
    const toolNameById = new Map<string, string>();
    const HIDDEN_TOOLS = new Set(['ToolSearch']);

    // The whole assistant reply (text + tool calls + results + stderr) is
    // streamed into ONE output item. This gives the user a single collapsible
    // <details> wrapper with a unified scrollbar instead of N stacked blocks
    // that each scroll independently.
    let transcriptHtml = '';
    const appendToTranscript = async (html: string): Promise<void> => {
      transcriptHtml += html;
      await execution.replaceOutput(new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(wrapTranscript(transcriptHtml), 'text/html')
      ]));
    };

    let result: ProcessResult;
    try {
    result = await runProcess(
      'claude',
      args,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      execution.token,
      async (chunk) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          const type = String(event.type || '');
          if (type === 'system') {
            const eventModel = String(event.model || '');
            this._model = eventModel;
            this._contextWindow = eventModel.toLowerCase().includes('1m') ? 1000000 : 200000;
          } else if (type === 'assistant') {
            const message = event.message as { content?: unknown; usage?: Record<string, number> } | undefined;
            const content = normalizeContent(message?.content);
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                sawAssistantText = true;
                answerText += block.text;
                await appendToTranscript(renderAssistantTextHtml(block.text));
              } else if (block.type === 'tool_use') {
                const name = typeof block.name === 'string' ? block.name : 'unknown';
                const id = typeof block.id === 'string' ? block.id : '';
                if (id) toolNameById.set(id, name);
                if (HIDDEN_TOOLS.has(name)) continue;
                if (name === KERNEL_RUN_TOOL) {
                  await appendToTranscript(renderPythonRunUseHtml(block.input));
                } else if (CODE_TOOLS.has(name)) {
                  await appendToTranscript(renderCodeToolUseHtml(name, block.input));
                } else {
                  await appendToTranscript(renderToolUseHtml(name, block.input));
                }
              }
            }
            if (message?.usage) {
              finalUsage = message.usage;
              this._lastInputTokens = usageInputTokens(finalUsage);
            }
          } else if (type === 'user') {
            const message = event.message as { content?: unknown } | undefined;
            for (const block of normalizeContent(message?.content)) {
              if (block.type === 'tool_result') {
                const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                const calledName = id ? toolNameById.get(id) || '' : '';
                if (HIDDEN_TOOLS.has(calledName)) continue;
                const resultContent = calledName === KERNEL_RUN_TOOL
                  ? extractTextContent(block.content)
                  : stringifyContent(block.content);
                await appendToTranscript(renderToolResultHtml(resultContent));
              }
            }
          } else if (type === 'result') {
            const turnCost = Number(event.total_cost_usd || 0);
            this._totalCost += turnCost;
            if (model === 'opus') this._opusCost += turnCost;
            else if (model === 'sonnet') this._sonnetCost += turnCost;
            finalDuration = Number(event.duration_ms || 0);
            const usage = event.usage as Record<string, number> | undefined;
            if (usage) {
              finalUsage = usage;
              this._lastInputTokens = usageInputTokens(usage);
            }
            if (typeof event.session_id === 'string' && event.session_id) {
              resultSessionId = event.session_id;
            }
            if (!sawAssistantText && typeof event.result === 'string' && event.result) {
              answerText += event.result;
              await appendToTranscript(renderAssistantTextHtml(event.result));
            }
          }
        }
      },
      async (chunk) => {
        await appendToTranscript(`<pre style="color:#ef4444;white-space:pre-wrap">${escapeHtml(chunk)}</pre>`);
      }
    );
    } finally {
      this._bridge.unregister(bridgeToken);
    }

    const cellTokens = (finalUsage.input_tokens || 0) + (finalUsage.output_tokens || 0);
    if (cellTokens > 0) {
      this._interceptor.setTokens(cell.document.uri.toString(), cellTokens);
    }
    if (Object.keys(finalUsage).length > 0) {
      await this._appendHtml(execution, tokenBarHtml(finalUsage, this._model || model, finalDuration));
    }

    // Extract this turn's messages from the session file Claude actually
    // wrote to (it may have forked to a new session id), then clean up both
    // the input file we wrote and any forked file Claude produced.
    const effectiveSessionId = resultSessionId || sessionId;
    const newMessages = this._extractLastTurnMessages(effectiveSessionId, prompt);
    this._recordRun(notebook, cell, 'prompt', prompt, answerText, cell.metadata?.[METADATA_INCLUDED] !== false, newMessages);

    this._cleanupSessionFile(sessionId);
    if (effectiveSessionId !== sessionId) this._cleanupSessionFile(effectiveSessionId);

    this._publishSessionState(notebook);
    execution.end(!result.cancelled && result.exitCode === 0, Date.now());
  }

  /**
   * Build a fresh session JSONL containing the rechained messages of all
   * prior included prompt cells (in current notebook order). Returns the
   * fresh sessionId and whether any history was written. If there's no
   * history, the file is not written and the caller should use --session-id
   * instead of --resume.
   */
  private async _prepareSessionForCell(
    notebook: vscode.NotebookDocument,
    currentCell: vscode.NotebookCell
  ): Promise<{ sessionId: string; hasHistory: boolean }> {
    const records = this._runsByNotebook.get(notebook.uri.toString());
    const sessionId = crypto.randomUUID();

    const lines: SessionMessage[] = [];
    let lastUuid: string | null = null;

    const pushChained = (msg: SessionMessage): void => {
      const m: SessionMessage = { ...msg };
      m.sessionId = sessionId;
      if (m.uuid) {
        const origParent = m.parentUuid;
        if (origParent && !lines.some((l) => l.uuid === origParent)) {
          m.parentUuid = lastUuid;
        }
        lastUuid = m.uuid as string;
      }
      lines.push(m);
    };

    if (records) {
      for (let i = 0; i < currentCell.index; i++) {
        const cell = notebook.cellAt(i);
        if (cell.metadata?.[METADATA_TOOL_CELL]) continue;
        if (cell.metadata?.[METADATA_INCLUDED] === false) continue;
        const record = records.get(cell.document.uri.toString());
        if (!record) continue;

        if (record.kind === 'python') {
          if (!record.source.trim()) continue;
          // Synthesize a user turn carrying the latest Python cell content.
          // No assistant reply is added — the next prompt cell will produce
          // one. Re-runs of this Python cell update record.source/output, so
          // the next prepared session naturally reflects the new state.
          const userUuid = crypto.randomUUID();
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
          pushChained({
            type: 'user',
            uuid: userUuid,
            parentUuid: lastUuid,
            isSidechain: false,
            timestamp: new Date().toISOString(),
            cwd,
            version: '2.1.143',
            message: {
              role: 'user',
              content:
                `Python cell ${i + 1} (executed in this notebook):\n` +
                '```python\n' + record.source + '\n```\n' +
                'Output:\n```\n' + (record.output || '(no output)') + '\n```'
            }
          } as SessionMessage);
        } else if (record.kind === 'prompt') {
          if (!record.messages || record.messages.length === 0) continue;
          for (const msg of record.messages) {
            pushChained(msg);
          }
        }
      }
    }

    if (lines.length === 0) {
      return { sessionId, hasHistory: false };
    }

    lines.push({ type: 'last-prompt', leafUuid: lastUuid || '', sessionId });
    const projectDir = this._getProjectDir();
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, sessionId + '.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf-8'
    );
    return { sessionId, hasHistory: true };
  }

  /**
   * After `claude -p --resume <sid>` completes, the session file has been
   * appended with this turn's user+assistant messages. Read those new
   * messages (everything after the last user message that started this turn).
   */
  private _extractLastTurnMessages(sessionId: string, prompt: string): SessionMessage[] {
    const fpath = this._findSessionFile(sessionId);
    if (!fpath) return [];

    const raw = fs.readFileSync(fpath, 'utf-8').trim();
    if (!raw) return [];

    const all: SessionMessage[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        all.push(JSON.parse(t) as SessionMessage);
      } catch {
        // skip malformed
      }
    }

    // Find the last user message whose content matches our prompt — that's
    // the start of this turn. Fall back to the last user message overall.
    let turnStart = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      const msg = all[i];
      if (msg.type !== 'user') continue;
      if (msg.isMeta) continue;
      const content = (msg.message as { content?: unknown } | undefined)?.content;
      const text = typeof content === 'string' ? content : '';
      if (text === prompt) {
        turnStart = i;
        break;
      }
      if (turnStart === -1) turnStart = i;
    }

    if (turnStart === -1) return [];

    const turn: SessionMessage[] = [];
    for (let i = turnStart; i < all.length; i++) {
      const msg = all[i];
      if (msg.type === 'last-prompt') continue;
      turn.push(msg);
    }
    return turn;
  }

  private _cleanupSessionFile(sessionId: string): void {
    try {
      const fpath = this._findSessionFile(sessionId);
      if (fpath) fs.unlinkSync(fpath);
    } catch {
      // best effort
    }
  }

  /**
   * Find the session JSONL file Claude wrote to. Prefers our cwd-derived
   * project dir, falls back to scanning all of ~/.claude/projects/* in case
   * Claude resolved the cwd differently (e.g. symlinks).
   */
  private _findSessionFile(sessionId: string): string | undefined {
    const primary = path.join(this._getProjectDir(), sessionId + '.jsonl');
    if (fs.existsSync(primary)) return primary;

    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsRoot)) return undefined;

    try {
      for (const entry of fs.readdirSync(projectsRoot)) {
        const candidate = path.join(projectsRoot, entry, sessionId + '.jsonl');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore directory read errors
    }
    return undefined;
  }

  private _getProjectDir(): string {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const safe = cwd.replace(/\//g, '-');
    return path.join(os.homedir(), '.claude', 'projects', safe);
  }

  private _recordRun(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    kind: CellRunKind,
    source: string,
    output: string,
    included: boolean,
    messages?: SessionMessage[]
  ): void {
    const notebookKey = notebook.uri.toString();
    let records = this._runsByNotebook.get(notebookKey);
    if (!records) {
      records = new Map();
      this._runsByNotebook.set(notebookKey, records);
    }
    records.set(cell.document.uri.toString(), {
      cellUri: cell.document.uri.toString(),
      kind,
      source,
      output,
      included,
      messages,
    });
  }

  private _publishSessionState(notebook?: vscode.NotebookDocument): void {
    let turnCount = 0;
    let excludedCount = 0;
    if (notebook) {
      for (let i = 0; i < notebook.cellCount; i++) {
        const cell = notebook.cellAt(i);
        if (isPromptCell(cell)) {
          turnCount++;
          if (cell.metadata?.[METADATA_INCLUDED] === false) excludedCount++;
        }
      }
    }

    this._sessionState.updateFromController({
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
      turnCount,
      totalCost: this._totalCost,
      opusCost: this._opusCost,
      sonnetCost: this._sonnetCost,
      excludedCount,
      inputTokens: this._lastInputTokens,
      contextWindow: this._contextWindow,
      model: this._model,
    });
  }

  private async _appendHtml(execution: vscode.NotebookCellExecution, html: string): Promise<void> {
    await execution.appendOutput(new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.text(html, 'text/html')
    ]));
  }

}

interface ProcessResult {
  exitCode: number | null;
  cancelled: boolean;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string | undefined,
  token: vscode.CancellationToken,
  onStdout: (chunk: string) => Promise<void>,
  onStderr: (chunk: string) => Promise<void>,
  env?: NodeJS.ProcessEnv
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelled = false;
    let settled = false;
    let stdoutWork = Promise.resolve();
    let stderrWork = Promise.resolve();

    const cancel = token.onCancellationRequested(() => {
      cancelled = true;
      proc.kill();
    });

    proc.on('error', (error) => {
      if (settled) return;
      settled = true;
      cancel.dispose();
      reject(error);
    });

    const stdout = readline.createInterface({ input: proc.stdout });
    stdout.on('line', (line) => {
      stdoutWork = stdoutWork.then(() => onStdout(`${line}\n`));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrWork = stderrWork.then(() => onStderr(chunk.toString('utf-8')));
    });

    proc.on('close', async (code) => {
      if (settled) return;
      settled = true;
      stdout.close();
      cancel.dispose();
      await Promise.all([stdoutWork, stderrWork]);
      resolve({ exitCode: code, cancelled });
    });
  });
}

function stripClaudeMagic(source: string): string {
  if (!source.startsWith('#%claude:')) return source;
  const firstNewline = source.indexOf('\n');
  return firstNewline === -1 ? '' : source.slice(firstNewline + 1);
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) return content.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function stringifyContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

function usageInputTokens(usage: Record<string, number>): number {
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

function tokenBarHtml(usage: Record<string, number>, _model: string, duration: number): string {
  const parts = [
    `in: ${formatNumber(usage.input_tokens || 0)}`,
    usage.cache_read_input_tokens ? `cached: ${formatNumber(usage.cache_read_input_tokens)}` : '',
    usage.cache_creation_input_tokens ? `new_cache: ${formatNumber(usage.cache_creation_input_tokens)}` : '',
    `out: ${formatNumber(usage.output_tokens || 0)}`,
    duration ? `${(duration / 1000).toFixed(1)}s` : '',
  ].filter(Boolean);

  return (
    '<div style="background:#f1f5f9;border-radius:4px;padding:6px 10px;margin-top:8px;' +
    'font-size:11px;color:#64748b;font-family:monospace">' +
    parts.join(' &nbsp;|&nbsp; ') +
    '</div>'
  );
}

function wrapTranscript(inner: string): string {
  // Single collapsible <details> with one scrolling region. The <summary> sits
  // outside the scrollbox so it's always reachable. max-height keeps long
  // transcripts from blowing out the cell — the user scrolls inside instead.
  return (
    '<details open style="border:1px solid #e2e8f0;border-radius:6px;background:#fff">' +
    '<summary style="cursor:pointer;padding:6px 10px;font-family:monospace;font-size:11px;' +
    'color:#64748b;background:#f8fafc;border-radius:6px 6px 0 0;user-select:none">' +
    'reply (click to collapse)</summary>' +
    '<div style="max-height:600px;overflow-y:auto;padding:8px 12px">' +
    inner +
    '</div>' +
    '</details>'
  );
}

function renderAssistantTextHtml(text: string): string {
  return (
    '<div style="margin:6px 0;border-left:3px solid #38bdf8;background:#f0f9ff;' +
    'padding:6px 12px;border-radius:0 6px 6px 0">' +
    renderMarkdownHtml(text) +
    '</div>'
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
        const t = (item as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return stringifyContent(content);
}

function renderMarkdownHtml(text: string): string {
  const escaped = escapeHtml(text);
  const withCode = escaped.replace(/```([\s\S]*?)```/g, (_match, code) => {
    return `<pre style="background:#1e1e2e;color:#cdd6f4;padding:12px;border-radius:6px;white-space:pre-wrap">${code}</pre>`;
  });
  return withCode
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim() ? `<p style="margin:6px 0">${paragraph.replace(/\n/g, '<br>')}</p>` : '')
    .join('');
}

function renderToolUseHtml(toolName: string, toolInput: unknown): string {
  return (
    '<details open style="margin:6px 0;border:1px solid #e0e0e0;border-radius:6px;padding:4px 8px">' +
    `<summary style="cursor:pointer;font-family:monospace;font-size:13px;color:#7c3aed">${escapeHtml(toolName)}</summary>` +
    `<pre style="background:#f8f8f8;padding:8px;border-radius:4px;font-size:12px;overflow-x:auto;margin-top:6px">${escapeHtml(stringifyContent(toolInput))}</pre>` +
    '</details>'
  );
}

function renderCodeToolUseHtml(toolName: string, toolInput: unknown): string {
  const palette: Record<string, { border: string; tag: string; lang: string }> = {
    Bash: { border: '#f59e0b', tag: '$ bash',  lang: 'bash' },
    Edit: { border: '#3b82f6', tag: '✎ edit',  lang: 'diff' },
    Write: { border: '#10b981', tag: '+ write', lang: 'text' },
  };
  const meta = palette[toolName] || { border: '#7c3aed', tag: toolName, lang: 'text' };
  const source = toolCellSource(toolName, toolInput);
  return (
    `<div style="margin:8px 0;border-left:3px solid ${meta.border};padding:4px 0 4px 10px">` +
    `<div style="font-family:monospace;font-size:11px;color:${meta.border};font-weight:600;margin-bottom:4px">${escapeHtml(meta.tag)}</div>` +
    `<pre style="background:#1e1e2e;color:#cdd6f4;padding:10px;border-radius:6px;font-size:12px;` +
    `white-space:pre-wrap;word-break:break-word;margin:0;overflow-x:auto">` +
    `${escapeHtml(source)}</pre>` +
    '</div>'
  );
}

function renderPythonRunUseHtml(toolInput: unknown): string {
  const code = isRecord(toolInput) && typeof toolInput.code === 'string' ? toolInput.code : stringifyContent(toolInput);
  const border = '#a78bfa';
  return (
    `<div style="margin:8px 0;border-left:3px solid ${border};padding:4px 0 4px 10px">` +
    `<div style="font-family:monospace;font-size:11px;color:${border};font-weight:600;margin-bottom:4px">` +
    `&gt;&gt;&gt; python (kernel)</div>` +
    `<pre style="background:#1e1e2e;color:#cdd6f4;padding:10px;border-radius:6px;font-size:12px;` +
    `white-space:pre-wrap;word-break:break-word;margin:0;overflow-x:auto">` +
    `${escapeHtml(code)}</pre>` +
    '</div>'
  );
}

function renderToolResultHtml(content: string): string {
  return (
    '<details open style="margin:2px 0 8px 28px;border-left:2px dashed #94a3b8;padding-left:10px">' +
    '<summary style="cursor:pointer;font-family:monospace;font-size:11px;color:#64748b">↳ result</summary>' +
    '<pre style="background:#f1f5f9;color:#334155;padding:8px;border-radius:4px;font-size:11px;' +
    'white-space:pre-wrap;word-break:break-word;margin-top:6px;overflow-x:auto">' +
    `${escapeHtml(truncate(content, 2000))}</pre>` +
    '</details>'
  );
}

function toolCellSource(toolName: string, toolInput: unknown): string {
  if (!isRecord(toolInput)) return stringifyContent(toolInput);
  if (toolName === 'Bash') return String(toolInput.command || '');
  if (toolName === 'Edit') {
    const filePath = String(toolInput.file_path || '');
    const oldString = String(toolInput.old_string || '');
    const newString = String(toolInput.new_string || '');
    return oldString ? `# Edit: ${filePath}\n# old:\n${oldString}\n# new:\n${newString}` : stringifyContent(toolInput);
  }
  if (toolName === 'Write') {
    return `# Write: ${String(toolInput.file_path || '')}\n${String(toolInput.content || '')}`;
  }
  return stringifyContent(toolInput);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n... (truncated)` : value;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
