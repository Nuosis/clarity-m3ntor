// Owner view for the local M3NT0R service. Data comes from /api/overview and
// /api/tasks/:id; /api/events pushes a change notice whenever local records change.
let data = null;
let selectedTask = null;
let view = 'goals';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = value => value ? new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '';
const status = value => value ? `<span class="status ${esc(value)}">${esc(value)}</span>` : '';

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
function showError(error, ms = 6000) {
  const box = $('#error');
  box.textContent = error.message; box.hidden = false;
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => { box.hidden = true; }, ms);
}
// A goal review problem shows once as a 3-second notice.
let shownReviewError = sessionStorage.getItem('m3ntor-review-error');
function noticeReviewError() {
  if (!data.review_error || data.review_error === shownReviewError) return;
  shownReviewError = data.review_error;
  sessionStorage.setItem('m3ntor-review-error', shownReviewError);
  showError(new Error(data.review_error), 3000);
}

async function load() {
  try {
    data = await api('/api/overview');
    render();
    if (selectedTask) await showTask(selectedTask);
  } catch (error) { showError(error); }
}

function render() {
  const worker = data.worker;
  $('#worker').textContent = worker.enabled ? `Worker on${worker.next_run_at ? ` · next run ${when(worker.next_run_at)}` : ''}` : 'Worker off';
  $('#question-count').textContent = data.questions.pending.length ? `(${data.questions.pending.length})` : '';
  renderRunning(); renderGoals(); renderProcesses(data.environment?.processes?.processes || [], data.internal_processes || [], true, data.triggers || []); renderSettings(); noticeReviewError(); renderTasks(); renderQuestions(); renderAssessment(); renderContext(); renderJournal();
  restoreDrafts();
}

const JOB_LABELS = { goal_review: 'inov8', poma_assessment: 'Assessment', poma_reassessment: 'Assessment', coaching: 'M3NT0R coaching', scheduled_task: 'Task', a2a_message: 'A2A request' };
function renderRunning() {
  const box = $('#running');
  const jobs = data.running || [];
  if (!jobs.length) { box.hidden = true; box.innerHTML = ''; return; }
  const first = jobs[0];
  const label = JOB_LABELS[first.task] || 'Job';
  box.innerHTML = `<span class="bar" aria-hidden="true"></span><span>${esc(label)} running since ${esc(when(first.started_at))}${jobs.length > 1 ? `, and ${jobs.length - 1} more` : ''}</span>`;
  box.hidden = false;
}

// Use cases come from the shared library through the local service; searched on demand.
let caseQuery = '';
async function loadUseCases() {
  const list = $('#case-list');
  try {
    const result = await api(`/api/use-cases?${caseQuery}`);
    list.innerHTML = result.cases.length ? result.cases.map(renderCase).join('') : '<p class="empty">No use cases match.</p>';
  } catch (error) { list.innerHTML = `<p class="empty">${esc(error.message)}</p>`; }
}
function renderCase(item) {
  const list = (title, values) => values?.length ? `<h3>${title}</h3><ul>${values.map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : '';
  const variants = item.variants?.length ? `<details>
      <summary>${item.variants.length} variant${item.variants.length === 1 ? '' : 's'}</summary>
      <div class="prose">${item.variants.map(v => `<h3>${esc(v.title)}${v.boosts ? ` <span class="chip boosts">${v.boosts} boost${v.boosts === 1 ? '' : 's'}</span>` : ''}</h3>${list('Differs by', v.distinct_aspects)}`).join('')}</div>
    </details>` : '';
  return `<article class="card case${item.boosts ? ' boosted' : ''}">
    <div class="head">
      <h2>${esc(item.title)}</h2>
      ${item.own ? `<button class="danger" type="button" data-revoke="${esc(item.id)}">Revoke</button>` : ''}
    </div>
    <div class="labels">
      ${item.boosts ? `<span class="chip boosts">${item.boosts} boost${item.boosts === 1 ? '' : 's'}</span>` : ''}
      ${item.own ? '<span class="chip own">Your business</span>' : ''}
      ${(item.poma_labels || []).map(l => `<span class="chip poma">${esc(l)}</span>`).join('')}
      ${(item.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}
      <span class="meta">${esc(item.source_kind === 'web_documented' ? 'Web documented' : 'Owner reported')} · ${esc(when(item.created_at))}</span>
    </div>
    <p>${esc(item.summary)}</p>
    <details>
      <summary>How it works</summary>
      <div class="prose">
        <h3>Process</h3>${renderMarkdown(item.process)}
        ${list('Prerequisites', item.prerequisites)}
        ${list('What the agent does', item.agent_actions)}
        <h3>Outcome</h3><p>${esc(item.outcome)}</p>
        ${item.owner_feedback ? `<h3>Owner feedback</h3><p>${esc(item.owner_feedback)}</p>` : ''}
        ${list('Limitations', item.evidence?.limitations)}
      </div>
    </details>
    ${variants}
  </article>`;
}
$('#case-filters').addEventListener('submit', event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const params = new URLSearchParams();
  if (form.get('q')) params.set('q', form.get('q'));
  for (const label of form.getAll('label')) params.append('label', label);
  if (form.get('source')) params.set('source', form.get('source'));
  if (form.get('tags')) params.set('tags', form.get('tags'));
  caseQuery = params.toString();
  loadUseCases();
});
$('#case-list').addEventListener('click', async event => {
  const id = event.target.dataset?.revoke;
  if (!id) return;
  if (!confirm('Revoke this use case? It will be removed from the shared library for every business.')) return;
  try { await api(`/api/use-cases/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); loadUseCases(); }
  catch (error) { showError(error); }
});

