import * as vscode from 'vscode';
import { PromptStreamSink, ToolResultBlock } from './types';

const CODE_TOOLS = new Set(['Bash', 'bash', 'Edit', 'edit', 'Write', 'create', 'str_replace']);

/** Tools rendered as a single inline pill. Optional `label` prefixes the value. */
const INLINE_TOOLS: Record<string, {
  color: string;
  tint: string;
  fg: string;
  field: string[];
  label?: string;
}> = {
  report_intent: { color: '#a855f7', tint: '#faf5ff', fg: '#581c87', field: ['intent'], label: 'Intent' },
  view: { color: '#0ea5e9', tint: '#f0f9ff', fg: '#075985', field: ['path', 'file_path'], label: 'View' },
  // Claude `-p` calls the file-view tool `Read` and the input field is
  // file_path. Same palette as Copilot's `view`.
  Read: { color: '#0ea5e9', tint: '#f0f9ff', fg: '#075985', field: ['file_path', 'path'], label: 'Read' },
  // File search: cyan-ish (sibling of view/read but distinct).
  Glob: { color: '#06b6d4', tint: '#ecfeff', fg: '#155e75', field: ['pattern'], label: 'Glob' },
  Grep: { color: '#06b6d4', tint: '#ecfeff', fg: '#155e75', field: ['pattern'], label: 'Grep' },
  // Web tools — teal/green.
  WebFetch: { color: '#0d9488', tint: '#f0fdfa', fg: '#115e59', field: ['url'], label: 'WebFetch' },
  WebSearch: { color: '#0d9488', tint: '#f0fdfa', fg: '#115e59', field: ['query'], label: 'WebSearch' },
};

/** Tools whose tool_result we suppress in the transcript — the call itself
 * already conveys the relevant information (e.g. `view` shows the path,
 * `report_intent` echoes the input back, `create` shows the file content
 * being written). */
export const SUPPRESS_RESULT_TOOLS = new Set([
  'view', 'report_intent', 'create', 'edit', 'str_replace',
  'Read', 'TodoWrite',
]);

export function buildStreamSink(
  execution: vscode.NotebookCellExecution,
  appendHtmlOutput: (html: string) => Promise<void>,
  setTranscript: (html: string) => void,
  getTranscript: () => string
): PromptStreamSink {
  let lastBlockKind: 'intent' | 'other' | undefined;
  let lastIntentText = '';

  const replace = async (): Promise<void> => {
    await execution.replaceOutput(new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.text(wrapTranscript(getTranscript()), 'text/html')
    ]));
  };
  const appendRaw = async (html: string): Promise<void> => {
    setTranscript(getTranscript() + html);
    await replace();
  };
  const append = async (html: string): Promise<void> => {
    lastBlockKind = 'other';
    await appendRaw(html);
  };
  const appendIntent = async (text: string): Promise<void> => {
    const normalized = text.trim();
    if (!normalized) return;
    if (lastBlockKind === 'intent' && normalized === lastIntentText) return;
    lastBlockKind = 'intent';
    lastIntentText = normalized;
    await appendRaw(renderIntentHtml(normalized));
  };

  return {
    async appendAssistantText(text) { await append(renderAssistantTextHtml(text)); },
    async appendToolUse(toolName, input) {
      if (toolName === 'TodoWrite') await append(renderTodoWriteHtml(input));
      else if (toolName === 'Task') await append(renderTaskHtml(input));
      else if (toolName === 'report_intent') await appendIntent(inlineToolValue(toolName, input));
      else if (INLINE_TOOLS[toolName]) await append(renderInlineToolHtml(toolName, input));
      else if (CODE_TOOLS.has(toolName)) await append(renderCodeToolUseHtml(toolName, input));
      else await append(renderToolUseHtml(toolName, input));
    },
    async appendPythonRun(code) { await append(renderPythonRunUseHtml(code)); },
    async appendToolResult(result) { await append(renderToolResultHtml(result)); },
    async appendError(text) { await append(renderErrorHtml(text)); },
    async appendReasoning(text) { await append(renderReasoningHtml(text)); },
    async appendIntent(text) { await appendIntent(text); },
    async appendPermission(kind, summary, decision) {
      await append(renderPermissionHtml(kind, summary, decision));
    },
    async appendCompaction(text) { await append(renderCompactionHtml(text)); },
    async appendSubagent(label, body) { await append(renderSubagentHtml(label, body)); },
    async appendWarning(text) { await append(renderWarningHtml(text)); },
    async appendInfo(text) { await append(renderInfoHtml(text)); },
  };

  // appendHtmlOutput is unused here but kept in the signature so the controller
  // can pass its existing helper for token-bar/footer output appended outside
  // the transcript.
  void appendHtmlOutput;
}

