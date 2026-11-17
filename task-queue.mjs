import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getM3ntorResult, jobDirectory, startTaskJob } from './m3ntor-jobs.mjs';
import { appendJournalInWrite, businessDate, serializeBusinessWrites } from './business-journal.mjs';

// Journal entries with fixed ids, so a retried write updates the same entry.
const journalOnce = (cwd, entryId, input) => serializeBusinessWrites(cwd, () => appendJournalInWrite(cwd, input, new Date(), entryId));
// A task's job ends with `STATUS: done` or `STATUS: not done — <reason>`.
const reportedDone = output => /^status:\s*done\b/i.test((String(output || '').trim().split('\n').pop() || '').replace(/[*`_]/g, '').trim());

// The owner's action system: immediate, delayed and recurring tasks persisted in
// .clarity_coach/action.sqlite3 and run by this service in the owner's harness.
// Task states: queued -> delivered (claimed) -> executing (job started) ->
// completed | failed, plus paused and done. A task's job id is stored before it
// is marked executing, so a restart follows the same job and never starts the
// work twice. Timers fire at the next due time; nothing polls.
const terminal = new Set(['complete', 'failed', 'interrupted']);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// Bootstrap direction (stop spending loops without progress): a task whose runs
// fail this many times in a row is paused with its state kept.
const MAX_CONSECUTIVE_FAILURES = 3;

const recurrenceSchema = {
  type: 'object',
  description: 'Omit for a one-off task. weekly runs on a weekday at HH:MM in the service\'s local time; interval_minutes repeats after each run.',
  properties: {
    weekly: { type: 'object', properties: { day: { type: 'string', enum: WEEKDAYS }, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } }, required: ['day', 'time'], additionalProperties: false },
    interval_minutes: { type: 'integer', minimum: 5 },
  },
  additionalProperties: false,
};

export const taskTools = [
  { name: 'set_task', description: 'Create or update a task in the owner\'s action queue. The service runs it in the owner\'s harness when due (now, at run_at, or on its recurrence) and records the result. Supplying an existing task_id updates that task instead of adding another; use this to reuse a matching recurring task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Existing task to update; omit to create.' }, title: { type: 'string' }, instruction: { type: 'string', description: 'The task: what the owner\'s agent should do when it runs.' }, success: { type: 'string', description: 'Definition of success: what must be true for the run to count as done.' }, constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints unique to this task.' }, category: { type: 'string', enum: ['recommendation', 'assessment', 'other'], description: 'recommendation for M3NT0R\'s weekly recommendation, assessment for the weekly reassessment.' }, run_at: { type: 'string', format: 'date-time', description: 'First run time; omit to run now (one-off) or at the next recurrence.' }, recurrence: recurrenceSchema, remove_on_completion: { type: 'boolean', description: 'One-off tasks only: after a successful run, journal the result and remove the task from the list (used for implementing a recommendation).' } }, required: ['title', 'instruction', 'success'], additionalProperties: false } },
  { name: 'list_tasks', description: 'List tasks with status (queued, delivered, executing, completed, failed, paused, done), next run time, last run and its result or error.', inputSchema: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'clear_task', description: 'Clear a task: action done marks it finished and stops any recurrence (history kept); action delete removes it and its run history. A running job is not stopped. When the owner has decided against a task, give their reason: it is journaled so M3NT0R can take it into account on its next weekly run.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, action: { type: 'string', enum: ['done', 'delete'] }, reason: { type: 'string', description: 'The owner\'s decision and reason, when they directed this.' } }, required: ['task_id', 'action'], additionalProperties: false } },
  { name: 'start_task_worker', description: 'Start running due tasks (persists across service restarts) and return the worker state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'stop_task_worker', description: 'Stop starting new tasks (persists across restarts). Jobs already running finish and their results are still recorded.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

export function nextWeekly(after, { day, time }) {
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(after);
  next.setHours(hours, minutes, 0, 0);
  next.setDate(next.getDate() + ((WEEKDAYS.indexOf(day) - next.getDay() + 7) % 7));
  if (next <= after) next.setDate(next.getDate() + 7);
  return next;
}

export function startTaskQueue({ cwd, harness, mcpUrl }) {
  const directory = path.join(cwd, '.clarity_coach');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'action.sqlite3'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL,
      recurrence TEXT, next_run_at TEXT, status TEXT NOT NULL,
      job_id TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, pause_reason TEXT,
      last_run_at TEXT, last_status TEXT, last_result TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, remove_on_completion INTEGER NOT NULL DEFAULT 0,
      success TEXT, constraints TEXT, category TEXT);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, job_id TEXT, status TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, result TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
  for (const [name, type] of [['remove_on_completion', 'INTEGER NOT NULL DEFAULT 0'], ['success', 'TEXT'], ['constraints', 'TEXT'], ['category', 'TEXT']]) if (!columns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  const now = () => new Date().toISOString();
  const get = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const update = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), now(), id);
  };
  const enabled = () => db.prepare("SELECT value FROM settings WHERE key = 'worker_enabled'").get()?.value === 'true';
  const setEnabled = value => db.prepare("INSERT INTO settings (key, value) VALUES ('worker_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(value));
  const view = task => task && { ...task, recurrence: task.recurrence ? JSON.parse(task.recurrence) : null, constraints: task.constraints ? JSON.parse(task.constraints) : [] };
  const watchers = new Map();
  let timer = null;

  function nextFor(task, from) {
    const recurrence = task.recurrence ? JSON.parse(task.recurrence) : null;
    if (!recurrence) return null;
    if (recurrence.weekly) return nextWeekly(from, recurrence.weekly).toISOString();
    return new Date(from.getTime() + recurrence.interval_minutes * 60000).toISOString();
  }

  // Record a finished job once, then requeue a recurring task or close a one-off.
  function settle(taskId, job) {
    const ok = job.status === 'complete' && reportedDone(job.output);
    const finished = now();
    const error = ok ? null : job.status === 'complete' ? `The task reported it was not done: ${String(job.output || '').trim().split('\n').pop()}` : (job.error || job.status);
    db.prepare("UPDATE runs SET status = ?, finished_at = ?, result = ?, error = ? WHERE task_id = ? AND job_id = ? AND status = 'executing'")
      .run(ok ? 'completed' : 'failed', finished, ok ? job.output : null, error, taskId, job.job_id);
    const task = get(taskId);
    if (!task || task.job_id !== job.job_id) return;
    if (!['delivered', 'executing'].includes(task.status)) {
      // Cleared while running: keep its done state and recurrence stopped, record the outcome.
      update(taskId, { job_id: null, last_run_at: finished, last_status: ok ? 'completed' : 'failed', last_result: ok ? job.output : null, last_error: error });
      return;
    }
    if (ok && task.remove_on_completion && !task.recurrence) {
      // Implemented: hold the task in 'finalizing' (protected from updates, retried after
      // a restart) until its result is journaled, then remove it and its runs.
      update(taskId, { status: 'finalizing', job_id: job.job_id, last_run_at: finished, last_status: 'completed', last_result: job.output, last_error: null });
      finalize(taskId);
      return;
    }
    const failures = ok ? 0 : task.consecutive_failures + 1;
    const next = task.recurrence ? nextFor(task, new Date()) : null;
    const status = !ok && failures >= MAX_CONSECUTIVE_FAILURES ? 'paused' : next ? 'queued' : ok ? 'completed' : 'failed';
    update(taskId, {
      status, job_id: null, consecutive_failures: failures, next_run_at: status === 'queued' ? next : null,
      pause_reason: status === 'paused' ? `${failures} consecutive failed runs; state kept. Fix the cause, then set_task this task_id to resume.` : null,
      last_run_at: finished, last_status: ok ? 'completed' : 'failed', last_result: ok ? job.output : null, last_error: error,
    });
  }

  async function finalize(taskId) {
    const task = get(taskId);
    if (task?.status !== 'finalizing') return;
    try {
      await journalOnce(cwd, `task-implemented-${task.id}-${task.job_id}`, { date: businessDate(new Date(task.last_run_at)), kind: 'activity', source: 'action_queue', content: `Implemented: ${task.title}\n\n${task.last_result}`, metadata: { task_id: task.id, job_id: task.job_id } });
      db.prepare("DELETE FROM runs WHERE task_id = ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'finalizing' AND job_id = ?)").run(task.id, task.id, task.job_id);
      db.prepare("DELETE FROM tasks WHERE id = ? AND status = 'finalizing' AND job_id = ?").run(task.id, task.job_id);
    } catch (error) {
      update(taskId, { last_error: `Journal before removal failed; retried at the next start: ${error.message}` });
    }
  }

  // Job state changes arrive as file events; an event during a check triggers one more.
  // A killed job writes nothing, so its state is also rechecked once a minute while it
  // runs (getM3ntorResult detects a dead worker).
  function follow(taskId, jobId) {
    if (watchers.has(jobId)) return;
    let busy = false, again = false, fsWatcher = null, liveness = null;
    watchers.set(jobId, { close() { fsWatcher?.close(); clearInterval(liveness); } });
    const stop = () => { watchers.get(jobId)?.close(); watchers.delete(jobId); };
    const check = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        let job;
        do {
          again = false;
          try { job = await getM3ntorResult(jobId); }
          catch (error) { job = { job_id: jobId, status: 'failed', error: error.message }; }
        } while (!terminal.has(job.status) && again);
        if (terminal.has(job.status)) { settle(taskId, job); stop(); schedule(); }
      } finally { busy = false; }
    };
    try { fsWatcher = watch(jobDirectory(jobId), () => { check(); }); }
    catch { /* job directory missing: the check records the failure */ }
    liveness = setInterval(check, 60000);
    check();
  }

  async function run(task) {
    // Claim with a job id saved before launch: a restart reconciles that same job.
    const jobId = randomUUID();
    const claimed = db.prepare("UPDATE tasks SET status = 'delivered', job_id = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(jobId, now(), task.id);
    if (!claimed.changes) return;
    db.prepare('INSERT INTO runs (id, task_id, job_id, status, started_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), task.id, jobId, 'executing', now());
    try { await startTaskJob({ ...task, job_id: jobId }, { cwd, harness, mcpUrl }); }
    catch (error) {
      db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE job_id = ?").run(now(), `Could not start: ${error.message}`, jobId);
      db.prepare("UPDATE tasks SET status = 'queued', job_id = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'delivered' AND job_id = ?").run(`Could not start: ${error.message}`, now(), task.id, jobId);
      return;
    }
    db.prepare("UPDATE tasks SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'delivered' AND job_id = ?").run(now(), task.id, jobId);
    follow(task.id, jobId);
  }

  function schedule() {
    clearTimeout(timer);
    if (!enabled()) return;
    const at = now();
    const due = db.prepare("SELECT * FROM tasks WHERE status = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?)").all(at);
    for (const task of due) run(task);
    const next = db.prepare("SELECT MIN(next_run_at) AS at FROM tasks WHERE status = 'queued' AND next_run_at > ?").get(at)?.at;
    if (next) timer = setTimeout(schedule, Math.min(Math.max(new Date(next) - Date.now(), 0) + 50, 2 ** 31 - 1));
  }

  // A job directory alone does not mean its worker started; the worker records its pid.
  function launched(jobId) {
    const directory = jobDirectory(jobId);
    if (existsSync(path.join(directory, 'launch.json'))) return true;
    try { return Boolean(JSON.parse(readFileSync(path.join(directory, 'state.json'), 'utf8')).worker_pid); } catch { return false; }
  }

  // Restart recovery: follow jobs already started; a claim that never started a job is requeued.
  for (const task of db.prepare("SELECT * FROM tasks WHERE status != 'finalizing' AND (job_id IS NOT NULL OR status IN ('delivered', 'executing'))").all()) {
    if (task.job_id && launched(task.job_id)) {
      if (task.status === 'delivered') update(task.id, { status: 'executing' });
      follow(task.id, task.job_id);
    } else if (['delivered', 'executing'].includes(task.status)) {
      // The job's worker never started: nothing ran, so the task is queued again.
      db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = 'Service stopped before the job started.' WHERE job_id = ? AND status = 'executing'").run(now(), task.job_id);
      update(task.id, { status: 'queued', job_id: null });
    }
  }
  for (const task of db.prepare("SELECT id FROM tasks WHERE status = 'finalizing'").all()) finalize(task.id);
  // A clear interrupted by a restart did not finish; hold the task as paused until the owner's clear is repeated.
  db.prepare("UPDATE tasks SET status = 'paused', pause_reason = 'A clear was interrupted; repeat clear_task to finish it.', updated_at = ? WHERE status = 'clearing'").run(now());
  schedule();

  const workerState = () => ({ enabled: enabled(), database: path.join(directory, 'action.sqlite3'), executing: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'executing'").get().n, next_run_at: db.prepare("SELECT MIN(next_run_at) AS at FROM tasks WHERE status = 'queued'").get()?.at || null });

  return {
    // Task with its runs, for the owner UI.
    detail(taskId) {
      const task = view(get(taskId));
      return task && { task, runs: db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC').all(taskId), worker: workerState() };
    },
    call(name, input) {
      if (name === 'set_task') {
        if (input.recurrence && !input.recurrence.weekly === !input.recurrence.interval_minutes) throw new Error('Give recurrence either weekly or interval_minutes.');
        const id = input.task_id || randomUUID();
        const existing = input.task_id ? get(id) : null;
        if (input.task_id && !existing) throw new Error(`Task ${id} was not found.`);
        if (existing && ['delivered', 'executing', 'finalizing', 'clearing'].includes(existing.status)) throw new Error('This task is running, being finalized or being cleared; update it after it finishes.');
        const recurrence = input.recurrence ? JSON.stringify(input.recurrence) : null;
        const nextRun = input.run_at ? new Date(input.run_at).toISOString() : recurrence ? nextFor({ recurrence }, new Date()) : null;
        if (input.run_at && Number.isNaN(new Date(input.run_at).getTime())) throw new Error('run_at must be an ISO date-time.');
        if (!input.success?.trim()) throw new Error('Give the definition of success for this task.');
        if (input.constraints && (!Array.isArray(input.constraints) || input.constraints.some(item => typeof item !== 'string'))) throw new Error('constraints must be a list of strings.');
        const contract = { success: input.success.trim(), constraints: input.constraints?.length ? JSON.stringify(input.constraints) : null, category: input.category || null };
        const removeOnCompletion = input.remove_on_completion === true ? 1 : 0;
        if (removeOnCompletion && recurrence) throw new Error('remove_on_completion applies to one-off tasks only.');
        if (existing) update(id, { title: input.title, instruction: input.instruction, recurrence, next_run_at: nextRun, status: 'queued', consecutive_failures: 0, pause_reason: null, remove_on_completion: removeOnCompletion, ...contract });
        else db.prepare('INSERT INTO tasks (id, title, instruction, recurrence, next_run_at, status, created_at, updated_at, remove_on_completion, success, constraints, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.title, input.instruction, recurrence, nextRun, 'queued', now(), now(), removeOnCompletion, contract.success, contract.constraints, contract.category);
        schedule();
        return { task: view(get(id)), created: !existing, worker: workerState() };
      }
      if (name === 'list_tasks') {
        const rows = input.status ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at').all(input.status) : db.prepare('SELECT * FROM tasks ORDER BY created_at').all();
        return { tasks: rows.map(view), worker: workerState() };
      }
      if (name === 'clear_task') {
        const task = get(input.task_id);
        if (!task) throw new Error(`Task ${input.task_id} was not found.`);
        // Reserve the task so it cannot start while the owner's reason is journaled;
        // the reason is journaled before anything is cleared, and a failure restores it.
        if (task.status === 'clearing') throw new Error('This task is already being cleared.');
        const previous = task.status;
        if (input.reason?.trim()) update(task.id, { status: 'clearing' });
        return (input.reason?.trim()
          ? journalOnce(cwd, `task-declined-${task.id}`, { kind: 'user_request', source: 'owner_decision', content: `The owner decided against: ${task.title}\nReason: ${input.reason.trim()}\nTask: ${task.instruction}`, metadata: { task_id: task.id, action: input.action } })
          : Promise.resolve(null)).catch(error => {
            db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'clearing'").run(previous, now(), task.id);
            throw error;
          }).then(entry => {
            if (input.action === 'delete') { db.prepare('DELETE FROM runs WHERE task_id = ?').run(task.id); db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id); }
            else update(task.id, { status: 'done', next_run_at: null });
            if (input.action === 'delete' && task.job_id) { watchers.get(task.job_id)?.close(); watchers.delete(task.job_id); }
            schedule();
            return { task_id: task.id, action: input.action, reason_journaled: Boolean(entry), worker: workerState() };
          });
      }
      if (name === 'start_task_worker') { setEnabled(true); schedule(); return workerState(); }
      if (name === 'stop_task_worker') { setEnabled(false); clearTimeout(timer); return workerState(); }
      throw new Error('Unknown task tool.');
    },
  };
}
