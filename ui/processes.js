// Business records and built-in flows share the draw.io view.
let currentProcess = null;
let showingChildReviews = false;
let visibleProcessDiagram = null;
const runHistories = new Map();
function runHistory(flow) {
  if (!runHistories.has(flow.id)) runHistories.set(flow.id, {
    selected: '', runs: [], detail: null, preview: null, error: null, loading: false, version: 0, manualSelection: false,
  });
  return runHistories.get(flow.id);
}
function processText(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function processStatus(flow) { return flow.status || 'unverified'; }
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
const reviewTime = value => value ? new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Etc/GMT+7',
}).format(new Date(value)) + ' PDT' : 'Not recorded';
const evidenceJson = value => JSON.stringify(value, (_key, field) => (
  typeof field === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(field) ? reviewTime(field) : field
), 2);
const reviewSources = { clock: 'Automatic cadence', manual: 'Manual Run', answer: 'Owner answer', recovery: 'Recovery return' };
const runStateLabels = {
  started: 'Running', running: 'Running', completed: 'Completed', failed: 'Failed', waiting: 'Waiting',
  skipped: 'Skipped', prior: 'Prior proof', current: 'Current', recovery: 'Recovery', open: 'Open',
  succeeded: 'Succeeded', stopped: 'Stopped', not_started: 'Run not started', not_recorded: 'Not recorded',
};
const processRunPath = flow => '/api/processes/' + encodeURIComponent(flow.id) + '/runs';

