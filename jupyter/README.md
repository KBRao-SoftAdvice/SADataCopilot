# Claude Notebook — JupyterLab

A custom IPython kernel + JupyterLab extension that turn an ordinary `.ipynb` notebook into a Claude notebook. Two cell kinds live side by side: **python** cells run in a persistent in-process REPL, and **prompt** cells call `claude -p` with a `python_run` MCP tool wired into that *same* REPL. Same feature surface as the [browser](../browser/README.md) and [VS Code](../vscode/README.md) versions.

The JupyterLab piece is two coupled packages:

| Package | Purpose |
|---|---|
| `claude_kernel/` | Python — IPython kernel (`Claude Code`) registered into Jupyter. Runs Python in-process, spawns `claude -p` for prompt cells, hosts the kernel bridge for `python_run`. |
| `claude_cell_toggle/` | TypeScript JupyterLab extension. Adds the per-cell toolbar (kind / model / include), patches `requestExecute` to ship cell metadata to the kernel, and renders the floating context-ring panel. |

## What's new vs. a normal Jupyter notebook

- **Two cell kinds, set per cell** — `claude_cell_kind` metadata flips a cell between `python` (default) and `prompt`. The toolbar pill (`python` / `prompt`) toggles it; the kernel branches on the metadata.
- **Persistent shared Python REPL** — `python` cells exec/eval into a single globals dict. Last-expression auto-print (REPL semantics), so `df.head()` on a line by itself prints the head, just like an IPython prompt.
- **In-turn `python_run`** — when Claude is running a prompt cell, the kernel registers a bearer token and stands up a localhost MCP `python_run` tool. The MCP child (`mcp/python_server.py`) forwards calls back to the *same* REPL, so Claude shares your namespace.
- **Inline streaming transcript** — assistant text + tool calls + tool results render into a single collapsible HTML block per prompt cell run. Tool cells are no longer auto-injected into the notebook (that diverged from the other surfaces).
- **Per-cell model picker (Sonnet / Opus)** — only shown on prompt cells; click to swap.
- **Per-cell include toggle** — drops a cell from the seeded session for the next prompt run, without removing it from the notebook.
- **Floating context-ring panel** — top-right widget showing live `Context: NN%`, total cost, and current model. Powered by an HTTP server inside the kernel; the labextension reads from it every 3s.

## Architecture

```
JupyterLab (browser)                          IPython kernel (ClaudeKernel)
─────────────────────                          ──────────────────────────────
[python cell] — execute ─────────────►   InProcessRepl.run_streaming(code)
                                              -> stdout/stderr -> iopub stream

[prompt cell] — execute ─────────────►   spawn `claude -p` with:
                                              --output-format stream-json
                                              --mcp-config { kernel: python_server.py }
                                              --strict-mcp-config
                                              --allowedTools Bash Read Edit Write
                                                  mcp__kernel__python_run

stream-json events (assistant/user/result)    inline transcript
                                          (display_data + update_display_data
                                           with a transient display_id, so we
                                           do one render and update in place)

                                          MCP child (python_server.py)
                                              ↓ python_run({code})
                                              POST http://127.0.0.1:<bridge>/api/kernel-bridge/run
                                              Bearer <one-time token>
                                              ↓
                                          ClaudeKernel._BridgeHandler
                                              ↓
                                          InProcessRepl.run_capturing(code)
                                              ↓
                                          { ok, output }  → back to Claude
```

The kernel bridge is a tiny stdlib `HTTPServer` on a random port, started in a daemon thread when the kernel boots. Per-run bearer tokens are registered before spawning `claude -p` and unregistered the moment the run finishes (success, error, or cancel).

## Cell metadata

| Key | Type | Default | Where it lives |
|---|---|---|---|
| `claude_cell_kind` | `'python' \| 'prompt'` | `'python'` | Cell metadata; flipped by toolbar |
| `claude_model` | `'sonnet' \| 'opus'` | `'sonnet'` | Cell metadata; only relevant for prompt cells |
| `claude_included` | `bool` | `true` | Cell metadata; drops cell from Claude's view of the notebook |
| `claude_tokens` | `int` | unset | Cell metadata; written by the kernel after a prompt run, displayed in the include pill |

The labextension intercepts every kernel `requestExecute` and prepends a small JSON envelope so the kernel knows the cell's metadata without round-tripping through comms:

```
__CLAUDE_CELL__{"kind":"prompt","model":"sonnet","turnIndex":3}__
<original cell source>
```

The envelope is stripped by the kernel before executing. Magic commands (`%session`, `%reset`, `%cd <path>`, `%cost`, `%panel`, `%help`) and legacy `__PYTHON__` / `#%claude:opus` prefixes still work.

## Source layout

