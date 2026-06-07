# SADataCopilot

SADataCopilot is a VS Code extension for working with AI agents directly inside Jupyter notebooks.

It adds a **Prompt** cell type to ordinary `.ipynb` files. Prompt cells sit beside Python and Markdown cells, run like normal notebook cells, and can use the same live Python session as the rest of the notebook.

## Objective

SADataCopilot keeps AI assistance inside the notebook workflow. Instead of copying notebook state into a separate chat, users can ask questions in place and let the agent inspect variables, run Python, and reason over results directly in the notebook.

## Key Features

### Prompt Cells

Use the **+ Prompt** toolbar button to add an AI prompt to any Jupyter notebook. Ask questions, request analysis, generate code, or inspect notebook state without leaving the notebook.

### Live Python Execution

Prompt cells can run Python through the same session used by notebook cells. Variables created earlier, such as `df` or `model`, are available to the agent while it responds.

### Inline Results and Tool Transcript

Agent responses appear inline below the prompt cell, along with a readable transcript of tool calls, executed Python, and results.

### Context Awareness

Users can include or exclude cells from the agent's context. Excluded cells still run normally, but the agent will not use them when answering future prompts.

### Multiple Agent Backends

SADataCopilot supports multiple backend options:

| Backend | Description | Requirement |
|---|---|---|
| `copilot` | Uses the GitHub Copilot SDK. This is the default backend. | `npm install -g @github/copilot` |
| `claude` | Runs prompts through the `claude -p` CLI. | `claude` CLI on `PATH` |
| `cursor` | Runs prompts through the Cursor `agent -p` CLI. | `agent` CLI on `PATH` |

Choose the backend from **Settings -> SADataCopilot -> Backend** or by updating `copilotNotebook.backend`.

### Per-Cell Model Selection

Each prompt cell can use its own model setting. Available models depend on the selected backend:

- GitHub Copilot: GPT-5 mini and GPT-5.5 with configurable reasoning effort.
- Claude: Sonnet and Opus.
- Cursor: the configured Cursor agent model.

### Notebook Context Header

The extension maintains a compact header at the top of each notebook showing token usage, estimated cost, prompt turns, and excluded cells.

### Persistent History

For saved notebooks, prompt history and usage information are preserved across reloads.

## Basic Workflow

1. Open a Jupyter notebook in VS Code.
2. Click **+ Prompt** to add a prompt cell.
3. Ask a question or give the agent a task.
4. Run the prompt cell like any other notebook cell.
5. Review the inline answer, tool transcript, and updated context header.

Example prompts:

- "Summarize the dataframe and identify suspicious columns."
- "Check whether the train/test split has label leakage."
- "Plot the distribution of the target variable."
- "Write a Python cell that evaluates this model."
