# Claude Notebook — browser UI

A Jupyter-style notebook in your browser, built around `claude -p`. Mix **Python**, **Markdown**, and **Claude prompt** cells in one document. Prompt cells call Claude (Sonnet by default, Opus optional) and let it execute Python in the *same* live kernel mid-turn via an MCP `python_run` tool — so Claude can inspect `df`, run a quick check, and reason about the result before responding.

Same feature surface as the VS Code extension and JupyterLab piece, in a single HTML page + Python backend with no build step.

## Features

- **Three cell types** — `python` (run in a persistent kernel), `markdown` (rendered in place), `prompt` (calls Claude).
- **Per-cell controls** — model picker (Sonnet/Opus) on prompt cells; include/exclude toggle on python and prompt cells (excluded cells stay in the UI but are dropped from Claude's view of the notebook).
- **In-turn `python_run` (MCP)** — Claude has a `python_run` tool wired to the live notebook kernel via a localhost HTTP bridge with bearer-token auth. Same namespace as your Python cells.
- **Inline streaming transcript** — each prompt cell renders assistant text + tool calls + tool results as they stream in, with model text visually distinct from tool blocks. `ToolSearch` is hidden.
- **Selective turn deletion** — exclude past prompt turns and click **Prune excluded** to rewrite the on-disk session with those turns removed and the `parentUuid` chain re-linked. Original file preserved.
- **Session library** — list and reopen any session in `~/.claude/projects/`, or load a `.jsonl` from disk.
- **Bottom status bar** — `Context: NN%` and `Cost: $0.NNNN` for the live session.

## Why

Claude Code manages conversation history internally — you either get all of it or start fresh. There's no way to selectively remove turns that are eating up your context window. Claude Notebook solves this by exploiting the fact that Claude Code stores sessions as JSONL files at `~/.claude/projects/<project>/`. These files have a simple structure:

- Each message is a JSON line with a `uuid` and `parentUuid` forming a linked chain
- `user`, `assistant`, `system`, and `attachment` types
- Token usage on each assistant message
- A `last-prompt` line pointing to the leaf of the chain

Since `claude -p --resume <session-id>` reads these files directly, you can remove lines, re-link the chain across the gap, write the file back, and resume — that's the underlying trick.

## Architecture

```
Browser (notebook.html)        Python server (server.py)         Claude CLI
       |                                |                              |
       |-- POST /api/python/exec ----->|                              |
       |   { kernelId, code }          |-- writes JSON request to     |
       |                               |   the persistent Python REPL |
       |<-- { ok, output } ------------|                              |
       |                                                              |
       |-- POST /api/run (SSE) ------->|-- claude -p --resume <sid>   |
       |   { sessionId, prompt,        |     --output-format          |
       |     kernelId, model,          |       stream-json --verbose  |
       |     history? }                |     --mcp-config '{kernel:   |
       |                               |       python_server.py with  |
       |                               |       bridge env}'           |
       |                               |     --strict-mcp-config      |
       |                               |     --allowedTools Bash      |
       |                               |       Read Edit Write        |
       |                               |       mcp__kernel__python_run|
       |                               |                              |
       |<-- event: event { stream-json events as they arrive }
       |<-- event: end { sessionId, sessionContent }
       |
       |                              MCP child (mcp/python_server.py)
       |                                       |
       |                                       |  python_run(code) ->
       |                                       |  POST /api/kernel-bridge/run
       |                                       |  Bearer <token>
       |                                       v
       |                                  same persistent Python REPL
       |                                  -> returns { ok, output }
       |
       |-- POST /api/delete-turns ----->|-- prune turns + re-link chain
       |<-- { new sessionId } ---------|
```

**notebook.html** — Single-file React app via CDN, no build step. Cells, transcript, status bar, modals.

**server.py** — Python stdlib HTTP server (threaded). Manages one persistent `PythonKernel` subprocess per `kernelId`, the kernel bridge with per-run bearer tokens, and the SSE stream from `claude -p`.

**mcp/python_server.py** — Standalone MCP stdio server spawned by Claude. Declares `python_run`, forwards each call to the bridge URL via the bearer token Claude was given via env. One-time tokens, unregistered when the run ends.

No dependencies beyond Python 3.9+ and the Claude CLI.

## Setup

```bash
cd ~/Desktop/claude/browser
python3 server.py
# -> Claude Notebook server running at http://localhost:8787/notebook.html
```

Open `http://localhost:8787/notebook.html` in your browser.

## Usage

### Cell types

The notebook starts with one Python cell. Use the `+ Python / + Markdown / + Prompt` bar between cells to insert more. Each cell has a toolbar with:
- run / stop button
- include toggle (◉ / ○) — drops the cell from Claude's view of the notebook in the next prompt
- model picker (prompt cells only)
- move-up / move-down / delete

**Cmd+Enter** in any cell runs it.

### Running a prompt cell

The server resolves session strategy as follows:
- If you already have a `sessionId` (from a prior prompt), `--resume <sid>` so Claude sees real history including tool calls.
- Otherwise, prior **included** Python/markdown/prompt cells are converted into a seeded JSONL session before the run, and `--resume`'d.
- If there's no prior content, `--session-id` starts a fresh session.

Claude is launched with stream-json output. Events stream into the prompt cell's transcript live: assistant text in a blue card, `python_run` calls as a Python block, code-edit tools styled per-tool, tool results matched back by `tool_use_id`. The `python_run` tool runs *in the same kernel* as your Python cells.

### Viewing & loading sessions

- **Sessions** button — list of recent sessions from `~/.claude/projects/`
- **Load** — open any `.jsonl` file
- Loading reduces JSONL into prompt cells with attached transcripts.

### Pruning turns

Mark prompt cells as excluded (○), then click **Prune excluded** in the header. The server rewrites the on-disk session with those turns removed and the `parentUuid` chain re-linked. The original file is preserved; you continue from the pruned session.

### Status bar

Bottom bar shows `Context: NN%`, `Tokens: <used> / <window>`, `Cost: $0.NNNN`, cell count, and session id.

## Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness check |
| `/api/sessions` | GET | List recent sessions in `~/.claude/projects/<cwd>` |
| `/api/session/<sid>` | GET | Read raw JSONL |
| `/api/python/exec` | POST | Run code in the named kernel — `{ kernelId, code } -> { ok, output }` |
| `/api/run` | POST (SSE) | Spawn `claude -p` with stream-json + MCP config; emit `event:` SSE for each line, `end:` with the final sessionId |
| `/api/delete-turns` | POST | Prune turns from a session and re-link parent chain |
| `/api/kernel-bridge/run` | POST (bearer) | Internal — only the spawned MCP child calls this |

## Security notes

- The kernel bridge is on `127.0.0.1` only and requires a per-run bearer token. Tokens are unregistered the moment `claude -p` exits.
- The MCP child gets the URL + token via env vars, never on the command line.
- Anyone who can already read the env of the MCP child can act as it — i.e. local-user trust boundary, same as the rest of the Claude CLI.

## Limitations

- The kernel is a plain `python3` REPL (`exec` in a single global dict). No notebook-style rich display, no IPython magics, no plot rendering — text stdout/stderr only.
- One kernel per browser session; reset clears it.
- Cell deletion in the UI doesn't delete past *messages* on disk — use **Prune excluded** for that.
- `python_run` results persist side effects (assignments, deletes). The tool description tells Claude to prefer non-mutating queries, but it can mutate state.
- Session resume relies on `~/.claude/projects/<cwd-as-dashes>/` — moving the project across machines doesn't carry sessions.

## Files

```
browser/
├── notebook.html         # Frontend — single-file React app
├── server.py             # Backend — Python HTTP server + kernel + SSE
├── mcp/
│   └── python_server.py  # Standalone MCP stdio server (python_run)
└── README.md
```
