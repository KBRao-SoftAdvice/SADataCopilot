import * as vscode from 'vscode';
import { OutputInterceptor } from './services/outputInterceptor';
import { CopilotNotebookController } from './services/notebookController';
import { CellStatusBarProvider, isPromptCell } from './providers/cellStatusBar';
import { ContextHeaderCellManager } from './providers/contextHeaderCell';
import { METADATA_MODEL, METADATA_INCLUDED, METADATA_REASONING_EFFORT } from './constants';
import { getNotebookBackend } from './services/backendResolver';

export function activate(context: vscode.ExtensionContext): void {
  const interceptor = new OutputInterceptor();
  const notebookController = new CopilotNotebookController(interceptor, context.extensionUri);
  const statusBar = new CellStatusBarProvider(interceptor);

  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((doc) => {
      if (doc.notebookType === 'jupyter-notebook') notebookController.clearNotebook(doc);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeNotebookDocument(async (e) => {
      statusBar.refresh();
      // Republish so the global status bar (input-token gauge) reflects
      // inclusion toggles immediately, not just after the next cell run.
      notebookController.refreshState(e.notebook);

      // VS Code's "+ Code" button inherits the language of the previously
      // focused cell. After running a prompt cell, that lands a new
      // `copilot-prompt` code cell where the user expected Python. Detect that
      // case (copilot-prompt language but no copilot_model metadata, since our
      // own +Prompt always sets it) and flip it to python.
      for (const change of e.contentChanges) {
        for (const cell of change.addedCells) {
          if (cell.kind !== vscode.NotebookCellKind.Code) continue;
          if (cell.document.languageId !== 'copilot-prompt') continue;
          if (cell.metadata?.[METADATA_MODEL]) continue;
          await vscode.languages.setTextDocumentLanguage(cell.document, 'python');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', statusBar)
  );

  // Switching backends mid-session leaves stats, prior-run history blobs, and
  // pooled backend processes from the old backend lying around — the next run
  // would mix rate tables and feed the new backend a history blob it can't
  // parse. Reset on change so every notebook starts fresh on the new backend.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('copilotNotebook.backend')) return;
      notebookController.reset();
      statusBar.refresh();
      vscode.window.showInformationMessage(
        'SADataCopilot: backend changed — session state cleared for all notebooks.'
      );
    })
  );

  const contextHeader = new ContextHeaderCellManager(notebookController);
  context.subscriptions.push(contextHeader);

  // Backend is a workspace-level setting (`copilotNotebook.backend`). The
  // command opens the Settings UI focused on it; the cell status-bar model
  // badge already shows which backend the notebook will use.
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot.openBackendSetting', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'copilotNotebook.backend')
    )
  );

  // + Prompt button: empty markdown-language code cell, copilot_model metadata only
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot.addPromptCell', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) return;

      const insertIndex = editor.selections[0]
        ? editor.selections[0].end
        : editor.notebook.cellCount;

      const cellData = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        '',
        'copilot-prompt'
      );
      const backend = getNotebookBackend(editor.notebook);
      if (backend === 'copilot') {
        cellData.metadata = {
          [METADATA_MODEL]: 'gpt-5.5',
          [METADATA_REASONING_EFFORT]: 'medium',
        };
      } else {
        cellData.metadata = { [METADATA_MODEL]: 'sonnet' };
      }

      const edit = new vscode.WorkspaceEdit();
      edit.set(editor.notebook.uri, [
        vscode.NotebookEdit.insertCells(insertIndex, [cellData])
      ]);
      await vscode.workspace.applyEdit(edit);

      const newSelection = new vscode.NotebookRange(insertIndex, insertIndex + 1);
      editor.selections = [newSelection];
      editor.revealRange(newSelection);
    })
  );

  // Per-cell picker. Copilot backend: GPT-5.5 reasoning effort
  // (Medium / High / XHigh). Claude backend: Sonnet / Opus model select.
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot.pickModel', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) return;
      const selection = editor.selections[0];
      if (!selection) return;
      const cell = editor.notebook.cellAt(selection.start);
      if (!isPromptCell(cell)) return;

      const backend = getNotebookBackend(editor.notebook);

      if (backend === 'claude') {
        const current = cell.metadata?.[METADATA_MODEL] || 'sonnet';
        const options = [
          { label: 'Sonnet', description: 'Fast & efficient', id: 'sonnet' },
          { label: 'Opus', description: 'Most capable', id: 'opus' },
        ];
        const picked = await vscode.window.showQuickPick(options, {
          placeHolder: `Current: ${current === 'opus' ? 'Opus' : 'Sonnet'}`,
        });
        if (!picked || picked.id === current) return;
        const edit = new vscode.WorkspaceEdit();
        edit.set(editor.notebook.uri, [
          vscode.NotebookEdit.updateCellMetadata(cell.index, {
            ...cell.metadata,
            [METADATA_MODEL]: picked.id,
          })
        ]);
        await vscode.workspace.applyEdit(edit);
        return;
      }

      // Copilot backend (default). One picker with four entries: GPT-5 mini
      // (default, no reasoning-effort knob) plus the three GPT-5.5 effort
      // variants.
      type CopilotPick = vscode.QuickPickItem & {
        modelId: 'gpt-5-mini' | 'gpt-5.5';
        effort?: 'medium' | 'high' | 'xhigh';
      };
      const currentModel = cell.metadata?.[METADATA_MODEL] === 'gpt-5-mini' ? 'gpt-5-mini' : 'gpt-5.5';
      const currentEffort = cell.metadata?.[METADATA_REASONING_EFFORT];
      const options: CopilotPick[] = [
        { label: 'GPT-5.5 · Medium',    description: 'Default — balanced reasoning',   modelId: 'gpt-5.5', effort: 'medium' },
        { label: 'GPT-5.5 · High',      description: 'More reasoning, slower',         modelId: 'gpt-5.5', effort: 'high'   },
        { label: 'GPT-5.5 · XHigh',     description: 'Maximum reasoning',              modelId: 'gpt-5.5', effort: 'xhigh'  },
        { label: 'GPT-5 mini',          description: 'Fast & cheap',                   modelId: 'gpt-5-mini' },
      ];
      const currentLabel = options.find(
        (o) => o.modelId === currentModel && o.effort === (currentModel === 'gpt-5.5' ? currentEffort : undefined)
      )?.label || options[0].label;
      const picked = await vscode.window.showQuickPick(options, {
        placeHolder: `Current: ${currentLabel}`,
      });
      if (!picked) return;
      if (picked.modelId === currentModel && picked.effort === currentEffort) return;

      const nextMeta: Record<string, unknown> = {
        ...cell.metadata,
        [METADATA_MODEL]: picked.modelId,
      };
      if (picked.effort) {
        nextMeta[METADATA_REASONING_EFFORT] = picked.effort;
      } else {
        delete nextMeta[METADATA_REASONING_EFFORT];
      }
      const edit = new vscode.WorkspaceEdit();
      edit.set(editor.notebook.uri, [
        vscode.NotebookEdit.updateCellMetadata(cell.index, nextMeta)
      ]);
      await vscode.workspace.applyEdit(edit);
    })
  );

  // Toggle inclusion
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot.toggleCellInclusion', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) return;
      const selection = editor.selections[0];
      if (!selection) return;
      const cell = editor.notebook.cellAt(selection.start);
      if (cell.kind !== vscode.NotebookCellKind.Code) return;
      const isPrompt = isPromptCell(cell);
      const isPython = cell.document.languageId === 'python';
      if (!isPrompt && !isPython) return;

      const included = cell.metadata?.[METADATA_INCLUDED] !== false;
      const edit = new vscode.WorkspaceEdit();
      edit.set(editor.notebook.uri, [
        vscode.NotebookEdit.updateCellMetadata(cell.index, {
          ...cell.metadata,
          [METADATA_INCLUDED]: !included
        })
      ]);
      await vscode.workspace.applyEdit(edit);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot.resetSession', () => {
      notebookController.reset();
      vscode.window.showInformationMessage('SADataCopilot: session state cleared');
    })
  );

  context.subscriptions.push(interceptor, notebookController, statusBar);
}

export function deactivate(): void {}
