# Claude Notebook — VS Code extension

A Jupyter-style notebook inside VS Code where Python cells, Markdown cells, and **Claude prompt cells** live side by side. Prompt cells call Claude (Sonnet by default, Opus optional) and let it execute Python in the *same* notebook kernel mid-turn — so Claude can inspect `df`, run a quick check, and reason about the result before responding.

## What it adds on top of a normal Jupyter notebook

- **`+ Prompt` toolbar button** — inserts a `claude-prompt` cell. Run it like any other cell; output appears inline.
- **Per-cell model picker** — pick Sonnet or Opus per prompt cell from the cell status bar.
- **Per-cell inclusion toggle** — exclude a Python or prompt cell from Claude's view of the notebook (the cell still runs locally; Claude just doesn't see it).
- **In-turn Python execution** — Claude has a `python_run` MCP tool wired into the live kernel. Same namespace as your Python cells: variables you defined (e.g. `df`, `model`) are accessible.
- **Inline tool transcript** — every assistant message, tool call, and tool result renders into one collapsible scrollable block per cell run, with model text visually distinct from tool blocks.
- **Bottom status bar** — shows `Context: NN%` and `Cost: $0.NNNN` for the live session, always visible while scrolling. Tooltips show exact token counts and dollar amounts.

## Architecture

```
VS Code notebook                     Extension host                       Claude CLI
─────────────────                    ──────────────                       ──────────
[Python cell]   ─── execute ───►   PythonRepl (ipykernel)   ◄─── stdin ── (separate)

[Prompt cell]   ─── execute ───►   ClaudeNotebookController
                                       │
                                       │  spawns:
                                       │   claude -p --resume <sid>
                                       │     --output-format stream-json
                                       │     --mcp-config { ... }
                                       │     --strict-mcp-config
                                       │     --allowedTools Bash Read Edit
                                       │       Write mcp__kernel__python_run
                                       ▼
                                  stream-json events                  Claude CLI
                                       │                                  │
                                  ┌────┴────────┐    spawns MCP child:    │
                                  │             │
                                  ▼             ▼     mcp/pythonServer.js (stdio MCP)
                          renderToolUse/    on `tool_use` for                 │
                          renderToolResult  python_run, child posts to:       │
                                                                              │
                                            KernelBridge (localhost HTTP)     │
                                                  │                           │
                                                  ▼                           │
                                            PythonRepl.run(code)              │
                                                  │                           │
                                                  ▼                           │
                                            stdout/stderr  ──── HTTP ◄────────┘
                                                              200 { ok, output }
                                                              ──── back to MCP child
                                                              ──── back to Claude
```

Key idea: **the MCP `python_run` tool runs in a child process** (Claude CLI spawns it as stdio MCP), but it forwards the Python code over a localhost HTTP bridge into the **live notebook kernel** running in the extension host. Bearer-token auth on the bridge so a leaked token can't be reused after a run finishes.

## Source layout

```
vscode/
├── package.json                    # cmds, language registration, jupyter-notebook activation
├── language-configuration.json     # claude-prompt language config
├── syntaxes/claude.tmLanguage.json # claude-prompt grammar (markdown-derived)
├── mcp/
│   └── pythonServer.js             # standalone MCP stdio server: declares python_run, forwards to bridge
├── src/
│   ├── extension.ts                # activate(): wire up controller, status bar, cmds, language flip
│   ├── constants.ts                # METADATA_MODEL, METADATA_INCLUDED
│   ├── types.ts                    # SessionState
│   ├── providers/
│   │   ├── cellStatusBar.ts        # per-cell: model picker, include toggle, isPromptCell()
│   │   └── statusBar.ts            # bottom-bar Context %/Cost $
│   └── services/
│       ├── notebookController.ts   # NotebookController; runs python and prompt cells; stream-json renderer
│       ├── pythonRepl.ts           # ipykernel harness; one REPL per notebook
│       ├── kernelBridge.ts         # localhost HTTP bridge with bearer-token auth
│       ├── sessionState.ts         # polls session info (cost/tokens) via http
│       └── outputInterceptor.ts    # captures port from CLI to talk to running session
└── renderer/
    └── renderer.ts                 # text/html cell-output renderer (sandbox webview)
```

## How a prompt cell run works (step by step)

