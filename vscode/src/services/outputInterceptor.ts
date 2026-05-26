import * as vscode from 'vscode';

/** Tracks a per-cell execution sequence number for prompt cells.
 * Bumps on every prompt run (including re-runs), so cells display the
 * order they were last executed in. Cells that have never run are
 * absent from the map. */
export class OutputInterceptor {
  private _onPort = new vscode.EventEmitter<number>();
  readonly onPortDiscovered = this._onPort.event;

  private _onExec = new vscode.EventEmitter<void>();
  readonly onExecUpdated = this._onExec.event;

  private _execMap = new Map<string, number>();

  getExecIndex(cellUri: string): number | undefined {
    return this._execMap.get(cellUri);
  }

  setExecIndex(cellUri: string, index: number): void {
    this._execMap.set(cellUri, index);
    this._onExec.fire();
  }

  /** Drop every cached entry whose cell URI lives under the given notebook
   * path. VS Code recycles cell URIs after a notebook is closed (especially
   * for untitled notebooks), so we clear them on close to keep stale numbers
   * from bleeding into a freshly opened notebook.
   *
   * Pass `notebook.uri.path` — cell URIs use the `vscode-notebook-cell:`
   * scheme with the notebook's path embedded, so a path-substring match
   * catches them regardless of scheme/fragment. */
  clearForNotebookPath(notebookPath: string): void {
    if (!notebookPath) return;
    let changed = false;
    for (const key of this._execMap.keys()) {
      if (key.includes(notebookPath)) {
        this._execMap.delete(key);
        changed = true;
      }
    }
    if (changed) this._onExec.fire();
  }

  dispose(): void {
    this._onPort.dispose();
    this._onExec.dispose();
  }
}
