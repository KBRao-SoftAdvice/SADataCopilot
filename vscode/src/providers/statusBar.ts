import * as vscode from 'vscode';
import { SessionStateService } from '../services/sessionState';
import { SessionState } from '../types';

export class SessionStatusBar implements vscode.Disposable {
  private _ctxItem: vscode.StatusBarItem;
  private _costItem: vscode.StatusBarItem;
  private _sub: vscode.Disposable;

  constructor(sessionState: SessionStateService) {
    this._ctxItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1001);
    this._ctxItem.name = 'Claude Context';
    this._costItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this._costItem.name = 'Claude Cost';
    this._sub = sessionState.onUpdate((s) => this._render(s));
    if (sessionState.state.contextWindow) this._render(sessionState.state);
  }

  private _render(s: SessionState): void {
    const used = s.inputTokens || 0;
    const win = s.contextWindow || 200000;
    const pct = Math.min(used / win, 1);
    const pctText = Math.round(pct * 100) + '%';
    const cost = (s.totalCost || 0).toFixed(4);

    this._ctxItem.text = `Context: ${pctText}`;
    this._ctxItem.tooltip = new vscode.MarkdownString(
      `${used.toLocaleString()} / ${win.toLocaleString()} tokens`
    );
    this._ctxItem.show();

    this._costItem.text = `Cost: $${cost}`;
    this._costItem.tooltip = new vscode.MarkdownString(`$${cost}`);
    this._costItem.show();
  }

  dispose(): void {
    this._sub.dispose();
    this._ctxItem.dispose();
    this._costItem.dispose();
  }
}