export function wrapTranscript(inner: string): string {
  return (
    '<details open style="border:1px solid #e2e8f0;border-radius:6px;background:#fff">' +
    '<summary style="cursor:pointer;padding:6px 10px;font-family:monospace;font-size:11px;' +
    'color:#64748b;background:#f8fafc;border-radius:6px 6px 0 0;user-select:none">' +
    '</summary>' +
    '<div style="max-height:600px;overflow-y:auto;padding:8px 12px">' +
    inner +
    '</div>' +
    '</details>'
  );
}

export function renderAssistantTextHtml(text: string): string {
  return (
    '<div style="margin:6px 0;border:2px solid #cbd5e1;' +
    'padding:8px 14px;border-radius:6px">' +
    renderMarkdownHtml(text) +
    '</div>'
  );
}

// Shared style fragments for tool/result/error frames — keeps every block
// visually consistent (3px colored left bar, bold colored label on top, tinted
// body box below).
const PRE_BASE_STYLE =
  'padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap;' +
  'word-break:break-word;margin:0;overflow-x:auto';

interface ToolFrame {
  border: string;
  tint: string;
  fg: string;
  label: string;
  body: string;
}

function renderToolFrame(f: ToolFrame): string {
  return (
    `<div style="margin:8px 0;border-left:3px solid ${f.border};padding:4px 0 4px 10px">` +
    `<div style="font-family:monospace;font-size:11px;color:${f.border};font-weight:600;margin-bottom:4px">` +
    escapeHtml(f.label) +
    '</div>' +
    f.body +
    '</div>'
  );
}

function renderTintedPre(text: string, tint: string, fg: string): string {
  return `<pre style="${PRE_BASE_STYLE};background:${tint};color:${fg}">${escapeHtml(text)}</pre>`;
}

export function renderErrorHtml(text: string): string {
  return renderToolFrame({
    border: '#ef4444',
    tint: '#fef2f2',
    fg: '#991b1b',
    label: 'Error',
    body: renderTintedPre(text, '#fef2f2', '#991b1b'),
  });
}

export function renderToolUseHtml(toolName: string, toolInput: unknown): string {
  // Generic fallback for tools we don't have a dedicated renderer for.
  return renderToolFrame({
    border: '#7c3aed',
    tint: '#f5f3ff',
    fg: '#4c1d95',
    label: toolName,
    body: `<pre style="${PRE_BASE_STYLE};background:#f5f3ff;color:#4c1d95">${escapeHtml(stringifyContent(toolInput))}</pre>`,
  });
}

