import * as vscode from 'vscode';
import { SessionState } from '../types';
import * as http from 'http';

export class SessionStateService {
  private _port: number | undefined;
  private _interval: ReturnType<typeof setInterval> | undefined;
  private _state: SessionState = {
    cwd: '',
    turnCount: 0,
    totalCost: 0,
    opusCost: 0,
    sonnetCost: 0,
    excludedCount: 0,
    inputTokens: 0,
    contextWindow: 200000,
    model: '',
  };

  private _onUpdate = new vscode.EventEmitter<SessionState>();
  readonly onUpdate = this._onUpdate.event;

  setPort(port: number): void {
    this._port = port;
    this._startPolling();
  }

  get state(): SessionState {
    return this._state;
  }

  updateFromController(state: SessionState): void {
    this._state = state;
    this._onUpdate.fire(this._state);
  }

  private _startPolling(): void {
    if (this._interval) clearInterval(this._interval);
    this._poll();
    this._interval = setInterval(() => this._poll(), 3000);
  }

  private _poll(): void {
    if (!this._port) return;
    const req = http.get(`http://127.0.0.1:${this._port}/api/session`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          this._state = {
            cwd: parsed.cwd || '',
            turnCount: parsed.turnCount || 0,
            totalCost: parsed.totalCost || 0,
            opusCost: parsed.opusCost || 0,
            sonnetCost: parsed.sonnetCost || 0,
            excludedCount: parsed.excludedCount || 0,
            inputTokens: parsed.inputTokens || 0,
            contextWindow: parsed.contextWindow || 200000,
            model: parsed.model || '',
          };
          this._onUpdate.fire(this._state);
        } catch {
          // parse error
        }
      });
    });
    req.on('error', () => {});
    req.end();
  }

  dispose(): void {
    if (this._interval) clearInterval(this._interval);
    this._onUpdate.dispose();
  }
}