function renderContext() {
  $('#context').innerHTML = data.context.trim()
    ? `<article class="card prose">${window.renderMarkdown(data.context)}</article>`
    : '<p class="empty">No business context recorded yet.</p>';
}

const FINISHED = new Set(['completed', 'done']);
const openTasks = () => data.tasks.filter(task => !FINISHED.has(task.status));
function renderTasks() {
  const list = $('#task-list');
  const tasks = openTasks();
  if (!tasks.length) { list.innerHTML = '<li class="empty">No open tasks.</li>'; return; }
  list.innerHTML = tasks.map(task => `
    <li data-id="${esc(task.id)}" class="${task.id === selectedTask ? 'selected' : ''}">
      <div class="title"><span>${esc(task.title)}</span>${status(task.status)}</div>
      <div class="meta">${goalLabel(task)}${task.next_run_at ? `Next ${when(task.next_run_at)}` : task.last_run_at ? `Last run ${when(task.last_run_at)}` : ''}</div>
    </li>`).join('');
}
function goalLabel(task) {
  const goal = task.goal_id && (data.goals || []).find(item => item.id === task.goal_id);
  const stage = goal?.stages.find(item => item.key === task.stage);
  return goal ? `${esc(goal.title)}${stage ? ` · ${esc(stage.name)}` : ''} · ` : '';
}