function internalDiagramXml(flow, run) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const text = dark ? '#e0e0e0' : '#333333';
  const neutral = dark ? '#8a8a8a' : '#777777';
  const palette = dark
    ? { started: '#8db3ff', current: '#8db3ff', completed: '#60c482', prior: '#84ad94', failed: '#f28891', recovery: '#f28891', waiting: '#e5b966', skipped: '#aab3c1' }
    : { started: '#385eaa', current: '#385eaa', completed: '#268046', prior: '#526f5f', failed: '#ad3f48', recovery: '#ad3f48', waiting: '#8d5b16', skipped: '#667080' };
  const traversed = new Set(run?.traversed || []);
  const color = id => palette[run?.nodes?.[id]?.status];
  const cells = flow.nodes.map(node => {
    const shape = node.type === 'decision' ? 'shape=rhombus;spacing=12;' : node.type === 'trigger' ? 'rounded=1;arcSize=18;' : 'rounded=0;';
    const stroke = color(node.id);
    const fill = dark ? '#222222' : '#f5f5f5';
    const style = shape + `whiteSpace=wrap;html=0;fontSize=16;fontFamily=Arial;fillColor=${fill};fontColor=${text};strokeColor=${stroke || neutral};strokeWidth=${stroke ? 3 : 1};`;
    const height = node.type === 'decision' || node.id === 'success' ? 72 : 58;
    const status = runStateLabels[run?.nodes?.[node.id]?.status];
    const value = processText(node.label) + (status ? '&#xa;' + processText(status) : '');
    return `<mxCell id="${node.id}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${24 + node.column * 182}" y="${24 + node.row * 107}" width="152" height="${height}" as="geometry"/></mxCell>`;
  });
  for (const edge of flow.edges) {
    const active = traversed.has(edge.id);
    const colorOnEdge = active ? color(edge.to) || color(edge.from) || neutral : neutral;
    const side = edge.to === 'skip' ? 'exitX=0;exitY=0.5;entryX=1;entryY=0.5;'
      : edge.to === 'checkpoint' ? 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;' : 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;';
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
async function mountProcessDiagram(flow, run = null, openInternal) {
  const version = ++processRenderVersion;
  activeProcessGraph?.destroy(); activeProcessGraph = null;
  const host = document.querySelector('.process-canvas');
  if (!host) return;
  const internal = flow.kind === 'internal';
  const diagram = run?.definition || flow;
  const internalNodes = new Map((diagram.nodes || []).map(node => [node.id, node]));
  const stepFromCell = id => internal ? internalNodes.get(id) : /^step-\d+$/.test(id) && flow.steps[Number(id.slice(5))];
  const openCell = id => {
    if (internal) openInternal(internalNodes.get(id));
    else openProcessStep(flow, Number(id.slice(5)));
  };
  if (!internal && !flow.steps?.length) { host.textContent = 'No steps recorded yet.'; return; }
  try {
    await loadProcessViewer();
    if (version !== processRenderVersion || !host.isConnected) return;
    host.replaceChildren();
    const div = document.createElement('div'); host.appendChild(div);
    const doc = window.mxUtils.parseXml(internal ? internalDiagramXml(diagram, run) : processDiagramXml(flow));
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
        node.dataset.step = internal ? cell.id : cell.id.slice(5);
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
function openProcessStep(flow, index) {
  if (!Number.isInteger(index) || !flow.steps?.[index]) return;
  const modal = processStepModal();
  const step = flow.steps[index];
  const signals = (flow.signals || []).filter(item => item.step === step);
  const failures = (flow.failure_conditions || []).filter(item => item.step === step);
  modal.dataset.step = index;
  modal.innerHTML = `<div class="process-modal-header"><div><p class="meta">${processStatus(flow) === 'validated' ? '' : `${processText(processStatusLabel(flow))} · `}${processNameWithBadge(flow)}</p><h2 id="process-step-title">${processText(step)}</h2></div><button type="button" class="ghost" data-close-step autofocus>Close</button></div>
    <div class="process-modal-body prose">${signals.length ? signals.map(item => `<h3>Expected signal</h3>${renderMarkdown(item.signal)}${item.source ? `<h3>Source</h3><p class="meta">${processText(item.source)}</p>` : ''}`).join('') : '<p class="empty">No supporting details recorded for this step yet.</p>'}
      ${failures.length ? `<h3>Failure conditions</h3>${failures.map(item => `${renderMarkdown(item.condition)}${item.after ? `<p><strong>When:</strong> ${processText(item.after)}</p>` : ''}`).join('')}` : ''}
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
function openReviewNode(flow, node, run, selected) {
  if (!node) return;
  const modal = processStepModal();
  const editable = !selected && Boolean(node.configuration);
  const config = run?.configuration || (!selected ? flow.configuration : node.id === 'agent' ? run?.nodes?.agent : null);
  modal.dataset.step = node.id;
  modal.innerHTML = `<div class="process-modal-header"><div><p class="meta">${processText(flow.name)}</p><h2 id="process-step-title">${processText(node.label)}</h2></div><button type="button" class="ghost" data-close-step autofocus>Close</button></div>
    <div class="process-modal-body prose">
      <h3>Configuration</h3><p>${processText(node.detail)}</p><p class="meta">${processText(node.binding)}</p>
      <form class="process-node-config">${configurationFields(node, config, editable)}${editable ? '<button type="submit" class="primary">Save</button><span role="status" data-config-feedback></span>' : ''}</form>
      ${selected ? `<h3>Run evidence</h3>${evidenceFields(run?.nodes?.[node.id])}` : ''}
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

function taskEvidence(task) {
  return `<details class="process-task-evidence"><summary>${processText(task.title)} · ${processText(task.status || 'Task record unavailable')}</summary>
    ${task.continuations.map(item => `<dl class="process-evidence-fields"><dt>Checkpoint</dt><dd>${processText(item.checkpoint || 'Not recorded')}</dd><dt>Owner</dt><dd>${processText(item.owner || 'Not recorded')}</dd><dt>Return</dt><dd>${processText(item.return_route || 'Not recorded')} · ${processText(item.state || 'Not recorded')}</dd></dl>`).join('')}
    ${task.runs.length ? `<ul>${task.runs.map(item => `<li>${processText(reviewTime(item.started_at))} · ${processText(runStateLabels[item.status] || item.status)}${item.error ? `<p class="meta">${processText(item.error)}</p>` : ''}</li>`).join('')}</ul>` : ''}
    <details><summary>Saved references</summary><pre>${processText(evidenceJson({ task_id: task.id, runs: task.runs.map(({ id, job_id }) => ({ id, job_id })), continuations: task.continuations }))}</pre></details>
  </details>`;
}
function openGoalRunNode(flow, node, run, showReview) {
  if (!node) return;
  const modal = processStepModal();
  const evidence = run?.nodes?.[node.id];
  const proof = evidence?.proof;
  const reviews = evidence?.reviews || (node.id === 'checkpoint' ? run?.child_reviews : []) || [];
  const prior = proof?.origin === 'before_run' || proof?.origin === 'reused';
  const proofHeading = prior ? 'Prior accepted evidence' : 'Evidence accepted in this run';
  const accepted = proof || (node.id === 'success' ? run?.success : null);
  const checkpoint = evidence?.checkpoint || (['checkpoint', 'waiting', 'recovery'].includes(node.id) ? evidence?.output : null);
  modal.dataset.step = node.id;
  modal.innerHTML = `<div class="process-modal-header"><div><p class="meta">${processText(run?.goal_title || flow.name)}</p><h2 id="process-step-title">${processText(node.label)}</h2></div><button type="button" class="ghost" data-close-step autofocus>Close</button></div>
    <div class="process-modal-body prose">
      ${node.work ? `<h3>Work</h3><p>${processText(node.work)}</p><h3>Done when</h3><p>${processText(node.done)}</p>` : `<p>${processText(node.detail)}</p>`}
      ${accepted ? `<h3>${proofHeading}</h3><p class="meta">${processText(reviewTime(accepted.at || accepted.accepted_at))}</p><p class="process-proof">${processText(accepted.evidence)}</p>` : ''}
      ${evidence?.prior_proof?.length ? `<details><summary>Earlier proof available</summary>${evidence.prior_proof.map(item => `<p class="meta">${processText(reviewTime(item.at))}</p><p class="process-proof">${processText(item.evidence)}</p>`).join('')}</details>` : ''}
      ${checkpoint ? `<h3>Current checkpoint</h3><p>${processText(checkpoint.reason)}</p>${checkpoint.continuations?.map(item => `<p>${processText(item.owner || 'Owner not recorded')} · ${processText(item.checkpoint || 'Checkpoint not recorded')}</p>`).join('') || ''}<details><summary>Checkpoint references</summary><pre>${processText(evidenceJson(checkpoint))}</pre></details>` : ''}
      ${evidence?.tasks?.length ? `<h3>Tasks</h3>${evidence.tasks.map(taskEvidence).join('')}` : ''}
      ${reviews.length ? `<h3>Child reviews</h3><ul class="process-tool-list">${reviews.map(review => `<li><button type="button" class="ghost" data-child-review="${processText(review.id)}">${processText(reviewSources[review.source] || 'Review')} · ${processText(reviewTime(review.created_at))}</button></li>`).join('')}</ul>` : ''}
      ${node.id === 'intake' && evidence ? evidenceFields(evidence) : ''}
      ${node.id === 'checkpoint' && run?.configuration ? `<details><summary>Initial configuration</summary><pre>${processText(evidenceJson(run.configuration))}</pre></details>` : ''}
    </div>`;
  modal.querySelectorAll('[data-child-review]').forEach(button => button.addEventListener('click', () => {
    modal.close();
    showReview(button.dataset.childReview);
  }));
  if (!modal.open) modal.showModal();
}

async function fetchProcessRun(flow, history, id, render) {
  const version = ++history.version;
  try {
    const detail = await api(processRunPath(flow) + '/' + encodeURIComponent(id));
    if (version !== history.version || history.selected !== id) return;
    if (JSON.stringify(history.detail) === JSON.stringify(detail) && !history.error) return;
    history.detail = detail;
    history.error = null;
    render();
  } catch (error) {
    if (version === history.version && history.selected === id) {
      history.error = error.message;
      render();
    }
  }
}
async function refreshProcessRuns(flow, history, render) {
  if (history.loading) return;
  history.loading = true;
  try {
    const { runs, current_goal = null, active_run_id } = await api(processRunPath(flow));
    const selectActive = active_run_id && !history.manualSelection && !history.selected;
    if (selectActive) history.selected = active_run_id;
    if (selectActive || JSON.stringify(history.runs) !== JSON.stringify(runs) || JSON.stringify(history.preview) !== JSON.stringify(current_goal) || history.error) {
      history.runs = runs;
      history.preview = current_goal;
      history.error = null;
      render();
    }
    if (history.selected) {
      const row = runs.find(item => item.id === history.selected);
      const childUnsettled = history.detail?.child_reviews?.some(child => !child.finished_at);
      if (history.detail?.id !== history.selected || !row?.finished_at || !history.detail?.finished_at || childUnsettled) {
        await fetchProcessRun(flow, history, history.selected, render);
      }
    }
  } catch (error) { history.error = error.message; render(); }
  finally { history.loading = false; }
}
function runPicker(flow, run, history, child, parentId) {
  const option = row => {
    const parent = row.goal_title ? row.goal_title + ' · ' + (runStateLabels[row.status] || row.status) : null;
    const review = reviewSources[row.source] || 'Historical review';
    const label = parent ? parent + ' · ' + reviewTime(row.created_at) : reviewTime(row.created_at) + ' · ' + review + (row.decision === 'skipped' ? ' · Skipped' : '');
    return `<option value="${processText(row.id)}"${row.id === history.selected ? ' selected' : ''}>${processText(label)}</option>`;
  };
  const group = (label, rows) => rows.length ? `<optgroup label="${label}">${rows.map(option).join('')}</optgroup>` : '';
  const options = child ? [
    group('Selected goal run', history.runs.filter(row => parentId && row.goal_run_id === parentId)),
    group('Other linked reviews', history.runs.filter(row => row.goal_run_id && row.goal_run_id !== parentId)),
    group('Earlier or unlinked reviews', history.runs.filter(row => !row.goal_run_id)),
  ].join('') : history.runs.map(option).join('');
  const message = history.error || (history.selected && !run ? 'Loading run…' : run?.historical ? 'Historical · Trigger and version not recorded' : '');
  const current = !child && history.preview ? history.preview.goal_title + ' · Run not started' : child ? 'Current configuration' : 'Goal run definition';
  return `<div class="process-run-controls">
    ${child ? '<button type="button" class="ghost" data-parent-diagram>Back to goal run</button>' : '<button type="button" class="ghost" data-child-diagram>Review traces and settings</button>'}
    <label>${child ? 'Child review' : 'Goal run'} <select data-process-run><option value="">${processText(current)}</option>${options}</select></label>
    <span class="meta">${flow.configuration.automatic_enabled ? 'Automatic reviews enabled' : 'Automatic reviews paused'}</span>
    ${message ? `<span class="meta" role="status">${processText(message)}</span>` : ''}</div>`;
}

function renderProcesses(businessFlows, internalFlows = [], refreshHistory = true) {
  const flows = [...businessFlows, ...internalFlows];
  const box = document.querySelector('#processes');
  if (!flows.length) { box.innerHTML = '<p class="empty">No processes recorded yet.</p>'; return; }
  if (!flows.some(flow => flow.id === currentProcess)) currentProcess = flows[0].id;
  const primary = flows.find(item => item.id === currentProcess);
  const open = box.querySelector('.process-notes')?.open || false;
  const internal = primary.kind === 'internal';
  const child = Boolean(internal && showingChildReviews && primary.review_process);
  const flow = child ? primary.review_process : primary;
  visibleProcessDiagram = flow.id;
  const history = internal ? runHistory(flow) : null;
  const run = !history ? null : history.selected ? (history.detail?.id === history.selected ? history.detail : null) : history.preview;
  const render = () => {
    if (visibleProcessDiagram === flow.id) renderProcesses(businessFlows, internalFlows, false);
  };
  const showReview = id => {
    if (!primary.review_process) return;
    const childHistory = runHistory(primary.review_process);
    if (id) {
      childHistory.selected = id;
      childHistory.detail = null;
      childHistory.version += 1;
    }
    childHistory.error = null;
    showingChildReviews = true;
    renderProcesses(businessFlows, internalFlows);
  };
  const openNode = node => child ? openReviewNode(flow, node, run, history.selected) : openGoalRunNode(flow, node, run, showReview);
  const agentic = businessFlows.filter(item => item.agentic === true).length;
  const unknown = businessFlows.filter(item => typeof item.agentic !== 'boolean').length;
  const badge = item => item.kind === 'internal' ? '<span class="meta">Internal</span>' : processStatus(item) === 'validated' ? '' : `<span class="status ${processText(processStatus(item))}">${processText(processStatusLabel(item))}</span>`;
  box.innerHTML = `${businessFlows.length ? `<div class="process-metric">Confirmed agentic: ${agentic}/${businessFlows.length} (${Math.round(agentic / businessFlows.length * 100)}%)${unknown ? ` · ${unknown} not assessed` : ''}</div>` : ''}<div class="process-workspace">
    <aside class="process-picker" aria-label="Processes">${flows.map(item => `<button type="button" data-process="${processText(item.id)}" class="${item.id === primary.id ? 'selected' : ''}" aria-pressed="${item.id === primary.id}">${badge(item)}${processNameWithBadge(item)}</button>`).join('')}</aside>
    <article class="process-view"><div class="process-header"><div>${badge(flow)}<h2>${processNameWithBadge(flow)}</h2></div><div class="process-controls"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><span data-process-zoom>100%</span><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="actual">Actual size</button><button type="button" data-zoom="fit">Fit diagram</button></div></div>
      ${internal ? runPicker(flow, run, history, child, runHistory(primary).selected) : ''}
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
    if (picker) { currentProcess = picker.dataset.process; showingChildReviews = false; renderProcesses(businessFlows, internalFlows); return; }
    if (event.target.closest('[data-child-diagram]')) { showReview(); return; }
    if (event.target.closest('[data-parent-diagram]')) { showingChildReviews = false; renderProcesses(businessFlows, internalFlows); return; }
    const zoom = event.target.closest('[data-zoom]');
    if (zoom) {
      if (zoom.dataset.zoom === 'fit') fitProcessGraph();
      else if (zoom.dataset.zoom === 'actual') activeProcessGraph?.zoomTo(1);
      else if (activeProcessGraph) activeProcessGraph[zoom.dataset.zoom === 'in' ? 'zoomIn' : 'zoomOut']();
      return;
    }
    const step = event.target.closest('[data-step]');
    if (step) {
      if (internal) openNode((run?.definition || flow).nodes.find(node => node.id === step.dataset.step));
      else openProcessStep(flow, Number(step.dataset.step));
    }
  };
  if (internal) {
    box.querySelector('[data-process-run]').onchange = event => {
      history.manualSelection = true;
      history.selected = event.target.value;
      history.detail = null;
      history.error = null;
      history.version += 1;
      render();
      box.querySelector('[data-process-run]')?.focus();
      if (history.selected) fetchProcessRun(flow, history, history.selected, render);
    };
    if (refreshHistory && !box.hidden) refreshProcessRuns(flow, history, render);
  }
  mountProcessDiagram(flow, run, openNode);
  box.onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-step]')) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); } };
}
