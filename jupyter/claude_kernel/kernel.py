"""Claude Code Jupyter Kernel.

Two cell kinds (selected by metadata, not by magic prefix):
  - python  -> run in a persistent in-process REPL (shared namespace, REPL semantics).
  - prompt  -> run via `claude -p` with stream-json output, rendered inline.

Prompt cells get a `python_run` MCP tool wired into the same REPL via a
localhost HTTP bridge with a per-run bearer token, so Claude can inspect /
mutate notebook state mid-turn (matches the VS Code extension and browser app).
"""

import ast
import contextlib
import html as html_mod
import io
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import traceback
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

from ipykernel.kernelbase import Kernel
from ipykernel.comm import CommManager

PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
UUID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
HERE = os.path.dirname(os.path.abspath(__file__))
MCP_SERVER_PATH = os.path.normpath(os.path.join(HERE, "..", "mcp", "python_server.py"))

CODE_TOOLS = {"Bash", "Edit", "Write"}
HIDDEN_TOOLS = {"ToolSearch"}
KERNEL_RUN_TOOL = "mcp__kernel__python_run"


# ---------------------------------------------------------------------------
# Rendering helpers
# ---------------------------------------------------------------------------

def _esc(text):
    return html_mod.escape(text if isinstance(text, str) else str(text))


def _render_markdown_html(text):
    escaped = _esc(text)
    with_code = re.sub(
        r"```([\s\S]*?)```",
        lambda m: (
            '<pre style="background:#1e1e2e;color:#cdd6f4;padding:12px;border-radius:6px;'
            'white-space:pre-wrap">'
            + m.group(1) +
            "</pre>"
        ),
        escaped,
    )
    parts = []
    for paragraph in re.split(r"\n{2,}", with_code):
        p = paragraph.strip()
        if p:
            parts.append(f'<p style="margin:6px 0">{p.replace(chr(10), "<br>")}</p>')
    return "".join(parts)


def _render_assistant_text(text):
    return (
        '<div style="margin:6px 0;border-left:3px solid #38bdf8;background:#f0f9ff;'
        'padding:6px 12px;border-radius:0 6px 6px 0">'
        + _render_markdown_html(text) +
        "</div>"
    )


def _stringify(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)


def _tool_source(tool_name, tool_input):
    if not isinstance(tool_input, dict):
        return _stringify(tool_input)
    if tool_name == "Bash":
        return str(tool_input.get("command", ""))
    if tool_name == "Edit":
        fp = tool_input.get("file_path", "")
        old = tool_input.get("old_string", "")
        new = tool_input.get("new_string", "")
        if old:
            return f"# Edit: {fp}\n# old:\n{old}\n# new:\n{new}"
        return _stringify(tool_input)
    if tool_name == "Write":
        return f"# Write: {tool_input.get('file_path', '')}\n{tool_input.get('content', '')}"
    return _stringify(tool_input)


def _render_code_tool_use(tool_name, tool_input):
    palette = {
        "Bash":  ("#f59e0b", "$ bash"),
        "Edit":  ("#3b82f6", "✎ edit"),
        "Write": ("#10b981", "+ write"),
    }
    border, tag = palette.get(tool_name, ("#7c3aed", tool_name))
    source = _tool_source(tool_name, tool_input)
    return (
        f'<div style="margin:8px 0;border-left:3px solid {border};padding:4px 0 4px 10px">'
        f'<div style="font-family:monospace;font-size:11px;color:{border};font-weight:600;'
        f'margin-bottom:4px">{_esc(tag)}</div>'
        f'<pre style="background:#1e1e2e;color:#cdd6f4;padding:10px;border-radius:6px;font-size:12px;'
        f'white-space:pre-wrap;word-break:break-word;margin:0;overflow-x:auto">{_esc(source)}</pre>'
        "</div>"
    )


