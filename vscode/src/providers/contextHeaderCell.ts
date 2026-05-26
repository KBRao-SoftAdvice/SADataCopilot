import * as vscode from 'vscode';
import { CopilotNotebookController } from '../services/notebookController';
import { SessionState } from '../types';
import { METADATA_CONTEXT_HEADER } from '../constants';

/**
 * Auto-managed markdown cell pinned at the top of every Jupyter notebook.
 * Each notebook's header reflects only that notebook's own runs — state is
 * looked up per-notebook from the controller, never shared.
 *
 * The cell is identified by `copilot_context_header: true` in its metadata so
 * we re-use the same cell rather than churning a new one on every update.
 */
export class ContextHeaderCellManager implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = [];
  /** Reentrancy guard per notebook: WorkspaceEdit fires onDidChangeNotebookDocument,
   *  which would otherwise re-enter ensureHeader and stack inserts. */
  private readonly _writing = new Set<string>();

  constructor(private readonly _controller: CopilotNotebookController) {
    this._disposables.push(
      this._controller.onStateChange(({ notebookKey, state }) => {
        const doc = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === notebookKey);
        if (!doc) return;
        void this._ensureHeader(doc, state);
      })
    );

    this._disposables.push(
      vscode.workspace.onDidOpenNotebookDocument((doc) => {
        if (doc.notebookType !== 'jupyter-notebook') return;
        void this._ensureHeader(doc, this._controller.getStateFor(doc));
      })
    );

    this._disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor((editor) => {
        if (editor && editor.notebook.notebookType === 'jupyter-notebook') {
          void this._ensureHeader(editor.notebook, this._controller.getStateFor(editor.notebook));
        }
      })
    );

    // Seed any notebooks that were already open at activation time.
    for (const doc of vscode.workspace.notebookDocuments) {
      if (doc.notebookType === 'jupyter-notebook') {
        void this._ensureHeader(doc, this._controller.getStateFor(doc));
      }
    }
  }

  dispose(): void {
    this._disposables.forEach((d) => d.dispose());
  }

  private async _ensureHeader(notebook: vscode.NotebookDocument, state: SessionState): Promise<void> {
    const key = notebook.uri.toString();
    if (this._writing.has(key)) return;
    const desired = renderHeaderMarkdown(state);

    // Sweep *all* header cells in document order. After a reload, our metadata
    // marker is gone (the Jupyter serializer strips unrecognized keys), so on
    // every state change we re-detect by HTML-comment marker. This also cleans
    // up the case where multiple stale headers ended up stacked.
    const headerIndices = findAllHeaderIndices(notebook);
    if (headerIndices.length === 1 && headerIndices[0] === 0) {
      const current = notebook.cellAt(0);
      if (current.document.getText() === desired) return;
    }

    this._writing.add(key);
    try {
      const cellData = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Markup,
        desired,
        'markdown'
      );
      cellData.metadata = { [METADATA_CONTEXT_HEADER]: true };

      const edits: vscode.NotebookEdit[] = [];
      // Delete every existing header from highest index downward so earlier
      // ranges aren't invalidated.
      for (const idx of [...headerIndices].sort((a, b) => b - a)) {
        edits.push(vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(idx, idx + 1)));
      }
      edits.push(vscode.NotebookEdit.insertCells(0, [cellData]));

      const wsEdit = new vscode.WorkspaceEdit();
      wsEdit.set(notebook.uri, edits);
      await vscode.workspace.applyEdit(wsEdit);
    } finally {
      this._writing.delete(key);
    }
  }
}

/** Locate every auto-managed header cell. We can't rely on cell metadata
 * because the Jupyter `.ipynb` serializer strips unrecognized keys on save —
 * after a reload, the metadata flag is gone. The HTML marker comment in the
 * cell text *is* preserved, so match on that. */
const HEADER_MARKER = '<!-- copilot-context-header (auto-managed) -->';
function findAllHeaderIndices(notebook: vscode.NotebookDocument): number[] {
  const out: number[] = [];
  for (let i = 0; i < notebook.cellCount; i++) {
    const cell = notebook.cellAt(i);
    if (cell.metadata?.[METADATA_CONTEXT_HEADER] === true) {
      out.push(i);
      continue;
    }
    if (cell.kind === vscode.NotebookCellKind.Markup
        && cell.document.getText().startsWith(HEADER_MARKER)) {
      out.push(i);
    }
  }
  return out;
}

function renderHeaderMarkdown(s: SessionState): string {
  const used = s.inputTokens || 0;
  const win = s.contextWindow || 200000;
  const pct = Math.min(used / win, 1);
  const pctText = Math.round(pct * 100);

  // SVG donut: circumference = 2 * pi * r. With r=28, C ≈ 175.93. Filled
  // length = pct * C; the gap is the rest. We rotate -90° so the arc starts
  // at 12 o'clock instead of 3 o'clock, which is the conventional progress
  // direction.
  const r = 28;
  const C = 2 * Math.PI * r;
  const filled = (pct * C).toFixed(2);
  const gap = (C - pct * C).toFixed(2);
  const arcColor = pct < 0.5 ? '#22c55e' : pct < 0.8 ? '#f59e0b' : '#ef4444';

  // Inline stats — single row, label and value on the same line, separated by
  // a thin divider so the strip stays compact.
  const stats: string[] = [
    stat('Tokens', `${formatTokens(used)} / ${formatTokens(win)}`),
    stat('Cost', `$${(s.totalCost || 0).toFixed(4)}`),
    stat('Turns', String(s.turnCount || 0)),
    stat('Excluded', String(s.excludedCount || 0)),
  ];

  const html = `
<!-- copilot-context-header (auto-managed) -->
<div style="display:flex;align-items:center;gap:16px;padding:8px 14px;border:1px solid rgba(127,127,127,0.25);border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <svg width="56" height="56" viewBox="0 0 74 74" style="flex-shrink:0;">
    <circle cx="37" cy="37" r="${r}" fill="none" stroke="rgba(127,127,127,0.25)" stroke-width="8"/>
    <circle cx="37" cy="37" r="${r}" fill="none" stroke="${arcColor}" stroke-width="8"
            stroke-dasharray="${filled} ${gap}" stroke-linecap="round"
            transform="rotate(-90 37 37)"/>
    <text x="37" y="42" text-anchor="middle" font-size="16" font-weight="600" fill="currentColor">${pctText}%</text>
  </svg>
  <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-size:12px;">
    <span style="display:inline-flex;flex-direction:column;line-height:1.15;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;opacity:0.6;">
      <span>Context</span>
      <span>Usage</span>
    </span>
    ${stats.join('\n    ')}
  </div>
</div>
`.trim();

  return html;
}

function stat(label: string, value: string): string {
  return (
    `<span style="display:inline-flex;align-items:baseline;gap:5px;">` +
    `<span style="opacity:0.6;">${escapeHtml(label)}</span>` +
    `<span style="font-weight:600;font-variant-numeric:tabular-nums;">${escapeHtml(value)}</span>` +
    `</span>`
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return String(n);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
