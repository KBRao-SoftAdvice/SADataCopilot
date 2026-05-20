import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import * as os from 'os';

const HARNESS = `
import sys, json, traceback

_g = {'__name__': '__main__'}

def _emit(event):
    sys.__stdout__.write(json.dumps(event) + '\\n')
    sys.__stdout__.flush()

class _Stream:
    def __init__(self, name):
        self.name = name
    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if s:
            _emit({'type': 'stream', 'name': self.name, 'text': s})
        return len(s)
    def writelines(self, lines):
        for line in lines:
            self.write(line)
    def flush(self): pass
    def isatty(self): return False

sys.stdout = _Stream('stdout')
sys.stderr = _Stream('stderr')

_emit({'type': 'ready'})

for raw in sys.__stdin__:
    raw = raw.strip()
    if not raw:
        continue
    try:
        req = json.loads(raw)
    except Exception:
        continue
    code = req.get('code', '')
    rid = req.get('id', '')
    ok = True
    try:
        try:
            tree = compile(code, '<cell>', 'eval')
            result = eval(tree, _g)
            if result is not None:
                _emit({'type': 'stream', 'name': 'stdout', 'text': repr(result) + '\\n'})
        except SyntaxError:
            tree = compile(code, '<cell>', 'exec')
            exec(tree, _g)
    except KeyboardInterrupt:
        ok = False
        _emit({'type': 'stream', 'name': 'stderr', 'text': 'KeyboardInterrupt\\n'})
    except SystemExit:
        ok = False
    except BaseException:
        ok = False
        try:
            traceback.print_exc()
        except Exception:
            pass
    _emit({'type': 'done', 'id': rid, 'ok': ok})
`;

interface PendingRun {
  id: string;
  onStream: (name: 'stdout' | 'stderr', text: string) => Promise<void>;
  resolve: (ok: boolean) => void;
}

export class PythonRepl implements vscode.Disposable {
  private _proc: ChildProcessWithoutNullStreams | undefined;
  private _ready: Promise<void> | undefined;
  private _pending: PendingRun | undefined;
  private _disposed = false;

  constructor(private readonly _python: string, private readonly _cwd: string | undefined) {}

  private async _ensureStarted(): Promise<void> {
    if (this._proc && !this._proc.killed) {
      if (this._ready) await this._ready;
      return;
    }

    const proc = spawn(this._python, ['-u', '-c', HARNESS], {
      cwd: this._cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    this._proc = proc;

    this._ready = new Promise((resolve, reject) => {
      const lines = readline.createInterface({ input: proc.stdout });
      lines.on('line', (line) => this._handleLine(line, resolve));

      proc.stderr.on('data', (chunk: Buffer) => {
        // Harness errors before stdio replacement land here
        const text = chunk.toString('utf-8');
        if (this._pending) {
          void this._pending.onStream('stderr', text);
        }
      });

      proc.on('error', (err) => reject(err));
      proc.on('close', () => {
        this._proc = undefined;
        this._ready = undefined;
        if (this._pending) {
          this._pending.resolve(false);
          this._pending = undefined;
        }
      });
    });

    await this._ready;
  }

  private _handleLine(line: string, ready: () => void): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(event.type || '');
    if (type === 'ready') {
      ready();
    } else if (type === 'stream' && this._pending) {
      const name = event.name === 'stderr' ? 'stderr' : 'stdout';
      const text = String(event.text || '');
      void this._pending.onStream(name, text);
    } else if (type === 'done' && this._pending) {
      const ok = event.ok !== false;
      const pending = this._pending;
      this._pending = undefined;
      pending.resolve(ok);
    }
  }

  async run(
    code: string,
    onStream: (name: 'stdout' | 'stderr', text: string) => Promise<void>,
    token: vscode.CancellationToken
  ): Promise<{ ok: boolean; cancelled: boolean }> {
    if (this._disposed) return { ok: false, cancelled: true };
    await this._ensureStarted();
    if (!this._proc) return { ok: false, cancelled: false };

    if (this._pending) {
      // Should not happen — cells run sequentially — but guard anyway
      return { ok: false, cancelled: false };
    }

    const id = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    let cancelled = false;

    const cancel = token.onCancellationRequested(() => {
      cancelled = true;
      this._interrupt();
    });

    const ok = await new Promise<boolean>((resolve) => {
      this._pending = { id, onStream, resolve };
      this._proc!.stdin.write(JSON.stringify({ id, code }) + '\n');
    });

    cancel.dispose();
    return { ok, cancelled };
  }

  private _interrupt(): void {
    if (!this._proc) return;
    if (os.platform() === 'win32') {
      // SIGINT semantics differ on Windows; killing is the only reliable option
      this._proc.kill();
    } else {
      try {
        this._proc.kill('SIGINT');
      } catch {
        this._proc.kill();
      }
    }
  }

  dispose(): void {
    this._disposed = true;
    if (this._proc) {
      try { this._proc.kill(); } catch { /* ignore */ }
      this._proc = undefined;
    }
  }
}