def _render_python_run_use(tool_input):
    code = tool_input.get("code", "") if isinstance(tool_input, dict) else _stringify(tool_input)
    border = "#a78bfa"
    return (
        f'<div style="margin:8px 0;border-left:3px solid {border};padding:4px 0 4px 10px">'
        f'<div style="font-family:monospace;font-size:11px;color:{border};font-weight:600;'
        f'margin-bottom:4px">&gt;&gt;&gt; python (kernel)</div>'
        f'<pre style="background:#1e1e2e;color:#cdd6f4;padding:10px;border-radius:6px;font-size:12px;'
        f'white-space:pre-wrap;word-break:break-word;margin:0;overflow-x:auto">{_esc(code)}</pre>'
        "</div>"
    )


def _render_tool_use(tool_name, tool_input):
    return (
        '<details open style="margin:6px 0;border:1px solid #e0e0e0;border-radius:6px;padding:4px 8px">'
        f'<summary style="cursor:pointer;font-family:monospace;font-size:13px;color:#7c3aed">'
        f'{_esc(tool_name)}</summary>'
        f'<pre style="background:#f8f8f8;padding:8px;border-radius:4px;font-size:12px;'
        f'overflow-x:auto;margin-top:6px">{_esc(_stringify(tool_input))}</pre>'
        "</details>"
    )


def _render_tool_result(content, max_chars=2000):
    text = _stringify(content)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n… (truncated)"
    return (
        '<details open style="margin:2px 0 8px 28px;border-left:2px dashed #94a3b8;padding-left:10px">'
        '<summary style="cursor:pointer;font-family:monospace;font-size:11px;color:#64748b">↳ result</summary>'
        '<pre style="background:#f1f5f9;color:#334155;padding:8px;border-radius:4px;font-size:11px;'
        'white-space:pre-wrap;word-break:break-word;margin-top:6px;overflow-x:auto">'
        + _esc(text) +
        "</pre></details>"
    )


def _extract_text_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if parts:
            return "\n".join(parts)
    return _stringify(content)


def _wrap_transcript(inner_html):
    return (
        '<details open style="border:1px solid #e2e8f0;border-radius:6px;background:#fff">'
        '<summary style="cursor:pointer;padding:6px 10px;font-family:monospace;font-size:11px;'
        'color:#64748b;background:#f8fafc;border-radius:6px 6px 0 0;user-select:none">'
        'reply (click to collapse)</summary>'
        '<div style="max-height:600px;overflow-y:auto;padding:8px 12px">'
        + inner_html +
        '</div></details>'
    )


def _token_bar_html(usage, model="", duration=None):
    inp = usage.get("input_tokens", 0)
    cache_create = usage.get("cache_creation_input_tokens", 0)
    cache_read = usage.get("cache_read_input_tokens", 0)
    out = usage.get("output_tokens", 0)
    parts = []
    if model:
        parts.append(f"<strong>{_esc(model)}</strong>")
    parts.append(f"in: {inp:,}")
    if cache_read:
        parts.append(f"cached: {cache_read:,}")
    if cache_create:
        parts.append(f"new_cache: {cache_create:,}")
    parts.append(f"out: {out:,}")
    if duration:
        parts.append(f"{duration / 1000:.1f}s")
    return (
        '<div style="background:#f1f5f9;border-radius:4px;padding:6px 10px;margin-top:8px;'
        'font-size:11px;color:#64748b;font-family:monospace">'
        + " &nbsp;|&nbsp; ".join(parts) +
        "</div>"
    )


# ---------------------------------------------------------------------------
# Session JSONL helpers
# ---------------------------------------------------------------------------

def _parse_session_lines(fpath):
    with open(fpath) as f:
        raw = f.read()
    lines = []
    for line in raw.strip().split("\n"):
        line = line.strip()
        if line:
            try:
                lines.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return lines


# ---------------------------------------------------------------------------
# Persistent in-process Python REPL
# ---------------------------------------------------------------------------

