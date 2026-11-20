// Process is a view of the saved business records; details stay behind disclosure.
let currentProcess = null;
function processText(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function processStatus(flow) { return flow.status || 'unverified'; }
function processStatusLabel(flow) { const value = processStatus(flow); return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' '); }
function processName(name) { return String(name).replace(/^DRAFT PARTIAL\s*[—–-]\s*/i, ''); }
// Same rendering boundary as CIG's DrawioOrgChart: mxGraph XML -> GraphViewer.
let processViewerLoading;
let activeProcessGraph = null;
let processRenderVersion = 0;
function loadProcessViewer() {
  return processViewerLoading ??= new Promise((resolve, reject) => {
    if (window.GraphViewer) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://viewer.diagrams.net/js/viewer-static.min.js';
    script.onload = resolve;
    script.onerror = () => { processViewerLoading = null; reject(new Error('Could not load the draw.io viewer.')); };
    document.head.appendChild(script);
  });
}
function processDiagramXml(flow) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const fill = dark ? '#222222' : '#f5f5f5', stroke = dark ? '#888888' : '#777777', font = dark ? '#cccccc' : '#333333';
  const steps = flow.steps || [];
  const cells = [], positions = [];
  let y = 24;
  const base = `whiteSpace=wrap;html=0;fontSize=16;fontFamily=Arial;spacing=16;fillColor=${fill};strokeColor=${stroke};fontColor=${font};`;
  const vertex = (id, label, x, top, width, height, decision = false) => {
    cells.push(`<mxCell id="${id}" value="${processText(label)}" style="${decision ? 'rhombus;spacingLeft=36;spacingRight=36;' : 'rounded=0;'}${base}" vertex="1" parent="1"><mxGeometry x="${x}" y="${top}" width="${width}" height="${height}" as="geometry"/></mxCell>`);
  };
  const edge = (id, from, to, label = '', extra = '', points = '') => {
    cells.push(`<mxCell id="${id}" value="${processText(label)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;endFill=1;fontSize=14;labelBackgroundColor=${dark ? '#222222' : '#ffffff'};strokeColor=${font};fontColor=${font};${extra}" edge="1" parent="1" source="${from}" target="${to}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`);
  };
  let followup = false;
  steps.forEach((step, index) => {
    const decision = /^Decision:/i.test(step);
    const label = decision ? step.replace(/^Decision:\s*/i, '').split('?')[0] + '?' : step;
    const height = decision ? 210 : Math.max(82, Math.ceil(label.length / 22) * 22 + 32);
    const width = decision ? 220 : 190;
    const x = (followup ? 520 : 300) + (decision ? -15 : 0);
    positions.push({ x, y, height, decision });
    vertex(`step-${index}`, label, x, y, width, height, decision);
    if (index) {
      const previous = steps[index - 1];
      const previousDecision = /^Decision:/i.test(previous);
      const response = previousDecision && /response.*received/i.test(previous);
      edge(`edge-${index}`, `step-${index - 1}`, `step-${index}`, previousDecision ? (response ? 'No' : 'Yes') : '', response ? 'exitX=0.75;exitY=0.75;entryX=0.5;entryY=0;' : 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
    }
    if (decision && /response.*received/i.test(step)) {
      vertex('response', 'Response received', 80, y + height + 60, 190, 82);
      edge('response-yes', `step-${index}`, 'response', 'Yes', 'exitX=0.25;exitY=0.75;entryX=0.5;entryY=0;');
      followup = true;
    }
    if (decision && /return to/i.test(step)) {
      const recipient = /return to\s+([^;,.]+)/i.exec(step)?.[1]?.trim();
      const target = recipient ? steps.findIndex((text, n) => n < index && text.toLowerCase().startsWith(recipient.toLowerCase())) : -1;
      if (target >= 0) {
        const top = positions[target];
        edge(`return-${index}`, `step-${index}`, `step-${target}`, 'No · amendments', 'exitX=0;exitY=0.5;entryX=0;entryY=0.5;', `<Array as="points"><mxPoint x="170" y="${y + height / 2}"/><mxPoint x="170" y="${top.y + top.height / 2}"/></Array>`);
      }
    }
    y += height + 60;
  });
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;
}
function updateProcessZoom() {
  const label = document.querySelector('[data-process-zoom]');
  if (label && activeProcessGraph) label.textContent = Math.round(activeProcessGraph.view.scale * 100) + '%';
}

