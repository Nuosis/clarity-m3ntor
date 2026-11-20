// Process is a view of the saved business records; details stay behind disclosure.
let currentProcess = null;
let processZoom = 1;
function processText(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function processName(name) { return String(name).replace(/^DRAFT PARTIAL\s*[—–-]\s*/i, ''); }
function flowLines(text, width = 33) {
  const words = String(text).split(/\s+/); const lines = [''];
  for (const word of words) {
    if (lines[lines.length - 1].length + word.length > width && lines[lines.length - 1]) lines.push(word);
    else lines[lines.length - 1] += (lines[lines.length - 1] ? ' ' : '') + word;
  }
  return lines;
}
function processDiagram(flow) {
  const steps = flow.steps || [];
  if (!steps.length) return '<p class="empty">No steps recorded yet.</p>';
  const columns = Math.min(3, steps.length), rows = Math.ceil(steps.length / columns);
  const width = columns * 336, height = rows * 160 + 36;
  const position = index => {
    const row = Math.floor(index / columns), col = row % 2 ? columns - 1 - index % columns : index % columns;
    return { x: col * 336 + 20, y: row * 160 + 22 };
  };
  const arrows = steps.slice(1).map((_, index) => {
    const a = position(index), b = position(index + 1);
    const across = a.y === b.y, right = b.x > a.x;
    const path = across ? `M ${a.x + (right ? 286 : 0)} ${a.y + 55} H ${b.x + (right ? -6 : 292)}` : `M ${a.x + 143} ${a.y + 110} V ${b.y - 7}`;
    return `<path d="${path}" class="process-edge" marker-end="url(#process-arrow)" />`;
  }).join('');
  const nodes = steps.map((step, index) => {
    const { x, y } = position(index);
    const lines = flowLines(step);
    return `<g class="process-node" tabindex="0" role="button" data-step="${index}" aria-label="Step ${index + 1}: ${processText(step)}">
      <title>${processText(step)}</title><rect x="${x}" y="${y}" width="286" height="110" rx="12" />
      <text x="${x + 15}" y="${y + 23}" class="process-number">${index + 1}</text>
      <text x="${x + 143}" y="${y + 61 - (lines.length - 1) * 9}" text-anchor="middle">${lines.map((line, n) => `<tspan x="${x + 143}" dy="${n ? 18 : 0}">${processText(line)}</tspan>`).join('')}</text>
    </g>`;
  }).join('');
  return `<svg class="process-diagram" style="--diagram-width:${width}px;--diagram-zoom:${processZoom}" viewBox="0 0 ${width} ${height}" role="group" aria-label="${processText(processName(flow.name))} — recorded step order">
    <defs><marker id="process-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>${arrows}${nodes}</svg>`;
}
function renderProcesses(flows) {
  const box = document.querySelector('#processes');
  if (!flows.length) { box.innerHTML = '<p class="empty">No processes recorded yet.</p>'; return; }
  if (!flows.some(flow => flow.id === currentProcess)) currentProcess = flows[0].id;
  const flow = flows.find(item => item.id === currentProcess);
  const open = box.querySelector('.process-notes')?.open || false;
  box.innerHTML = `<div class="process-workspace">
    <aside class="process-picker" aria-label="Processes">${flows.map(item => `<button type="button" data-process="${processText(item.id)}" class="${item.id === flow.id ? 'selected' : ''}" aria-pressed="${item.id === flow.id}">${/^DRAFT/i.test(item.name) ? '<span class="process-draft">Draft · Partial</span>' : ''}<span>${processText(processName(item.name))}</span></button>`).join('')}</aside>
    <article class="process-view"><div class="process-header"><h2>${processText(processName(flow.name))}</h2><div class="process-controls"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="fit">Fit</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button></div></div>
      <div class="process-canvas">${processDiagram(flow)}</div>
      <div id="process-step-detail" hidden></div>
      <details class="process-notes"${open ? ' open' : ''}><summary>Details</summary><div class="prose">
        <h3>Trigger</h3>${renderMarkdown(flow.trigger || '')}<h3>Completion</h3>${renderMarkdown(flow.completion || '')}
        <h3>Handoffs</h3><ul>${(flow.handoffs || []).map(item => `<li>${processText(item)}</li>`).join('')}</ul>
        <h3>Step signals</h3>${(flow.signals || []).map(item => `<h4>${processText(item.step)}</h4>${renderMarkdown(item.signal)}<p class="meta">${processText(item.source)}</p>`).join('')}
        <h3>Failure conditions</h3>${(flow.failure_conditions || []).map(item => `<p><strong>${processText(item.step)}</strong></p>${renderMarkdown(item.condition)}<p class="meta">${processText(item.after)}</p>`).join('')}
        <h3>Examples</h3>${(flow.examples || []).map(item => `<p>${processText(item.date || '')}</p>${renderMarkdown(item.ref || '')}`).join('')}
        <p class="meta">Diagram shows the recorded step order; branch and handoff review remains pending.</p>
      </div></details>
    </article></div>`;
  box.onclick = event => {
    const picker = event.target.closest('[data-process]');
    if (picker) { currentProcess = picker.dataset.process; processZoom = 1; renderProcesses(flows); return; }
    const zoom = event.target.closest('[data-zoom]');
    if (zoom) {
      processZoom = zoom.dataset.zoom === 'fit' ? 1 : Math.max(0.5, Math.min(3, processZoom + (zoom.dataset.zoom === 'in' ? 0.25 : -0.25)));
      box.querySelector('.process-diagram').style.setProperty('--diagram-zoom', processZoom); return;
    }
    const step = event.target.closest('[data-step]');
    if (step) {
      const index = Number(step.dataset.step), signal = (flow.signals || []).find(item => item.step === flow.steps[index]);
      const panel = box.querySelector('#process-step-detail');
      panel.hidden = false;
      panel.innerHTML = `<div class="process-header"><h3>${processText(flow.steps[index])}</h3><button type="button" class="ghost" data-close-step>Close</button></div>${signal ? `<div class="prose">${renderMarkdown(signal.signal)}</div><p class="meta">${processText(signal.source)}</p>` : ''}`;
    }
    if (event.target.closest('[data-close-step]')) box.querySelector('#process-step-detail').hidden = true;
  };
  box.onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-step]')) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); } };
}
