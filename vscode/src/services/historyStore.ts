import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CellRunRecord, CellRunKind } from './backends/types';
import { OutputInterceptor } from './outputInterceptor';

/** Persistable subset of NotebookStats. Kept in sync with that interface. */
export interface NotebookStatsSnapshot {
  totalCost: number;
  opusCost: number;
  sonnetCost: number;
  lastInputTokens: number;
  contextWindow: number;
  model: string;
}

interface SavedCell {
  /** Position in the notebook at save time. Used as a tiebreaker when
   * multiple cells share a sourceHash. */
  index: number;
  /** SHA-256 of the cell source, truncated. Used to re-attach a saved
   * record to the right cell after reload — survives reorders. */
  sourceHash: string;
  kind?: CellRunKind;
  source?: string;
  output?: string;
  /** Backend-opaque history blob. Whatever shape the backend stored at
   * run time gets round-tripped via JSON. */
  history?: unknown;
  execIndex?: number;
}

interface SidecarFile {
  version: 1;
  stats: NotebookStatsSnapshot;
  cells: SavedCell[];
}

/** Path for a notebook's sidecar history. Returns null for untitled
 * notebooks, which have no on-disk location. Works with any URI scheme
 * (local, vscode-remote://, etc.) since vscode.workspace.fs handles them. */
function sidecarUri(notebookUri: vscode.Uri): vscode.Uri | null {
  if (notebookUri.scheme === 'untitled') return null;
  return notebookUri.with({ path: notebookUri.path + '.copilot-history.json' });
}

function sourceHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export interface RehydrateResult {
  records: Map<string, CellRunRecord>;
  stats: NotebookStatsSnapshot;
}

/** Load the sidecar (if any) and re-attach saved entries to the live cells.
 * Matching prefers same-index + matching hash, then falls back to any
 * unused entry with a matching hash (handles reorders). Cells whose source
 * has changed since the last save get no record — they look unrun. */
export async function loadHistory(
  notebook: vscode.NotebookDocument,
  interceptor: OutputInterceptor
): Promise<RehydrateResult | null> {
  const uri = sidecarUri(notebook.uri);
  if (!uri) return null;
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return null;
  }
  let data: SidecarFile;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!data || data.version !== 1 || !Array.isArray(data.cells)) return null;

  const records = new Map<string, CellRunRecord>();
  const used = new Set<number>();
  for (let i = 0; i < notebook.cellCount; i++) {
    const cell = notebook.cellAt(i);
    const hash = sourceHash(cell.document.getText());
    let chosen = -1;
    // Prefer the entry that was saved at this same index, if its hash matches.
    const sameIdxPos = data.cells.findIndex((c) => c.index === i);
    if (sameIdxPos !== -1 && data.cells[sameIdxPos].sourceHash === hash && !used.has(sameIdxPos)) {
      chosen = sameIdxPos;
    } else {
      for (let j = 0; j < data.cells.length; j++) {
        if (used.has(j)) continue;
        if (data.cells[j].sourceHash === hash) { chosen = j; break; }
      }
    }
    if (chosen < 0) continue;
    used.add(chosen);
    const entry = data.cells[chosen];
    if (entry.kind && entry.source !== undefined) {
      records.set(cell.document.uri.toString(), {
        cellUri: cell.document.uri.toString(),
        kind: entry.kind,
        source: entry.source,
        output: entry.output ?? '',
        // `included` is re-derived from live metadata at use time; the
        // saved value would be stale anyway.
        included: true,
        history: entry.history,
      });
    }
    if (entry.execIndex) {
      interceptor.setExecIndex(cell.document.uri.toString(), entry.execIndex);
    }
  }
  return { records, stats: data.stats };
}

/** Write the sidecar. Walks the live notebook so cell indices and hashes
 * reflect the current document, not the in-memory record's stale URI. */
export async function saveHistory(
  notebook: vscode.NotebookDocument,
  records: Map<string, CellRunRecord>,
  interceptor: OutputInterceptor,
  stats: NotebookStatsSnapshot
): Promise<void> {
  const uri = sidecarUri(notebook.uri);
  if (!uri) return;
  const cells: SavedCell[] = [];
  for (let i = 0; i < notebook.cellCount; i++) {
    const cell = notebook.cellAt(i);
    const cellUri = cell.document.uri.toString();
    const record = records.get(cellUri);
    const execIndex = interceptor.getExecIndex(cellUri);
    if (!record && !execIndex) continue;
    cells.push({
      index: i,
      sourceHash: sourceHash(cell.document.getText()),
      kind: record?.kind,
      source: record?.source,
      output: record?.output,
      history: record?.history,
      execIndex,
    });
  }
  const data: SidecarFile = { version: 1, stats, cells };
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(data, null, 2)));
  } catch (err) {
    console.error('Copilot Notebook: failed to write history sidecar', err);
  }
}
