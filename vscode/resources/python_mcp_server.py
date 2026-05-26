#!/usr/bin/env python3
"""Stdio MCP server bundled with the VS Code extension.

Spawned as a child of `claude` via --mcp-config when the user runs a prompt
cell with the Claude backend. Declares a single `python_run` tool and forwards
each call back into the live notebook kernel via a localhost HTTP bridge owned
by the extension.

Configuration via env (set when spawning claude):
  KERNEL_BRIDGE_URL    e.g. http://127.0.0.1:54321
  KERNEL_BRIDGE_TOKEN  one-time bearer token scoped to this run
"""

import json
import os
import sys
import urllib.request
import urllib.error

BRIDGE_URL = os.environ.get('KERNEL_BRIDGE_URL', '')
BRIDGE_TOKEN = os.environ.get('KERNEL_BRIDGE_TOKEN', '')

TOOL = {
    "name": "python_run",
    "description": (
        "Execute Python code in the user's notebook kernel and return stdout/stderr. "
        "Shares the same namespace as the user's Python cells, so variables defined "
        "in earlier cells (e.g. df, model) are accessible. Use this whenever you "
        "need to inspect data, run a quick check, or compute something whose result "
        "you will reason about. Side effects (reassigning variables, deleting "
        "state) persist; prefer non-mutating queries unless the user explicitly "
        "asks you to change state."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "Python source to execute. Last expression is auto-printed (REPL semantics).",
            }
        },
        "required": ["code"],
    },
}


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def respond(msg_id, result):
    send({"jsonrpc": "2.0", "id": msg_id, "result": result})


def respond_error(msg_id, code, message):
    send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}})


def call_bridge(code):
    if not BRIDGE_URL or not BRIDGE_TOKEN:
        raise RuntimeError("Kernel bridge not configured (missing env)")
    body = json.dumps({"code": code}).encode("utf-8")
    req = urllib.request.Request(
        BRIDGE_URL.rstrip("/") + "/run",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + BRIDGE_TOKEN,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"ok": False, "output": "Bridge {}: {}".format(e.code, e.read().decode("utf-8", "ignore"))}
    except Exception as e:
        return {"ok": False, "output": "Bridge error: " + str(e)}


def handle(message):
    msg_id = message.get("id")
    method = message.get("method", "")
    params = message.get("params", {}) or {}

    if method == "initialize":
        respond(msg_id, {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "copilot-notebook-kernel", "version": "0.1.0"},
            "capabilities": {"tools": {}},
        })
        return

    if method == "notifications/initialized":
        return

    if method == "tools/list":
        respond(msg_id, {"tools": [TOOL]})
        return

    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments", {}) or {}
        if name != TOOL["name"]:
            respond_error(msg_id, -32601, "Unknown tool: " + str(name))
            return
        code = args.get("code", "")
        if not isinstance(code, str) or not code.strip():
            respond(msg_id, {
                "content": [{"type": "text", "text": "(empty code)"}],
                "isError": True,
            })
            return
        result = call_bridge(code)
        ok = bool(result.get("ok", False))
        output = result.get("output", "")
        respond(msg_id, {
            "content": [{"type": "text", "text": output if output else "(no output)"}],
            "isError": not ok,
        })
        return

    if msg_id is not None:
        respond_error(msg_id, -32601, "Method not found: " + method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            handle(msg)
        except Exception as err:
            if msg.get("id") is not None:
                respond_error(msg["id"], -32603, str(err))


if __name__ == "__main__":
    main()