```
jupyter/
├── pyproject.toml                          # claude-kernel package
├── README.md
├── mcp/
│   └── python_server.py                    # standalone MCP stdio server (python_run)
├── claude_kernel/                          # Python IPython kernel
│   ├── __init__.py
│   ├── __main__.py                         # IPKernelApp.launch_instance(kernel_class=ClaudeKernel)
│   ├── kernel.json                         # registered kernel spec
│   ├── kernel.py                           # ClaudeKernel + InProcessRepl + bridge HTTP server + renderers
│   └── install.py                          # `python -m claude_kernel.install` to register the spec
└── claude_cell_toggle/                     # JupyterLab extension (TypeScript)
    ├── pyproject.toml
    ├── package.json
    ├── src/index.ts                        # toolbar, requestExecute interception, ring panel
    ├── style/base.css
    └── claude_cell_toggle/                 # built labextension assets (output of build)
```

## Setup

Both packages need to be installed once.

```bash
cd ~/Desktop/claude/jupyter

# 1. Install the kernel package (Python).
pip install -e .
python -m claude_kernel.install            # registers `claude_code` kernel spec for current user

# 2. Build & install the labextension (TypeScript).
cd claude_cell_toggle
jlpm install                                # one-time
jlpm run build:prod                         # or `jlpm run watch` while iterating
pip install -e .                            # picks up the labextension

# 3. Launch JupyterLab as usual.
jupyter lab
```

Open or create a notebook, then in the kernel picker choose **Claude Code**. The first cell defaults to a Python cell — type `import pandas as pd; df = pd.DataFrame(...)`, run it, then click `python` on the next cell's toolbar to flip it to `prompt`, type "what does df look like?", and run.

## How a prompt cell run works

1. The labextension intercepts `kernel.requestExecute` on the active cell, reads `claude_cell_kind`, `claude_model`, and the cell's prompt-turn index, and prepends `__CLAUDE_CELL__{...}__\n` to the cell source.
2. The kernel parses the envelope, dispatches on `kind`. For `prompt`:
   - Builds a fresh JSONL session from prior **included** prompt-cell turns and writes it to `~/.claude/projects/<cwd>/<sid>.jsonl` (or starts a fresh session if there's no history).
   - Registers a per-run bearer token on the bridge.
   - Spawns `claude -p --resume <sid> --output-format stream-json --verbose --mcp-config '{...}' --strict-mcp-config --allowedTools Bash Read Edit Write mcp__kernel__python_run <preamble + prompt>`.
3. `mcp/python_server.py` is launched as the MCP stdio child. Its env carries `KERNEL_BRIDGE_URL` and `KERNEL_BRIDGE_TOKEN`. When Claude calls `python_run({code})`, the child POSTs to `http://127.0.0.1:<bridge>/api/kernel-bridge/run` with the token. The kernel routes the call to `InProcessRepl.run_capturing(code)` and returns `{ ok, output }`. Claude sees the captured stdout/stderr and can keep reasoning.
4. As stream-json events arrive, the kernel renders them into a single transcript HTML string with a transient `display_id` and updates it in place via `update_display_data` — the UI sees one block grow as the run progresses, not N stacked outputs.
5. After the CLI exits, the bridge token is unregistered (always — `try/finally`), the temporary session JSONL is cleaned up, and a token-usage bar is appended below the transcript.

## Magic commands

In any cell (whether `python` or `prompt`), a line starting with `%` is treated as a kernel magic:

| Magic | Effect |
|---|---|
| `%session` | Show turn count, excluded count, total cost, cwd |
| `%reset` | Clear stored turns and cost (does *not* affect on-disk session files) |
| `%cd <path>` | Change kernel working directory (also affects where session JSONL lives) |
| `%cost` | Show total cost so far |
| `%panel` | Re-inject the floating context-ring panel |
| `%help` | Quick help |

## Limitations / notes

- The Python REPL is **in-process** — `ClaudeKernel` itself is the Python interpreter that runs your code. That gives instant access for `python_run` (no IPC), but means an unhandled exception in user code is caught and printed but *cannot* take down the kernel.
- One REPL per kernel; there's no per-notebook isolation.
- `python_run` persists side effects (assignments, deletes). The tool description tells Claude to prefer non-mutating queries unless explicitly asked otherwise.
- The bridge is bound to `127.0.0.1` and gated by a per-run bearer token, but it's still a local-user trust boundary — anyone who can read the MCP child's env can call the bridge.
- Cell deletion in JupyterLab does not delete past *messages* on disk. To prune past turns, use the [browser notebook](../browser/README.md) and its **Prune excluded** action — the on-disk session files are interchangeable.
- The `language` field in `kernel.json` is `python`, so JupyterLab uses the Python syntax highlighter and the Monaco IntelliSense for `python` cells. Prompt cells are still Python from JupyterLab's POV; the kernel's envelope is what makes them be sent to Claude instead.
