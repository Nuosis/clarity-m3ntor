// Owner view for the local M3NT0R service. Data comes from /api/overview and
// /api/tasks/:id; /api/events pushes a change notice whenever local records change.
let data = null;
let selectedTask = null;
let view = 'tasks';

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
  renderRunning(); renderTasks(); renderQuestions(); renderAssessment(); renderRecommendations(); renderContext(); renderJournal();
  restoreDrafts();
}

const JOB_LABELS = { poma_assessment: 'Assessment', poma_reassessment: 'Assessment', coaching: 'M3NT0R coaching', scheduled_task: 'Task', a2a_message: 'A2A request' };
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
      <div class="meta">${task.next_run_at ? `Next ${when(task.next_run_at)}` : task.last_run_at ? `Last run ${when(task.last_run_at)}` : ''}</div>
    </li>`).join('');
}

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
    ${task.category === 'recommendation' && task.status === 'queued' ? declineForm(task.id) : ''}
    <h3>Runs</h3>
    ${runs.length ? runs.map(renderRun).join('') : '<p class="empty">Not run yet.</p>'}`;
  bindDecline(pane);
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

function declineForm(id) {
  return `<form class="decline" data-id="${esc(id)}">
    <textarea name="reason" placeholder="Reason for not implementing" aria-label="Reason for not implementing" required></textarea>
    <div class="actions"><button class="secondary" type="submit">Don't implement</button></div>
  </form>`;
}
function bindDecline(root) {
  root.querySelectorAll('form.decline').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      data = await api(`/api/tasks/${encodeURIComponent(form.dataset.id)}/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: form.reason.value }) });
      drafts.delete(draftKey(form.reason));
      selectedTask = null; $('#task-detail').innerHTML = '<p class="empty">Select a task.</p>';
      render();
    } catch (error) { showError(error); }
  }));
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

function renderRecommendations() {
  const { open, history } = data.recommendations;
  $('#recommendations').innerHTML = `
    ${open.length ? open.map(task => `<div class="card">
      <div class="title"><h2>${esc(task.title)}</h2> ${status(task.status)}</div>
      ${task.next_run_at ? `<div class="meta">Runs ${when(task.next_run_at)}</div>` : ''}
      <div class="prose">${window.renderMarkdown(task.instruction || '')}</div>
      ${task.success ? `<h3>Success means</h3><div class="prose">${window.renderMarkdown(task.success)}</div>` : ''}
      ${task.constraints?.length ? `<h3>Constraints</h3><ul>${task.constraints.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
      ${task.status === 'queued' ? declineForm(task.id) : ''}
    </div>`).join('') : '<p class="empty">No open recommendation.</p>'}
    ${history.length ? `<div class="card"><h2>Earlier</h2>${history.map(entry => `<div class="entry"><div class="meta">${esc(entry.date)}</div><div class="content">${esc(entry.content)}</div></div>`).join('')}</div>` : ''}`;
  bindDecline($('#recommendations'));
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
