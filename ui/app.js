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
function showError(error) {
  const box = $('#error');
  box.textContent = error.message; box.hidden = false;
  setTimeout(() => { box.hidden = true; }, 6000);
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
  renderRunning(); renderGoals(); renderSettings(); renderTasks(); renderQuestions(); renderAssessment(); renderContext(); renderJournal();
  restoreDrafts();
}

const JOB_LABELS = { goal_review: 'Goal review', poma_assessment: 'Assessment', poma_reassessment: 'Assessment', coaching: 'M3NT0R coaching', scheduled_task: 'Task', a2a_message: 'A2A request' };
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
  return `<article class="card case">
    <div class="head">
      <h2>${esc(item.title)}</h2>
      ${item.own ? `<button class="danger" type="button" data-revoke="${esc(item.id)}">Revoke</button>` : ''}
    </div>
    <div class="labels">
      ${item.own ? '<span class="chip own">Your business</span>' : ''}
      ${(item.poma_labels || []).map(l => `<span class="chip poma">${esc(l)}</span>`).join('')}
      ${(item.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}
      <span class="meta">${esc(item.source_kind === 'web_documented' ? 'Web documented' : 'Owner reported')} · ${esc(when(item.created_at))}</span>
    </div>
    <p>${esc(item.summary)}</p>
    <details>
      <summary>How it works</summary>
      <div class="prose">
        <h3>Process</h3><p>${esc(item.process)}</p>
        ${list('Prerequisites', item.prerequisites)}
        ${list('What the agent does', item.agent_actions)}
        <h3>Outcome</h3><p>${esc(item.outcome)}</p>
        ${item.owner_feedback ? `<h3>Owner feedback</h3><p>${esc(item.owner_feedback)}</p>` : ''}
        ${list('Limitations', item.evidence?.limitations)}
      </div>
    </details>
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

function renderTasks() {
  const list = $('#task-list');
  if (!data.tasks.length) { list.innerHTML = '<li class="empty">No tasks.</li>'; return; }
  list.innerHTML = data.tasks.map(task => `
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
const GOAL_STATUS = { active: 'active', waiting: 'waiting', improving: 'improving', maintaining: 'maintaining', stopped: 'stopped' };
function renderGoals() {
  const pace = data.pace || {};
  const goals = data.goals || [];
  const reviewing = pace.reviewing_job_id;
  $('#goals').innerHTML = `
    <div class="card filters">
      <button class="primary" type="button" id="run-review"${reviewing ? ' disabled' : ''}>Run</button>
      <span class="meta">${reviewing ? 'Reviewing now' : pace.pace === 'yolo' ? 'Reviews when the current stage\'s tasks are done or blocked' : pace.next_review_at ? `Next review ${when(pace.next_review_at)}` : ''}${pace.last_review_at ? ` · last ${when(pace.last_review_at)}` : ''}${data.full_access ? ' · Full access' : ''}</span>
    </div>
    ${data.review_error ? `<p class="card" style="color: var(--bad)">${esc(data.review_error)}</p>` : ''}
    ${goals.length ? goals.map(renderGoal).join('') : '<p class="empty">No goals.</p>'}`;
  $('#run-review').addEventListener('click', async () => {
    $('#run-review').disabled = true;
    try { data = await api('/api/goals/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); render(); }
    catch (error) { $('#run-review').disabled = false; showError(error); }
  });
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
      <h2>Agent cycle</h2>
      <div class="row">
        <select name="pace" aria-label="Agent cycle">${Object.entries(PACE_LABELS).map(([value, label]) => `<option value="${value}"${pace.pace === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
        <label${pace.pace === 'daily' ? '' : ' hidden'}>at <input type="time" name="time" value="${esc(pace.time || '08:00')}"></label>
      </div>
      <p class="meta">YOLO reviews as soon as the current stage's tasks are done or blocked.</p>
      <h2>Full access</h2>
      <label class="toggle"><input type="checkbox" name="full_access"${data.full_access ? ' checked' : ''}> Run tasks and goal reviews with full access</label>
      <p class="meta">Codex runs without a sandbox or approvals; Claude runs with permissions bypassed. They can change anything you can. Coaching and A2A requests stay read-only.</p>
      <div class="actions"><button class="primary" type="submit">Save</button></div>
    </form>`;
  const form = $('#settings-form');
  form.pace.addEventListener('change', () => { form.time.parentElement.hidden = form.pace.value !== 'daily'; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      data = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pace: form.pace.value, time: form.time.value, full_access: form.full_access.checked }) });
      document.activeElement?.blur(); render();
    } catch (error) { showError(error); }
  });
}
function renderGoal(goal) {
  const tasks = data.tasks.filter(task => task.goal_id === goal.id && (!goal.stage || task.stage === goal.stage.key));
  return `<article class="card goal">
    <div class="title"><h2>${esc(goal.title)}</h2> ${status(GOAL_STATUS[goal.status] || goal.status)}</div>
    ${goal.outcome ? `<p>${esc(goal.outcome)}</p>` : ''}
    <ol class="stages">${goal.stages.map(stage => `<li class="${stage.state}">${esc(stage.name)}</li>`).join('')}</ol>
    ${goal.status !== 'stopped' && goal.stage ? `
      <h3>Stage ${goal.stage.index} of ${goal.stages.length}: ${esc(goal.stage.name)}</h3>
      <p>${esc(goal.stage.work)}</p>
      <dl><dt>Done when</dt><dd>${esc(goal.stage.done_check)}</dd></dl>
      ${tasks.length ? `<ul class="goal-tasks">${tasks.map(task => `<li><a href="#" data-task="${esc(task.id)}">${esc(task.title)}</a> ${status(task.status)}</li>`).join('')}</ul>` : '<p class="empty">No tasks for this stage yet.</p>'}` : ''}
    ${goal.kind === 'environment' ? environmentRecords(goal) : ''}
    ${goal.completed.length ? `<details><summary>Completed stages</summary>${goal.completed.map(item => `<div class="entry"><div class="meta">${esc(item.name)} · ${when(item.at)}</div><div class="content">${esc(item.evidence)}</div></div>`).join('')}</details>` : ''}
    ${goal.stop_reason ? `<p class="meta">Stopped: ${esc(goal.stop_reason)}</p>` : ''}
    ${goal.kind !== 'environment' && goal.status !== 'stopped' ? `<form class="stop-goal" data-id="${esc(goal.id)}">
      <textarea name="reason" placeholder="Reason for stopping this goal" aria-label="Reason for stopping this goal" required></textarea>
      <div class="actions"><button class="secondary" type="submit">Stop goal</button></div>
    </form>` : ''}
  </article>`;
}
function environmentRecords(goal) {
  const env = data.environment || {};
  const open = key => goal.stage?.key === key ? ' open' : '';
  const sources = env.sources?.sources || [];
  const commitments = env.plate?.commitments || [];
  const processes = env.processes?.processes || [];
  const needed = value => value === true ? 'Needed' : value === false ? 'Not needed' : 'Undecided';
  return `
    <details${open('infrastructure')}><summary>Sources (${sources.filter(s => s.needed).length} needed of ${sources.length})</summary>
      ${sources.length ? `<table class="records"><thead><tr><th>Source</th><th>Needed</th><th>Last read-back</th></tr></thead><tbody>${sources.map(s => `<tr>
        <td><strong>${esc(s.name)}</strong><div class="meta">${esc(s.route || '')}</div></td>
        <td>${needed(s.needed)}${s.needed_reason ? `<div class="meta">${esc(s.needed_reason)}</div>` : ''}</td>
        <td>${s.read_back ? `${status(s.read_back.ok ? 'completed' : 'failed')} ${when(s.read_back.at)}<div class="meta">${esc(s.read_back.what)}</div>` : '<span class="meta">None</span>'}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="empty">No sources recorded.</p>'}
    </details>
    <details${open('observability')}><summary>Plate (${commitments.length} commitments${env.plate?.updated_at ? `, updated ${when(env.plate.updated_at)}` : ''})</summary>
      ${commitments.length ? `<table class="records"><thead><tr><th>Commitment</th><th>To</th><th>Due</th><th>Status</th></tr></thead><tbody>${commitments.map(c => `<tr><td>${esc(c.what)}<div class="meta">${(c.sources || []).map(s => esc(s.ref)).join(', ')}</div></td><td>${esc(c.to_whom)}</td><td>${esc(c.due || '')}</td><td>${esc(c.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No commitments recorded.</p>'}
      ${env.plate?.priorities?.length ? `<h3>Priorities</h3><ol>${env.plate.priorities.map(p => `<li>${esc(p)}</li>`).join('')}</ol>` : ''}
    </details>
    <details${open('process')}><summary>Processes (${processes.length})</summary>
      ${processes.length ? processes.map(f => `<div class="entry"><strong>${esc(f.name)}</strong><div class="meta">Trigger: ${esc(f.trigger || 'not recorded')} · Completion: ${esc(f.completion || 'not recorded')} · ${(f.examples || []).length} examples</div>${f.steps?.length ? `<ol>${f.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}</div>`).join('') : '<p class="empty">No processes recorded.</p>'}
    </details>`;
}
$('#goals').addEventListener('click', event => {
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
  const { pending, answered } = data.questions;
  $('#questions').innerHTML = `
    <h2>Waiting on you</h2>
    ${pending.length ? pending.map(q => `
      <form class="card question" data-id="${esc(q.id)}">
        <p>${esc(q.question)}</p>
        <textarea name="answer" placeholder="Your answer"></textarea>
        <div class="actions">
          <button class="primary" type="submit" value="answer">Answer</button>
          <button class="secondary" type="submit" value="dismiss">Dismiss</button>
        </div>
      </form>`).join('') : '<p class="empty">No questions waiting.</p>'}
    ${answered.length ? `<h3>Answered</h3>${answered.map(q => `<div class="entry"><div>${esc(q.question)}</div><div class="meta">${esc(q.status)} ${when(q.updatedAt)}</div>${q.answer ? `<div class="content">${esc(q.answer)}</div>` : ''}</div>`).join('')}` : ''}`;
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
      ${latest.report || latest.summary ? `<div class="prose">${window.renderMarkdown(latest.report || latest.summary)}</div>` : ''}
    </div>` : '<p class="empty">No assessment yet.</p>'}`;
}


function renderJournal() {
  $('#journal').innerHTML = data.journal.length ? data.journal.map(day => `
    <div class="card"><h2>${esc(day.date)}</h2>
      ${day.entries.map(entry => `<div class="entry"><div class="meta">${when(entry.createdAt)} · ${esc(entry.kind)}</div><div class="content">${esc(entry.content)}</div></div>`).join('')}
    </div>`).join('') : '<p class="empty">No journal entries in the last 14 days.</p>';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
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
events.addEventListener('changed', () => {
  if (document.activeElement?.tagName === 'TEXTAREA') { pending = true; return; }
  load();
});
document.addEventListener('focusout', () => { if (pending) { pending = false; setTimeout(() => { if (document.activeElement?.tagName !== 'TEXTAREA') load(); else pending = true; }, 0); } });
load();
