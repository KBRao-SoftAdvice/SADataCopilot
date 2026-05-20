import * as vscode from 'vscode';
import { OutputInterceptor } from './services/outputInterceptor';
import { SessionStateService } from './services/sessionState';
import { ClaudeNotebookController } from './services/notebookController';
import { CellStatusBarProvider, isPromptCell } from './providers/cellStatusBar';
import { SessionStatusBar } from './providers/statusBar';
import { METADATA_MODEL, METADATA_INCLUDED } from './constants';

export function activate(context: vscode.ExtensionContext): void {
  const interceptor = new OutputInterceptor();
  const sessionState = new SessionStateService();
  const notebookController = new ClaudeNotebookController(sessionState, interceptor, context.extensionUri);
  const statusBar = new CellStatusBarProvider(interceptor);

  interceptor.onPortDiscovered((port) => sessionState.setPort(port));

  context.subscriptions.push(
    vscode.workspace.onDidChangeNotebookDocument(async (e) => {
      statusBar.refresh();

      // VS Code's "+ Code" button inherits the language of the previously
      // focused cell. After running a prompt cell, that lands a new
      // `claude-prompt` code cell where the user expected Python. Detect that
      // case (claude-prompt language but no claude_model metadata, since our
      // own +Prompt always sets it) and flip it to python.
      for (const change of e.contentChanges) {
        for (const cell of change.addedCells) {
          if (cell.kind !== vscode.NotebookCellKind.Code) continue;
          if (cell.document.languageId !== 'claude-prompt') continue;
          if (cell.metadata?.[METADATA_MODEL]) continue;
          await vscode.languages.setTextDocumentLanguage(cell.document, 'python');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', statusBar)
  );

  const sessionStatus = new SessionStatusBar(sessionState);
  context.subscriptions.push(sessionStatus);

  // + Prompt button: empty markdown-language code cell, claude_model metadata only
  context.subscriptions.push(
    vscode.commands.registerCommand('claude.addPromptCell', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) return;

      const insertIndex = editor.selections[0]
        ? editor.selections[0].end
        : editor.notebook.cellCount;

      const cellData = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        '',
        'claude-prompt'
      );
      cellData.metadata = { [METADATA_MODEL]: 'sonnet' };

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

  // Model picker: Opus / Sonnet
  context.subscriptions.push(
    vscode.commands.registerCommand('claude.pickModel', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) return;
      const selection = editor.selections[0];
      if (!selection) return;
      const cell = editor.notebook.cellAt(selection.start);
      if (!isPromptCell(cell)) return;

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
          [METADATA_MODEL]: picked.id
        })
      ]);
      await vscode.workspace.applyEdit(edit);
    })
  );

  // Toggle inclusion
  context.subscriptions.push(
    vscode.commands.registerCommand('claude.toggleCellInclusion', async () => {
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
    vscode.commands.registerCommand('claude.resetSession', () => {
      notebookController.reset();
      vscode.window.showInformationMessage('Claude session state cleared');
    })
  );

  context.subscriptions.push(interceptor, sessionState, notebookController, statusBar);
}

export function deactivate(): void {}