class InProcessRepl:
    """REPL semantics on a shared globals dict. Last expression auto-prints.

    `run_capturing` redirects stdout/stderr (used when MCP python_run is
    forwarded into us — we want to ship captured output back to Claude rather
    than emit it to the notebook front-end). Cell runs use `run_streaming`
    which calls a callback per stdout/stderr chunk so the caller can route to
    iopub.

    A single lock serializes runs so an MCP python_run that lands while a cell
    is mid-execution waits for the cell to finish.
    """

    def __init__(self):
        self._globals = {"__name__": "__main__"}
        self._lock = threading.Lock()

    def _exec_split(self, code):
        tree = ast.parse(code, mode="exec")
        if not tree.body:
            return
        last = tree.body[-1]
        if isinstance(last, ast.Expr):
            head = ast.Module(body=tree.body[:-1], type_ignores=[])
            tail = ast.Expression(body=last.value)
            ast.fix_missing_locations(head)
            ast.fix_missing_locations(tail)
            if head.body:
                exec(compile(head, "<cell>", "exec"), self._globals)
            value = eval(compile(tail, "<cell>", "eval"), self._globals)
            if value is not None:
                sys.stdout.write(repr(value) + "\n")
        else:
            exec(compile(tree, "<cell>", "exec"), self._globals)

    def run_streaming(self, code, on_stream):
        with self._lock:
            stdout = _CallbackStream("stdout", on_stream)
            stderr = _CallbackStream("stderr", on_stream)
            old_out, old_err = sys.stdout, sys.stderr
            sys.stdout, sys.stderr = stdout, stderr
            ok = True
            try:
                try:
                    self._exec_split(code)
                except SystemExit:
                    pass
                except BaseException:
                    ok = False
                    traceback.print_exc()
            finally:
                sys.stdout, sys.stderr = old_out, old_err
            return ok

    def run_capturing(self, code):
        buf = io.StringIO()
        with self._lock:
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                ok = True
                try:
                    self._exec_split(code)
                except SystemExit:
                    pass
                except BaseException:
                    ok = False
                    traceback.print_exc()
        return ok, buf.getvalue()


class _CallbackStream:
    def __init__(self, name, callback):
        self.name = name
        self._cb = callback

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if s:
            self._cb(self.name, s)
        return len(s)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        pass

    def isatty(self):
        return False


# ---------------------------------------------------------------------------
# Bridge HTTP server (kernel-side)
# ---------------------------------------------------------------------------

class _BridgeHandler(BaseHTTPRequestHandler):
    kernel = None  # set on the class before serve_forever

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/session":
            self._get_session()
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()
        if path == "/api/kernel-bridge/run":
            self._kernel_bridge_run(body)
        elif path == "/api/reset":
            self._post_reset()
        elif path == "/api/cd":
            self._post_cd(body)
        else:
            self._json({"error": "not found"}, 404)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json(self, data, status=200):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def _get_session(self):
        k = self.kernel
        excluded = sum(1 for t in k._turns if not t.get("included", True))
        self._json({
            "cwd": k.cwd,
            "turnCount": len(k._turns),
            "totalCost": k.total_cost,
            "excludedCount": excluded,
            "inputTokens": k._last_input_tokens,
            "contextWindow": k._context_window,
            "model": k._model_name,
        })

    def _post_reset(self):
        k = self.kernel
        k._turns = []
        k.total_cost = 0.0
        k._last_input_tokens = 0
        self._json({"ok": True})

    def _post_cd(self, body):
        k = self.kernel
        path = body.get("path", "")
        expanded = os.path.expanduser(path)
        if not os.path.isdir(expanded):
            self._json({"error": f"not a directory: {path}"}, 400)
            return
        k.cwd = expanded
        self._json({"ok": True, "cwd": expanded})

    def _kernel_bridge_run(self, body):
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if not self.kernel._bridge_lookup(token):
            self._json({"error": "unauthorized"}, 401)
            return
        code = body.get("code", "")
        if not isinstance(code, str):
            self._json({"error": "code must be a string"}, 400)
            return
        ok, output = self.kernel._repl.run_capturing(code)
        self._json({"ok": ok, "output": output})

    def log_message(self, format, *args):
        pass


def _find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Floating ring panel (kept — user opted to keep it)
# ---------------------------------------------------------------------------

