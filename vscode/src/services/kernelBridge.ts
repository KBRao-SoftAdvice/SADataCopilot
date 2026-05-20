import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { PythonRepl } from './pythonRepl';

interface Registration {
  repl: PythonRepl;
  onRun?: (code: string, output: string, ok: boolean) => void;
}

/**
 * Localhost HTTP bridge that lets the spawned MCP stdio server forward
 * python_run tool calls back into the live notebook PythonRepl.
 *
 * One bridge per extension activation. Each prompt-cell execution registers a
 * one-time bearer token mapped to the notebook's REPL; the MCP child receives
 * the URL + token via env vars. Unregister when the prompt run completes so a
 * leaked token can't be reused later.
 */
export class KernelBridge implements vscode.Disposable {
  private _server: http.Server | undefined;
  private _port = 0;
  private _registrations = new Map<string, Registration>();
  private _starting: Promise<void> | undefined;

  async start(): Promise<{ url: string }> {
    if (!this._starting) {
      this._starting = new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => this._handle(req, res));
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (typeof addr === 'object' && addr) {
            this._port = addr.port;
            this._server = server;
            resolve();
          } else {
            reject(new Error('Bridge failed to bind'));
          }
        });
      });
    }
    await this._starting;
    return { url: `http://127.0.0.1:${this._port}` };
  }

  register(reg: Registration): string {
    const token = crypto.randomBytes(24).toString('hex');
    this._registrations.set(token, reg);
    return token;
  }

  unregister(token: string): void {
    this._registrations.delete(token);
  }

  private _handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/run') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const reg = this._registrations.get(token);
    if (!reg) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      let code = '';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { code?: unknown };
        if (typeof body.code !== 'string') throw new Error('code must be a string');
        code = body.code;
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }

      let output = '';
      const cancelToken = new vscode.CancellationTokenSource();
      try {
        const { ok } = await reg.repl.run(
          code,
          async (_name, text) => { output += text; },
          cancelToken.token
        );
        reg.onRun?.(code, output, ok);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok, output }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      } finally {
        cancelToken.dispose();
      }
    });
  }

  dispose(): void {
    this._registrations.clear();
    if (this._server) {
      this._server.close();
      this._server = undefined;
    }
  }
}
