import * as vscode from 'vscode';
import { PythonRepl } from './pythonRepl';
import { OutputInterceptor } from './outputInterceptor';
import { isPromptCell, getPromptModel, getReasoningEffort, getCopilotCellModel } from '../providers/cellStatusBar';
import { METADATA_INCLUDED, METADATA_TOOL_CELL } from '../constants';
import { NotebookBackend, BackendId, CellRunRecord, CellRunKind, PromptRunInput } from './backends/types';
import { CopilotBackend } from './backends/copilot';
import { ClaudeBackend } from './backends/claude';
import { CursorBackend } from './backends/cursor';
import { buildStreamSink, tokenBarHtml } from './backends/render';
import { getNotebookBackend } from './backendResolver';
import { loadHistory, saveHistory } from './historyStore';
import { SessionState } from '../types';

interface NotebookStats {
  totalCost: number;
  opusCost: number;
  sonnetCost: number;
  lastInputTokens: number;
  contextWindow: number;
  model: string;
}

function freshStats(): NotebookStats {
  return {
    totalCost: 0,
    opusCost: 0,
    sonnetCost: 0,
    lastInputTokens: 0,
    contextWindow: 200000,
    model: '',
  };
}

export class CopilotNotebookController implements vscode.Disposable {
  private readonly _controller: vscode.NotebookController;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _runsByNotebook = new Map<string, Map<string, CellRunRecord>>();
  private readonly _pythonByNotebook = new Map<string, PythonRepl>();
  private readonly _statsByNotebook = new Map<string, NotebookStats>();
  /** Notebooks whose sidecar we've already attempted to load. */
  private readonly _hydrated = new Set<string>();
  /** Pending sidecar-write timers keyed by notebook URI. Coalesces bursts
   * of saves (e.g. a cell finishing alongside metadata edits) into one. */
  private readonly _saveTimers = new Map<string, NodeJS.Timeout>();
  /** Pooled backend instances keyed by id. Two notebooks both on the Copilot
   * backend share the same CLI process; switching a notebook to a different
   * backend just routes through a different entry. */
  private readonly _backends = new Map<BackendId, NotebookBackend>();
  private _executionOrder = 1;

  private readonly _onState = new vscode.EventEmitter<{ notebookKey: string; state: SessionState }>();
  /** Fires per-notebook whenever stats change (run finishes, cell toggled, etc.). */
  readonly onStateChange = this._onState.event;

  constructor(
    private readonly _interceptor: OutputInterceptor,
    private readonly _extensionUri: vscode.Uri
  ) {
    this._controller = vscode.notebooks.createNotebookController(
      'copilot-notebook-controller',
      'jupyter-notebook',
      'SADataCopilot'
    );
    this._controller.supportedLanguages = ['python', 'copilot-prompt', 'markdown', 'plaintext', 'shellscript', 'diff'];
    this._controller.description = 'SADataCopilot — routes notebook cells to Python or an LLM agent';
    this._controller.detail = 'Code cells run as Python; + Prompt cells run through the configured agent.';
    this._controller.executeHandler = (cells, notebook) => this._executeAll(cells, notebook);
  }

  /** Republish session state for the given notebook. Cheap — just walks cells
   * and emits the aggregate. Call this after metadata changes (e.g. toggling
   * inclusion) so the header reflects the new excluded set immediately. */
  refreshState(notebook?: vscode.NotebookDocument): void {
    if (notebook) this._publishSessionState(notebook);
  }

  /** Compute the current header state for a notebook on demand. Used by the
   * header manager when a notebook is opened/focused before any run.
   * Triggers sidecar hydration as a side effect so a freshly opened
   * notebook surfaces persisted stats without waiting for a run. */
  getStateFor(notebook: vscode.NotebookDocument): SessionState {
    void this._ensureHydrated(notebook);
    return this._computeState(notebook);
  }

  reset(): void {
    for (const t of this._saveTimers.values()) clearTimeout(t);
    this._saveTimers.clear();
    this._hydrated.clear();
    this._runsByNotebook.clear();
    this._statsByNotebook.clear();
    for (const repl of this._pythonByNotebook.values()) repl.dispose();
    this._pythonByNotebook.clear();
    // Disposing every pooled backend tears down its sessions.
    for (const backend of this._backends.values()) {
      Promise.resolve(backend.dispose?.()).catch(() => { /* ignore */ });
    }
    this._backends.clear();
    // Re-publish for every open notebook so headers reset to zero.
    for (const doc of vscode.workspace.notebookDocuments) {
      if (doc.notebookType === 'jupyter-notebook') this._publishSessionState(doc);
    }
  }

