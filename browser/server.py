#!/usr/bin/env python3
"""
Backend for Claude Notebook (browser).

Bridges the browser to:
- a Python kernel (subprocess REPL, one per session)
- `claude -p` with stream-json output and an MCP `python_run` tool that
  forwards back into the same kernel via a localhost HTTP bridge.

Endpoints:
  GET  /api/health
  GET  /api/sessions                 list sessions on disk
  GET  /api/session/<sid>            read raw JSONL
  POST /api/python/exec              { kernelId, code } -> { ok, output }
  POST /api/run                      stream-json SSE: prompt + claude -p
  POST /api/delete-turns             remove turns and re-link parent chain
  POST /api/kernel-bridge/run        (called by MCP child only) bearer-token
"""

import http.server
import socketserver
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

PORT = 8787
HERE = os.path.dirname(os.path.abspath(__file__))
CWD = os.path.expanduser("~")
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
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


def get_kernel(kernel_id):
    with KERNELS_LOCK:
        kernel = KERNELS.get(kernel_id)
        if not kernel:
            kernel = PythonKernel(kernel_id, cwd=CWD)
            KERNELS[kernel_id] = kernel
        return kernel


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
# Helpers
# ---------------------------------------------------------------------------

def is_valid_uuid(s):
    return bool(UUID_RE.match(s))


def get_project_dir(cwd=None):
    safe_cwd = (cwd or CWD).replace("/", "-")
    d = os.path.join(PROJECTS_DIR, safe_cwd)
    os.makedirs(d, exist_ok=True)
    return d