export function renderCodeToolUseHtml(toolName: string, toolInput: unknown): string {
  // tint = lightest sympathetic shade of `border`; fg = darker shade for body text contrast on the tint.
  const palette: Record<string, { border: string; tint: string; fg: string; tag: string }> = {
    Bash: { border: '#f59e0b', tint: '#fffbeb', fg: '#78350f', tag: 'Bash' },
    bash: { border: '#f59e0b', tint: '#fffbeb', fg: '#78350f', tag: 'Bash' },
    Edit: { border: '#3b82f6', tint: '#eff6ff', fg: '#1e3a8a', tag: 'Edit' },
    edit: { border: '#3b82f6', tint: '#eff6ff', fg: '#1e3a8a', tag: 'Edit' },
    str_replace: { border: '#3b82f6', tint: '#eff6ff', fg: '#1e3a8a', tag: 'Edit' },
    Write: { border: '#10b981', tint: '#ecfdf5', fg: '#065f46', tag: 'Write' },
    create: { border: '#10b981', tint: '#ecfdf5', fg: '#065f46', tag: 'Write' },
  };
  const meta = palette[toolName] || { border: '#7c3aed', tint: '#f5f3ff', fg: '#4c1d95', tag: toolName };
  const description = toolDescription(toolName, toolInput);
  const label = description ? `${meta.tag}: ${description}` : meta.tag;

  let body: string;
  if ((toolName === 'Edit' || toolName === 'edit' || toolName === 'str_replace') && isRecord(toolInput)) {
    const oldString = String(toolInput.old_string || toolInput.old_str || '');
    const newString = String(toolInput.new_string || toolInput.new_str || '');
    body = (oldString || newString)
      ? renderEditDiffHtml(oldString, newString)
      : renderTintedPre(toolCellSource(toolName, toolInput), meta.tint, meta.fg);
  } else {
    body = renderTintedPre(toolCellSource(toolName, toolInput), meta.tint, meta.fg);
  }
  return renderToolFrame({ border: meta.border, tint: meta.tint, fg: meta.fg, label, body });
}

function renderEditDiffHtml(oldString: string, newString: string): string {
  const block = (bg: string, fg: string, sign: string, text: string): string => {
    if (!text) return '';
    const lines = text.split('\n').map((l) => escapeHtml(`${sign} ${l}`)).join('\n');
    return `<pre style="${PRE_BASE_STYLE};background:${bg};color:${fg};margin:0 0 4px 0">${lines}</pre>`;
  };
  return block('#fef2f2', '#991b1b', '-', oldString) + block('#f0fdf4', '#166534', '+', newString);
}

/** Render a unified diff (cursor's editToolCall result diffString) with
 * per-line tinting: red for `-`, green for `+`, slate for hunk headers. */
export function renderUnifiedDiffHtml(diff: string): string {
  if (!diff.trim()) return '';
  const rows = diff.split('\n').map((line) => {
    let bg = 'transparent';
    let fg = '#334155';
    if (line.startsWith('+++') || line.startsWith('---')) {
      bg = '#f1f5f9'; fg = '#64748b';
    } else if (line.startsWith('@@')) {
      bg = '#e2e8f0'; fg = '#475569';
    } else if (line.startsWith('+')) {
      bg = '#f0fdf4'; fg = '#166534';
    } else if (line.startsWith('-')) {
      bg = '#fef2f2'; fg = '#991b1b';
    }
    return `<div style="background:${bg};color:${fg};padding:1px 8px;white-space:pre-wrap;word-break:break-word">${escapeHtml(line) || '&nbsp;'}</div>`;
  }).join('');
  return `<div style="font-family:monospace;font-size:12px;border-radius:6px;overflow:hidden;border:1px solid #e2e8f0">${rows}</div>`;
}

export function renderPythonRunUseHtml(code: string): string {
  const border = '#a78bfa';
  const tint = '#f5f3ff';
  const fg = '#4c1d95';
  return renderToolFrame({
    border,
    tint,
    fg,
    label: 'Python: kernel',
    body: renderTintedPre(code, tint, fg),
  });
}

export function renderInlineToolHtml(toolName: string, toolInput: unknown): string {
  const meta = INLINE_TOOLS[toolName];
  const border = meta?.color || '#7c3aed';
  const tint = meta?.tint || '#f5f3ff';
  const fg = meta?.fg || '#4c1d95';
  const label = meta?.label || toolName;
  const value = inlineToolValue(toolName, toolInput);
  return renderToolFrame({
    border,
    tint,
    fg,
    label,
    body: renderTintedPre(value, tint, fg),
  });
}