1. User runs a `claude-prompt` cell.
2. `ClaudeNotebookController._executePromptCell` builds the prompt by walking notebook cells, including only those whose `claude_included !== false`. Markdown cells become text; Python cells become fenced code blocks; prior prompt cells become prior assistant turns.
3. `KernelBridge.start()` ensures a localhost HTTP server is listening on a random port. `register({ repl })` returns a single-use bearer token bound to *this* notebook's `PythonRepl`.
4. The controller spawns `claude -p` with:
   - `--output-format stream-json --verbose`
   - `--mcp-config '{"mcpServers":{"kernel":{"command":<node>,"args":["mcp/pythonServer.js"],"env":{KERNEL_BRIDGE_URL,KERNEL_BRIDGE_TOKEN}}}}'`
   - `--strict-mcp-config`
   - `--allowedTools Bash Read Edit Write mcp__kernel__python_run`
5. The MCP child (`pythonServer.js`) speaks stdio JSON-RPC to the CLI. When Claude calls `python_run`, the child POSTs `{ code }` with the bearer token to the bridge URL. The bridge looks up the registration, runs `repl.run(code, …)`, and returns `{ ok, output }` — Claude sees stdout/stderr immediately and can continue reasoning.
6. The controller streams `assistant` / `user` events out of the CLI, routing each block:
   - `text` → blue "Claude" card (no header label).
   - `tool_use` → call card; `python_run` rendered as a Python block, code-edit tools rendered specially, others generic. `ToolSearch` is hidden entirely.
   - `tool_result` → result card matched back to its tool by `tool_use_id`. For `python_run`, only the text portion is shown (not the raw JSON envelope).
7. All blocks accumulate into a single transcript HTML buffer; the cell output is updated with one `replaceOutput` per delta wrapped in a `<details open>` 600px-tall scroll container — collapsible and scrollable, but unified.
8. After the CLI exits (success, error, or cancel), the bridge token is unregistered in a `finally` block.

## The `claude-prompt` language

Prompt cells use a custom registered language id `claude-prompt` (with a markdown-derived TextMate grammar). Reasons:

- The Jupyter serializer was converting prompt cells back to *markdown cells* on save/reload when their language was `markdown`. A custom language id breaks that round-trip — it stays a code cell.
- VS Code's `+ Code` button inherits the language of the previously focused cell. After running a prompt cell, the new code cell would land as `claude-prompt`. Fix: `onDidChangeNotebookDocument` watches for newly added `claude-prompt` cells with no `claude_model` metadata (our own `+ Prompt` always sets it) and flips them to `python` via `vscode.languages.setTextDocumentLanguage`.

## Cell metadata

Two fields stored on cell metadata:

- `claude_model`: `'sonnet' | 'opus'` — only on prompt cells. Drives the per-cell picker and signals "this is a prompt cell" even before a language is assigned.
- `claude_included`: `boolean` (default true) — when `false`, the cell is hidden from Claude's view of the notebook in the next prompt. It still runs locally.

`isPromptCell(cell)` recognizes a prompt cell by either `languageId === 'claude-prompt'`, `claude_model` metadata, or a `#%claude:` text prefix (legacy).

## Status bar

`SessionStatusBar` (`src/providers/statusBar.ts`) creates two left-aligned items:

- `Context: NN%` — tooltip: `<used> / <window> tokens`
- `Cost: $0.NNNN` — tooltip: `$0.NNNN`

Updates come from `SessionStateService`, which polls `http://127.0.0.1:<port>/api/session` on the running Claude CLI session.

## Dev / build

```bash
cd ~/Desktop/claude/vscode
npm install
npm run compile           # production build
npm run watch             # dev build with file watching
```

Then in VS Code: open the `vscode/` folder, press F5 to launch an Extension Development Host. Open any `.ipynb` file (the extension activates on `onNotebook:jupyter-notebook`), use **+ Prompt** in the toolbar to add a prompt cell, type a question, and run it like a normal cell.

## Limitations / notes

- One Python REPL (`ipykernel`) per notebook, started lazily on first run.
- The kernel bridge is bound to `127.0.0.1` only and gated by per-run bearer tokens; tokens are unregistered when the run ends.
- `python_run` results persist side effects (assignments, deletes). The tool description tells Claude to prefer non-mutating queries unless explicitly asked otherwise — but it can still mutate state, by design.
- `mcp__kernel__python_run` is the only kernel tool exposed; Claude's allowed tools are `Bash`, `Read`, `Edit`, `Write`, plus `python_run`. `ToolSearch` is silently filtered from the transcript.
- Session resume is per-notebook: the controller passes `--resume <sessionId>` after the first run so multi-turn prompt cells share history.
