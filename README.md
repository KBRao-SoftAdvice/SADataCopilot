# Claude tooling

Two frontends for the same idea — a notebook around `claude -p`, where Python cells and Claude prompt cells share one live Python kernel, and Claude can call `python_run` mid-turn to inspect / mutate that kernel.

| Project | Where it lives | What it is |
|---|---|---|
| Browser notebook | [`browser/`](browser/README.md) | Single-page React app + Python HTTP server. No build step. |
| VS Code extension | [`vscode/`](vscode/README.md) | Notebook controller for `.ipynb` files inside VS Code. |

Both share the same architecture: a **localhost HTTP bridge** with a per-run bearer token, a stdio **MCP server** (`mcp/python_server.py` or `pythonServer.js`) declaring `python_run`, and a **stream-json** pipeline for `claude -p` output rendered as an inline transcript.

## Common features

- Two cell kinds: **python** (persistent REPL, shared namespace) and **prompt** (calls Claude).
- Per-cell **model picker** (Sonnet / Opus) on prompt cells.
- Per-cell **include toggle** — drops a cell from Claude's view of the notebook without removing it from the UI.
- **In-turn `python_run`** — Claude has an MCP tool wired to the same Python kernel as the notebook, so it can read variables (`df`, `model`, …) and run quick checks before answering.
- **Inline streaming transcript** — assistant text + tool calls + tool results render into one collapsible block per prompt cell as they arrive.
- **Selective turn pruning** — exclude prompt turns and rewrite the on-disk JSONL session, re-linking the `parentUuid` chain across the gap (browser surface; the others rely on cell-level inclusion to compose seed sessions).

See each project's README for source layout and the project-specific quirks.

## How to run each one

Prerequisites: the `claude` CLI installed and authenticated, and Python 3.9+ on your `PATH`.

### Browser notebook

No build step. Just run the server and open the URL:

```bash
cd browser
python3 server.py
# → http://localhost:8787/notebook.html
```

The first cell starts as a prompt cell. A left sidebar lists files in the per-session workspace; use the `+ Python / + Markdown / + Prompt` bar between cells to add more, then **Cmd+Enter** to run. Set `NOTEBOOK_TOKEN=<password>` to require a browser-native Basic-auth popup (handy when exposing via a tunnel).

### VS Code extension

Build, then launch an Extension Development Host:

```bash
cd vscode
npm install                # one-time
npm run compile            # production build  (or `npm run watch` while iterating)
```

Then in VS Code: open the `vscode/` folder and press **F5**. In the new window, open any `.ipynb` file. The extension activates on `onNotebook:jupyter-notebook`. Use the **+ Prompt** toolbar button to add a prompt cell, type a question, and run it like any other cell.
