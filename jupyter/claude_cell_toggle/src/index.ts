import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { Cell } from '@jupyterlab/cells';
import '../style/base.css';

const META_INCLUDED = 'claude_included';
const META_KIND = 'claude_cell_kind'; // 'python' | 'prompt'
const META_MODEL = 'claude_model'; // 'sonnet' | 'opus'
const COMM_TARGET = 'claude_cell_toggle';

let panelCreated = false;

function createFloatingPanel(port: number): void {
  if (panelCreated) return;
  if (document.getElementById('claude-panel')) return;
  panelCreated = true;

  const base = `http://127.0.0.1:${port}`;
  const C = 251.3;

  const panel = document.createElement('div');
  panel.id = 'claude-panel';
  panel.innerHTML = `
    <div id="ck-ring-wrap">
      <svg id="ck-ring-svg" viewBox="0 0 100 100" width="90" height="90">
        <circle id="ck-ring-bg" cx="50" cy="50" r="40"
          fill="none" stroke="#e2e8f0" stroke-width="7"/>
        <circle id="ck-ring-fg" cx="50" cy="50" r="40"
          fill="none" stroke="#10b981" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="251.3" stroke-dashoffset="251.3"
          transform="rotate(-90 50 50)"
          style="transition: stroke-dashoffset 0.6s ease, stroke 0.3s"/>
        <text id="ck-ring-text" x="50" y="46"
          font-size="13" font-weight="700" fill="#334155"
          text-anchor="middle" dominant-baseline="central">0%</text>
        <text id="ck-ring-sub" x="50" y="60"
          font-size="9" fill="#94a3b8"
          text-anchor="middle" dominant-baseline="central">0 / 0k</text>
      </svg>
      <div id="ck-cost">$0.0000</div>
      <div id="ck-model"></div>
    </div>
  `;

  Object.assign(panel.style, {
    position: 'fixed',
    top: '60px',
    right: '16px',
    zIndex: '9999',
    background: 'white',
    border: '1px solid #e2e8f0',
    borderRadius: '16px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.10)',
    fontFamily: '-apple-system, sans-serif',
    fontSize: '12px',
    overflow: 'hidden',
    width: '180px',
    userSelect: 'none'
  });

  const wrap = panel.querySelector('#ck-ring-wrap') as HTMLElement;
  if (wrap) {
    Object.assign(wrap.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '14px 12px 10px'
    });
  }

  const costEl = panel.querySelector('#ck-cost') as HTMLElement;
  if (costEl) {
    Object.assign(costEl.style, {
      marginTop: '8px',
      fontFamily: 'monospace',
      fontSize: '13px',
      fontWeight: '600',
      color: '#334155',
      textAlign: 'center'
    });
  }

  const modelEl = panel.querySelector('#ck-model') as HTMLElement;
  if (modelEl) {
    Object.assign(modelEl.style, {
      marginTop: '2px',
      fontSize: '10px',
      color: '#94a3b8',
      textAlign: 'center'
    });
  }

  document.body.appendChild(panel);

  function colorForPct(p: number): string {
    if (p < 0.5) return '#10b981';
    if (p < 0.75) return '#f59e0b';
    return '#ef4444';
  }

  async function refresh(): Promise<void> {
    try {
      const r = await fetch(base + '/api/session');
      const d = await r.json();
      const used = d.inputTokens || 0;
      const win = d.contextWindow || 200000;
      const pct = Math.min(used / win, 1);
      const fg = document.getElementById('ck-ring-fg');
      if (fg) {
        fg.style.strokeDashoffset = String(C * (1 - pct));
        fg.style.stroke = colorForPct(pct);
      }
      const ringText = document.getElementById('ck-ring-text');
      if (ringText) ringText.textContent = Math.round(pct * 100) + '%';
      const usedK = (used / 1000).toFixed(used >= 10000 ? 0 : 1);
      const winK = (win / 1000).toFixed(0);
      const ringSub = document.getElementById('ck-ring-sub');
      if (ringSub) ringSub.textContent = usedK + 'k / ' + winK + 'k';
      const cost = document.getElementById('ck-cost');
      if (cost) cost.textContent = '$' + (d.totalCost || 0).toFixed(4);
      const mdl = document.getElementById('ck-model');
      if (mdl) mdl.textContent = d.model || '';
    } catch (_e) {
      // server not ready yet
    }
  }

  refresh();
  setInterval(refresh, 3000);
}