def _panel_html(ui_port):
    return f'''<script>
(function() {{
  if (document.getElementById('claude-panel')) return;

  const PORT = {ui_port};
  const BASE = 'http://127.0.0.1:' + PORT;

  const panel = document.createElement('div');
  panel.id = 'claude-panel';
  panel.innerHTML = `
<style>
#claude-panel {{
  position: fixed; top: 60px; right: 16px; z-index: 9999;
  background: white; border: 1px solid #e2e8f0; border-radius: 16px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.10); font-family: -apple-system, sans-serif;
  font-size: 12px; overflow: hidden; width: 180px;
  cursor: pointer; user-select: none;
}}
#ck-ring-wrap {{
  display: flex; flex-direction: column; align-items: center;
  padding: 14px 12px 10px;
}}
#ck-ring-svg {{ width: 90px; height: 90px; }}
#ck-ring-bg {{ fill: none; stroke: #e2e8f0; stroke-width: 7; }}
#ck-ring-fg {{ fill: none; stroke-width: 7; stroke-linecap: round;
  transition: stroke-dashoffset 0.6s ease, stroke 0.3s; }}
#ck-ring-text {{
  font-size: 13px; font-weight: 700; fill: #334155;
  text-anchor: middle; dominant-baseline: central;
}}
#ck-ring-sub {{
  font-size: 9px; fill: #94a3b8;
  text-anchor: middle; dominant-baseline: central;
}}
#ck-cost {{
  margin-top: 8px; font-family: monospace; font-size: 13px;
  font-weight: 600; color: #334155; text-align: center;
}}
#ck-model {{
  margin-top: 2px; font-size: 10px; color: #94a3b8; text-align: center;
}}
</style>
<div id="ck-ring-wrap">
  <svg id="ck-ring-svg" viewBox="0 0 100 100">
    <circle id="ck-ring-bg" cx="50" cy="50" r="40"/>
    <circle id="ck-ring-fg" cx="50" cy="50" r="40"
      stroke-dasharray="251.3" stroke-dashoffset="251.3"
      transform="rotate(-90 50 50)"/>
    <text id="ck-ring-text" x="50" y="46">0%</text>
    <text id="ck-ring-sub" x="50" y="60">0 / 0k</text>
  </svg>
  <div id="ck-cost">$0.0000</div>
  <div id="ck-model"></div>
</div>
`;
  document.body.appendChild(panel);

  const C = 251.3;
  function colorForPct(p) {{
    if (p < 0.5) return '#10b981';
    if (p < 0.75) return '#f59e0b';
    return '#ef4444';
  }}
  async function refresh() {{
    try {{
      const r = await fetch(BASE + '/api/session');
      const d = await r.json();
      const used = d.inputTokens || 0;
      const win = d.contextWindow || 200000;
      const pct = Math.min(used / win, 1);
      const fg = document.getElementById('ck-ring-fg');
      fg.style.strokeDashoffset = String(C * (1 - pct));
      fg.style.stroke = colorForPct(pct);
      document.getElementById('ck-ring-text').textContent = Math.round(pct * 100) + '%';
      const usedK = (used / 1000).toFixed(used >= 10000 ? 0 : 1);
      const winK = (win / 1000).toFixed(0);
      document.getElementById('ck-ring-sub').textContent = usedK + 'k / ' + winK + 'k';
      document.getElementById('ck-cost').textContent = '$' + (d.totalCost || 0).toFixed(4);
      document.getElementById('ck-model').textContent = d.model || '';
    }} catch(e) {{}}
  }}
  refresh();
  setInterval(refresh, 3000);
}})();
</script>'''


# ---------------------------------------------------------------------------
# Kernel
# ---------------------------------------------------------------------------

# The labextension prepends a JSON envelope to a cell's source so the kernel
# knows what kind of cell this is and which model/turn to use:
#   __CLAUDE_CELL__{"kind":"prompt","model":"sonnet","turnIndex":3}__\n<source>
# Default (no envelope) = python.
ENVELOPE_RE = re.compile(r"^__CLAUDE_CELL__(.*?)__\n", re.DOTALL)