  dispose(): void {
    // Flush any pending sidecar writes synchronously (timers haven't fired
    // yet but we still want the latest state on disk before tearing down).
    for (const [key, timer] of this._saveTimers) {
      clearTimeout(timer);
      const doc = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === key);
      if (doc) {
        const records = this._runsByNotebook.get(key) || new Map();
        const stats = this._statsByNotebook.get(key) || freshStats();
        void saveHistory(doc, records, this._interceptor, stats);
      }
    }
    this._saveTimers.clear();
    for (const repl of this._pythonByNotebook.values()) repl.dispose();
    this._pythonByNotebook.clear();
    this._onState.dispose();
    for (const backend of this._backends.values()) {
      Promise.resolve(backend.dispose?.()).catch(() => { /* ignore */ });
    }
    this._backends.clear();
    this._controller.dispose();
    this._disposables.forEach((d) => d.dispose());
  }

  /** Drop all per-notebook state for a closed notebook. VS Code can recycle
   * notebook/cell URIs (especially for untitled notebooks), so leaving stats
   * around makes a freshly-opened notebook inherit the closed one's numbers. */
  clearNotebook(notebook: vscode.NotebookDocument): void {
    const key = notebook.uri.toString();
    const timer = this._saveTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this._saveTimers.delete(key);
    }
    this._hydrated.delete(key);
    this._statsByNotebook.delete(key);
    this._runsByNotebook.delete(key);
    const repl = this._pythonByNotebook.get(key);
    if (repl) {
      repl.dispose();
      this._pythonByNotebook.delete(key);
    }
    this._interceptor.clearForNotebookPath(notebook.uri.path);
  }

  /** Lazy-load the sidecar for this notebook the first time we touch it.
   * Re-attaches CellRunRecord history blobs, exec indices, and stats so a
   * reopened notebook can pick up where it left off. */
  private async _ensureHydrated(notebook: vscode.NotebookDocument): Promise<void> {
    const key = notebook.uri.toString();
    if (this._hydrated.has(key)) return;
    this._hydrated.add(key);
    const loaded = await loadHistory(notebook, this._interceptor);
    if (!loaded) return;
    if (loaded.records.size > 0) {
      this._runsByNotebook.set(key, loaded.records);
    }
    this._statsByNotebook.set(key, { ...loaded.stats });
    this._publishSessionState(notebook);
  }

  /** Debounced sidecar write. Called after every successful run. */
  private _scheduleSave(notebook: vscode.NotebookDocument): void {
    const key = notebook.uri.toString();
    const existing = this._saveTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._saveTimers.delete(key);
      const records = this._runsByNotebook.get(key) || new Map();
      const stats = this._statsByNotebook.get(key) || freshStats();
      void saveHistory(notebook, records, this._interceptor, stats);
    }, 500);
    this._saveTimers.set(key, timer);
  }

  private _getStats(notebook: vscode.NotebookDocument): NotebookStats {
    const key = notebook.uri.toString();
    let stats = this._statsByNotebook.get(key);
    if (!stats) {
      stats = freshStats();
      this._statsByNotebook.set(key, stats);
    }
    return stats;
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

  private _getBackend(notebook: vscode.NotebookDocument): NotebookBackend {
    const desired = getNotebookBackend(notebook);
    let backend = this._backends.get(desired);
    if (!backend) {
      if (desired === 'claude') backend = new ClaudeBackend(this._extensionUri);
      else if (desired === 'cursor') backend = new CursorBackend(this._extensionUri);
      else backend = new CopilotBackend(this._extensionUri);
      this._backends.set(desired, backend);
    }
    return backend;
  }

  private async _executeAll(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    for (const cell of cells) {
      await this._executeCell(cell, notebook);
    }
  }

  private async _executeCell(cell: vscode.NotebookCell, notebook: vscode.NotebookDocument): Promise<void> {
    await this._ensureHydrated(notebook);

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
    this._bumpExecIndex(notebook, cell);
    execution.end(ok && !cancelled, Date.now());
    this._publishSessionState(notebook);
    this._scheduleSave(notebook);
  }

  private async _executePromptCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    execution: vscode.NotebookCellExecution
  ): Promise<void> {
    const prompt = stripPromptMagic(cell.document.getText());
    if (!prompt.trim()) {
      this._recordRun(notebook, cell, 'prompt', prompt, '', cell.metadata?.[METADATA_INCLUDED] !== false);
      execution.end(true, Date.now());
      return;
    }

    const backendId = getNotebookBackend(notebook);
    const model = getPromptModel(cell, backendId);
    const reasoningEffort =
      backendId === 'copilot' && getCopilotCellModel(cell) === 'gpt-5.5'
        ? getReasoningEffort(cell)
        : undefined;
    const isExcluded = cell.metadata?.[METADATA_INCLUDED] === false;

    let transcriptHtml = '';
    const sink = buildStreamSink(
      execution,
      (html) => this._appendHtml(execution, html),
      (next) => { transcriptHtml = next; },
      () => transcriptHtml
    );

    const abortController = new AbortController();
    const cancelSub = execution.token.onCancellationRequested(() => abortController.abort());

    const priorRuns = this._collectPriorRuns(notebook, cell);
    const input: PromptRunInput = {
      prompt,
      model,
      reasoningEffort,
      isExcluded,
      cellUriString: cell.document.uri.toString(),
      notebookKey: notebook.uri.toString(),
      priorRuns,
      repl: this._getPythonRepl(notebook),
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      abortController,
      cancellationToken: execution.token,
    };

    const backend = this._getBackend(notebook);
    let result;
    try {
      result = await backend.runPromptTurn(input, sink);
    } finally {
      cancelSub.dispose();
    }

    const stats = this._getStats(notebook);
    stats.totalCost += result.usage.costUsd || 0;
    if (model === 'opus') stats.opusCost += result.usage.costUsd || 0;
    else if (model === 'sonnet') stats.sonnetCost += result.usage.costUsd || 0;

    if (result.modelUsed) stats.model = result.modelUsed;
    if (result.contextWindow) stats.contextWindow = result.contextWindow;

    // Header context gauge always reflects the most recent non-excluded
    // run's full footprint: input + cache_read + cache_creation + output.
    // That's the most comprehensive picture of what the conversation costs
    // right now; we don't try to combine across cells. Excluded runs are
    // standalone (no prior context), so we skip them — otherwise the gauge
    // would drop to a small number after running an excluded cell.
    if (!isExcluded) {
      const totalContext =
        (result.usage.totalInputForContext || 0)
        + (result.usage.outputTokens || 0);
      if (totalContext) stats.lastInputTokens = totalContext;
    }

    this._bumpExecIndex(notebook, cell);

    if (result.usage.inputTokens || result.usage.outputTokens) {
      await this._appendHtml(execution, tokenBarHtml(result.usage, stats.model || model, result.usage.durationMs, result.footer));
    }

    this._recordRun(
      notebook,
      cell,
      'prompt',
      prompt,
      result.answerText,
      cell.metadata?.[METADATA_INCLUDED] !== false,
      result.history
    );

    execution.end(!result.cancelled && !result.errored, Date.now());
    // Publish *after* end() so the header-cell WorkspaceEdit isn't racing
    // VS Code's notebook-busy lock that surrounds executing cells.
    this._publishSessionState(notebook);
    this._scheduleSave(notebook);
  }

  private _collectPriorRuns(notebook: vscode.NotebookDocument, currentCell: vscode.NotebookCell): CellRunRecord[] {
    const records = this._runsByNotebook.get(notebook.uri.toString());
    if (!records) return [];
    const out: CellRunRecord[] = [];
    for (let i = 0; i < currentCell.index; i++) {
      const cell = notebook.cellAt(i);
      if (cell.metadata?.[METADATA_TOOL_CELL]) continue;
      const record = records.get(cell.document.uri.toString());
      if (!record) continue;
      // Re-derive `included` from live cell metadata — the stored value is
      // captured at execution time and goes stale if the user toggles the
      // cell after running it.
      const included = cell.metadata?.[METADATA_INCLUDED] !== false;
      out.push(included === record.included ? record : { ...record, included });
    }
    return out;
  }

  /** Stamp `cell` with the next monotonically-increasing exec number for
   * this notebook. Mirrors Jupyter's gutter: latest run = highest number,
   * earlier numbers stay put on the cells that produced them. Re-running
   * a cell promotes it to a new high. */
  private _bumpExecIndex(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell): void {
    let max = 0;
    for (let i = 0; i < notebook.cellCount; i++) {
      const idx = this._interceptor.getExecIndex(notebook.cellAt(i).document.uri.toString());
      if (idx !== undefined && idx > max) max = idx;
    }
    this._interceptor.setExecIndex(cell.document.uri.toString(), max + 1);
  }

  private _recordRun(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    kind: CellRunKind,
    source: string,
    output: string,
    included: boolean,
    history?: unknown
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
      history,
    });
  }

  private _publishSessionState(notebook: vscode.NotebookDocument): void {
    const state = this._computeState(notebook);
    this._onState.fire({ notebookKey: notebook.uri.toString(), state });
  }

  private _computeState(notebook: vscode.NotebookDocument): SessionState {
    const stats = this._statsByNotebook.get(notebook.uri.toString()) || freshStats();
    let turnCount = 0;
    let excludedCount = 0;
    for (let i = 0; i < notebook.cellCount; i++) {
      const cell = notebook.cellAt(i);
      if (cell.metadata?.[METADATA_TOOL_CELL]) continue;
      const isPrompt = isPromptCell(cell);
      if (isPrompt) turnCount++;
      // Inclusion toggle applies to both prompt and Python cells.
      if ((isPrompt || cell.document.languageId === 'python')
          && cell.metadata?.[METADATA_INCLUDED] === false) {
        excludedCount++;
      }
    }

    return {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
      turnCount,
      totalCost: stats.totalCost,
      opusCost: stats.opusCost,
      sonnetCost: stats.sonnetCost,
      excludedCount,
      inputTokens: stats.lastInputTokens,
      contextWindow: stats.contextWindow,
      model: stats.model,
    };
  }

  private async _appendHtml(execution: vscode.NotebookCellExecution, html: string): Promise<void> {
    await execution.appendOutput(new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.text(html, 'text/html')
    ]));
  }
}

function stripPromptMagic(source: string): string {
  if (!source.startsWith('#%copilot:')) return source;
  const firstNewline = source.indexOf('\n');
  return firstNewline === -1 ? '' : source.slice(firstNewline + 1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