function fitProcessGraph() {
  const host = document.querySelector('.process-canvas');
  if (!activeProcessGraph || !host?.clientWidth) return;
  const bounds = activeProcessGraph.getGraphBounds(), scale = activeProcessGraph.view.scale;
  if (bounds.width > 0 && bounds.height > 0) activeProcessGraph.zoomTo(Math.min(1, (host.clientWidth - 48) / (bounds.width / scale), (host.clientHeight - 48) / (bounds.height / scale)));
  host.scrollLeft = 0; host.scrollTop = 0;
}
async function mountProcessDiagram(flow) {
  const version = ++processRenderVersion;
  activeProcessGraph?.destroy(); activeProcessGraph = null;
  const host = document.querySelector('.process-canvas');
  if (!host) return;
  if (!flow.steps?.length) { host.textContent = 'No steps recorded yet.'; return; }
  try {
    await loadProcessViewer();
    if (version !== processRenderVersion || !host.isConnected) return;
    host.replaceChildren();
    const div = document.createElement('div'); host.appendChild(div);
    const doc = window.mxUtils.parseXml(processDiagramXml(flow));
    const viewer = new window.GraphViewer(div, doc.documentElement, { nav: true, resize: true, lightbox: false, center: true });
    const graph = viewer.graph; activeProcessGraph = graph;
    graph.setEnabled(false); graph.setTooltips(false);
    let down = null;
    graph.addMouseListener({
      mouseDown: (_, me) => { down = me.getCell()?.vertex ? { id: me.getCell().id, x: me.getX(), y: me.getY() } : null; },
      mouseMove: () => {},
      mouseUp: (_, me) => {
        const cell = me.getCell();
        if (down && cell?.id === down.id && Math.abs(me.getX() - down.x) + Math.abs(me.getY() - down.y) < 6) {
          const index = Number(cell.id.replace('step-', ''));
          if (Number.isInteger(index) && flow.steps[index]) {
            openProcessStep(flow, index);
          }
        }
        down = null;
      },
    });
    graph.getCursorForCell = cell => cell?.vertex && /^step-\d+$/.test(cell.id) ? 'pointer' : null;
    const makeAccessible = () => {
      graph.getModel().getChildVertices(graph.getDefaultParent()).forEach(cell => {
        const node = graph.view.getState(cell)?.shape?.node;
        if (!node || !/^step-\d+$/.test(cell.id)) return;
        node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button');
        node.setAttribute('aria-label', cell.value); node.dataset.step = cell.id.replace('step-', '');
      });
    };
    graph.view.addListener(window.mxEvent.SCALE, makeAccessible);
    graph.view.addListener(window.mxEvent.SCALE, updateProcessZoom);
    graph.zoomTo(1); makeAccessible(); updateProcessZoom();
  } catch (error) { if (version === processRenderVersion) host.textContent = error.message; }
}
function openProcessStep(flow, index) {
  if (!Number.isInteger(index) || !flow.steps?.[index]) return;
  let modal = document.querySelector('#process-step-modal');
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = 'process-step-modal';
    modal.setAttribute('aria-labelledby', 'process-step-title');
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
      if (event.target.closest('[data-close-step]')) modal.close();
      if (event.target === modal) {
        const bounds = modal.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) modal.close();
      }
    });
    modal.addEventListener('close', () => document.querySelector(`#processes [data-step="${modal.dataset.step}"]`)?.focus());
  }
  const step = flow.steps[index];
  const signals = (flow.signals || []).filter(item => item.step === step);
  const failures = (flow.failure_conditions || []).filter(item => item.step === step);
  modal.dataset.step = index;
  modal.innerHTML = `<div class="process-modal-header"><div><p class="meta">${processText(processStatusLabel(flow))} · ${processText(processName(flow.name))}</p><h2 id="process-step-title">${processText(step)}</h2></div><button type="button" class="ghost" data-close-step autofocus>Close</button></div>
    <div class="process-modal-body prose">${signals.length ? signals.map(item => `<h3>Expected signal</h3>${renderMarkdown(item.signal)}${item.source ? `<h3>Source</h3><p class="meta">${processText(item.source)}</p>` : ''}`).join('') : '<p class="empty">No supporting details recorded for this step yet.</p>'}
      ${failures.length ? `<h3>Failure conditions</h3>${failures.map(item => `${renderMarkdown(item.condition)}${item.after ? `<p><strong>When:</strong> ${processText(item.after)}</p>` : ''}`).join('')}` : ''}
    </div>`;
  if (!modal.open) modal.showModal();
}

