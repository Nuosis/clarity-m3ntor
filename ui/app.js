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
  renderTasks(); renderQuestions(); renderAssessment(); renderJournal();
}

function renderTasks() {
  const list = $('#task-list');
  if (!data.tasks.length) { list.innerHTML = '<li class="empty">No tasks.</li>'; return; }
  list.innerHTML = data.tasks.map(task => `
    <li data-id="${esc(task.id)}" class="${task.id === selectedTask ? 'selected' : ''}">
      <div>${esc(task.title)} ${status(task.status)}</div>
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
      render();
    } catch (error) { showError(error); }
  }));
}

function renderAssessment() {
  const [latest, ...earlier] = data.assessments;
  const areas = ['process', 'observability', 'measurement', 'agency'];
  const ratings = assessment => `<table><tr><th>Area</th><th>Category</th><th>Score</th>${earlier.length ? '<th>Previous</th>' : ''}</tr>${areas.map(area => `<tr><td>${area[0].toUpperCase() + area.slice(1)}</td><td>${esc(assessment.ratings?.[area]?.category)}</td><td>${esc(assessment.ratings?.[area]?.score)}/10</td>${earlier.length ? `<td>${esc(earlier[0].ratings?.[area]?.score)}/10</td>` : ''}</tr>`).join('')}</table>`;
  const open = data.recommendations.open;
  $('#assessment').innerHTML = `
    ${latest ? `<div class="card">
      <h2>${status(latest.status)} Assessment ${when(latest.assessed_at)}</h2>
      ${ratings(latest)}
      ${latest.report ? `<h3>Summary</h3><pre>${esc(latest.report)}</pre>` : latest.summary ? `<h3>Summary</h3><pre>${esc(latest.summary)}</pre>` : ''}
    </div>` : '<p class="empty">No assessment yet.</p>'}
    <div class="card">
      <h2>Recommendation</h2>
      ${open.length ? open.map(task => `<div class="entry">
        <div>${esc(task.title)} ${status(task.status)}</div>
        <div class="meta">${task.next_run_at ? `Runs ${when(task.next_run_at)}` : ''}</div>
        <div class="content">${esc(task.instruction)}</div>
        ${task.status === 'queued' ? declineForm(task.id) : ''}
      </div>`).join('') : '<p class="empty">No open recommendation.</p>'}
      ${data.recommendations.history.length ? `<h3>Earlier</h3>${data.recommendations.history.map(entry => `<div class="entry"><div class="meta">${esc(entry.date)}</div><div class="content">${esc(entry.content)}</div></div>`).join('')}` : ''}
    </div>`;
  bindDecline($('#assessment'));
}

function renderJournal() {
  $('#journal').innerHTML = data.journal.length ? data.journal.map(day => `
    <div class="card"><h2>${esc(day.date)}</h2>
      ${day.entries.map(entry => `<div class="entry"><div class="meta">${when(entry.createdAt)} · ${esc(entry.kind)}</div><div class="content">${esc(entry.content)}</div></div>`).join('')}
    </div>`).join('') : '<p class="empty">No journal entries in the last 14 days.</p>';
}

document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => {
  view = button.dataset.view;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b === button));
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== view; });
}));
$('#task-list').addEventListener('click', event => {
  const item = event.target.closest('li[data-id]');
  if (item) showTask(item.dataset.id);
});

// Typing in a form is not interrupted by a refresh; the refresh runs after the field loses focus.
let pending = false;
const events = new EventSource('/api/events');
events.addEventListener('changed', () => {
  if (document.activeElement?.tagName === 'TEXTAREA') { pending = true; return; }
  load();
});
document.addEventListener('focusout', () => { if (pending) { pending = false; load(); } });
load();
