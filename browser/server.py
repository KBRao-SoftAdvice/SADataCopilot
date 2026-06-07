#!/usr/bin/env python3
"""
Backend for SADataCopilot Notebook (browser).

Bridges the browser to:
- a Python kernel (subprocess REPL, one per session)
- a long-lived Node sidecar that drives @github/copilot-sdk against an
  OpenAI-compatible endpoint. The sidecar reaches back into the user's
  kernel via a localhost HTTP bridge for the python_run tool.

Endpoints:
  GET  /api/health
  GET  /api/files?kernelId=...       list files in the session workspace
  POST /api/python/exec              { kernelId, code } -> { ok, output }
  POST /api/run                      SSE stream of agent events
  POST /api/keepalive                { kernelId } -> { alive }
  POST /api/kernel-bridge/run        (called by sidecar) bearer-token
"""

import http.server
import socketserver
import json
import os
import re
import base64
import secrets
import hmac
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import shutil

PORT = 8787
HERE = os.path.dirname(os.path.abspath(__file__))
# Shared-secret auth gate. Set NOTEBOOK_TOKEN to a known value before
# exposing this server publicly (tunnel etc); otherwise we generate one at
# startup and print it so single-user local dev still works without env.
ACCESS_TOKEN = os.environ.get("NOTEBOOK_TOKEN") or secrets.token_urlsafe(24)
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
# Per-session scratch dirs live under here. Each kernel id gets its own
# subdir; deleted when the kernel is reaped or the server shuts down.
WORKSPACES_ROOT = os.path.join(HERE, ".workspaces")
os.makedirs(WORKSPACES_ROOT, exist_ok=True)
UUID_RE = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
MCP_SERVER_PATH = os.path.join(HERE, "mcp", "python_server.py")

PYTHON_BIN = os.environ.get("CLAUDE_NOTEBOOK_PYTHON") or os.environ.get("PYTHON") or sys.executable


# ---------------------------------------------------------------------------
# Python REPL kernel
# ---------------------------------------------------------------------------

HARNESS = r"""
import sys, json, traceback

_g = {'__name__': '__main__'}

def _emit(event):
    sys.__stdout__.write(json.dumps(event) + '\n')
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
                _emit({'type': 'stream', 'name': 'stdout', 'text': repr(result) + '\n'})
        except SyntaxError:
            tree = compile(code, '<cell>', 'exec')
            exec(tree, _g)
    except KeyboardInterrupt:
        ok = False
        _emit({'type': 'stream', 'name': 'stderr', 'text': 'KeyboardInterrupt\n'})
    except SystemExit:
        ok = False
    except BaseException:
        ok = False
        try:
            traceback.print_exc()
        except Exception:
            pass
    _emit({'type': 'done', 'id': rid, 'ok': ok})
"""


