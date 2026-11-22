// Business records and built-in flows share the draw.io view.
let currentProcess = null;
let selectedProcessRun = '';
let processRunList = [];
let processRunDetail = null;
let processRunError = null;
let processRunListPending = false;
let processRunDetailVersion = 0;
function processText(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function processStatus(flow) { return flow.status || 'unverified'; }
function processOrderRank(flow) {
  if (flow.kind === 'internal') return 0;
  const value = processStatus(flow);
  return value === 'validated' ? 1 : value === 'unverified' ? 3 : 2;
}
function sortProcesses(flows) {
  return [...flows].sort((a, b) => processOrderRank(a) - processOrderRank(b));
}
function processStatusLabel(flow) { const value = processStatus(flow); return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' '); }
function processNameWithBadge(flow) {
  return `<span class="process-name-line"><span>${processText(processName(flow.name))}</span>${processStatus(flow) === 'validated' ? '<span class="process-validation-check" role="img" aria-label="Validated process definition" title="Definition validated"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="currentColor"/><path d="m5.5 10 3 3 6-6" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : ''}</span>`;
}
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
function businessStepType(step) {
  if (/^Decision:/i.test(step)) return 'decision';
  if (/\b(D5|inov8|M3NT0R|M-CODEX|agent)\b/i.test(step)) return 'agent';
  if (/\b(handoff|sub-?process)\b/i.test(step)) return 'process';
  return 'operation';
}
function shortNodeLabel(text, fallback, max = 72) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}
function processDiagramXml(flow, run = null) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const neutral = dark ? '#8a8a8a' : '#777777', font = dark ? '#e0e0e0' : '#333333';
  const palette = dark
    ? { started: '#8db3ff', completed: '#60c482', failed: '#f28891', waiting: '#e5b966', skipped: '#aab3c1' }
    : { started: '#385eaa', completed: '#268046', failed: '#ad3f48', waiting: '#8d5b16', skipped: '#667080' };
  const typeFills = dark
    ? { trigger: '#222222', decision: '#222222', operation: '#222222', agent: '#1b2738', process: '#252035', terminal: '#28241e' }
    : { trigger: '#f5f5f5', decision: '#f5f5f5', operation: '#f5f5f5', agent: '#e8f1ff', process: '#f1ecff', terminal: '#f6f1e7' };
  const typeShapes = {
    trigger: 'shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1;size=14;spacingLeft=18;spacingRight=18;',
    decision: 'shape=rhombus;spacingLeft=36;spacingRight=36;',
    operation: 'rounded=0;',
    agent: 'shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;size=18;spacingLeft=22;spacingRight=22;',
    process: 'shape=process;backgroundOutline=1;size=0.08;spacingLeft=18;spacingRight=18;',
    terminal: 'rounded=1;arcSize=50;spacingLeft=18;spacingRight=18;',
  };
  const steps = flow.steps || [];
  const cells = [], positions = [];
  let y = 24;
  const vertex = (id, label, x, top, width, height, kind = 'operation') => {
    const runStatus = run?.nodes?.[id]?.status;
    const stroke = palette[runStatus] || neutral;
    const strokeWidth = runStatus ? 3 : kind === 'agent' || kind === 'terminal' ? 2 : 1;
    const fill = typeFills[kind] || typeFills.operation;
    const statusText = runStateLabels[runStatus];
    const value = processText(label) + (statusText ? '&#xa;' + processText(statusText) : '');
    const style = `${typeShapes[kind] || typeShapes.operation}whiteSpace=wrap;html=0;fontSize=15;fontFamily=Arial;spacing=12;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};fontColor=${font};`;
    cells.push(`<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${top}" width="${width}" height="${height}" as="geometry"/></mxCell>`);
  };
  const edge = (id, from, to, label = '', extra = '', points = '') => {
    cells.push(`<mxCell id="${id}" value="${processText(label)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;endFill=1;fontSize=14;labelBackgroundColor=${dark ? '#222222' : '#ffffff'};strokeColor=${font};fontColor=${font};${extra}" edge="1" parent="1" source="${from}" target="${to}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`);
  };
  // Explicit Trigger entry node
  const hasResponseSplit = steps.some(step => /^Decision:/i.test(step) && /response.*received/i.test(step));
  const mainX = hasResponseSplit ? 380 : 300;
  const triggerLabel = shortNodeLabel(flow.trigger, 'Trigger', 68);
  const triggerHeight = Math.max(72, Math.ceil(triggerLabel.length / 24) * 20 + 28);
  vertex('trigger-0', triggerLabel, mainX - 15, y, 220, triggerHeight, 'trigger');
  y += triggerHeight + 52;
  let splitDecisionIndex = -1;
  let splitDecisionBottomY = 0;
  let followupY = 0;
  let responseY = 0;
  let lastFollowupId = null;
  let lastResponseId = null;
  let inResponseBranch = false;
  steps.forEach((step, index) => {
    const kind = businessStepType(step);
    const decision = kind === 'decision';
    const label = decision ? step.replace(/^Decision:\s*/i, '').split('?')[0] + '?' : step;
    const height = decision ? 210 : Math.max(82, Math.ceil(label.length / 22) * 22 + 32);
    const width = decision ? 220 : kind === 'agent' ? 216 : 196;
    const isUnanswered = splitDecisionIndex >= 0 && !inResponseBranch && /^Unanswered\b/i.test(step);
    if (splitDecisionIndex >= 0 && !isUnanswered && !inResponseBranch) {
      inResponseBranch = true;
      responseY = splitDecisionBottomY + 60;
    }
    let x, top;
    if (isUnanswered) {
      x = 680 + (decision ? -15 : kind === 'agent' ? -10 : 0);
      top = followupY;
      followupY += height + 60;
    } else if (inResponseBranch) {
      x = 200 + (decision ? -15 : kind === 'agent' ? -10 : 0);
      top = responseY;
      responseY += height + 60;
    } else {
      x = mainX + (decision ? -15 : kind === 'agent' ? -10 : 0);
      top = y;
      y += height + 60;
    }
    positions.push({ x, y: top, height, width, decision });
    vertex(`step-${index}`, label, x, top, width, height, kind);
    if (index === 0) {
      edge('edge-trigger', 'trigger-0', 'step-0', '', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
    } else if (isUnanswered) {
      if (!lastFollowupId) {
        edge(`edge-${index}`, `step-${splitDecisionIndex}`, `step-${index}`, 'No · unanswered', 'exitX=0.75;exitY=0.75;entryX=0.5;entryY=0;');
      } else {
        edge(`edge-${index}`, lastFollowupId, `step-${index}`, '', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
      }
      lastFollowupId = `step-${index}`;
    } else if (inResponseBranch) {
      if (!lastResponseId) {
        edge('response-yes', `step-${splitDecisionIndex}`, `step-${index}`, 'Yes · response received', 'exitX=0.25;exitY=0.75;entryX=0.5;entryY=0;');
      } else {
        const prevStep = steps[index - 1];
        const prevIsOutcomeDecision = /^Decision:/i.test(prevStep) && /accepted/i.test(prevStep);
        edge(`edge-${index}`, lastResponseId, `step-${index}`, prevIsOutcomeDecision ? 'Accepted' : '', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
      }
      lastResponseId = `step-${index}`;
    } else {
      const previous = steps[index - 1];
      const previousDecision = /^Decision:/i.test(previous);
      edge(`edge-${index}`, `step-${index - 1}`, `step-${index}`, previousDecision ? 'Yes' : '', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
    }
    if (decision && /response.*received/i.test(step)) {
      splitDecisionIndex = index;
      splitDecisionBottomY = top + height;
      followupY = splitDecisionBottomY + 60;
    }
    if (decision && /revision/i.test(step)) {
      const target = steps.findIndex((text, n) => n < index && /prepare\s+scope|offer\s+version/i.test(text));
      if (target >= 0) {
        const targetPos = positions[target];
        edge(`revision-${index}`, `step-${index}`, `step-${target}`, 'Revision requested', 'exitX=0;exitY=0.5;entryX=0;entryY=0.5;', `<Array as="points"><mxPoint x="70" y="${top + height / 2}"/><mxPoint x="70" y="${targetPos.y + targetPos.height / 2}"/></Array>`);
      }
    }
    if (decision && /declined|deferred/i.test(step)) {
      vertex('declined', 'Declined / deferred', 460, top + Math.round((height - 82) / 2), 170, 82, 'terminal');
      edge(`declined-${index}`, `step-${index}`, 'declined', 'Declined / deferred', 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;');
    }
    if (decision && /return to/i.test(step)) {
      const recipient = /return to\s+([^;,.]+)/i.exec(step)?.[1]?.trim();
      const target = recipient ? steps.findIndex((text, n) => n < index && text.toLowerCase().startsWith(recipient.toLowerCase())) : -1;
      if (target >= 0) {
        const targetPos = positions[target];
        edge(`return-${index}`, `step-${index}`, `step-${target}`, 'No · amendments', 'exitX=0;exitY=0.5;entryX=0;entryY=0.5;', `<Array as="points"><mxPoint x="170" y="${top + height / 2}"/><mxPoint x="170" y="${targetPos.y + targetPos.height / 2}"/></Array>`);
      }
    }
  });
  // Explicit Terminal completion node(s)
  if (splitDecisionIndex >= 0) {
    if (lastFollowupId) {
      vertex('terminal-followup', 'Pending · 1-month reminder', 668, followupY, 220, 82, 'terminal');
      edge('edge-terminal-followup', lastFollowupId, 'terminal-followup', '', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
    }
    if (lastResponseId) {
      const termLabel = shortNodeLabel(flow.completion, 'Completed', 68);
      const termHeight = Math.max(72, Math.ceil(termLabel.length / 24) * 20 + 28);
      vertex('terminal-0', termLabel, 188, responseY, 220, termHeight, 'terminal');
      edge('edge-terminal', lastResponseId, 'terminal-0', '', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
    } else {
      vertex('response', 'Response received', 190, splitDecisionBottomY + 60, 210, 82, 'terminal');
      edge('response-yes', `step-${splitDecisionIndex}`, 'response', 'Yes', 'exitX=0.25;exitY=0.75;entryX=0.5;entryY=0;');
    }
  } else {
    const termLabel = shortNodeLabel(flow.completion, 'Completed', 68);
    const termHeight = Math.max(72, Math.ceil(termLabel.length / 24) * 20 + 28);
    vertex('terminal-0', termLabel, mainX - 15, y, 220, termHeight, 'terminal');
    if (steps.length) edge('edge-terminal', `step-${steps.length - 1}`, 'terminal-0', '', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
    else edge('edge-terminal', 'trigger-0', 'terminal-0', '', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
  }
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;
}
const reviewTime = value => value ? new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Etc/GMT+7',
}).format(new Date(value)) + ' PDT' : 'Not recorded';
const evidenceJson = value => JSON.stringify(value, (_key, field) => (
  typeof field === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(field) ? reviewTime(field) : field
), 2);
const reviewSources = { clock: 'Automatic cadence', manual: 'Manual Run', answer: 'Owner answer', recovery: 'Recovery return' };
const runStateLabels = { started: 'Running', completed: 'Completed', failed: 'Failed', waiting: 'Waiting', skipped: 'Skipped' };
const processRunPath = flow => '/api/processes/' + encodeURIComponent(flow.id) + '/runs';
const defaultNodeTypes = {
  trigger: { label: 'Trigger', definition: 'Entry event that can initiate a flow run.' },
  decision: { label: 'Decision', definition: 'Evaluates conditions and routes the run along one branch.' },
  operation: { label: 'Operation', definition: 'Deterministic service step that reads or updates local records.' },
  agent: { label: 'Agentic', definition: 'LLM-driven step that reasons over context and acts through tools.' },
  process: { label: 'Process', definition: 'Invokes or depends on another process flow (documented or undocumented).' },
  terminal: { label: 'Terminal', definition: 'End state that terminates the run with a recorded disposition.' },
};
const normalizeNodeType = type => (type === 'outcome' ? 'terminal' : type || 'operation');
const nodeTypeInfo = (flow, type) => {
  const key = normalizeNodeType(type);
  return flow?.node_types?.[key] || defaultNodeTypes[key] || { label: key, definition: '' };
};
const legendIcons = {
  trigger: '<svg viewBox="0 0 24 14" aria-hidden="true"><polygon points="4,1 23,1 20,13 1,13"/></svg>',
  decision: '<svg viewBox="0 0 24 14" aria-hidden="true"><polygon points="12,1 23,7 12,13 1,7"/></svg>',
  operation: '<svg viewBox="0 0 24 14" aria-hidden="true"><rect x="2" y="1" width="20" height="12"/></svg>',
  agent: '<svg viewBox="0 0 24 14" aria-hidden="true"><polygon points="6,1 18,1 23,7 18,13 6,13 1,7"/></svg>',
  process: '<svg viewBox="0 0 24 14" aria-hidden="true"><rect x="2" y="1" width="20" height="12"/><line x1="6" y1="1" x2="6" y2="13"/><line x1="18" y1="1" x2="18" y2="13"/></svg>',
  terminal: '<svg viewBox="0 0 24 14" aria-hidden="true"><rect x="2" y="1" width="20" height="12" rx="6" ry="6"/></svg>',
};
function nodeLegend(flow) {
  const types = Object.keys(defaultNodeTypes);
  return `<div class="process-legend" aria-label="Node types">${types.map(key => {
    const info = nodeTypeInfo(flow, key);
    return `<span class="process-legend-item type-${key}" title="${processText(info.definition)}">${legendIcons[key]}<span>${processText(info.label)}</span></span>`;
  }).join('')}</div>`;
}

function internalDiagramXml(flow, run) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const text = dark ? '#e0e0e0' : '#333333';
  const neutral = dark ? '#8a8a8a' : '#777777';
  const palette = dark
    ? { started: '#8db3ff', completed: '#60c482', failed: '#f28891', waiting: '#e5b966', skipped: '#aab3c1' }
    : { started: '#385eaa', completed: '#268046', failed: '#ad3f48', waiting: '#8d5b16', skipped: '#667080' };
  const typeFills = dark
    ? { trigger: '#222222', decision: '#222222', operation: '#222222', agent: '#1b2738', process: '#252035', terminal: '#28241e' }
    : { trigger: '#f5f5f5', decision: '#f5f5f5', operation: '#f5f5f5', agent: '#e8f1ff', process: '#f1ecff', terminal: '#f6f1e7' };
  const typeShapes = {
    trigger: 'shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1;size=14;spacingLeft=12;spacingRight=12;',
    decision: 'shape=rhombus;spacing=12;',
    operation: 'rounded=0;',
    agent: 'shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;size=16;spacingLeft=18;spacingRight=18;',
    process: 'shape=process;backgroundOutline=1;size=0.08;spacingLeft=14;spacingRight=14;',
    terminal: 'rounded=1;arcSize=50;',
  };
  const traversed = new Set(run?.traversed || []);
  const color = id => palette[run?.nodes?.[id]?.status];
  const cells = flow.nodes.map(node => {
    const kind = normalizeNodeType(node.type);
    const shape = typeShapes[kind] || typeShapes.operation;
    const stroke = color(node.id);
    const fill = typeFills[kind] || typeFills.operation;
    const strokeWidth = stroke ? 3 : kind === 'agent' || kind === 'terminal' ? 2 : 1;
    const style = shape + `whiteSpace=wrap;html=0;fontSize=16;fontFamily=Arial;fillColor=${fill};fontColor=${text};strokeColor=${stroke || neutral};strokeWidth=${strokeWidth};`;
    const decision = kind === 'decision';
    const width = kind === 'agent' ? 172 : 152;
    const x = 24 + node.column * 182 - (width - 152) / 2;
    const status = runStateLabels[run?.nodes?.[node.id]?.status];
    const value = processText(node.label) + (status ? '&#xa;' + processText(status) : '');
    return `<mxCell id="${node.id}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${24 + node.row * 107}" width="${width}" height="${decision ? 72 : 58}" as="geometry"/></mxCell>`;
  });
  for (const edge of flow.edges) {
    const active = traversed.has(edge.id);
    const colorOnEdge = active ? color(edge.to) || color(edge.from) || neutral : neutral;
    const side = edge.to === 'skip' ? 'exitX=0;exitY=0.5;entryX=1;entryY=0.5;' : 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;';
    cells.push(`<mxCell id="${edge.id}" value="${processText(edge.label)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;endFill=1;fontSize=13;labelBackgroundColor=${dark ? '#222222' : '#ffffff'};fontColor=${text};strokeColor=${colorOnEdge};strokeWidth=${active ? 3 : 1};${side}" edge="1" parent="1" source="${edge.from}" target="${edge.to}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  }
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
async function mountProcessDiagram(flow, run = null, triggers = []) {
  const version = ++processRenderVersion;
  activeProcessGraph?.destroy(); activeProcessGraph = null;
  const host = document.querySelector('.process-canvas');
  if (!host) return;
  const internal = flow.kind === 'internal';
  const diagram = run?.definition || flow;
  const internalNodes = new Map((diagram.nodes || []).map(node => [node.id, node]));
  const stepFromCell = id => internal ? internalNodes.get(id) : (id === 'trigger-0' || id === 'terminal-0' || id === 'terminal-followup' || id === 'response' || id === 'declined' || (/^step-\d+$/.test(id) && flow.steps?.[Number(id.slice(5))]));
  const openCell = id => {
    if (internal) openInternalNode(flow, internalNodes.get(id), run);
    else openBusinessCell(flow, id, run, triggers);
  };
  if (!internal && !flow.steps?.length && !flow.trigger) { host.textContent = 'No steps recorded yet.'; return; }
  try {
    await loadProcessViewer();
    if (version !== processRenderVersion || !host.isConnected) return;
    host.replaceChildren();
    const div = document.createElement('div'); host.appendChild(div);
    const doc = window.mxUtils.parseXml(internal ? internalDiagramXml(diagram, run) : processDiagramXml(flow, run));
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
          if (stepFromCell(cell.id)) openCell(cell.id);
        }
        down = null;
      },
    });
    graph.getCursorForCell = cell => cell?.vertex && stepFromCell(cell.id) ? 'pointer' : null;
    const makeAccessible = () => {
      graph.getModel().getChildVertices(graph.getDefaultParent()).forEach(cell => {
        const node = graph.view.getState(cell)?.shape?.node;
        if (!node || !stepFromCell(cell.id)) return;
        node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button');
        node.setAttribute('aria-label', cell.value.replace('\n', ' · '));
        node.dataset.step = cell.id;
      });
    };
    graph.view.addListener(window.mxEvent.SCALE, makeAccessible);
    graph.view.addListener(window.mxEvent.SCALE, updateProcessZoom);
    graph.zoomTo(1);
    if (internal) fitProcessGraph();
    makeAccessible(); updateProcessZoom();
  } catch (error) { if (version === processRenderVersion) host.textContent = error.message; }
}
function processStepModal() {
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
  return modal;
}
function openBusinessCell(flow, cellId, run = null, triggers = []) {
  const modal = processStepModal();
  if (cellId === 'trigger-0') {
    const info = nodeTypeInfo(flow, 'trigger');
    const bound = (triggers || []).filter(item => item.flow_id === flow.id);
    modal.dataset.step = cellId;
    modal.innerHTML = `<div class="process-modal-header"><div><p class="meta">${processNameWithBadge(flow)} · <span class="process-node-type type-trigger">${processText(info.label)}</span></p><h2 id="process-step-title">Trigger</h2></div><button type="button" class="ghost" data-close-step autofocus>Close</button></div>
      <div class="process-modal-body prose">
        <p class="meta">${processText(info.definition)}</p>
        <h3>Defined trigger</h3>${renderMarkdown(flow.trigger || 'No trigger recorded yet.')}
        ${bound.length ? `<h3>Registered receivers</h3><ul>${bound.map(item => `<li><strong>${processText(item.name)}</strong> (${processText(item.kind)}) · <code>POST ${processText(item.receiver_path)}</code>${item.last_event ? ` · last ${processText(item.last_event.disposition)}` : ''}</li>`).join('')}</ul>` : ''}
        ${selectedProcessRun ? `<h3>Run evidence</h3>${evidenceFields(run?.nodes?.['trigger-0'])}` : ''}
      </div>`;
    if (!modal.open) modal.showModal();
    return;
  }
  if (cellId === 'terminal-0' || cellId === 'terminal-followup' || cellId === 'response' || cellId === 'declined') {
    const info = nodeTypeInfo(flow, 'terminal');
    modal.dataset.step = cellId;
    const title = cellId === 'response' ? 'Response received' : cellId === 'declined' ? 'Declined / deferred' : cellId === 'terminal-followup' ? 'Pending · 1-month reminder' : 'Completion';
    const body = cellId === 'response'
      ? 'Customer responded to the offer; follow-up branch ends and flow proceeds to resolution.'
      : cellId === 'declined'
        ? 'Customer declined or deferred the offer; retain the disposition and close without handing off to delivery.'
        : cellId === 'terminal-followup'
          ? 'No response after day 1/3/7/10 follow-ups; 1-month reminder saved to circle back.'
          : (flow.completion || 'No completion definition recorded yet.');
    modal.innerHTML = `<div class="process-modal-header"><div><p class="meta">${processNameWithBadge(flow)} · <span class="process-node-type type-terminal">${processText(info.label)}</span></p><h2 id="process-step-title">${title}</h2></div><button type="button" class="ghost" data-close-step autofocus>Close</button></div>
      <div class="process-modal-body prose">
        <p class="meta">${processText(info.definition)}</p>
        <h3>Terminal definition</h3>${renderMarkdown(body)}
        ${selectedProcessRun ? `<h3>Run evidence</h3>${evidenceFields(run?.nodes?.[cellId] || run?.nodes?.['terminal-received'])}` : ''}
      </div>`;
    if (!modal.open) modal.showModal();
    return;
  }
  const index = Number(String(cellId).replace(/^step-/, ''));
  openProcessStep(flow, index, run);
}
function openProcessStep(flow, index, run = null) {
  if (!Number.isInteger(index) || !flow.steps?.[index]) return;
  const modal = processStepModal();
  const step = flow.steps[index];
  const typeKey = businessStepType(step);
  const typeInfo = nodeTypeInfo(flow, typeKey);
  const signals = (flow.signals || []).filter(item => item.step === step);
  const failures = (flow.failure_conditions || []).filter(item => item.step === step);
  modal.dataset.step = `step-${index}`;
  modal.innerHTML = `<div class="process-modal-header"><div><p class="meta">${processStatus(flow) === 'validated' ? '' : `${processText(processStatusLabel(flow))} · `}${processNameWithBadge(flow)} · <span class="process-node-type type-${typeKey}">${processText(typeInfo.label)}</span></p><h2 id="process-step-title">${processText(step)}</h2></div><button type="button" class="ghost" data-close-step autofocus>Close</button></div>
    <div class="process-modal-body prose">
      ${typeInfo.definition ? `<p class="meta">${processText(typeInfo.definition)}</p>` : ''}
      ${signals.length ? signals.map(item => `<h3>Expected signal</h3>${renderMarkdown(item.signal)}${item.source ? `<h3>Source</h3><p class="meta">${processText(item.source)}</p>` : ''}`).join('') : '<p class="empty">No supporting details recorded for this step yet.</p>'}
      ${failures.length ? `<h3>Failure conditions</h3>${failures.map(item => `${renderMarkdown(item.condition)}${item.after ? `<p><strong>When:</strong> ${processText(item.after)}</p>` : ''}`).join('')}` : ''}
      ${selectedProcessRun ? `<h3>Run evidence</h3>${evidenceFields(run?.nodes?.[`step-${index}`])}` : ''}
    </div>`;
  if (!modal.open) modal.showModal();
}

function configurationFields(node, config, editable) {
  if (!node.configuration || !config) return '';
  if (node.configuration === 'cadence') {
    const choices = { hourly: 'Hourly', daily: 'Daily', yolo: 'On change' };
    if (!editable) return `<p>${processText(choices[config.pace] || 'Not recorded')}${config.pace === 'daily' ? ' · ' + processText(config.time) : ''} · ${config.automatic_enabled ? 'Automatic reviews enabled' : 'Automatic reviews paused'}</p>`;
    return `<label>Cadence <select name="pace">${Object.entries(choices).map(([value, label]) => `<option value="${value}"${value === config.pace ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label data-daily-time${config.pace === 'daily' ? '' : ' hidden'}>Daily time <input name="time" type="time" value="${processText(config.time)}"></label>`;
  }
  const runner = config.agent_harness || config.harness;
  const name = runner === 'codex' ? 'Codex' : runner === 'claude' ? 'Claude' : 'Not recorded';
  const permission = config.full_access == null ? 'Not recorded' : config.full_access ? 'Full access' : 'Standard access';
  return `${editable ? `<label>Agent runner <select name="agent_harness"><option value="codex"${runner === 'codex' ? ' selected' : ''}>Codex</option><option value="claude"${runner === 'claude' ? ' selected' : ''}>Claude</option></select></label>` : `<p>${name}</p>`}
    <p class="meta">${processText(config.model || 'Model not recorded')} · ${processText(permission)}${config.permission_mode ? ' · ' + processText(config.permission_mode) : ''}</p>`;
}
function evidenceFields(evidence) {
  if (!evidence) return '<p class="empty">Not recorded</p>';
  const fields = [
    ['State', runStateLabels[evidence.status]], ['Reason', evidence.reason], ['Queued', evidence.queued_at && reviewTime(evidence.queued_at)],
    ['Started', evidence.started_at && reviewTime(evidence.started_at)],
    ['Worker started', evidence.worker_started_at && reviewTime(evidence.worker_started_at)], ['Finished', evidence.finished_at && reviewTime(evidence.finished_at)],
    ['Error', evidence.error], ['Input', evidence.input_ref], ['Command', evidence.command_ref], ['Output', evidence.output_ref], ['Tool source', evidence.tool_ref],
  ].filter(([, value]) => value);
  const tools = evidence.tools || [];
  return `${fields.length ? `<dl class="process-evidence-fields">${fields.map(([label, value]) => `<dt>${label}</dt><dd>${processText(value)}</dd>`).join('')}</dl>` : '<p class="empty">Not recorded</p>'}
    ${evidence.input ? `<details><summary>Input reference</summary><pre>${processText(evidenceJson(evidence.input))}</pre></details>` : ''}
    ${evidence.output ? `<details><summary>Output reference</summary><pre>${processText(evidenceJson(evidence.output))}</pre></details>` : ''}
    ${tools.length ? `<h4>Tool activity</h4><ul class="process-tool-list">${tools.map(tool => `<li><strong>${processText(tool.label)}</strong>${tool.server ? ' · ' + processText(tool.server) : ''} · ${processText(runStateLabels[tool.status] || tool.status)}<span class="meta"> · line ${processText(tool.result_line)}</span></li>`).join('')}</ul>` : ''}`;
}
function openInternalNode(flow, node, run) {
  if (!node) return;
  const modal = processStepModal();
  const editable = !selectedProcessRun && Boolean(node.configuration);
  const config = run?.configuration || (!selectedProcessRun ? flow.configuration : node.id === 'agent' ? run?.nodes?.agent : null);
  const typeKey = normalizeNodeType(node.type);
  const typeInfo = nodeTypeInfo(run?.definition || flow, node.type);
  modal.dataset.step = node.id;
  modal.innerHTML = `<div class="process-modal-header"><div><p class="meta">${processText(flow.name)} · <span class="process-node-type type-${typeKey}">${processText(typeInfo.label)}</span></p><h2 id="process-step-title">${processText(node.label)}</h2></div><button type="button" class="ghost" data-close-step autofocus>Close</button></div>
    <div class="process-modal-body prose">
      ${typeInfo.definition ? `<p class="meta">${processText(typeInfo.definition)}</p>` : ''}
      <h3>Configuration</h3><p>${processText(node.detail)}</p><p class="meta">${processText(node.binding)}</p>
      <form class="process-node-config">${configurationFields(node, config, editable)}${editable ? '<button type="submit" class="primary">Save</button><span role="status" data-config-feedback></span>' : ''}</form>
      ${selectedProcessRun ? `<h3>Run evidence</h3>${evidenceFields(run?.nodes?.[node.id])}` : ''}
      ${run?.version && node.id === 'eligibility' ? `<details><summary>Saved versions</summary><dl class="process-evidence-fields"><dt>Definition</dt><dd>${processText(run.version)}</dd><dt>Configuration</dt><dd>${processText(run.configuration_version)}</dd></dl></details>` : ''}
    </div>`;
  const form = modal.querySelector('form');
  if (editable) {
    form.elements.pace?.addEventListener('change', () => { form.querySelector('[data-daily-time]').hidden = form.elements.pace.value !== 'daily'; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const feedback = form.querySelector('[data-config-feedback]');
      const button = form.querySelector('button');
      const patch = Object.fromEntries(new FormData(form));
      if (patch.pace !== 'daily') delete patch.time;
      button.disabled = true;
      try {
        const response = await api('/api/processes/' + encodeURIComponent(flow.id) + '/configuration', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
        });
        flow.configuration = response.configuration;
        feedback.textContent = 'Saved';
        await load();
      } catch (error) { feedback.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  if (!modal.open) modal.showModal();
}

async function fetchProcessRun(flow, id, render) {
  const version = ++processRunDetailVersion;
  try {
    const detail = await api(processRunPath(flow) + '/' + encodeURIComponent(id));
    if (version !== processRunDetailVersion || selectedProcessRun !== id) return;
    if (JSON.stringify(processRunDetail) === JSON.stringify(detail)) return;
    processRunDetail = detail;
    processRunError = null;
    render();
  } catch (error) {
    if (version === processRunDetailVersion && selectedProcessRun === id) {
      processRunError = error.message;
      render();
    }
  }
}
async function refreshProcessRuns(flow, render) {
  if (processRunListPending) return;
  processRunListPending = true;
  try {
    const { runs } = await api(processRunPath(flow));
    if (JSON.stringify(processRunList) !== JSON.stringify(runs) || processRunError) {
      processRunList = runs;
      processRunError = null;
      render();
    }
    if (selectedProcessRun) {
      const row = runs.find(item => item.id === selectedProcessRun);
      if (processRunDetail?.id !== selectedProcessRun || !row?.finished_at || !processRunDetail?.finished_at) await fetchProcessRun(flow, selectedProcessRun, render);
    }
  } catch (error) { processRunError = error.message; render(); }
  finally { processRunListPending = false; }
}
function runPicker(flow, run) {
  const options = processRunList.map(row => {
    const src = reviewSources[row.source] || (row.source ? row.source.charAt(0).toUpperCase() + row.source.slice(1) : 'Historical');
    const label = reviewTime(row.created_at) + ' · ' + src + (row.synthetic ? ' · Synthetic' : '') + (row.decision === 'skipped' ? ' · Skipped' : '');
    return `<option value="${processText(row.id)}"${row.id === selectedProcessRun ? ' selected' : ''}>${processText(label)}</option>`;
  }).join('');
  const status = processRunError || (selectedProcessRun && !run ? 'Loading run…' : run?.historical ? 'Historical · Trigger and version not recorded' : '');
  const autoMeta = flow.configuration ? `<span class="meta">${flow.configuration.automatic_enabled ? 'Automatic reviews enabled' : 'Automatic reviews paused'}</span>` : `<span class="meta">${processRunList.length ? `${processRunList.length} recorded run${processRunList.length === 1 ? '' : 's'}` : 'No runs recorded yet'}</span>`;
  return `<div class="process-run-controls"><label>View <select data-process-run><option value="">Current definition</option>${options}</select></label>
    ${autoMeta}
    ${status ? `<span class="meta" role="status">${processText(status)}</span>` : ''}</div>`;
}

function triggerStrip(flow, triggers) {
  const bound = (triggers || []).filter(item => item.flow_id === flow.id);
  if (!bound.length) return '';
  return `<div class="process-triggers" aria-label="Registered triggers"><span class="meta">Triggers (${bound.length}):</span>${bound.map(item => {
    const last = item.last_event ? ` · last ${item.last_event.disposition}` : '';
    return `<span class="process-trigger-chip" title="${processText(item.receiver_path)}">${processText(item.name)} <span class="meta">(${processText(item.kind)}${processText(last)})</span></span>`;
  }).join('')}</div>`;
}

function renderProcesses(businessFlows, internalFlows = [], refreshHistory = true, triggers = [], clarifyBridge = null) {
  const flows = sortProcesses([...businessFlows, ...internalFlows]);
  const box = document.querySelector('#processes');
  if (!flows.length) { box.innerHTML = '<p class="empty">No processes recorded yet.</p>'; return; }
  if (!flows.some(flow => flow.id === currentProcess)) currentProcess = flows[0].id;
  const flow = flows.find(item => item.id === currentProcess);
  const open = box.querySelector('.process-notes')?.open || false;
  const internal = flow.kind === 'internal';
  const run = processRunDetail?.id === selectedProcessRun ? processRunDetail : null;
  const render = () => {
    if (currentProcess === flow.id) renderProcesses(businessFlows, internalFlows, false, triggers, clarifyBridge);
  };
  const agentic = businessFlows.filter(item => item.agentic === true).length;
  const unknown = businessFlows.filter(item => typeof item.agentic !== 'boolean').length;
  const bridgeSummary = clarifyBridge?.state ? ` · Clarify bridge: ${clarifyBridge.state}` : '';
  const delegationControl = !internal ? `<label class="toggle" style="margin-left:auto"><input type="checkbox" data-clarify-delegate="${processText(flow.id)}"${flow.delegate_from_clarify ? ' checked' : ''}> Delegate from Clarify</label>` : '';
  const badge = item => item.kind === 'internal' ? '<span class="meta">Internal</span>' : processStatus(item) === 'validated' ? '' : `<span class="status ${processText(processStatus(item))}">${processText(processStatusLabel(item))}</span>`;
  box.innerHTML = `${businessFlows.length ? `<div class="process-metric">Confirmed agentic: ${agentic}/${businessFlows.length} (${Math.round(agentic / businessFlows.length * 100)}%)${unknown ? ` · ${unknown} not assessed` : ''}${processText(bridgeSummary)}</div>` : ''}<div class="process-workspace">
    <aside class="process-picker" aria-label="Processes">${flows.map(item => `<button type="button" data-process="${processText(item.id)}" class="${item.id === flow.id ? 'selected' : ''}" aria-pressed="${item.id === flow.id}">${badge(item)}${processNameWithBadge(item)}</button>`).join('')}</aside>
    <article class="process-view"><div class="process-header"><div>${badge(flow)}<h2>${processNameWithBadge(flow)}</h2></div>${delegationControl}<div class="process-controls"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><span data-process-zoom>100%</span><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="actual">Actual size</button><button type="button" data-zoom="fit">Fit diagram</button></div></div>
      ${runPicker(flow, run)}${nodeLegend(run?.definition || flow)}
      ${triggerStrip(flow, triggers)}
      <div class="process-canvas" role="region" aria-label="Process diagram" tabindex="0"><p class="meta">Loading diagram…</p></div>
      ${internal ? '' : `<details class="process-notes"${open ? ' open' : ''}><summary>Details</summary><div class="prose">
        <p class="meta">Agentic: ${flow.agentic === true ? 'Yes' : flow.agentic === false ? 'No' : 'Not assessed'}</p>${flow.agentic_evidence ? renderMarkdown(flow.agentic_evidence) : ''}
        ${flow.validation_evidence ? `<h3>Definition validation</h3>${renderMarkdown(flow.validation_evidence)}` : ''}
        <h3>Trigger</h3>${renderMarkdown(flow.trigger || '')}<h3>Completion</h3>${renderMarkdown(flow.completion || '')}
        <h3>Handoffs</h3><ul>${(flow.handoffs || []).map(item => `<li>${processText(item)}</li>`).join('')}</ul>
        ${flow.signal_access?.length ? `<h3>Signal access</h3>${flow.signal_access.map(item => `<p><strong>${processText(item.kind)}</strong> · ${processText(item.ok && item.direct ? 'Direct read confirmed' : 'Access gap')}</p>${renderMarkdown(item.what)}<p class="meta">${processText(item.ref)}</p>`).join('')}` : ''}
        <h3>Step signals</h3>${(flow.signals || []).map(item => `<h4>${processText(item.step)}</h4>${renderMarkdown(item.signal)}<p class="meta">${processText(item.source)}</p>`).join('')}
        <h3>Failure conditions</h3>${(flow.failure_conditions || []).map(item => `<p><strong>${processText(item.step)}</strong></p>${renderMarkdown(item.condition)}<p class="meta">${processText(item.after)}</p>`).join('')}
        <h3>Examples</h3>${(flow.examples || []).map(item => `<p>${processText(item.date || '')}</p>${renderMarkdown(item.ref || '')}`).join('')}
      </div></details>`}
    </article></div>`;
  box.onclick = event => {
    const picker = event.target.closest('[data-process]');
    if (picker) {
      if (currentProcess !== picker.dataset.process) {
        currentProcess = picker.dataset.process;
        selectedProcessRun = '';
        processRunList = [];
        processRunDetail = null;
        processRunError = null;
        processRunDetailVersion += 1;
      }
      renderProcesses(businessFlows, internalFlows, true, triggers, clarifyBridge);
      return;
    }
    const zoom = event.target.closest('[data-zoom]');
    if (zoom) {
      if (zoom.dataset.zoom === 'fit') fitProcessGraph();
      else if (zoom.dataset.zoom === 'actual') activeProcessGraph?.zoomTo(1);
      else if (activeProcessGraph) activeProcessGraph[zoom.dataset.zoom === 'in' ? 'zoomIn' : 'zoomOut']();
      return;
    }
    const step = event.target.closest('[data-step]');
    if (step) {
      if (internal) openInternalNode(flow, (run?.definition || flow).nodes.find(node => node.id === step.dataset.step), run);
      else openBusinessCell(flow, step.dataset.step, run, triggers);
    }
  };
  const delegateBox = box.querySelector('[data-clarify-delegate]');
  if (delegateBox) {
    delegateBox.onchange = async () => {
      delegateBox.disabled = true;
      try {
        data = await api(`/api/processes/${encodeURIComponent(delegateBox.dataset.clarifyDelegate)}/delegation`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: delegateBox.checked }),
        });
        renderProcesses(data.environment?.processes?.processes || [], data.internal_processes || [], false, data.triggers || [], data.clarify_bridge || null);
      } catch (error) {
        delegateBox.checked = !delegateBox.checked;
        showError(error);
      } finally { delegateBox.disabled = false; }
    };
  }
  box.querySelector('[data-process-run]').onchange = event => {
    selectedProcessRun = event.target.value;
    processRunDetail = null;
    processRunError = null;
    processRunDetailVersion += 1;
    render();
    box.querySelector('[data-process-run]')?.focus();
    if (selectedProcessRun) fetchProcessRun(flow, selectedProcessRun, render);
  };
  if (refreshHistory && !box.hidden) refreshProcessRuns(flow, render);
  mountProcessDiagram(flow, run, triggers);
  box.onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-step]')) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); } };
}