def build_session_jsonl(cells, session_id, cwd):
    """Build a session JSONL from arbitrary user/assistant text cells.
    Used for seed history."""
    lines = []
    ts = datetime.now(timezone.utc).isoformat()

    lines.append(json.dumps({
        "type": "permission-mode",
        "permissionMode": "default",
        "sessionId": session_id,
    }))

    prev_uuid = None
    for cell in cells:
        uid = str(uuid.uuid4())
        entry = {
            "parentUuid": prev_uuid,
            "isSidechain": False,
            "type": cell["role"],
            "uuid": uid,
            "timestamp": ts,
            "sessionId": session_id,
        }
        if cell["role"] == "user":
            entry["message"] = {"role": "user", "content": cell["content"]}
            entry["permissionMode"] = "default"
            entry["userType"] = "external"
            entry["entrypoint"] = "sdk-cli"
            entry["cwd"] = cwd
            entry["version"] = "2.1.143"
            entry["gitBranch"] = "HEAD"
        else:
            entry["message"] = {
                "model": "claude-opus-4-6",
                "id": "msg_composed_" + uid[:8],
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": cell["content"]}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": max(1, len(cell["content"]) // 4)},
            }
        lines.append(json.dumps(entry))
        prev_uuid = uid

    lines.append(json.dumps({
        "type": "last-prompt",
        "leafUuid": prev_uuid or "",
        "sessionId": session_id,
    }))

    return "\n".join(lines) + "\n"


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

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/sessions":
            self._list_sessions()
        elif path == "/api/health":
            self._json_response({"ok": True})
        elif path.startswith("/api/session/"):
            sid = path.split("/api/session/", 1)[1]
            self._read_session(sid)
        else:
            self.directory = HERE
            super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/run":
            # streamed; do not pre-read body via _read_body chunked
            self._run_claude_stream()
            return
        body = self._read_body()
        if path == "/api/python/exec":
            self._exec_python(body)
        elif path == "/api/delete-turns":
            self._delete_turns(body)
        elif path == "/api/kernel-bridge/run":
            self._kernel_bridge_run(body)
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

    # -- session list / read -------------------------------------------------

    def _list_sessions(self):
        project_dir = get_project_dir()
        sessions = []
        for f in sorted(Path(project_dir).glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
            sid = f.stem
            if not is_valid_uuid(sid):
                continue
            first_prompt = ""
            turn_count = 0
            try:
                with open(f) as fh:
                    for line in fh:
                        obj = json.loads(line)
                        if obj.get("type") == "user" and not obj.get("isMeta"):
                            turn_count += 1
                            if not first_prompt:
                                content = obj.get("message", {}).get("content", "")
                                if isinstance(content, str):
                                    first_prompt = content[:120].replace("<", "").strip()
            except (json.JSONDecodeError, OSError):
                continue
            sessions.append({
                "id": sid,
                "preview": first_prompt or "(empty)",
                "turns": turn_count,
                "modified": f.stat().st_mtime,
                "size": f.stat().st_size,
            })
        self._json_response(sessions[:50])

    def _read_session(self, sid):
        if not is_valid_uuid(sid):
            self._json_response({"error": "invalid session id"}, 400)
            return
        project_dir = get_project_dir()
        fpath = os.path.join(project_dir, sid + ".jsonl")
        if not os.path.exists(fpath):
            self._json_response({"error": "not found"}, 404)
            return
        with open(fpath) as f:
            content = f.read()
        self._json_response({"sessionId": sid, "content": content})

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

    def _kernel_bridge_run(self, body):
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        kernel_id = bridge_lookup(token)
        if not kernel_id:
            self._json_response({"error": "unauthorized"}, 401)
            return
        code = body.get("code", "")
        if not isinstance(code, str):
            self._json_response({"error": "code must be a string"}, 400)
            return
        try:
            kernel = get_kernel(kernel_id)
            result = kernel.run(code)
            self._json_response(result)
        except Exception as e:
            self._json_response({"error": str(e)}, 500)

    # -- claude run (streaming) ---------------------------------------------

    def _run_claude_stream(self):
        body = self._read_body()
        existing_session_id = body.get("sessionId", "")
        history = body.get("history", [])
        prompt = body.get("prompt", "")
        cwd = body.get("cwd", CWD)
        kernel_id = body.get("kernelId", "")
        model = body.get("model", "")  # 'sonnet' | 'opus' | ''

        if not prompt:
            self._json_response({"error": "prompt is required"}, 400)
            return

        project_dir = get_project_dir(cwd)

        # Decide session strategy
        session_id = None
        resume = False
        if existing_session_id and is_valid_uuid(existing_session_id):
            fpath = os.path.join(project_dir, existing_session_id + ".jsonl")
            if os.path.exists(fpath):
                session_id = existing_session_id
                resume = True

        if session_id is None and history:
            session_id = str(uuid.uuid4())
            jsonl = build_session_jsonl(history, session_id, cwd)
            fpath = os.path.join(project_dir, session_id + ".jsonl")
            with open(fpath, "w") as f:
                f.write(jsonl)
            resume = True

        if session_id is None:
            session_id = str(uuid.uuid4())
            resume = False

        # Prepare MCP config for python_run
        bridge_token = ""
        mcp_args = []
        if kernel_id:
            bridge_token = bridge_register(kernel_id)
            mcp_config = {
                "mcpServers": {
                    "kernel": {
                        "command": PYTHON_BIN,
                        "args": [MCP_SERVER_PATH],
                        "env": {
                            "KERNEL_BRIDGE_URL": "http://127.0.0.1:" + str(PORT),
                            "KERNEL_BRIDGE_TOKEN": bridge_token,
                        },
                    }
                }
            }
            mcp_args = [
                "--mcp-config", json.dumps(mcp_config),
                "--strict-mcp-config",
                "--allowedTools", "Bash", "Read", "Edit", "Write", "mcp__kernel__python_run",
            ]
        else:
            mcp_args = ["--allowedTools", "Bash", "Read", "Edit", "Write"]

        cmd = ["claude", "-p"]
        if model in ("sonnet", "opus"):
            cmd += ["--model", model]
        cmd += ["--output-format", "stream-json", "--verbose"]
        cmd += mcp_args
        if resume:
            cmd += ["--resume", session_id]
        else:
            cmd += ["--session-id", session_id]
        # The user's prompt goes last. We prepend a preamble to teach Claude
        # about python_run, mirroring the VS Code extension's behavior.
        full_prompt = (build_preamble() + "\n\n" + prompt) if kernel_id else prompt
        cmd.append(full_prompt)

        # Stream as SSE
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

        emit("start", {"sessionId": session_id, "resume": resume})

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=cwd,
            )
        except FileNotFoundError:
            emit("error", {"message": "claude CLI not found in PATH"})
            emit("end", {"sessionId": session_id})
            if bridge_token:
                bridge_unregister(bridge_token)
            return

        result_session_id = session_id
        # Pipe stdout line-by-line as raw stream-json events
        try:
            for line in proc.stdout:
                line = line.rstrip("\n")
                if not line.strip():
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    emit("raw", {"line": line})
                    continue
                emit("event", parsed)
                if parsed.get("type") == "result":
                    sid = parsed.get("session_id")
                    if isinstance(sid, str) and sid:
                        result_session_id = sid

            proc.wait(timeout=600)
            stderr = proc.stderr.read() if proc.stderr else ""
            if stderr.strip():
                emit("stderr", {"text": stderr[:2000]})

            # Read back final session file content
            final_fpath = os.path.join(get_project_dir(cwd), result_session_id + ".jsonl")
            session_content = ""
            if os.path.exists(final_fpath):
                with open(final_fpath) as f:
                    session_content = f.read()
            emit("end", {
                "sessionId": result_session_id,
                "returncode": proc.returncode,
                "sessionContent": session_content,
            })
        except subprocess.TimeoutExpired:
            proc.kill()
            emit("error", {"message": "claude timed out (10 min)"})
            emit("end", {"sessionId": session_id})
        except Exception as e:
            emit("error", {"message": str(e)})
            emit("end", {"sessionId": session_id})
        finally:
            if bridge_token:
                bridge_unregister(bridge_token)

    # -- delete turns -------------------------------------------------------

    def _delete_turns(self, body):
        source_sid = body.get("sessionId", "")
        delete_indices = set(body.get("deleteTurnIndices", []))

        if not source_sid or not is_valid_uuid(source_sid):
            self._json_response({"error": "valid sessionId required"}, 400)
            return

        project_dir = get_project_dir()
        fpath = os.path.join(project_dir, source_sid + ".jsonl")
        if not os.path.exists(fpath):
            self._json_response({"error": "session not found"}, 404)
            return

        with open(fpath) as f:
            raw_content = f.read()

        lines = []
        for line in raw_content.strip().split("\n"):
            line = line.strip()
            if line:
                try:
                    lines.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

        turn_idx = -1
        msg_to_turn = {}
        for msg in lines:
            if msg.get("type") == "user" and not msg.get("isMeta"):
                turn_idx += 1
            if msg.get("uuid"):
                msg_to_turn[msg["uuid"]] = turn_idx

        keep_uuids = {uid for uid, tidx in msg_to_turn.items() if tidx not in delete_indices}

        kept = []
        for m in lines:
            uid = m.get("uuid")
            mtype = m.get("type", "")
            if uid:
                if uid in keep_uuids:
                    kept.append(m)
            elif mtype in ("permission-mode", "file-history-snapshot", "queue-operation", "ai-title"):
                kept.append(m)

        uuid_set = {m["uuid"] for m in kept if m.get("uuid")}
        last_uuid = None
        rechained = []
        for m in kept:
            m2 = dict(m)
            if m2.get("uuid"):
                if m2.get("parentUuid") and m2["parentUuid"] not in uuid_set:
                    m2["parentUuid"] = last_uuid
                last_uuid = m2["uuid"]
            rechained.append(m2)

        new_id = str(uuid.uuid4())
        for m in rechained:
            if "sessionId" in m:
                m["sessionId"] = new_id

        rechained.append({
            "type": "last-prompt",
            "leafUuid": last_uuid or "",
            "sessionId": new_id,
        })

        new_content = "\n".join(json.dumps(m) for m in rechained) + "\n"
        new_fpath = os.path.join(project_dir, new_id + ".jsonl")
        with open(new_fpath, "w") as f:
            f.write(new_content)

        self._json_response({
            "sessionId": new_id,
            "sessionContent": new_content,
        })

    def log_message(self, format, *args):
        msg = (args[0] if args else "")
        # Skip noisy SSE chunk logs
        sys.stdout.write("[notebook] " + str(msg) + "\n")


if __name__ == "__main__":
    os.chdir(HERE)
    server = ThreadedHTTPServer(("127.0.0.1", PORT), NotebookHandler)
    print("Claude Notebook server running at http://localhost:" + str(PORT) + "/notebook.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        for k in list(KERNELS.values()):
            k.dispose()
        server.shutdown()