function inlineToolValue(toolName: string, toolInput: unknown): string {
  const meta = INLINE_TOOLS[toolName];
  if (isRecord(toolInput) && meta) {
    for (const f of meta.field) {
      const v = toolInput[f];
      if (typeof v === 'string' && v) return v;
    }
  }
  return stringifyContent(toolInput);
}

export function renderTodoWriteHtml(toolInput: unknown): string {
  // TodoWrite payload is { todos: [{ content, activeForm, status }] }.
  // Render as a checklist instead of raw JSON: status icon + content.
  const border = '#0891b2';
  const tint = '#ecfeff';
  const fg = '#155e75';
  const todos = isRecord(toolInput) && Array.isArray(toolInput.todos) ? toolInput.todos : [];
  if (todos.length === 0) {
    return renderToolFrame({
      border, tint, fg, label: 'Todos',
      body: renderTintedPre(stringifyContent(toolInput), tint, fg),
    });
  }
  const rows = todos.map((raw) => {
    if (!isRecord(raw)) return '';
    const status = String(raw.status || 'pending');
    const content = String(raw.content || raw.activeForm || '');
    const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○';
    const color = status === 'completed' ? '#16a34a' : status === 'in_progress' ? '#0891b2' : '#94a3b8';
    const decoration = status === 'completed' ? 'text-decoration:line-through;opacity:0.7' : '';
    return (
      `<div style="display:flex;gap:8px;align-items:flex-start;padding:2px 0">` +
      `<span style="color:${color};font-family:monospace;font-weight:600">${mark}</span>` +
      `<span style="${decoration}">${escapeHtml(content)}</span>` +
      `</div>`
    );
  }).join('');
  const body =
    `<div style="${PRE_BASE_STYLE};background:${tint};color:${fg};font-family:inherit;white-space:normal">` +
    rows +
    `</div>`;
  return renderToolFrame({ border, tint, fg, label: 'Todos', body });
}

export function renderTaskHtml(toolInput: unknown): string {
  // `Task` spawns a subagent. Use the same indigo palette as
  // renderSubagentHtml so the Task call and any later subagent.* events line
  // up visually. Show the subagent_type and description; the long prompt text
  // is hidden behind a <details>.
  const border = '#6366f1';
  const tint = '#eef2ff';
  const fg = '#3730a3';
  const rec = isRecord(toolInput) ? toolInput : {};
  const subtype = typeof rec.subagent_type === 'string' ? rec.subagent_type : '';
  const description = typeof rec.description === 'string' ? rec.description : '';
  const prompt = typeof rec.prompt === 'string' ? rec.prompt : '';
  const label = subtype ? `Task: ${subtype}` : 'Task';
  const head = description ? renderTintedPre(description, tint, fg) : '';
  const promptBlock = prompt
    ? `<details style="margin-top:4px">` +
      `<summary style="cursor:pointer;font-family:monospace;font-size:11px;color:${fg};opacity:0.8">prompt</summary>` +
      renderTintedPre(prompt, tint, fg) +
      `</details>`
    : '';
  return renderToolFrame({
    border, tint, fg, label,
    body: head + promptBlock || renderTintedPre(stringifyContent(toolInput), tint, fg),
  });
}

export function renderToolResultHtml(content: string | ToolResultBlock[]): string {
  // Slate-tinted variant of renderToolFrame so results read as "secondary"
  // next to their preceding tool calls.
  const border = '#94a3b8';
  const tint = '#f1f5f9';
  const fg = '#334155';
  const body = typeof content === 'string'
    ? renderTintedPre(truncate(content, 2000), tint, fg)
    : content.map((b) => renderResultBlock(b, tint, fg)).join('');
  return renderToolFrame({ border, tint, fg, label: 'Result', body });
}

