import * as vscode from 'vscode';
import { PythonRepl } from '../pythonRepl';

export type SessionMessage = Record<string, unknown> & { uuid?: string; parentUuid?: string | null };

export type CellRunKind = 'python' | 'prompt';

export interface CellRunRecord {
  cellUri: string;
  kind: CellRunKind;
  source: string;
  output: string;
  included: boolean;
  /** Backend-opaque blob carrying whatever a backend needs to splice this turn back into a future session. */
  history?: unknown;
}

export interface PromptRunInput {
  prompt: string;
  model: string;
  /** Optional reasoning-effort hint. Currently used by the Copilot backend
   * for GPT-5.5; ignored by Claude/Cursor. */
  reasoningEffort?: 'medium' | 'high' | 'xhigh';
  isExcluded: boolean;
  /** URI string of the cell currently running. Used by Copilot to track which cells are in the live session. */
  cellUriString: string;
  /** Stable per-notebook key (e.g. notebook URI). Used by Copilot to cache one session per notebook. */
  notebookKey: string;
  /** Prior runs in cell order (excluding the current cell). Backends decide how to use this for resume/replay. */
  priorRuns: CellRunRecord[];
  /** Live notebook kernel — backends close over this for in-process Python tools. */
  repl: PythonRepl;
  cwd: string | undefined;
  abortController: AbortController;
  cancellationToken: vscode.CancellationToken;
}

export interface PromptTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Aggregate input for the bar (input + cache). */
  totalInputForContext?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface SessionFooter {
  filesModified?: number;
  linesAdded?: number;
  linesRemoved?: number;
  totalPremiumRequests?: number;
}

export interface PromptRunResult {
  answerText: string;
  /** Backend-opaque history blob to stash on the run record. */
  history?: unknown;
  errored: boolean;
  cancelled: boolean;
  modelUsed: string;
  contextWindow: number;
  usage: PromptTurnUsage;
  /** Populated from session.shutdown — appended to the token bar footer. */
  footer?: SessionFooter;
}

/**
 * One block of a structured tool result. The Copilot SDK emits these via
 * `ToolExecutionCompleteResult.contents[]` for tools that produce non-text
 * output (images, terminal output, resource links). Keep the union narrow:
 * unknown variants render as JSON text via the fallback.
 */
export type ToolResultBlock =
  | { type: 'text'; text: string }
  | { type: 'terminal'; text: string; exitCode?: number; cwd?: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; title?: string; description?: string; mimeType?: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string }
  | { type: 'diff'; text: string };

/**
 * Render hook the controller passes to the backend so the backend can stream
 * tool calls / assistant text into the same collapsible transcript without
 * needing to know any HTML.
 */
export interface PromptStreamSink {
  appendAssistantText(text: string): Promise<void>;
  appendToolUse(toolName: string, input: unknown): Promise<void>;
  appendPythonRun(code: string): Promise<void>;
  appendToolResult(result: string | ToolResultBlock[]): Promise<void>;
  appendError(text: string): Promise<void>;
  appendReasoning(text: string): Promise<void>;
  appendIntent(text: string): Promise<void>;
  appendPermission(kind: string, summary: string, decision?: string): Promise<void>;
  appendCompaction(text: string): Promise<void>;
  appendSubagent(label: string, body: string): Promise<void>;
  appendWarning(text: string): Promise<void>;
  appendInfo(text: string): Promise<void>;
}

export type BackendId = 'copilot' | 'claude' | 'cursor';

export interface NotebookBackend {
  readonly id: BackendId;
  /** Notebook controller calls this once per prompt cell run. */
  runPromptTurn(input: PromptRunInput, sink: PromptStreamSink): Promise<PromptRunResult>;
  /** Optional cleanup when the controller resets or disposes. */
  dispose?(): void | Promise<void>;
}