class PythonKernel:
    """One persistent Python subprocess per kernel id. Run requests are
    serialized with a lock so MCP-driven runs don't interleave with cell runs."""

    def __init__(self, kernel_id, cwd=None):
        self.kernel_id = kernel_id
        self.cwd = cwd or os.getcwd()
        self._proc = None
        self._lock = threading.Lock()
        self._start()

    def _start(self):
        self._proc = subprocess.Popen(
            [PYTHON_BIN, "-u", "-c", HARNESS],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=self.cwd,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        # Wait for ready
        line = self._proc.stdout.readline()
        try:
            event = json.loads(line)
            if event.get("type") != "ready":
                raise RuntimeError("Python kernel didn't signal ready: " + line)
        except json.JSONDecodeError:
            raise RuntimeError("Python kernel garbled startup: " + line)

    def run(self, code):
        if self._proc is None or self._proc.poll() is not None:
            self._start()
        with self._lock:
            rid = "r" + secrets.token_hex(4)
            self._proc.stdin.write(json.dumps({"id": rid, "code": code}) + "\n")
            self._proc.stdin.flush()
            output = []
            ok = True
            while True:
                line = self._proc.stdout.readline()
                if not line:
                    return {"ok": False, "output": "(kernel died)"}
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = event.get("type")
                if t == "stream":
                    output.append(event.get("text", ""))
                elif t == "done":
                    if event.get("id") == rid:
                        ok = bool(event.get("ok", False))
                        break
            return {"ok": ok, "output": "".join(output)}

    def dispose(self):
        if self._proc:
            try:
                self._proc.terminate()
            except Exception:
                pass
            self._proc = None


KERNELS = {}
KERNELS_LOCK = threading.Lock()
# kernel_id -> monotonic seconds of the last ping/use. Stale kernels are
# disposed by the reaper thread below. We start the timer on creation so a
# kernel that's never used still gets cleaned up if its tab vanishes.
KERNEL_LAST_SEEN = {}
# kernel_id -> absolute workspace path. Created lazily on first use; rmtree'd
# when the kernel is reaped.
KERNEL_WORKSPACE = {}
KERNEL_IDLE_TIMEOUT_SEC = 90  # disposed if no ping/use within this window


def _touch_kernel(kernel_id):
    KERNEL_LAST_SEEN[kernel_id] = time.monotonic()


def get_workspace(kernel_id):
    """Return the per-session workspace dir, creating it on first call.
    All file I/O (Python kernel cwd, claude tool calls, MCP children) is
    confined here via OS-level sandboxing."""
    ws = KERNEL_WORKSPACE.get(kernel_id)
    if ws and os.path.isdir(ws):
        return ws
    ws = os.path.join(WORKSPACES_ROOT, kernel_id)
    os.makedirs(ws, exist_ok=True)
    KERNEL_WORKSPACE[kernel_id] = ws
    return ws


def get_kernel(kernel_id):
    with KERNELS_LOCK:
        kernel = KERNELS.get(kernel_id)
        if not kernel:
            ws = get_workspace(kernel_id)
            kernel = PythonKernel(kernel_id, cwd=ws)
            KERNELS[kernel_id] = kernel
        _touch_kernel(kernel_id)
        return kernel


def keepalive_kernel(kernel_id):
    """Mark a kernel as still in use without spawning one. Called by the
    browser's periodic ping; if the kernel doesn't exist (e.g. server was
    just restarted), do nothing — the next exec call will recreate it."""
    with KERNELS_LOCK:
        if kernel_id in KERNELS:
            _touch_kernel(kernel_id)
            return True
        return False


def _reap_stale_kernels():
    """Background thread: dispose kernels whose last ping/use is older than
    KERNEL_IDLE_TIMEOUT_SEC. Catches tab refresh, tab close, browser crash —
    anything that stops the keepalive pings. Also rmtrees the per-session
    workspace dir so idle scratch space doesn't accumulate."""
    while True:
        time.sleep(15)
        cutoff = time.monotonic() - KERNEL_IDLE_TIMEOUT_SEC
        stale = []
        with KERNELS_LOCK:
            for kid, last in list(KERNEL_LAST_SEEN.items()):
                if last < cutoff:
                    stale.append(kid)
            for kid in stale:
                kernel = KERNELS.pop(kid, None)
                KERNEL_LAST_SEEN.pop(kid, None)
                ws = KERNEL_WORKSPACE.pop(kid, None)
                if kernel:
                    try:
                        kernel.dispose()
                    except Exception:
                        pass
                if ws and os.path.isdir(ws):
                    try:
                        shutil.rmtree(ws, ignore_errors=True)
                    except Exception:
                        pass
        if stale:
            sys.stdout.write("[notebook] reaped {} idle kernel(s)\n".format(len(stale)))


threading.Thread(target=_reap_stale_kernels, daemon=True).start()


# ---------------------------------------------------------------------------
# Kernel bridge (bearer-token registrations)
# ---------------------------------------------------------------------------

BRIDGE_REGISTRATIONS = {}
BRIDGE_LOCK = threading.Lock()


def bridge_register(kernel_id):
    token = secrets.token_hex(24)
    with BRIDGE_LOCK:
        BRIDGE_REGISTRATIONS[token] = kernel_id
    return token


def bridge_lookup(token):
    with BRIDGE_LOCK:
        return BRIDGE_REGISTRATIONS.get(token)


def bridge_unregister(token):
    with BRIDGE_LOCK:
        BRIDGE_REGISTRATIONS.pop(token, None)


# ---------------------------------------------------------------------------
# Sidecar manager (one long-lived Node process per server)
# ---------------------------------------------------------------------------
#
# Protocol on the sidecar's stdio: one JSON object per line in each direction.
# Request:  {"requestId", "prompt", "model", "kernelId"}
# Response: stream of {"requestId", "type": "event"|"end"|"error", ...}
#
# A single shared bridge token is registered with the sidecar at spawn time so
# the python_run tool can call back without per-request token plumbing.

SIDECAR_PATH = os.path.join(HERE, "sidecar.mjs")
NODE_BIN = os.environ.get("NODE_BIN", "node")

_SIDECAR_PROC = None
_SIDECAR_BRIDGE_TOKEN = None
_SIDECAR_LOCK = threading.Lock()
# requestId -> queue.Queue of dict events from the sidecar.
_SIDECAR_INBOX = {}
_SIDECAR_INBOX_LOCK = threading.Lock()


def _sidecar_route_kernel_for_token(token):
    """The sidecar uses a single shared bridge token (set at spawn) but each
    request specifies its own kernelId in the python_run tool args, which the
    sidecar relays through. Look up the token's "default" kernel — actually
    unused now since the sidecar passes kernelId in the bridge POST body."""
    return None


def _sidecar_start():
    global _SIDECAR_PROC, _SIDECAR_BRIDGE_TOKEN
    if _SIDECAR_PROC and _SIDECAR_PROC.poll() is None:
        return
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        raise RuntimeError("OPENAI_API_KEY must be set")

    # Shared token used by the sidecar's python_run tool to authenticate to
    # /api/kernel-bridge/run. Register with kernel_id="" — the bridge handler
    # will look at the request body's kernelId instead.
    _SIDECAR_BRIDGE_TOKEN = secrets.token_hex(24)
    with BRIDGE_LOCK:
        BRIDGE_REGISTRATIONS[_SIDECAR_BRIDGE_TOKEN] = "*"  # wildcard: trust body's kernelId

    env = dict(os.environ)
    env["OPENAI_API_KEY"] = openai_key
    env["KERNEL_BRIDGE_URL"] = "http://127.0.0.1:" + str(PORT) + "/api/kernel-bridge/run"
    env["KERNEL_BRIDGE_TOKEN"] = _SIDECAR_BRIDGE_TOKEN

    sys.stdout.write("[sidecar] spawning {} {}\n".format(NODE_BIN, SIDECAR_PATH))
    sys.stdout.flush()
    _SIDECAR_PROC = subprocess.Popen(
        [NODE_BIN, SIDECAR_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=HERE,
        env=env,
        bufsize=1,
    )

    def _read_stdout():
        for line in _SIDECAR_PROC.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                sys.stdout.write("[sidecar] non-json stdout: {}\n".format(line[:200]))
                sys.stdout.flush()
                continue
            req_id = msg.get("requestId")
            if not req_id:
                continue
            with _SIDECAR_INBOX_LOCK:
                q = _SIDECAR_INBOX.get(req_id)
            if q is not None:
                q.put(msg)

    def _read_stderr():
        for line in _SIDECAR_PROC.stderr:
            sys.stdout.write("[sidecar:err] " + line)
            sys.stdout.flush()

    threading.Thread(target=_read_stdout, daemon=True).start()
    threading.Thread(target=_read_stderr, daemon=True).start()


def _sidecar_send(payload):
    with _SIDECAR_LOCK:
        if not _SIDECAR_PROC or _SIDECAR_PROC.poll() is not None:
            _sidecar_start()
        _SIDECAR_PROC.stdin.write(json.dumps(payload) + "\n")
        _SIDECAR_PROC.stdin.flush()


def _sidecar_register_request(req_id):
    import queue as _queue
    q = _queue.Queue()
    with _SIDECAR_INBOX_LOCK:
        _SIDECAR_INBOX[req_id] = q
    return q


def _sidecar_unregister_request(req_id):
    with _SIDECAR_INBOX_LOCK:
        _SIDECAR_INBOX.pop(req_id, None)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_valid_uuid(s):
    return bool(UUID_RE.match(s))


def get_project_dir(cwd):
    """Map a working directory to its `~/.claude/projects/<safe-cwd>/` slot.
    Claude's session store slugifies the cwd by replacing every `/` AND every
    `.` with `-` (so `/foo/.workspaces/x` becomes `-foo--workspaces-x`).
    Replacing only `/` puts our seeded JSONL in a sibling directory and
    `--resume` then errors with "No conversation found with session ID"."""
    safe_cwd = cwd.replace("/", "-").replace(".", "-")
    d = os.path.join(PROJECTS_DIR, safe_cwd)
    os.makedirs(d, exist_ok=True)
    return d


def _append_synthetic_turn(lines, parent_uuid, user_text, assistant_text, session_id, cwd):
    """Append a (user, assistant) pair narrating a non-prompt cell. Returns
    the new tail uuid. Mirrors vscode appendSyntheticTurn."""
    ts = datetime.now(timezone.utc).isoformat()
    user_uuid = str(uuid.uuid4())
    lines.append({
        "parentUuid": parent_uuid,
        "isSidechain": False,
        "type": "user",
        "uuid": user_uuid,
        "timestamp": ts,
        "sessionId": session_id,
        "message": {"role": "user", "content": user_text},
        "permissionMode": "default",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": cwd,
        "version": "2.1.143",
        "gitBranch": "HEAD",
    })
    assistant_uuid = str(uuid.uuid4())
    lines.append({
        "parentUuid": user_uuid,
        "isSidechain": False,
        "type": "assistant",
        "uuid": assistant_uuid,
        "timestamp": ts,
        "sessionId": session_id,
        "message": {
            "model": "claude-opus-4-6",
            "id": "msg_synth_" + assistant_uuid[:8],
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": assistant_text}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": max(1, len(assistant_text) // 4)},
        },
    })
    return assistant_uuid


def _python_narration(index, source, output):
    return (
        "Python cell {} (executed in this notebook):\n".format(index + 1) +
        "```python\n" + source + "\n```\n" +
        "Output:\n```\n" + (output or "(no output)") + "\n```"
    )


def build_session_jsonl(prior_turns, session_id, cwd):
    """Build a session JSONL from structured prior turns. Mirrors vscode's
    ClaudeBackend._buildSession: prompt cells splice their captured stream-
    json messages with parentUuid relinked across the gap; python and
    markdown cells synthesize a (user, assistant) narration pair."""
    lines = []

    lines.append({
        "type": "permission-mode",
        "permissionMode": "default",
        "sessionId": session_id,
    })

    last_uuid = None
    for i, turn in enumerate(prior_turns):
        kind = turn.get("kind")
        if kind == "python":
            user_text = _python_narration(i, turn.get("source", ""), turn.get("output", ""))
            last_uuid = _append_synthetic_turn(
                lines, last_uuid, user_text, "(noted — Python state recorded)", session_id, cwd,
            )
        elif kind == "markdown":
            user_text = "Notebook context:\n" + turn.get("source", "")
            last_uuid = _append_synthetic_turn(
                lines, last_uuid, user_text, "(noted)", session_id, cwd,
            )
        elif kind == "prompt":
            messages = turn.get("messages") or []
            for j, m in enumerate(messages):
                if not isinstance(m, dict):
                    continue
                cloned = dict(m)
                cloned["sessionId"] = session_id
                if j == 0 and last_uuid and cloned.get("uuid"):
                    cloned["parentUuid"] = last_uuid
                if cloned.get("uuid"):
                    last_uuid = cloned["uuid"]
                lines.append(cloned)

    lines.append({
        "type": "last-prompt",
        "leafUuid": last_uuid or "",
        "sessionId": session_id,
    })

    return "\n".join(json.dumps(l) for l in lines) + "\n"


def build_preamble():
    return (
        "You are answering inside a notebook prompt cell. To work with Python, "
        "use the python_run tool: it executes code in the live notebook kernel "
        "and returns stdout/stderr to you. The kernel shares the same namespace "
        "as the user's Python cells, so variables like `df` defined earlier "
        "are available. Use python_run whenever you need to inspect data, "
        "check shapes/values, or compute something to reason about. Side "
        "effects persist - prefer non-mutating queries unless the user "
        "explicitly asks you to change state."
    )


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class NotebookHandler(http.server.SimpleHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def _is_authed(self):
        """True if the request carries valid HTTP Basic credentials. The
        username is ignored; only the password is checked, with a
        constant-time compare so timing leaks don't help an attacker."""
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(auth[len("Basic "):]).decode("utf-8")
        except Exception:
            return False
        # Username is ignored — only the password matters. Browsers send
        # whatever the user typed in the username field; we accept anything.
        _, _, password = decoded.partition(":")
        return hmac.compare_digest(password, ACCESS_TOKEN)

    def _challenge_basic_auth(self):
        """Send a 401 with `WWW-Authenticate: Basic` so the browser shows
        its native username/password popup. Browsers cache the credentials
        per-origin until the tab/window is closed."""
        self.send_response(401)
        self._cors()
        self.send_header("WWW-Authenticate", 'Basic realm="SADataCopilot"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Authentication required")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        # Health is open so a tunnel/proxy can probe liveness without auth.
        if path == "/api/health":
            self._json_response({"ok": True})
            return
        if not self._is_authed():
            self._challenge_basic_auth()
            return
        if path == "/api/files":
            qs = parse_qs(parsed.query or "")
            self._list_files(qs.get("kernelId", [""])[0])
        else:
            self.directory = HERE
            super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        # MCP bridge is local-only (called by the python_server child) and
        # validates its own bridge_token; don't gate on the access token.
        if path == "/api/kernel-bridge/run":
            body = self._read_body()
            self._kernel_bridge_run(body)
            return
        if not self._is_authed():
            self._challenge_basic_auth()
            return
        if path == "/api/run":
            # streamed; do not pre-read body via _read_body chunked
            self._run_sidecar_stream()
            return
        body = self._read_body()
        if path == "/api/python/exec":
            self._exec_python(body)
        elif path == "/api/keepalive":
            self._keepalive(body)
        else:
            self.send_error(404)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json_response(self, data, status=200):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    # -- python kernel exec --------------------------------------------------

    def _exec_python(self, body):
        kernel_id = body.get("kernelId", "")
        code = body.get("code", "")
        if not kernel_id:
            self._json_response({"error": "kernelId required"}, 400)
            return
        if not isinstance(code, str):
            self._json_response({"error": "code must be a string"}, 400)
            return
        try:
            kernel = get_kernel(kernel_id)
            result = kernel.run(code)
            self._json_response(result)
        except Exception as e:
            self._json_response({"error": str(e)}, 500)

    def _list_files(self, kernel_id):
        """List the workspace tree for the given kernel. Returns a flat
        list of `{ path, type, size }` entries (path relative to workspace
        root). Skips dotfiles and the `.claude` project sidecar dir so the
        sidebar doesn't get cluttered with session JSONL state."""
        if not kernel_id:
            self._json_response({"error": "kernelId required"}, 400)
            return
        ws = KERNEL_WORKSPACE.get(kernel_id)
        if not ws or not os.path.isdir(ws):
            # No workspace yet — kernel hasn't been spawned. Return empty
            # rather than 404 so the sidebar can render an empty state.
            self._json_response({"workspace": "", "files": []})
            return
        entries = []
        for dirpath, dirnames, filenames in os.walk(ws):
            # Filter dotdirs in-place so os.walk doesn't descend into them.
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            rel_dir = os.path.relpath(dirpath, ws)
            for d in dirnames:
                rel = d if rel_dir == "." else os.path.join(rel_dir, d)
                entries.append({"path": rel, "type": "dir"})
            for f in filenames:
                if f.startswith("."):
                    continue
                rel = f if rel_dir == "." else os.path.join(rel_dir, f)
                try:
                    size = os.path.getsize(os.path.join(dirpath, f))
                except OSError:
                    size = 0
                entries.append({"path": rel, "type": "file", "size": size})
        entries.sort(key=lambda e: (e["type"] != "dir", e["path"].lower()))
        self._json_response({"workspace": ws, "files": entries})

    def _keepalive(self, body):
        # Browser pings this every ~30s with its kernel id. The reaper
        # disposes any kernel that hasn't been touched within
        # KERNEL_IDLE_TIMEOUT_SEC. `alive` tells the client whether the
        # kernel still exists server-side; a fresh `false` means the next
        # python exec will spawn a new one (and reset all REPL state).
        kernel_id = body.get("kernelId", "")
        if not kernel_id:
            self._json_response({"error": "kernelId required"}, 400)
            return
        alive = keepalive_kernel(kernel_id)
        self._json_response({"alive": alive})

    def _kernel_bridge_run(self, body):
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        registered = bridge_lookup(token)
        if not registered:
            sys.stdout.write("[bridge] UNAUTHORIZED token_prefix={!r}\n".format(token[:8]))
            sys.stdout.flush()
            self._json_response({"error": "unauthorized"}, 401)
            return
        # Wildcard registration ("*") = sidecar token; body must specify kernelId.
        # Per-kernel registration = legacy single-kernel binding.
        kernel_id = body.get("kernelId", "") if registered == "*" else registered
        if not kernel_id:
            self._json_response({"error": "kernelId required"}, 400)
            return
        code = body.get("code", "")
        if not isinstance(code, str):
            self._json_response({"error": "code must be a string"}, 400)
            return
        sys.stdout.write("[bridge] kernel={} run({} chars)\n".format(kernel_id, len(code)))
        sys.stdout.flush()
        try:
            kernel = get_kernel(kernel_id)
            result = kernel.run(code)
            sys.stdout.write("[bridge] kernel={} done ok={}\n".format(
                kernel_id, result.get("ok") if isinstance(result, dict) else "?"))
            sys.stdout.flush()
            self._json_response(result)
        except Exception as e:
            sys.stdout.write("[bridge] kernel={} EXCEPTION {}: {}\n".format(
                kernel_id, type(e).__name__, e))
            sys.stdout.flush()
            self._json_response({"error": str(e)}, 500)

    # -- agent run (streaming via sidecar) ----------------------------------

    def _run_sidecar_stream(self):
        body = self._read_body()
        prompt = body.get("prompt", "")
        kernel_id = body.get("kernelId", "")
        model = body.get("model", "") or "gpt-5-mini"
        is_excluded = bool(body.get("isExcluded", False))
        prior_runs = body.get("priorRuns", []) or []

        run_id = uuid.uuid4().hex[:8]
        def rlog(msg):
            sys.stdout.write("[run {}] {}\n".format(run_id, msg))
            sys.stdout.flush()

        rlog("ENTER kernel={} model={!r} prompt={!r}".format(
            kernel_id, model, prompt[:80]))

        if not prompt:
            self._json_response({"error": "prompt is required"}, 400)
            return
        if not kernel_id:
            self._json_response({"error": "kernelId is required"}, 400)
            return

        # Ensure workspace exists so the kernel + python_run share state.
        get_workspace(kernel_id)

        # SSE stream
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def emit(event_type, data):
            try:
                payload = "event: " + event_type + "\n"
                payload += "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"
                self.wfile.write(payload.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

        try:
            _sidecar_start()
        except Exception as e:
            rlog("sidecar start failed: {}".format(e))
            emit("error", {"message": "sidecar unavailable: " + str(e)})
            emit("end", {})
            return

        request_id = uuid.uuid4().hex
        inbox = _sidecar_register_request(request_id)
        emit("start", {"sessionId": request_id})
        rlog("sending to sidecar requestId={}".format(request_id))

        try:
            _sidecar_send({
                "requestId": request_id,
                "prompt": prompt,
                "model": model,
                "kernelId": kernel_id,
                "isExcluded": is_excluded,
                "priorRuns": prior_runs,
                "workspace": get_workspace(kernel_id),
            })
        except Exception as e:
            rlog("sidecar send failed: {}".format(e))
            emit("error", {"message": "sidecar send failed: " + str(e)})
            emit("end", {})
            _sidecar_unregister_request(request_id)
            return

        end_payload = None
        try:
            while True:
                try:
                    msg = inbox.get(timeout=600)
                except Exception:
                    rlog("TIMEOUT waiting for sidecar")
                    emit("error", {"message": "sidecar timed out"})
                    break
                mtype = msg.get("type")
                if mtype == "event":
                    emit("event", msg.get("event") or {})
                elif mtype == "error":
                    emit("error", {"message": msg.get("message") or "unknown sidecar error"})
                elif mtype == "end":
                    end_payload = msg.get("result") or {}
                    break
        finally:
            _sidecar_unregister_request(request_id)

        emit("end", {
            "sessionId": request_id,
            "result": end_payload or {},
        })
        rlog("EXIT")

    def log_message(self, format, *args):
        msg = (args[0] if args else "")
        # Skip noisy SSE chunk logs
        sys.stdout.write("[notebook] " + str(msg) + "\n")


if __name__ == "__main__":
    os.chdir(HERE)
    bind_host = os.environ.get("NOTEBOOK_HOST", "127.0.0.1")
    server = ThreadedHTTPServer((bind_host, PORT), NotebookHandler)
    print("SADataCopilot browser notebook running at http://localhost:" + str(PORT) + "/notebook.html", flush=True)
    if "NOTEBOOK_TOKEN" not in os.environ:
        print("[auth] No NOTEBOOK_TOKEN set; generated one for this run.", flush=True)
    print("[auth] Browser will prompt for a username/password.", flush=True)
    print("[auth] Username: anything (e.g. 'admin')", flush=True)
    print("[auth] Password: " + ACCESS_TOKEN, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        for k in list(KERNELS.values()):
            try:
                k.dispose()
            except Exception:
                pass
        # Wipe every per-session workspace dir on shutdown.
        for ws in list(KERNEL_WORKSPACE.values()):
            if ws and os.path.isdir(ws):
                shutil.rmtree(ws, ignore_errors=True)
        server.shutdown()