function renderResultBlock(block: ToolResultBlock, tint: string, fg: string): string {
  switch (block.type) {
    case 'text':
      return renderTintedPre(truncate(block.text, 2000), tint, fg);
    case 'diff':
      return renderUnifiedDiffHtml(block.text);
    case 'terminal': {
      const header = block.exitCode !== undefined || block.cwd
        ? `<div style="font-family:monospace;font-size:11px;color:${fg};margin-bottom:4px">` +
          (block.cwd ? `cwd: ${escapeHtml(block.cwd)}` : '') +
          (block.cwd && block.exitCode !== undefined ? ' &nbsp;|&nbsp; ' : '') +
          (block.exitCode !== undefined ? `exit: ${block.exitCode}` : '') +
          '</div>'
        : '';
      // Terminal output reads better on a dark background like a real shell.
      return header +
        `<pre style="${PRE_BASE_STYLE};background:#1e1e2e;color:#cdd6f4">${escapeHtml(truncate(block.text, 4000))}</pre>`;
    }
    case 'image':
      return `<img src="data:${escapeHtml(block.mimeType)};base64,${escapeHtml(block.data)}" ` +
        'style="max-width:100%;border-radius:6px;margin:4px 0" />';
    case 'resource_link': {
      const title = block.title || block.uri;
      const desc = block.description ? `<div style="font-size:11px;color:${fg};opacity:0.8">${escapeHtml(block.description)}</div>` : '';
      return `<div style="${PRE_BASE_STYLE};background:${tint};color:${fg}">` +
        `<a href="${escapeHtml(block.uri)}" style="color:${fg};font-weight:600">${escapeHtml(title)}</a>` +
        desc +
        '</div>';
    }
    case 'resource': {
      const text = block.text || `(binary resource: ${block.uri})`;
      return renderTintedPre(truncate(text, 2000), tint, fg);
    }
  }
}

export function renderReasoningHtml(text: string): string {
  // Reasoning is the model's private chain-of-thought. Style it like the
  // assistant box but dimmed and italic so it reads as secondary content.
  return (
    '<div style="margin:6px 0;border:1px dashed #cbd5e1;' +
    'padding:8px 14px;border-radius:6px;color:#64748b;font-style:italic">' +
    '<div style="font-family:monospace;font-size:11px;color:#94a3b8;font-weight:600;margin-bottom:4px;font-style:normal">' +
    'Thinking' +
    '</div>' +
    renderMarkdownHtml(text) +
    '</div>'
  );
}

export function renderIntentHtml(text: string): string {
  // Same purple palette as the report_intent inline tool — these are the
  // same conceptual signal (agent narrating its plan).
  return renderToolFrame({
    border: '#a855f7',
    tint: '#faf5ff',
    fg: '#581c87',
    label: 'Intent',
    body: renderTintedPre(text, '#faf5ff', '#581c87'),
  });
}

export function renderPermissionHtml(kind: string, summary: string, decision?: string): string {
  // Cyan/teal — distinct from tools (which are warm/cool palette colors)
  // and from results/errors. Decision is appended to the label so the user
  // sees "Permission: shell — approved" once resolved.
  const border = '#0891b2';
  const tint = '#ecfeff';
  const fg = '#155e75';
  const label = decision ? `Permission: ${kind} — ${decision}` : `Permission: ${kind}`;
  return renderToolFrame({
    border,
    tint,
    fg,
    label,
    body: renderTintedPre(summary, tint, fg),
  });
}

export function renderCompactionHtml(text: string): string {
  // Slate, like results — compaction is metadata about the conversation,
  // not user-facing content.
  return renderToolFrame({
    border: '#64748b',
    tint: '#f8fafc',
    fg: '#334155',
    label: 'Compaction',
    body: renderTintedPre(text, '#f8fafc', '#334155'),
  });
}

export function renderSubagentHtml(label: string, body: string): string {
  // Indigo — sits between the violet generic tool color and the purple
  // intent/inline tools, signalling "child agent context".
  return renderToolFrame({
    border: '#6366f1',
    tint: '#eef2ff',
    fg: '#3730a3',
    label,
    body: renderTintedPre(body, '#eef2ff', '#3730a3'),
  });
}