function getKind(cell: Cell): 'python' | 'prompt' {
  const v = cell.model.getMetadata(META_KIND);
  return v === 'prompt' ? 'prompt' : 'python';
}

function getIncluded(cell: Cell): boolean {
  return cell.model.getMetadata(META_INCLUDED) !== false;
}

function getModel(cell: Cell): 'sonnet' | 'opus' {
  const v = cell.model.getMetadata(META_MODEL);
  return v === 'opus' ? 'opus' : 'sonnet';
}

function formatTokens(n: number): string {
  if (n <= 0) return '';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

function ensureToolbar(cell: Cell, panel: NotebookPanel): void {
  if (cell.node.querySelector('.claude-cell-toolbar')) {
    refreshToolbar(cell);
    return;
  }
  if (cell.model.getMetadata(META_INCLUDED) === undefined) {
    cell.model.setMetadata(META_INCLUDED, true);
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'claude-cell-toolbar';

  const kindBtn = document.createElement('button');
  kindBtn.className = 'claude-pill claude-pill-kind';
  kindBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  kindBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const next = getKind(cell) === 'prompt' ? 'python' : 'prompt';
    cell.model.setMetadata(META_KIND, next);
  });

  const modelBtn = document.createElement('button');
  modelBtn.className = 'claude-pill claude-pill-model';
  modelBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    cell.model.setMetadata(META_MODEL, getModel(cell) === 'sonnet' ? 'opus' : 'sonnet');
  });

  const includeBtn = document.createElement('button');
  includeBtn.className = 'claude-pill claude-pill-include';
  includeBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  includeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    cell.model.setMetadata(META_INCLUDED, !getIncluded(cell));
  });

  toolbar.appendChild(kindBtn);
  toolbar.appendChild(modelBtn);
  toolbar.appendChild(includeBtn);

  const inputWrapper = cell.node.querySelector('.jp-Cell-inputWrapper');
  if (inputWrapper) {
    inputWrapper.insertBefore(toolbar, inputWrapper.firstChild);
  }

  cell.model.metadataChanged.connect(() => {
    refreshToolbar(cell);
    sendInclusionState(panel);
  });

  refreshToolbar(cell);
}

function refreshToolbar(cell: Cell): void {
  const toolbar = cell.node.querySelector('.claude-cell-toolbar');
  if (!toolbar) return;
  const kindBtn = toolbar.querySelector('.claude-pill-kind') as HTMLButtonElement | null;
  const modelBtn = toolbar.querySelector('.claude-pill-model') as HTMLButtonElement | null;
  const includeBtn = toolbar.querySelector('.claude-pill-include') as HTMLButtonElement | null;
  if (!kindBtn || !modelBtn || !includeBtn) return;

  const kind = getKind(cell);
  const model = getModel(cell);
  const included = getIncluded(cell);

  kindBtn.textContent = kind === 'prompt' ? 'prompt' : 'python';
  kindBtn.title = `Cell kind: ${kind} (click to switch)`;
  kindBtn.setAttribute('data-kind', kind);

  modelBtn.textContent = model;
  modelBtn.title = `Model: ${model} (click to swap)`;
  modelBtn.style.display = kind === 'prompt' ? '' : 'none';

  const tokens = cell.model.getMetadata('claude_tokens') as number | undefined;
  includeBtn.textContent = included ? (tokens ? formatTokens(tokens) : 'in') : 'out';
  includeBtn.title = included
    ? 'Included in session — click to exclude'
    : 'Excluded from session — click to include';
  includeBtn.setAttribute('data-included', String(included));

  cell.node.setAttribute('data-claude-kind', kind);
  if (included) {
    cell.node.removeAttribute('data-claude-excluded');
  } else {
    cell.node.setAttribute('data-claude-excluded', 'true');
  }
}

function sendInclusionState(panel: NotebookPanel): void {
  const notebook = panel.content;
  const kernel = panel.sessionContext?.session?.kernel;
  if (!kernel || !notebook.model) return;

  const state: boolean[] = [];
  for (const cell of notebook.widgets) {
    if (getKind(cell) !== 'prompt') continue;
    state.push(getIncluded(cell));
  }

  try {
    const comm = kernel.createComm(COMM_TARGET);
    comm.open({});
    comm.send({ inclusion: state });
    comm.close({});
  } catch (_e) {
    // kernel may not have registered the target yet
  }
}