function renderProcesses(flows) {
  const box = document.querySelector('#processes');
  if (!flows.length) { box.innerHTML = '<p class="empty">No processes recorded yet.</p>'; return; }
  if (!flows.some(flow => flow.id === currentProcess)) currentProcess = flows[0].id;
  const flow = flows.find(item => item.id === currentProcess);
  const open = box.querySelector('.process-notes')?.open || false;
  const agentic = flows.filter(item => item.agentic === true).length;
  const unknown = flows.filter(item => typeof item.agentic !== 'boolean').length;
  box.innerHTML = `<div class="process-metric">Confirmed agentic: ${agentic}/${flows.length} (${Math.round(agentic / flows.length * 100)}%)${unknown ? ` · ${unknown} not assessed` : ''}</div><div class="process-workspace">
    <aside class="process-picker" aria-label="Processes">${flows.map(item => `<button type="button" data-process="${processText(item.id)}" class="${item.id === flow.id ? 'selected' : ''}" aria-pressed="${item.id === flow.id}"><span class="status ${processText(processStatus(item))}">${processText(processStatusLabel(item))}</span><span>${processText(processName(item.name))}</span></button>`).join('')}</aside>
    <article class="process-view"><div class="process-header"><div><span class="status ${processText(processStatus(flow))}">${processText(processStatusLabel(flow))}</span><h2>${processText(processName(flow.name))}</h2></div><div class="process-controls"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><span data-process-zoom>100%</span><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="actual">Actual size</button><button type="button" data-zoom="fit">Fit diagram</button></div></div>
      <div class="process-canvas" role="region" aria-label="Process diagram" tabindex="0"><p class="meta">Loading diagram…</p></div>
      <details class="process-notes"${open ? ' open' : ''}><summary>Details</summary><div class="prose">
        <p class="meta">Agentic: ${flow.agentic === true ? 'Yes' : flow.agentic === false ? 'No' : 'Not assessed'}</p>${flow.agentic_evidence ? renderMarkdown(flow.agentic_evidence) : ''}
        <h3>Trigger</h3>${renderMarkdown(flow.trigger || '')}<h3>Completion</h3>${renderMarkdown(flow.completion || '')}
        <h3>Handoffs</h3><ul>${(flow.handoffs || []).map(item => `<li>${processText(item)}</li>`).join('')}</ul>
        ${flow.signal_access?.length ? `<h3>Signal access</h3>${flow.signal_access.map(item => `<p><strong>${processText(item.kind)}</strong> · ${processText(item.ok && item.direct ? 'Direct read confirmed' : 'Access gap')}</p>${renderMarkdown(item.what)}<p class="meta">${processText(item.ref)}</p>`).join('')}` : ''}
        <h3>Step signals</h3>${(flow.signals || []).map(item => `<h4>${processText(item.step)}</h4>${renderMarkdown(item.signal)}<p class="meta">${processText(item.source)}</p>`).join('')}
        <h3>Failure conditions</h3>${(flow.failure_conditions || []).map(item => `<p><strong>${processText(item.step)}</strong></p>${renderMarkdown(item.condition)}<p class="meta">${processText(item.after)}</p>`).join('')}
        <h3>Examples</h3>${(flow.examples || []).map(item => `<p>${processText(item.date || '')}</p>${renderMarkdown(item.ref || '')}`).join('')}
        <p class="meta">Diagram follows the saved steps and explicit decision outcomes. Process documentation and handoff review remain pending.</p>
      </div></details>
    </article></div>`;
  box.onclick = event => {
    const picker = event.target.closest('[data-process]');
    if (picker) { currentProcess = picker.dataset.process; renderProcesses(flows); return; }
    const zoom = event.target.closest('[data-zoom]');
    if (zoom) {
      if (zoom.dataset.zoom === 'fit') fitProcessGraph();
      else if (zoom.dataset.zoom === 'actual') activeProcessGraph?.zoomTo(1);
      else if (activeProcessGraph) activeProcessGraph[zoom.dataset.zoom === 'in' ? 'zoomIn' : 'zoomOut']();
      return;
    }
    const step = event.target.closest('[data-step]');
    if (step) {
      const index = Number(step.dataset.step);
      if (!Number.isInteger(index) || !flow.steps[index]) return;
      openProcessStep(flow, index);
    }
  };
  mountProcessDiagram(flow);
  box.onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-step]')) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); } };
}
