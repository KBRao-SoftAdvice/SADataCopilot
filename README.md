# Claude tooling

Three frontends for the same idea — a Jupyter-style notebook around `claude -p`, where Python cells and Claude prompt cells share one live Python kernel, and Claude can call `python_run` mid-turn to inspect / mutate that kernel.

| Project | Where it lives | What it is |
|---|---|---|
| Browser notebook | [`browser/`](browser/README.md) | Single-page React app + Python HTTP server. No build step. |
| VS Code extension | [`vscode/`](vscode/README.md) | Notebook controller for `.ipynb` files inside VS Code. |
| JupyterLab | [`jupyter/`](jupyter/README.md) | Custom IPython kernel + JupyterLab extension. |

All three share the same architecture: a **localhost HTTP bridge** with a per-run bearer token, a stdio **MCP server** (`mcp/python_server.py` or `pythonServer.js`) declaring `python_run`, and a **stream-json** pipeline for `claude -p` output rendered as an inline transcript.

## Common features (all three)

- Two cell kinds: **python** (persistent REPL, shared namespace) and **prompt** (calls Claude).
- Per-cell **model picker** (Sonnet / Opus) on prompt cells.
- Per-cell **include toggle** — drops a cell from Claude's view of the notebook without removing it from the UI.
- **In-turn `python_run`** — Claude has an MCP tool wired to the same Python kernel as the notebook, so it can read variables (`df`, `model`, …) and run quick checks before answering.
- **Inline streaming transcript** — assistant text + tool calls + tool results render into one collapsible block per prompt cell as they arrive.
- **Selective turn pruning** — exclude prompt turns and rewrite the on-disk JSONL session, re-linking the `parentUuid` chain across the gap (browser surface; the others rely on cell-level inclusion to compose seed sessions).

See each project's README for source layout and the project-specific quirks.

## How to run each one

Prerequisites for all three: the `claude` CLI installed and authenticated, and Python 3.9+ on your `PATH`.

### Browser notebook

No build step. Just run the server and open the URL:

```bash
cd browser
python3 server.py
# → http://localhost:8787/notebook.html
```

The first cell starts as Python. Use the `+ Python / + Markdown / + Prompt` bar between cells to add more, then **Cmd+Enter** to run.

### VS Code extension

Build, then launch an Extension Development Host:

```bash
cd vscode
npm install                # one-time
npm run compile            # production build  (or `npm run watch` while iterating)
```

Then in VS Code: open the `vscode/` folder and press **F5**. In the new window, open any `.ipynb` file. The extension activates on `onNotebook:jupyter-notebook`. Use the **+ Prompt** toolbar button to add a prompt cell, type a question, and run it like any other cell.

### JupyterLab

Two pieces — the kernel package and the labextension. Both must be installed into the same Python environment that runs `jupyter lab`.

```bash
# 1. Kernel (Python).
cd jupyter
pip install -e .
python -m claude_kernel.install         # registers the `Claude Code` kernel spec

# 2. Labextension (TypeScript).
cd claude_cell_toggle
jlpm install                            # one-time
jlpm run build:prod                     # or `jlpm run watch` while iterating
pip install -e .                        # exposes the built labextension to Jupyter

# 3. Launch.
jupyter lab
```

Open or create a notebook and pick **Claude Code** in the kernel picker. New cells default to **python** (persistent REPL); click the `python` pill on a cell's toolbar to flip it to **prompt**, type a question, and run. The floating ring panel appears in the top-right showing live context % and cost.

Verify the install with:

```bash
jupyter kernelspec list                 # → claude_code
jupyter labextension list               # → claude-cell-toggle … enabled OK
```