function getPromptTurnIndex(panel: NotebookPanel, target: Cell): number {
  let idx = 0;
  for (const cell of panel.content.widgets) {
    if (getKind(cell) !== 'prompt') continue;
    if (cell === target) return idx;
    idx++;
  }
  return idx;
}

function addToolbarsToCells(panel: NotebookPanel): void {
  const notebook = panel.content;

  function processAll(): void {
    for (const cell of notebook.widgets) {
      ensureToolbar(cell, panel);
    }
  }

  panel.context.ready.then(() => {
    processAll();
    notebook.model!.cells.changed.connect(() => {
      setTimeout(processAll, 50);
    });
  });
}

function setupPanelPortListener(panel: NotebookPanel): void {
  const notebook = panel.content;
  panel.context.ready.then(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;

          const portEls = node.classList?.contains('claude-panel-port')
            ? [node]
            : Array.from(node.querySelectorAll('.claude-panel-port'));
          for (const pel of portEls) {
            const portStr = pel.getAttribute('data-port');
            if (portStr) {
              createFloatingPanel(parseInt(portStr, 10));
            }
            pel.remove();
          }

          const tokenEls = node.classList?.contains('claude-token-payload')
            ? [node]
            : Array.from(node.querySelectorAll('.claude-token-payload'));
          for (const tel of tokenEls) {
            const raw = tel.getAttribute('data-claude-tokens');
            if (raw) {
              const tokens = parseInt(raw, 10);
              if (tokens > 0) {
                const active = notebook.activeCell;
                if (active) active.model.setMetadata('claude_tokens', tokens);
              }
            }
            tel.remove();
          }
        }
      }
    });
    observer.observe(notebook.node, { childList: true, subtree: true });
  });
}

function setupExecuteInterception(panel: NotebookPanel): void {
  function patchKernel(): void {
    const kernel = panel.sessionContext.session?.kernel;
    if (!kernel) return;
    if ((kernel as unknown as { _claudePatched?: boolean })._claudePatched) return;
    (kernel as unknown as { _claudePatched?: boolean })._claudePatched = true;

    const origReqExec = kernel.requestExecute.bind(kernel);
    kernel.requestExecute = (content, disposeOnDone?, metadata?) => {
      const cell = panel.content.activeCell;
      if (
        cell &&
        content.code &&
        !content.code.startsWith('%') &&
        !content.code.startsWith('__CLAUDE_CELL__')
      ) {
        const kind = getKind(cell);
        const envelope: Record<string, unknown> = { kind };
        if (kind === 'prompt') {
          envelope.model = getModel(cell);
          envelope.turnIndex = getPromptTurnIndex(panel, cell);
        }
        const prefix = '__CLAUDE_CELL__' + JSON.stringify(envelope) + '__\n';
        content = { ...content, code: prefix + content.code };
      }
      return origReqExec(content, disposeOnDone, metadata);
    };
  }

  patchKernel();
  panel.sessionContext.sessionChanged.connect(() => patchKernel());
  panel.sessionContext.kernelChanged.connect(() => patchKernel());
  panel.context.ready.then(() => patchKernel());
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'claude-cell-toggle:plugin',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('Claude Cell Toggle activated');

    app.commands.addCommand('claude-cell-toggle:toggle-include', {
      label: 'Toggle Claude Cell Inclusion',
      execute: () => {
        const p = tracker.currentWidget;
        if (!p) return;
        const cell = p.content.activeCell;
        if (!cell) return;
        cell.model.setMetadata(META_INCLUDED, !getIncluded(cell));
      }
    });

    app.commands.addCommand('claude-cell-toggle:toggle-kind', {
      label: 'Toggle Claude Cell Kind (python/prompt)',
      execute: () => {
        const p = tracker.currentWidget;
        if (!p) return;
        const cell = p.content.activeCell;
        if (!cell) return;
        cell.model.setMetadata(META_KIND, getKind(cell) === 'prompt' ? 'python' : 'prompt');
      }
    });

    tracker.widgetAdded.connect(
      (_sender: INotebookTracker, p: NotebookPanel) => {
        addToolbarsToCells(p);
        setupPanelPortListener(p);
        setupExecuteInterception(p);
      }
    );

    if (tracker.currentWidget) {
      addToolbarsToCells(tracker.currentWidget);
      setupPanelPortListener(tracker.currentWidget);
      setupExecuteInterception(tracker.currentWidget);
    }
  }
};

export default plugin;
