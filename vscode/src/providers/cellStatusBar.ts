import * as vscode from 'vscode';
import { METADATA_MODEL, METADATA_INCLUDED, METADATA_TOOL_CELL, METADATA_TOOL_NAME } from '../constants';
import { OutputInterceptor } from '../services/outputInterceptor';

export class CellStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this._onDidChange.event;

  constructor(private readonly _interceptor: OutputInterceptor) {
    _interceptor.onTokensUpdated(() => this._onDidChange.fire());
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

    // Only show Claude UI for executable code cells (prompt or Python).
    // Markdown cells never participate in Claude context, so no toggle.
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
    toggleItem.command = 'claude.toggleCellInclusion';
    toggleItem.tooltip = included
      ? 'Included in Claude context — click to exclude'
      : 'Excluded from Claude context — click to include';
    items.push(toggleItem);

    // Remaining items are prompt-cell-only
    if (!isPrompt) return items;

    // Token count (left) — always visible, shows — before execution
    const tokens = this._interceptor.getTokens(cell.document.uri.toString());
    const tokenLabel = tokens && tokens > 0 ? formatTokens(tokens) : '—';
    const tokenItem = new vscode.NotebookCellStatusBarItem(
      `$(symbol-number) ${tokenLabel}`,
      vscode.NotebookCellStatusBarAlignment.Left
    );
    tokenItem.tooltip = tokens ? `${tokens.toLocaleString()} tokens (cell contribution)` : 'No token data yet';
    items.push(tokenItem);

    // Model picker (right) — Sonnet or Opus
    const model = getPromptModel(cell);
    const label = model === 'opus' ? 'Opus' : 'Sonnet';
    const modelItem = new vscode.NotebookCellStatusBarItem(
      `$(sparkle) ${label}`,
      vscode.NotebookCellStatusBarAlignment.Right
    );
    modelItem.command = 'claude.pickModel';
    modelItem.tooltip = 'Click to switch model (Sonnet / Opus)';
    items.push(modelItem);

    return items;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export function isPromptCell(cell: vscode.NotebookCell): boolean {
  if (cell.kind !== vscode.NotebookCellKind.Code) return false;
  if (cell.document.languageId === 'claude-prompt') return true;
  if (cell.metadata?.[METADATA_MODEL] === 'opus' || cell.metadata?.[METADATA_MODEL] === 'sonnet') {
    return true;
  }
  return cell.document.getText().startsWith('#%claude:');
}

export function getPromptModel(cell: vscode.NotebookCell): string {
  const meta = cell.metadata?.[METADATA_MODEL];
  if (meta === 'opus' || meta === 'sonnet') return meta;
  const source = cell.document.getText();
  if (source.startsWith('#%claude:opus')) return 'opus';
  return 'sonnet';
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}
