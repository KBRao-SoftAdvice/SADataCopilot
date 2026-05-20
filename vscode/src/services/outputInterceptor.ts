import * as vscode from 'vscode';

export class OutputInterceptor {
  private _onPort = new vscode.EventEmitter<number>();
  readonly onPortDiscovered = this._onPort.event;

  private _onTokens = new vscode.EventEmitter<void>();
  readonly onTokensUpdated = this._onTokens.event;

  private _tokenMap = new Map<string, number>();

  getTokens(cellUri: string): number | undefined {
    return this._tokenMap.get(cellUri);
  }

  setTokens(cellUri: string, tokens: number): void {
    if (tokens <= 0) return;
    this._tokenMap.set(cellUri, tokens);
    this._onTokens.fire();
  }

  dispose(): void {
    this._onPort.dispose();
    this._onTokens.dispose();
  }
}
