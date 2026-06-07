# SADataCopilot

SADataCopilot is a VS Code extension that brings agentic data work into Jupyter notebooks.

Jupyter notebooks are still one of the most effective ways to explore data because code, prose, and outputs live together in a modular document. Agentic coding tools add a different kind of power: they can reason across context, inspect intermediate results, and handle open-ended requests that would be tedious to spell out step by step.

Most agent interfaces, though, force the user into a chat-first workflow. That is useful for complex tasks, but awkward for normal data analysis, where the work often alternates between simple manual code and higher-level questions. Computing an average should stay a one-line Python cell; investigating a suspicious model result may be a good job for an agent.

SADataCopilot combines both modes. It upgrades ordinary `.ipynb` notebooks with prompt cells that run beside Python and Markdown cells, allowing users to freely mix manual Python execution with agentic prompts in the same notebook and against the same live kernel.

## What It Enables

- **Notebook-native agent prompts:** Add a `Prompt` cell directly inside a Jupyter notebook and run it like any other cell.
- **Shared Python state:** Variables created in Python cells are visible to the agent, and agent tool calls can run Python in the same live session.
- **Mixed human and agent workflow:** Use Python for quick, precise operations and prompts for broader reasoning, debugging, exploration, or code generation.
- **Inline answers and transcripts:** Agent responses, tool calls, Python executions, and results appear under the prompt cell instead of in a separate chat panel.
- **Selective context control:** Include or exclude individual Python and prompt cells from future agent context without deleting your notebook work.
- **Per-cell model selection:** Choose the model for each prompt cell based on the task.
- **Multiple agent backends:** Use GitHub Copilot by default, or switch to Claude or Cursor from VS Code settings.
- **Context and cost visibility:** A compact notebook header shows context usage, token estimates, cost, prompt turns, and excluded cells.
- **Persistent prompt history:** Saved notebooks restore prior prompt outputs, execution order, usage state, and backend history through a sidecar file.

## Core Features

### Prompt Cells

SADataCopilot adds a **+ Prompt** button to VS Code notebooks. Prompt cells sit directly among Python and Markdown cells, so analysis can stay in one document:

1. Load or transform data in Python.
2. Ask the agent to inspect, explain, validate, or extend the analysis.
3. Continue with more Python, another prompt, or Markdown notes.

Prompt cells are useful for tasks such as:

- summarizing a dataframe and identifying suspicious columns
- checking for leakage or inconsistent splits
- generating a plotting or evaluation cell
- explaining an unexpected result
- proposing the next analysis step
- refactoring exploratory code into reusable functions

### Live Kernel Access

The agent is connected to the same Python session used by the notebook. If a Python cell creates `df`, `model`, or `features`, a later prompt can inspect those objects by running Python against the live notebook state.

This keeps the workflow practical: users do not need to serialize data into a prompt, paste outputs into chat, or ask the model to guess what happened in the kernel.

### Context Control

Every executable cell can be included or excluded from the agent's context. Excluding a cell leaves it in the notebook and does not stop it from running; it simply prevents that cell from being sent to the agent on future turns.

This is useful when a notebook contains scratch work, stale experiments, large outputs, or private context that should not influence the next prompt.

### Backend and Model Choices

The VS Code extension supports these backends:

| Backend | Description |
|---|---|
| `copilot` | Default backend using the GitHub Copilot SDK. Supports GPT-5 mini and GPT-5.5 with Medium, High, and XHigh reasoning effort. |
| `claude` | Runs prompt cells through the `claude -p` CLI. Supports Sonnet and Opus. |
| `cursor` | Runs prompt cells through the Cursor `agent -p` CLI. |

The backend is configured with `copilotNotebook.backend`. Model selection is available per prompt cell where the backend supports it.

### Inline Execution Trace

Prompt output is rendered in the notebook cell output area, including:

- assistant text
- reasoning or intent events when provided by the backend
- tool calls
- Python code run by the agent
- tool results
- token and usage information

The notebook remains the source of truth for the analysis instead of scattering state across a separate chat window.

### Notebook Usage Header

SADataCopilot maintains an auto-managed header at the top of each notebook showing:

- current context usage
- token window estimate
- accumulated cost
- number of prompt turns
- number of excluded cells

This makes long-running notebooks easier to manage and helps users decide when to prune context.

### Persistent History

For saved notebooks, SADataCopilot writes a `.copilot-history.json` sidecar file next to the notebook. This lets the extension restore prompt outputs, execution numbering, usage state, and backend-specific conversation history after reopening the notebook.

## Microsoft Products Used

SADataCopilot uses several Microsoft ecosystem products and platforms:

| Product | How SADataCopilot uses it |
|---|---|
| GitHub Copilot SDK | The default agent backend for prompt cells. It lets the VS Code extension run Copilot-powered model turns, stream events, call notebook-aware tools, and support per-cell model choices such as GPT-5 mini and GPT-5.5 reasoning variants. |
| Visual Studio Code extension platform | The primary product surface. SADataCopilot is published as a VS Code extension that integrates with Jupyter notebooks, adds the `Prompt` cell type, contributes notebook toolbar commands, renders inline agent output, and manages per-cell status controls. |
| Azure Web App | The browser notebook can be hosted as a web application on Azure, making the standalone browser surface available beyond a local machine while preserving the same notebook-agent interaction model. The browser package includes a [`Dockerfile`](browser/Dockerfile) for containerized hosting. |

## Project Layout

| Path | Purpose |
|---|---|
| [`vscode/`](vscode/README.md) | Main SADataCopilot VS Code extension for `.ipynb` notebooks. |
| [`browser/`](browser/README.md) | Standalone browser surface for the same notebook-agent idea, backed by a Copilot SDK sidecar. |

The VS Code extension is the primary project surface. The browser implementation is retained as a standalone prototype and reference implementation for the agentic notebook workflow.

## Basic Workflow

1. Install and enable the SADataCopilot extension in VS Code.
2. Open any Jupyter `.ipynb` notebook.
3. Use **+ Prompt** to insert an agent prompt cell.
4. Run Python, Markdown, and Prompt cells in any order.
5. Use include/exclude controls to choose what the agent sees.
6. Review the inline response, tool transcript, and context header.

## Development

See the extension README for setup and development details:

- [VS Code extension README](vscode/README.md)
- [Browser prototype README](browser/README.md)
