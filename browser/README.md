# SADataCopilot Browser Notebook

The browser notebook is a standalone web surface for the same agentic notebook workflow used by the VS Code extension. It lets users mix Python, Markdown, and prompt cells in one browser tab, with prompt cells powered by a Node sidecar that drives the GitHub Copilot SDK in BYOK mode.

The browser app is useful for hosted demos, lightweight shared access, and Azure Web App or container deployments where installing a VS Code extension is not the right fit.

## Features

- **Three cell types:** Python cells run in a persistent Python REPL, Markdown cells render in place, and Prompt cells call the agent.
- **Shared Python kernel:** Prompt cells can invoke `python_run`, which executes code in the same kernel namespace as the Python cells.
- **Copilot SDK sidecar:** `server.py` streams requests to `sidecar.mjs`, which manages Copilot SDK sessions, tool calls, history replay, and OpenAI-compatible BYOK model calls.
- **Inline transcript:** Assistant responses, tool calls, Python executions, and results stream back into the prompt cell output.
- **Per-cell context control:** Python and prompt cells can be included or excluded from future prompt context without removing them from the notebook.
- **File sidebar:** The browser lists files in the per-kernel workspace and refreshes after runs.
- **Session widget:** The top-right widget shows context usage, included/excluded turns, and estimated cost.
- **Password gate:** Set `NOTEBOOK_TOKEN=<password>` to protect the UI and API with HTTP Basic auth. `/api/health` remains open for probes.
- **Container-ready:** The browser directory includes a `Dockerfile`, `.dockerignore`, and npm package files for hosted deployment.

## Architecture

```
Browser (notebook.html)        Python server (server.py)        Node sidecar (sidecar.mjs)
       |                                |                                  |
       |-- POST /api/python/exec ----->|                                  |
       |   { kernelId, code }          |-- persistent Python REPL         |
       |<-- { ok, output } ------------|                                  |
       |                                                                   |
       |-- POST /api/run (SSE) ------->|-- JSON request over stdin ------>|
       |   { prompt, kernelId,         |   { requestId, prompt,           |
       |     model, priorRuns,         |     model, kernelId,             |
       |     isExcluded }              |     priorRuns, workspace }        |
       |                                                                   |
       |                                                                   |-- Copilot SDK
       |                                                                   |   provider:
       |                                                                   |   OpenAI-compatible
       |                                                                   |   OPENAI_API_KEY
       |                                                                   |
       |<-- SSE event stream ----------|<-- JSON events over stdout -------|
       |                                                                   |
       |                              /api/kernel-bridge/run <-------------|
       |                              Bearer token + { kernelId, code }    |
       |                              runs python_run in the same REPL      |
```

`server.py` is a Python stdlib HTTP server. It owns the browser API, persistent Python kernels, per-kernel workspaces, Basic auth, and the kernel bridge used by `python_run`.

`sidecar.mjs` is a long-lived Node process. It loads `@github/copilot-sdk`, creates prompt sessions, replays prior included notebook cells, exposes the `python_run` tool, and returns streamed agent events to the Python server.

`notebook.html` is a single-file React app loaded via CDN. It manages cells, transcripts, the file sidebar, context/cost widget, and prompt execution.

## Setup

Install JavaScript dependencies once:

```bash
cd browser
npm install
```

Start the local server:

```bash
OPENAI_API_KEY=<key> python3 server.py
```

Then open `http://localhost:8787/notebook.html`.

Optional settings:

| Setting | Purpose |
|---|---|
| `NOTEBOOK_TOKEN` | Enables HTTP Basic auth for the browser and API. |
| `OPENAI_API_KEY` | Required for prompt cells. Used by the sidecar provider. |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible base URL. Defaults to `https://api.openai.com/v1`. |
| `NOTEBOOK_HOST` | Bind host. Defaults to `127.0.0.1`; container deployments set `0.0.0.0`. |
| `NODE_BIN` | Node executable used to spawn the sidecar. Defaults to `node`. |

Python cells can run without `OPENAI_API_KEY`; prompt cells require it.

## Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness check. Intentionally unauthenticated for probes. |
| `/api/files?kernelId=...` | GET | Lists files in the kernel workspace. |
| `/api/python/exec` | POST | Runs Python in the named kernel. |
| `/api/run` | POST (SSE) | Streams a prompt-cell run through the sidecar. |
| `/api/keepalive` | POST | Keeps an active kernel from being reaped. |
| `/api/kernel-bridge/run` | POST | Internal bridge used by the sidecar's `python_run` tool. |

## Container Hosting

The included `Dockerfile` builds a Python + Node runtime, installs browser npm dependencies, copies the notebook server files, and runs `python3 -u server.py`.

For hosted deployments, provide at least:

```bash
NOTEBOOK_HOST=0.0.0.0
NOTEBOOK_TOKEN=<shared-password>
OPENAI_API_KEY=<key>
```

Do not commit deployment files that contain live URLs, API keys, passwords, or other credentials.

## Files

```
browser/
├── notebook.html       # Browser UI
├── server.py           # Python HTTP server, kernels, auth, SSE
├── sidecar.mjs         # Copilot SDK sidecar process
├── package.json        # Sidecar dependencies
├── Dockerfile          # Container image for hosted use
└── mcp/                # Legacy MCP helper retained in the tree
```