export function renderWarningHtml(text: string): string {
  return renderToolFrame({
    border: '#eab308',
    tint: '#fefce8',
    fg: '#854d0e',
    label: 'Warning',
    body: renderTintedPre(text, '#fefce8', '#854d0e'),
  });
}

export function renderInfoHtml(text: string): string {
  return renderToolFrame({
    border: '#0ea5e9',
    tint: '#f0f9ff',
    fg: '#075985',
    label: 'Info',
    body: renderTintedPre(text, '#f0f9ff', '#075985'),
  });
}

export function renderMarkdownHtml(text: string): string {
  const escaped = escapeHtml(text);
  const withCode = escaped.replace(/```([\s\S]*?)```/g, (_match, code) => {
    return `<pre style="background:#1e1e2e;color:#cdd6f4;padding:12px;border-radius:6px;white-space:pre-wrap">${code}</pre>`;
  });
  return withCode
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim() ? `<p style="margin:6px 0">${paragraph.replace(/\n/g, '<br>')}</p>` : '')
    .join('');
}

export function tokenBarHtml(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}, _model: string, _durationMs?: number, footer?: SessionFooter): string {
  const parts = [
    `in: ${formatNumber(usage.inputTokens || 0)}`,
    usage.cacheReadTokens ? `cached: ${formatNumber(usage.cacheReadTokens)}` : '',
    usage.cacheCreationTokens ? `new_cache: ${formatNumber(usage.cacheCreationTokens)}` : '',
    `out: ${formatNumber(usage.outputTokens || 0)}`,
    usage.costUsd ? `$${usage.costUsd.toFixed(4)}` : '',
    footer?.filesModified ? `${footer.filesModified} file${footer.filesModified === 1 ? '' : 's'}` : '',
    footer && (footer.linesAdded || footer.linesRemoved)
      ? `+${footer.linesAdded || 0}/-${footer.linesRemoved || 0}`
      : '',
    footer?.totalPremiumRequests ? `${footer.totalPremiumRequests} req` : '',
  ].filter(Boolean);
  return (
    '<div style="background:#f1f5f9;border-radius:4px;padding:6px 10px;margin-top:8px;' +
    'font-size:11px;color:#64748b;font-family:monospace">' +
    parts.join(' &nbsp;|&nbsp; ') +
    '</div>'
  );
}

export interface SessionFooter {
  filesModified?: number;
  linesAdded?: number;
  linesRemoved?: number;
  totalPremiumRequests?: number;
}

export function stringifyContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n... (truncated)` : value;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toolDescription(toolName: string, toolInput: unknown): string {
  if (!isRecord(toolInput)) return '';
  if (toolName === 'Bash' || toolName === 'bash') {
    return typeof toolInput.description === 'string' ? toolInput.description : '';
  }
  if (toolName === 'Write' || toolName === 'create') {
    const p = toolInput.file_path || toolInput.path;
    return typeof p === 'string' ? p : '';
  }
  if (toolName === 'Edit' || toolName === 'edit' || toolName === 'str_replace') {
    const oldStr = String(toolInput.old_string || toolInput.old_str || '');
    const newStr = String(toolInput.new_string || toolInput.new_str || '');
    if (!oldStr && !newStr) return '';
    return `${snippet(oldStr)} → ${snippet(newStr)}`;
  }
  return '';
}

function snippet(value: string, max = 20): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + '…';
}

function toolCellSource(toolName: string, toolInput: unknown): string {
  if (!isRecord(toolInput)) return stringifyContent(toolInput);
  if (toolName === 'Bash' || toolName === 'bash') return String(toolInput.command || '');
  if (toolName === 'Edit' || toolName === 'str_replace') {
    const oldString = String(toolInput.old_string || toolInput.old_str || '');
    const newString = String(toolInput.new_string || toolInput.new_str || '');
    return oldString ? `# old:\n${oldString}\n# new:\n${newString}` : stringifyContent(toolInput);
  }
  if (toolName === 'Write' || toolName === 'create') {
    return String(toolInput.content || toolInput.file_text || '');
  }
  return stringifyContent(toolInput);
}
