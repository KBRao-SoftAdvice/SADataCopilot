import * as vscode from 'vscode';
import {
  METADATA_MODEL,
  METADATA_INCLUDED,
  METADATA_TOOL_CELL,
  METADATA_TOOL_NAME,
  METADATA_REASONING_EFFORT,
} from '../constants';
import { OutputInterceptor } from '../services/outputInterceptor';
import { getNotebookBackend } from '../services/backendResolver';
import { BackendId } from '../services/backends/types';

export class CellStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this._onDidChange.event;

  constructor(private readonly _interceptor: OutputInterceptor) {
    _interceptor.onExecUpdated(() => this._onDidChange.fire());
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const items: vscode.NotebookCellStatusBarItem[] = [];

    // Tool cells: show tool name badge only
    if (cell.metadata?.[METADATA_TOOL_CELL]) {
      const toolName = cell.metadata?.[METADATA_TOOL_NAME] || 'Tool';
      const icons: Record<string, string> = {
        'Bash': '$(terminal)',
        'Edit': '$(edit)',
        'Write': '$(new-file)',
        'Read': '$(file)',
      };
      const icon = icons[toolName] || '$(tools)';
      const item = new vscode.NotebookCellStatusBarItem(
        `${icon} ${toolName}`,
        vscode.NotebookCellStatusBarAlignment.Left
      );
      item.tooltip = `Tool call: ${toolName}`;
      items.push(item);
      return items;
    }

    // Only show Copilot UI for executable code cells (prompt or Python).
    // Markdown cells never participate in Copilot context, so no toggle.
    if (cell.kind !== vscode.NotebookCellKind.Code) return items;
    const isPrompt = isPromptCell(cell);
    const isPython = cell.document.languageId === 'python';
    if (!isPrompt && !isPython) return items;

    // Inclusion toggle (left) — applies to prompt and Python cells.
    // Uses semantic codicons that ship with theme colors (green / red).
    const included = cell.metadata?.[METADATA_INCLUDED] !== false;
    const toggleItem = new vscode.NotebookCellStatusBarItem(
      included ? '$(testing-passed-icon) Include' : '$(testing-failed-icon) Exclude',
      vscode.NotebookCellStatusBarAlignment.Left
    );
    toggleItem.command = 'copilot.toggleCellInclusion';
    toggleItem.tooltip = included
      ? 'Included in Copilot context — click to exclude'
      : 'Excluded from Copilot context — click to include';
    items.push(toggleItem);

    // Execution-order badge (left): monotonic counter — latest run has the
    // highest number, like Jupyter's [N] gutter. Hidden until the cell has
    // actually run. Shown on both prompt and python cells.
    const execIndex = this._interceptor.getExecIndex(cell.document.uri.toString());
    if (execIndex) {
      const orderItem = new vscode.NotebookCellStatusBarItem(
        `[${execIndex}]`,
        vscode.NotebookCellStatusBarAlignment.Left
      );
      orderItem.tooltip = `Execution order: ${execIndex}`;
      items.push(orderItem);
    }

    // Remaining items are prompt-cell-only
    if (!isPrompt) return items;

    // Model badge (right). Cursor backend is locked to Composer 2.5, so the
    // picker is hidden and a static label is shown. Copilot exposes the
    // GPT-5 mini / GPT-5.5 picker (with effort variants). Claude keeps the
    // Sonnet/Opus picker. Backend resolution is per-notebook.
    const backend = getNotebookBackend(cell.notebook);
    if (backend === 'cursor') {
      const item = new vscode.NotebookCellStatusBarItem(
        '$(sparkle) Composer',
        vscode.NotebookCellStatusBarAlignment.Right
      );
      item.tooltip = 'Cursor backend uses Composer 2.5';
      items.push(item);
    } else if (backend === 'claude') {
      const model = getPromptModel(cell, 'claude');
      const label = model === 'opus' ? 'Opus' : 'Sonnet';
      const modelItem = new vscode.NotebookCellStatusBarItem(
        `$(sparkle) ${label}`,
        vscode.NotebookCellStatusBarAlignment.Right
      );
      modelItem.command = 'copilot.pickModel';
      modelItem.tooltip = 'Click to switch model (Sonnet / Opus)';
      items.push(modelItem);
    } else {
      const copilotModel = getCopilotCellModel(cell);
      let label: string;
      let tooltip: string;
      if (copilotModel === 'gpt-5-mini') {
        label = 'GPT-5 mini';
        tooltip = 'Click to switch model (GPT-5 mini / GPT-5.5)';
      } else {
        const effort = getReasoningEffort(cell);
        label = `GPT-5.5 · ${EFFORT_LABEL[effort]}`;
        tooltip = 'Click to switch model (GPT-5 mini / GPT-5.5)';
      }
      const modelItem = new vscode.NotebookCellStatusBarItem(
        `$(sparkle) ${label}`,
        vscode.NotebookCellStatusBarAlignment.Right
      );
      modelItem.command = 'copilot.pickModel';
      modelItem.tooltip = tooltip;
      items.push(modelItem);
    }

    return items;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export type ReasoningEffortChoice = 'medium' | 'high' | 'xhigh';

export const EFFORT_LABEL: Record<ReasoningEffortChoice, string> = {
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

export type CopilotCellModel = 'gpt-5-mini' | 'gpt-5.5';

export function isPromptCell(cell: vscode.NotebookCell): boolean {
  if (cell.kind !== vscode.NotebookCellKind.Code) return false;
  if (cell.document.languageId === 'copilot-prompt') return true;
  const meta = cell.metadata?.[METADATA_MODEL];
  if (meta === 'opus' || meta === 'sonnet' || meta === 'gpt-5.5' || meta === 'gpt-5-mini') return true;
  if (cell.metadata?.[METADATA_REASONING_EFFORT]) return true;
  return cell.document.getText().startsWith('#%copilot:');
}

export function getPromptModel(cell: vscode.NotebookCell, backend: BackendId): string {
  if (backend === 'copilot') return getCopilotCellModel(cell);
  const meta = cell.metadata?.[METADATA_MODEL];
  if (meta === 'opus' || meta === 'sonnet') return meta;
  const source = cell.document.getText();
  if (source.startsWith('#%copilot:opus')) return 'opus';
  return 'sonnet';
}

export function getCopilotCellModel(cell: vscode.NotebookCell): CopilotCellModel {
  const meta = cell.metadata?.[METADATA_MODEL];
  if (meta === 'gpt-5.5') return 'gpt-5.5';
  return 'gpt-5-mini';
}

export function getReasoningEffort(cell: vscode.NotebookCell): ReasoningEffortChoice {
  const meta = cell.metadata?.[METADATA_REASONING_EFFORT];
  if (meta === 'medium' || meta === 'high' || meta === 'xhigh') return meta;
  return 'medium';
}

