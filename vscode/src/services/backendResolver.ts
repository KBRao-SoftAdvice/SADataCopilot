import * as vscode from 'vscode';
import { BackendId } from './backends/types';

const VALID: ReadonlySet<BackendId> = new Set(['copilot', 'claude', 'cursor']);

/** Resolve which backend to use. Reads `copilotNotebook.backend` (workspace
 * setting) — the same value for every notebook in this VS Code instance.
 * `notebook` is accepted for API symmetry with the previous per-notebook
 * resolver but is otherwise unused. */
export function getNotebookBackend(_notebook?: vscode.NotebookDocument): BackendId {
  const v = vscode.workspace.getConfiguration('copilotNotebook').get<string>('backend');
  if (v && VALID.has(v as BackendId)) return v as BackendId;
  return 'copilot';
}