class ClaudeKernel(Kernel):
    implementation = "claude_code"
    implementation_version = "0.6"
    language = "python"
    language_version = sys.version.split()[0]
    language_info = {
        "name": "python",
        "mimetype": "text/x-python",
        "file_extension": ".py",
    }
    banner = "Claude Code Kernel — Python + prompt cells"

    msg_types = Kernel.msg_types + ["comm_open", "comm_msg", "comm_close"]

    def __init__(self, **kwargs):
        self.comm_manager = CommManager(parent=self)
        super().__init__(**kwargs)
        self.cwd = os.path.expanduser("~")
        self.total_cost = 0.0
        self._turns = []
        self._last_input_tokens = 0
        self._context_window = 200000
        self._model_name = ""
        self._repl = InProcessRepl()
        self._bridge_tokens = {}
        self._bridge_lock = threading.Lock()
        self._ui_port = self._start_bridge_server()
        self._panel_injected = False
        self.comm_manager.register_target("claude_cell_toggle", self._handle_comm_open)

    # -- comm plumbing -------------------------------------------------------

    def comm_open(self, stream, ident, msg):
        self.comm_manager.comm_open(stream, ident, msg)

    def comm_msg(self, stream, ident, msg):
        self.comm_manager.comm_msg(stream, ident, msg)

    def comm_close(self, stream, ident, msg):
        self.comm_manager.comm_close(stream, ident, msg)

    def _handle_comm_open(self, comm, open_msg):
        comm.on_msg(self._handle_comm_msg)

    def _handle_comm_msg(self, msg):
        data = msg.get("content", {}).get("data", {})
        inclusion = data.get("inclusion")
        if isinstance(inclusion, list):
            for i, v in enumerate(inclusion):
                if i < len(self._turns):
                    self._turns[i]["included"] = bool(v)

    # -- bridge --------------------------------------------------------------

    def _start_bridge_server(self):
        port = _find_free_port()
        _BridgeHandler.kernel = self
        server = HTTPServer(("127.0.0.1", port), _BridgeHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return port

    def _bridge_register(self):
        token = secrets.token_hex(24)
        with self._bridge_lock:
            self._bridge_tokens[token] = True
        return token

    def _bridge_lookup(self, token):
        with self._bridge_lock:
            return token in self._bridge_tokens

    def _bridge_unregister(self, token):
        with self._bridge_lock:
            self._bridge_tokens.pop(token, None)

    # -- iopub helpers -------------------------------------------------------

    def _display_html(self, html_content, display_id=None, update=False):
        msg_type = "update_display_data" if update else "display_data"
        content = {"data": {"text/html": html_content}, "metadata": {}}
        if display_id is not None:
            content["transient"] = {"display_id": display_id}
        self.send_response(self.iopub_socket, msg_type, content)

    def _stream(self, name, text):
        self.send_response(self.iopub_socket, "stream", {"name": name, "text": text})

    def _ensure_panel(self):
        if not self._panel_injected:
            self._display_html(_panel_html(self._ui_port))
            self._panel_injected = True

    # -- envelope ------------------------------------------------------------

    def _parse_envelope(self, code):
        m = ENVELOPE_RE.match(code)
        if not m:
            return {}, code
        try:
            meta = json.loads(m.group(1))
        except json.JSONDecodeError:
            return {}, code[m.end():]
        return meta, code[m.end():]

    # -- main dispatch -------------------------------------------------------

    def do_execute(self, code, silent, store_history=True, user_expressions=None, allow_stdin=False):
        if not code.strip():
            return self._ok()

        if not silent:
            self._ensure_panel()

        meta, source = self._parse_envelope(code)
        kind = meta.get("kind") or "python"

        # Backwards-compat: legacy magic prefixes still work.
        if not meta:
            if source.startswith("__PYTHON__"):
                kind = "python"
                source = source[len("__PYTHON__"):]
            elif source.startswith("#%claude:"):
                kind = "prompt"
                first_nl = source.index("\n") if "\n" in source else len(source)
                model_line = source[:first_nl].strip()
                meta = {"model": model_line.split(":", 1)[1] if ":" in model_line else "opus"}
                source = source[first_nl:].lstrip("\n") if "\n" in source else ""

        if source.lstrip().startswith("%"):
            return self._handle_magic(source.strip())

        if kind == "prompt":
            return self._execute_prompt(source, meta, silent)
        return self._execute_python(source, silent)

    # -- python --------------------------------------------------------------

    def _execute_python(self, code, silent):
        if not code.strip():
            return self._ok()
        ok = self._repl.run_streaming(
            code,
            (lambda name, text: None) if silent else self._stream,
        )
        return self._ok(ok=ok)

    # -- prompt --------------------------------------------------------------

    def _execute_prompt(self, prompt, meta, silent):
        prompt = prompt.strip()
        if not prompt:
            return self._ok()

        cell_model = (meta.get("model") or "sonnet").lower()
        ti_raw = meta.get("turnIndex")
        if isinstance(ti_raw, int):
            turn_index = ti_raw
        elif isinstance(ti_raw, str) and ti_raw.lstrip("-").isdigit():
            turn_index = int(ti_raw)
        else:
            turn_index = len(self._turns)

        resume_sid, resume_path = self._build_session_for_turn(turn_index)
        bridge_token = self._bridge_register()
        try:
            mcp_config = {
                "mcpServers": {
                    "kernel": {
                        "command": sys.executable,
                        "args": [MCP_SERVER_PATH],
                        "env": {
                            "KERNEL_BRIDGE_URL": f"http://127.0.0.1:{self._ui_port}",
                            "KERNEL_BRIDGE_TOKEN": bridge_token,
                        },
                    }
                }
            }

            cmd = ["claude", "-p"]
            if cell_model in ("sonnet", "opus"):
                cmd += ["--model", cell_model]
            cmd += [
                "--output-format", "stream-json", "--verbose",
                "--mcp-config", json.dumps(mcp_config),
                "--strict-mcp-config",
                "--allowedTools", "Bash", "Read", "Edit", "Write", KERNEL_RUN_TOOL,
            ]
            if resume_sid:
                cmd += ["--resume", resume_sid]
            else:
                cmd += ["--session-id", str(uuid.uuid4())]

            full_prompt = self._build_preamble() + "\n\n" + prompt
            cmd.append(full_prompt)

            self._stream_claude_run(cmd, prompt, turn_index, cell_model, resume_path, silent)
        finally:
            self._bridge_unregister(bridge_token)

        return self._ok()

    def _build_preamble(self):
        return (
            "You are answering inside a notebook prompt cell. To work with Python, "
            "use the python_run tool: it executes code in the live notebook kernel "
            "and returns stdout/stderr to you. The kernel shares the same namespace "
            "as the user's Python cells, so variables like `df` defined earlier are "
            "available. Use python_run whenever you need to inspect data, check "
            "shapes/values, or compute something to reason about. Side effects "
            "persist - prefer non-mutating queries unless the user explicitly asks "
            "you to change state."
        )

    def _stream_claude_run(self, cmd, prompt, turn_index, cell_model, resume_path, silent):
        try:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, cwd=self.cwd,
            )
        except FileNotFoundError:
            if not silent:
                self._display_html('<div style="color:#ef4444;padding:6px">claude CLI not found in PATH</div>')
            return

        display_id = "claude-" + secrets.token_hex(4)
        transcript_html = ""
        first_render = True

        def push(html):
            nonlocal transcript_html, first_render
            transcript_html += html
            if silent:
                return
            self._display_html(_wrap_transcript(transcript_html), display_id=display_id, update=not first_render)
            first_render = False

        tool_name_by_id = {}
        final_usage = {}
        final_cost = 0.0
        final_duration = 0
        result_sid = ""
        saw_assistant_text = False

        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                etype = event.get("type", "")

                if etype == "system":
                    model = event.get("model", "")
                    if model:
                        self._model_name = model
                        self._context_window = 1000000 if "1m" in model.lower() else 200000

                elif etype == "assistant":
                    msg = event.get("message", {}) or {}
                    content = msg.get("content", [])
                    if isinstance(content, str):
                        content = [{"type": "text", "text": content}]
                    for block in content:
                        btype = block.get("type", "")
                        if btype == "text":
                            text = block.get("text", "")
                            if text:
                                saw_assistant_text = True
                                push(_render_assistant_text(text))
                        elif btype == "tool_use":
                            name = block.get("name", "unknown")
                            tid = block.get("id", "")
                            if tid:
                                tool_name_by_id[tid] = name
                            if name in HIDDEN_TOOLS:
                                continue
                            inp = block.get("input", {}) or {}
                            if name == KERNEL_RUN_TOOL:
                                push(_render_python_run_use(inp))
                            elif name in CODE_TOOLS:
                                push(_render_code_tool_use(name, inp))
                            else:
                                push(_render_tool_use(name, inp))
                    usage = msg.get("usage")
                    if usage:
                        final_usage = usage
                        self._last_input_tokens = (
                            usage.get("input_tokens", 0)
                            + usage.get("cache_creation_input_tokens", 0)
                            + usage.get("cache_read_input_tokens", 0)
                        )

                elif etype == "user":
                    msg = event.get("message", {}) or {}
                    content = msg.get("content", [])
                    if isinstance(content, list):
                        for block in content:
                            if not isinstance(block, dict):
                                continue
                            if block.get("type") != "tool_result":
                                continue
                            tid = block.get("tool_use_id", "")
                            called = tool_name_by_id.get(tid, "")
                            if called in HIDDEN_TOOLS:
                                continue
                            raw_content = block.get("content", "")
                            shown = _extract_text_content(raw_content) if called == KERNEL_RUN_TOOL else _stringify(raw_content)
                            push(_render_tool_result(shown))

                elif etype == "result":
                    final_cost = float(event.get("total_cost_usd", 0) or 0)
                    final_duration = int(event.get("duration_ms", 0) or 0)
                    rusage = event.get("usage")
                    if rusage:
                        final_usage = rusage
                        self._last_input_tokens = (
                            rusage.get("input_tokens", 0)
                            + rusage.get("cache_creation_input_tokens", 0)
                            + rusage.get("cache_read_input_tokens", 0)
                        )
                    if isinstance(event.get("session_id"), str):
                        result_sid = event["session_id"]
                    if not saw_assistant_text and event.get("result"):
                        push(_render_assistant_text(str(event["result"])))

            proc.wait(timeout=600)
            self.total_cost += final_cost

            if result_sid:
                turn_messages = self._extract_last_turn_messages(result_sid, prompt)
                turn_data = {"messages": turn_messages, "included": True}
                if turn_index < len(self._turns):
                    self._turns[turn_index] = turn_data
                else:
                    while len(self._turns) < turn_index:
                        self._turns.append({"messages": [], "included": True})
                    self._turns.append(turn_data)

            if not silent and final_usage:
                self._display_html(_token_bar_html(final_usage, self._model_name or cell_model, final_duration))

            stderr = proc.stderr.read() if proc.stderr else ""
            if proc.returncode != 0 and stderr.strip() and not silent:
                self._display_html(
                    f'<div style="color:#ef4444;background:#fef2f2;padding:8px;border-radius:6px;'
                    f'font-size:12px;margin-top:4px">⚠ {_esc(stderr[:500])}</div>'
                )

            if resume_path and os.path.exists(resume_path):
                try:
                    os.remove(resume_path)
                except OSError:
                    pass

        except subprocess.TimeoutExpired:
            proc.kill()
            if not silent:
                self._display_html('<div style="color:#ef4444;padding:8px">⏱ Claude timed out (10 min)</div>')
        except Exception as e:
            if not silent:
                self._display_html(f'<div style="color:#ef4444;padding:8px">Error: {_esc(str(e))}</div>')

    # -- session prep / resume ----------------------------------------------

    def _build_session_for_turn(self, turn_index):
        included = [
            t for i, t in enumerate(self._turns[:turn_index]) if t.get("included", True)
        ]
        if not included:
            return None, None

        session_id = str(uuid.uuid4())
        project_dir = self._get_project_dir()
        fpath = os.path.join(project_dir, session_id + ".jsonl")

        lines = []
        last_uuid = None
        for turn in included:
            for msg in turn.get("messages", []):
                m = dict(msg)
                m["sessionId"] = session_id
                if last_uuid and m.get("uuid"):
                    m["parentUuid"] = last_uuid
                if m.get("uuid"):
                    last_uuid = m["uuid"]
                lines.append(m)

        lines.append({"type": "last-prompt", "leafUuid": last_uuid or "", "sessionId": session_id})

        with open(fpath, "w") as f:
            for line in lines:
                f.write(json.dumps(line) + "\n")
        return session_id, fpath

    def _extract_last_turn_messages(self, session_id, prompt):
        fpath = self._find_session_file(session_id)
        if not fpath:
            return []
        all_msgs = _parse_session_lines(fpath)
        turn_start = -1
        for i in range(len(all_msgs) - 1, -1, -1):
            msg = all_msgs[i]
            if msg.get("type") != "user" or msg.get("isMeta"):
                continue
            content = (msg.get("message") or {}).get("content")
            if isinstance(content, str) and content.endswith(prompt):
                turn_start = i
                break
            if turn_start == -1:
                turn_start = i
        if turn_start == -1:
            return []
        out = []
        for msg in all_msgs[turn_start:]:
            if msg.get("type") == "last-prompt":
                continue
            out.append(msg)
        return out

    def _find_session_file(self, sid):
        primary = os.path.join(self._get_project_dir(), sid + ".jsonl")
        if os.path.exists(primary):
            return primary
        if os.path.isdir(PROJECTS_DIR):
            for d in Path(PROJECTS_DIR).iterdir():
                if d.is_dir():
                    candidate = d / (sid + ".jsonl")
                    if candidate.exists():
                        return str(candidate)
        return None

    def _get_project_dir(self):
        safe_cwd = self.cwd.replace("/", "-")
        d = os.path.join(PROJECTS_DIR, safe_cwd)
        os.makedirs(d, exist_ok=True)
        return d

    # -- magics --------------------------------------------------------------

    def _handle_magic(self, code):
        parts = code.split(None, 1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ""

        if cmd == "%reset":
            self._turns = []
            self.total_cost = 0.0
            self._last_input_tokens = 0
            self._display_html('<div style="color:#10b981;padding:6px">Session reset.</div>')
        elif cmd == "%session":
            total = len(self._turns)
            excluded = sum(1 for t in self._turns if not t.get("included", True))
            self._display_html(
                f'<div style="padding:6px;font-family:monospace;font-size:12px">'
                f'turns: {total} | excluded: {excluded} | '
                f'cost: ${self.total_cost:.4f} | cwd: {_esc(self.cwd)}</div>'
            )
        elif cmd == "%cd":
            if arg:
                expanded = os.path.expanduser(arg)
                if os.path.isdir(expanded):
                    self.cwd = expanded
                    self._display_html(f'<div style="color:#10b981;padding:6px">CWD: {_esc(expanded)}</div>')
                else:
                    self._display_html(f'<div style="color:#ef4444;padding:6px">Not a directory: {_esc(expanded)}</div>')
            else:
                self._display_html(f'<div style="padding:6px;font-family:monospace">{_esc(self.cwd)}</div>')
        elif cmd == "%cost":
            self._display_html(
                f'<div style="padding:6px;font-family:monospace;font-size:12px">'
                f'Total: <strong>${self.total_cost:.4f}</strong></div>'
            )
        elif cmd == "%panel":
            self._panel_injected = False
            self._ensure_panel()
        elif cmd == "%help":
            self._display_html(
                '<div style="padding:8px;font-size:12px">'
                "<strong>Claude Code Kernel</strong><br><br>"
                "Cells default to <strong>python</strong> (persistent REPL, shared namespace). "
                "Use the labextension toolbar (○ prompt / ● python) to flip a cell to "
                "<strong>prompt</strong>, which calls <code>claude -p</code> with a "
                "<code>python_run</code> tool wired into the same Python REPL.<br><br>"
                "<strong>Magics:</strong><br>"
                "<code>%session</code> &nbsp; <code>%reset</code> &nbsp; "
                "<code>%cd &lt;path&gt;</code> &nbsp; <code>%cost</code> &nbsp; "
                "<code>%panel</code> &nbsp; <code>%help</code></div>"
            )
        else:
            self._display_html(f'<div style="color:#ef4444;padding:6px">Unknown: {_esc(cmd)}. Try %help</div>')

        return self._ok()

    # -- helpers -------------------------------------------------------------

    def _ok(self, ok=True):
        if ok:
            return {
                "status": "ok",
                "execution_count": self.execution_count,
                "payload": [],
                "user_expressions": {},
            }
        return {
            "status": "error",
            "execution_count": self.execution_count,
            "ename": "Error",
            "evalue": "",
            "traceback": [],
        }