const PACE_LABELS = { hourly: 'Hourly', daily: 'Daily', yolo: 'YOLO' };
const GOAL_STATUS = { active: 'active', waiting: 'waiting', stopped: 'stopped' };
function renderGoals() {
  const goals = (data.goals || []).filter(goal => goal.status !== 'inactive');
  const expanded = new Set([...$('#goals').querySelectorAll('details[data-detail][open]')].map(item => item.dataset.detail));
  $('#goals').innerHTML = goals.length ? goals.map(renderGoal).join('') : '<p class="empty">No goals.</p>';
  $('#goals').querySelectorAll('details[data-detail]').forEach(item => { item.open = expanded.has(item.dataset.detail); });
  $('#goals').querySelectorAll('form.stop-goal').forEach(stop => stop.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      data = await api(`/api/goals/${encodeURIComponent(stop.dataset.id)}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: stop.reason.value }) });
      drafts.delete(draftKey(stop.reason));
      render();
    } catch (error) { showError(error); }
  }));
}
function renderSettings() {
  if ($('#settings').contains(document.activeElement)) return; // keep the owner's unsaved edits
  const pace = data.pace || {};
  $('#settings').innerHTML = `
    <form id="settings-form" class="card settings">
      <h2>inov8</h2>
      <div class="row">
        <select name="pace" aria-label="inov8 pace">${Object.entries(PACE_LABELS).map(([value, label]) => `<option value="${value}"${pace.pace === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
        <label${pace.pace === 'daily' ? '' : ' hidden'}>at <input type="time" name="time" value="${esc(pace.time || '08:00')}"></label>
        <button class="primary" type="button" id="run-review"${pace.reviewing_job_id ? ' disabled' : ''}>Run</button>
      </div>
      <p class="meta">YOLO reviews as soon as the current stage's tasks are done or blocked.</p>
      <h2>Agent runner</h2>
      <div class="row">
        <select name="agent_harness" aria-label="Agent runner">${[['codex', 'Codex'], ['claude', 'Claude']].map(([value, label]) => `<option value="${value}"${(data.agent_harness || 'codex') === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
      </div>
      <p class="meta">Runs tasks and inov8. M3NT0R's coaching and assessments keep their own harness.</p>
      <h2>Full access</h2>
      <label class="toggle"><input type="checkbox" name="full_access"${data.full_access ? ' checked' : ''}> Run tasks and inov8 with full access</label>
      <p class="meta">Codex runs without a sandbox or approvals; Claude runs with permissions bypassed. They can change anything you can. Coaching and A2A requests stay read-only.</p>
      <div class="actions"><button class="primary" type="submit">Save</button></div>
    </form>`;
  const form = $('#settings-form');
  form.pace.addEventListener('change', () => { form.time.parentElement.hidden = form.pace.value !== 'daily'; });
  $('#run-review').addEventListener('click', async () => {
    $('#run-review').disabled = true;
    try { data = await api('/api/goals/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); render(); }
    catch (error) { $('#run-review').disabled = false; showError(error); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      data = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pace: form.pace.value, time: form.time.value, agent_harness: form.agent_harness.value, full_access: form.full_access.checked }) });
      document.activeElement?.blur(); render();
    } catch (error) { showError(error); }
  });
}
function renderGoalStages(goal) {
  return `<span class="stages" role="list">${goal.stages.map(stage => `<span role="listitem" class="${esc(stage.state)}">${esc(stage.name)}</span>`).join('')}</span>`;
}
function renderGoalFlowDetails(goal) {
  const tasks = openTasks().filter(task => task.goal_id === goal.id && (!goal.stage || task.stage === goal.stage.key));
  return `${renderGoalStages(goal)}
    ${goal.stage ? `<h3>Stage ${goal.stage.index} of ${goal.stages.length}: ${esc(goal.stage.name)}</h3>
      <div class="prose">${renderMarkdown(goal.stage.work)}</div>
      <dl><dt>Done when</dt><dd class="prose">${renderMarkdown(goal.stage.done_check)}</dd></dl>
      ${tasks.length ? `<ul class="goal-tasks">${tasks.map(task => `<li><a href="#" data-task="${esc(task.id)}">${esc(task.title)}</a> ${status(task.status)}</li>`).join('')}</ul>` : '<p class="empty">No tasks for this stage yet.</p>'}` : ''}
    ${goal.completed.length ? `<details><summary>Completed stages</summary>${goal.completed.map(item => `<div class="entry"><div class="meta">${esc(item.name)} · ${when(item.at)}</div><div class="prose">${renderMarkdown(item.evidence)}</div></div>`).join('')}</details>` : ''}`;
}
function openGoalFlow(goal) {
  let modal = $('#goal-flow-modal');
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = 'goal-flow-modal';
    modal.setAttribute('aria-labelledby', 'goal-flow-title');
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
      if (event.target.closest('[data-close-goal-flow]')) modal.close();
      const task = event.target.closest('[data-task]');
      if (task) {
        event.preventDefault(); modal.close();
        document.querySelector('nav button[data-view="tasks"]').click();
        showTask(task.dataset.task);
      }
      if (event.target === modal) {
        const bounds = modal.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) modal.close();
      }
    });
    modal.addEventListener('close', () => document.querySelector(`[data-goal-flow="${CSS.escape(modal.dataset.goal)}"]`)?.focus());
  }
  modal.dataset.goal = goal.id;
  modal.innerHTML = `<div class="process-modal-header"><h2 id="goal-flow-title">${esc(goal.title)}</h2><button type="button" class="ghost" data-close-goal-flow autofocus>Close</button></div><div class="process-modal-body">${renderGoalFlowDetails(goal)}</div>`;
  if (!modal.open) modal.showModal();
}
function renderGoal(goal) {
  return `<article class="card goal">
    <div class="title"><h2>${esc(goal.title)}</h2> ${status(GOAL_STATUS[goal.status] || goal.status)}</div>
    <button type="button" class="goal-flow-trigger" data-goal-flow="${esc(goal.id)}" aria-label="View stage details for ${esc(goal.title)}" aria-haspopup="dialog">${renderGoalStages(goal)}</button>
    <details data-detail="${esc(goal.id)}"><summary>Details</summary>
    <div class="goal-details">
    ${goal.outcome ? `<div class="prose">${renderMarkdown(goal.outcome)}</div>` : ''}
    ${goal.kind === 'environment' ? environmentRecords(goal) : ''}
    ${goal.stop_reason ? `<h3>Stopped</h3><div class="prose">${renderMarkdown(goal.stop_reason)}</div>` : ''}
    ${goal.kind !== 'environment' && goal.status !== 'stopped' ? `<form class="stop-goal" data-id="${esc(goal.id)}">
      <textarea name="reason" placeholder="Reason for stopping this goal" aria-label="Reason for stopping this goal" required></textarea>
      <div class="actions"><button class="secondary" type="submit">Stop goal</button></div>
    </form>` : ''}
    </div></details>
  </article>`;
}
function environmentRecords(goal) {
  const env = data.environment || {};
  const sources = env.sources?.sources || [];
  const commitments = env.plate?.commitments || [];
  const processes = sortProcesses(env.processes?.processes || []);
  const needed = value => value === true ? 'Needed' : value === false ? 'Not needed' : 'Undecided';
  return `
    <details data-detail="${esc(goal.id)}-infrastructure"><summary>Sources (${sources.filter(s => s.needed).length} needed of ${sources.length})</summary>
      ${sources.length ? `<table class="records"><thead><tr><th>Source</th><th>Needed</th><th>Last read-back</th></tr></thead><tbody>${sources.map(s => `<tr>
        <td><strong>${esc(s.name)}</strong><div class="meta">${esc(s.route || '')}</div></td>
        <td>${needed(s.needed)}${s.needed_reason ? `<div class="meta">${esc(s.needed_reason)}</div>` : ''}</td>
        <td>${s.read_back ? `${status(s.read_back.ok ? 'completed' : 'failed')} ${when(s.read_back.at)}<div class="meta">${esc(s.read_back.what)}</div>` : '<span class="meta">None</span>'}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="empty">No sources recorded.</p>'}
    </details>
    <details data-detail="${esc(goal.id)}-process"><summary>Processes (${processes.length})</summary>
      ${processes.length ? processes.map(f => `<div class="entry"><strong>${esc(processName(f.name))}</strong> ${status(processStatus(f))}<div class="meta">Trigger: ${esc(f.trigger || 'not recorded')} · Completion: ${esc(f.completion || 'not recorded')} · ${(f.examples || []).length} examples</div>${f.signals?.length ? `<table class="records"><thead><tr><th>Step</th><th>Signal</th><th>Source</th></tr></thead><tbody>${f.signals.map(s => `<tr><td>${esc(s.step)}</td><td>${esc(s.signal)}</td><td>${esc(s.source)}</td></tr>`).join('')}</tbody></table>` : f.steps?.length ? `<ol>${f.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}</div>`).join('') : '<p class="empty">No processes recorded.</p>'}
    </details>
    <details data-detail="${esc(goal.id)}-observability"><summary>Commitments (${commitments.length}${env.plate?.updated_at ? `, updated ${when(env.plate.updated_at)}` : ''})</summary>
      ${commitments.length ? `<table class="records"><thead><tr><th>Work</th><th>For</th><th>Due</th><th>Step</th></tr></thead><tbody>${commitments.map(c => `<tr><td>${esc(c.what)}<div class="meta">${(c.sources || []).map(s => esc(s.ref)).join(', ')}</div></td><td>${esc(c.to_whom)}</td><td>${esc(c.due || '')}</td><td>${esc(c.process ? `${c.process}: ${c.step || ''}` : c.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No commitments recorded.</p>'}
      ${env.plate?.priorities?.length ? `<h3>Priorities</h3><ol>${env.plate.priorities.map(p => `<li>${esc(p)}</li>`).join('')}</ol>` : ''}
    </details>`;
}
$('#goals').addEventListener('click', event => {
  const flow = event.target.closest('[data-goal-flow]');
  if (flow) {
    const goal = (data.goals || []).find(item => item.id === flow.dataset.goalFlow);
    if (goal) openGoalFlow(goal);
    return;
  }
  const id = event.target.dataset?.task;
  if (!id) return;
  event.preventDefault();
  document.querySelector('nav button[data-view="tasks"]').click();
  showTask(id);
});

async function showTask(id) {
  selectedTask = id;
  renderTasks();
  const pane = $('#task-detail');
  let detail;
  try { detail = await api(`/api/tasks/${encodeURIComponent(id)}`); }
  catch { pane.innerHTML = '<p class="empty">This task is no longer in the list.</p>'; selectedTask = null; return; }
  const { task, runs } = detail;
  const recurrence = task.recurrence?.weekly ? `Weekly, ${task.recurrence.weekly.day} ${task.recurrence.weekly.time}` : task.recurrence?.interval_minutes ? `Every ${task.recurrence.interval_minutes} minutes` : 'Once';
  pane.innerHTML = `
    <h2>${esc(task.title)} ${status(task.status)}</h2>
    <dl>
      <dt>Task</dt><dd>${esc(task.instruction)}</dd>
      <dt>Success</dt><dd>${esc(task.success || '')}</dd>
      ${task.constraints?.length ? `<dt>Constraints</dt><dd>${task.constraints.map(esc).join('\n')}</dd>` : ''}
      <dt>Schedule</dt><dd>${esc(recurrence)}${task.next_run_at ? `, next ${when(task.next_run_at)}` : ''}</dd>
      ${task.pause_reason ? `<dt>Paused</dt><dd>${esc(task.pause_reason)}</dd>` : ''}
      ${task.last_error ? `<dt>Last error</dt><dd>${esc(task.last_error)}</dd>` : ''}
    </dl>
    <h3>Runs</h3>
    ${runs.length ? runs.map(renderRun).join('') : '<p class="empty">Not run yet.</p>'}`;
  restoreDrafts();
}

function renderRun(run) {
  const process = run.process;
  return `<div class="card">
    <div>${status(run.status)} ${when(run.started_at)}${run.finished_at ? ` to ${when(run.finished_at)}` : ''}</div>
    ${process?.steps?.length ? `<h3>What the agent did</h3><ol class="steps">${process.steps.map(step => `<li>${esc(step.tool)} <code>${esc(step.input)}</code></li>`).join('')}</ol>` : ''}
    ${run.result || process?.output ? `<h3>Result</h3><pre>${esc(run.result || process.output)}</pre>` : ''}
    ${run.error ? `<h3>Error</h3><pre>${esc(run.error)}</pre>` : ''}
  </div>`;
}

function renderQuestions() {
  const { pending } = data.questions;
  $('#questions').innerHTML = `
    ${pending.length ? '<h2>Waiting on you</h2>' : ''}
    ${pending.length ? pending.map(q => `
      <form class="card question" data-id="${esc(q.id)}">
        <div class="prose">${window.renderMarkdown(q.question)}</div>
        <textarea name="answer" placeholder="Your answer"></textarea>
        <div class="actions">
          <button class="primary" type="submit" value="answer">Answer</button>
          <button class="secondary" type="submit" value="dismiss">Dismiss</button>
        </div>
      </form>`).join('') : `<form class="card note">
        <label for="owner-note"><strong>Tell me what else I can do for you</strong></label>
        <textarea id="owner-note" name="note"></textarea>
        <div class="actions"><button class="primary" type="submit">Send</button></div>
      </form>`}
`;
  document.querySelector('form.note')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    if (!form.note.value.trim()) { showError(new Error('Write something first.')); return; }
    try {
      data = await api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: form.note.value }) });
      drafts.delete(draftKey(form.note));
      render();
      showError(new Error('Sent. The next goal review will take it into account.'), 3000);
    } catch (error) { showError(error); }
  });
  document.querySelectorAll('form.question').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const action = event.submitter?.value || 'answer';
    if (action === 'answer' && !form.answer.value.trim()) { showError(new Error('Write an answer first.')); return; }
    try {
      data = await api(`/api/questions/${encodeURIComponent(form.dataset.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, answer: form.answer.value }) });
      drafts.delete(draftKey(form.answer));
      render();
    } catch (error) { showError(error); }
  }));
}

function renderAssessment() {
  const [latest, previous] = data.assessments;
  const areas = ['process', 'observability', 'measurement', 'agency'];
  const ratings = assessment => `<div class="ratings">${areas.map(area => {
    const rating = assessment.ratings?.[area] || {};
    const before = previous?.ratings?.[area]?.score;
    return `<div class="rating">
      <span class="area">${area[0].toUpperCase() + area.slice(1)}</span>
      <span class="category">${esc(rating.category)}</span>
      <span class="track"><span class="fill" style="width:${Math.max(0, Math.min(10, Number(rating.score) || 0)) * 10}%"></span></span>
      <span class="score">${esc(rating.score)}<small>/10</small>${before !== undefined && before !== rating.score ? ` <small>(was ${esc(before)})</small>` : ''}</span>
    </div>`; }).join('')}</div>`;
  $('#assessment').innerHTML = `
    ${latest ? `<div class="card">
      <h2>Assessment ${esc(when(latest.assessed_at))} ${status(latest.status)}</h2>
      ${ratings(latest)}
      ${latest.owner_summary ? `<div class="prose">${window.renderMarkdown(latest.owner_summary)}</div>` : '<p class="empty">This assessment has no summary for you. The next assessment writes one.</p>'}
    </div>` : '<p class="empty">No assessment yet.</p>'}`;
}


// Timeline dates use the owner's requested fixed PDT offset, including day boundaries.
const journalDate = value => new Date(new Date(value).getTime() - 7 * 3600000).toISOString().slice(0, 10);
const journalTime = value => new Date(value).toLocaleTimeString('en-US', { timeZone: 'Etc/GMT+7', hour: 'numeric', minute: '2-digit' }) + ' PDT';
const journalPlain = value => String(value || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`#]/g, '').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '').replace(/\s+/g, ' ').trim();
const journalPreview = value => { const text = journalPlain(value); return text.length > 180 ? text.slice(0, 177).trimEnd() + '…' : text; };
const journalRunDetails = new Map();
function renderJournal() {
  const box = $('#journal');
  const expanded = new Set([...box.querySelectorAll('details[open]')].map(item => item.dataset.event));
  const runs = data.activity || [];
  const runIds = new Set(runs.map(run => run.job_id));
  const events = runs.map(run => ({ id: 'run-' + run.job_id, at: run.started_at, run,
    label: run.task === 'goal_review' ? 'INOV8 run' : run.task === 'coaching' ? 'M3NT0R run' : JOB_LABELS[run.task] || 'Agent run',
    preview: run.summary || (['running', 'queued'].includes(run.status) ? 'Work is under way.' : 'No result recorded.') }));
  for (const day of data.journal || []) for (const entry of day.entries) {
    // The full matching journal entry remains in the run's expanded details.
    if (entry.metadata?.job_id && runIds.has(entry.metadata.job_id)) continue;
    events.push({ id: 'entry-' + entry.id, at: entry.createdAt, entry,
      label: /inov8|^goals$/i.test(entry.source || '') ? 'INOV8 activity' : /m3nt[o0]r/i.test(entry.source || '') ? 'M3NT0R activity' : entry.kind === 'owner_decision' || entry.kind === 'user_request' ? 'Owner direction' : 'Journal',
      preview: entry.summary?.trim() || entry.content.split('\n')[0] });
  }
  const groups = new Map();
  events.sort((a, b) => String(b.at).localeCompare(String(a.at))).forEach(event => {
    const day = journalDate(event.at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(event);
  });
  const today = journalDate(new Date());
  if (!groups.has(today)) groups.set(today, []);
  box.innerHTML = [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, items]) => {
    const dateLabel = date === today ? 'Today' : new Date(date + 'T12:00:00-07:00').toLocaleDateString('en-US', { timeZone: 'Etc/GMT+7', weekday: 'long', month: 'short', day: 'numeric' });
    const count = items.filter(item => item.run).length;
    return `<section class="journal-day"><h2>${esc(dateLabel)} <span class="meta">${count} run${count === 1 ? '' : 's'}</span></h2>
      ${items.length ? `<ol class="activity-timeline">${items.map(item => {
        const run = item.run;
        const runStatus = run ? ({ complete: 'Run finished', failed: 'Failed', interrupted: 'Interrupted', running: 'Running', queued: 'Queued' }[run.status] || run.status) : '';
        const summary = item.entry?.summary?.trim();
        const body = run ? journalRunDetails.get(run.job_id) || '' : `<div class="prose">${renderMarkdown(summary || item.entry.content)}</div>${summary && summary !== item.entry.content.trim() ? `<details><summary>Technical details</summary><div class="prose">${renderMarkdown(item.entry.content)}</div></details>` : ''}<p class="meta">Source: ${esc(item.entry.source || item.entry.kind)}</p>`;
        return `<li class="timeline-item"><details data-event="${esc(item.id)}"${run ? ` data-job="${esc(run.job_id)}"` : ''}${expanded.has(item.id) ? ' open' : ''}>
          <summary><time datetime="${esc(item.at)}">${esc(journalTime(item.at))}</time><span class="timeline-heading"><strong>${esc(item.label)}</strong>${run ? `<span class="status ${esc(run.status)}">${esc(runStatus)}</span>` : ''}<span class="timeline-preview">${esc(journalPreview(item.preview))}</span></span></summary>
          <div class="timeline-details">${body || '<p class="meta">Loading details…</p>'}</div>
        </details></li>`;
      }).join('')}</ol>` : '<p class="empty">No activity recorded today.</p>'}</section>`;
  }).join('');
}
$('#journal').addEventListener('toggle', async event => {
  const details = event.target;
  if (!details.open || !details.dataset.job || journalRunDetails.has(details.dataset.job)) return;
  const id = details.dataset.job;
  try {
    const result = await api('/api/activity/' + encodeURIComponent(id));
    const related = (data.journal || []).flatMap(day => day.entries).filter(entry => entry.metadata?.job_id === id);
    const body = `<p class="meta">Started ${esc(journalTime(result.started_at))}${result.finished_at ? ` · Finished ${esc(journalTime(result.finished_at))}` : ''}</p>
      <div class="prose">${renderMarkdown(result.error || result.output || 'No result recorded yet.')}</div>
      ${related.length ? `<details><summary>Journal notes (${related.length})</summary>${related.map(entry => `<div class="prose">${renderMarkdown(entry.content)}</div>`).join('')}</details>` : ''}`;
    if (!['running', 'queued'].includes(result.status)) journalRunDetails.set(id, body);
    details.querySelector('.timeline-details').innerHTML = body;
  } catch (error) { details.querySelector('.timeline-details').textContent = error.message; }
}, true);

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (data) renderProcesses(data.environment?.processes?.processes || [], data.internal_processes || [], true, data.triggers || []);
  const button = $('#theme');
  button.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}
applyTheme(document.documentElement.dataset.theme || 'light');
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('m3ntor-theme', next);
  applyTheme(next);
});

document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => {
  view = button.dataset.view;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b === button));
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== view; });
  if (view === 'use-cases') loadUseCases();
  if (view === 'processes' && data) renderProcesses(data.environment?.processes?.processes || [], data.internal_processes || [], true, data.triggers || []);
}));
$('#task-list').addEventListener('click', event => {
  const item = event.target.closest('li[data-id]');
  if (item) showTask(item.dataset.id);
});

// Unsent text is kept per form (question or task id) and put back after every refresh;
// a refresh that arrives while the owner is typing waits until the field loses focus.
const drafts = new Map();
const draftKey = field => `${field.form?.className}:${field.form?.dataset.id}:${field.name}`;
document.addEventListener('input', event => { if (event.target.tagName === 'TEXTAREA') drafts.set(draftKey(event.target), event.target.value); });
function restoreDrafts() {
  document.querySelectorAll('form textarea').forEach(field => { const value = drafts.get(draftKey(field)); if (value) field.value = value; });
}
let pending = false;
const events = new EventSource('/api/events');
events.addEventListener('reload', () => location.reload());
events.addEventListener('changed', () => {
  if (document.activeElement?.tagName === 'TEXTAREA') { pending = true; return; }
  load();
});
document.addEventListener('focusout', () => { if (pending) { pending = false; setTimeout(() => { if (document.activeElement?.tagName !== 'TEXTAREA') load(); else pending = true; }, 0); } });
load();
