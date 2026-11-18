import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getM3ntorResult, jobDirectory, startTaskJob, startGoalReviewJob } from './m3ntor-jobs.mjs';
import { stagesFor, GOAL_REVIEW_INSTRUCTION } from './goals.mjs';
import { environmentCheck, readEnvironment } from './environment.mjs';
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
  { name: 'set_task', description: 'Create or update a task in the owner\'s action queue. The service runs it in the owner\'s harness when due (now, at run_at, or on its recurrence) and records the result. Supplying an existing task_id updates that task instead of adding another; use this to reuse a matching recurring task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Existing task to update; omit to create.' }, title: { type: 'string' }, instruction: { type: 'string', description: 'The task: what the owner\'s agent should do when it runs.' }, success: { type: 'string', description: 'Definition of success: what must be true for the run to count as done.' }, constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints unique to this task.' }, category: { type: 'string', enum: ['assessment', 'use_case', 'other'], description: 'assessment for the weekly reassessment, use_case for researching an owner-reported use case.' }, run_at: { type: 'string', format: 'date-time', description: 'First run time; omit to run now (one-off) or at the next recurrence.' }, recurrence: recurrenceSchema, remove_on_completion: { type: 'boolean', description: 'One-off tasks only: after a successful run, journal the result and remove the task from the list (used for one-off work whose record belongs in the journal).' }, goal_id: { type: 'string', description: 'The goal this task works on; omit for one-off work the owner directs.' }, stage: { type: 'string', description: 'With goal_id: the goal\'s current stage key (list_goals). Tasks for a stage the goal has not reached are refused.' } }, required: ['title', 'instruction', 'success'], additionalProperties: false } },
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

export function startTaskQueue({ cwd, harness, mcpUrl, latestAssessment = async () => null }) {
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
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT, source TEXT,
      position INTEGER NOT NULL, stage INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      completed TEXT NOT NULL DEFAULT '[]', stop_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
  for (const [name, type] of [['remove_on_completion', 'INTEGER NOT NULL DEFAULT 0'], ['success', 'TEXT'], ['constraints', 'TEXT'], ['category', 'TEXT'], ['goal_id', 'TEXT'], ['stage', 'TEXT']]) if (!columns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
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
    try { await startTaskJob({ ...task, job_id: jobId }, { cwd, harness, mcpUrl, ...agentRun() }); }
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
    // One task at a time: the next due task starts only when nothing is running.
    // One-off work the owner directs (no goal) goes ahead of goal tasks.
    const busy = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('delivered', 'executing', 'finalizing')").get().n;
    const due = busy ? null : db.prepare("SELECT * FROM tasks WHERE status = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY goal_id IS NOT NULL, COALESCE(next_run_at, created_at), created_at LIMIT 1").get(at);
    if (due) run(due);
    considerReview();
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
  // ---- Goals ------------------------------------------------------------------
  const setting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  const setSetting = (key, value) => value === null
    ? db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    : db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  const getGoal = id => db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  const updateGoal = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE goals SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), now(), id);
  };
  const goalView = goal => {
    if (!goal) return null;
    const stages = stagesFor(goal.kind);
    const current = stages[goal.stage];
    return { id: goal.id, title: goal.title, kind: goal.kind, outcome: goal.outcome, source: goal.source, position: goal.position, status: goal.status,
      stage: current ? { index: goal.stage + 1, key: current.key, name: current.name, work: current.work, done_check: current.done } : null,
      stages: stages.map((stage, index) => ({ index: index + 1, key: stage.key, name: stage.name, state: index < goal.stage ? 'done' : index === goal.stage ? 'current' : 'later' })),
      completed: JSON.parse(goal.completed), stop_reason: goal.stop_reason, created_at: goal.created_at, updated_at: goal.updated_at };
  };
  // The working environment goal exists from install and always comes first.
  if (!db.prepare("SELECT id FROM goals WHERE kind = 'environment'").get()) {
    db.prepare('INSERT INTO goals (id, title, kind, outcome, source, position, stage, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)')
      .run(randomUUID(), 'Working environment', 'environment', "The agent sees what is on the owner's plate and knows how the business does its work.", 'm3ntor', 'active', now(), now());
  }
  // One goal is active at a time; when none is, the next waiting goal by position starts.
  function activeGoal() {
    let goal = db.prepare("SELECT * FROM goals WHERE status = 'active' ORDER BY position LIMIT 1").get();
    if (!goal) {
      goal = db.prepare("SELECT * FROM goals WHERE status = 'waiting' ORDER BY position, created_at LIMIT 1").get();
      if (goal) { updateGoal(goal.id, { status: 'active', stage: 0 }); goal = getGoal(goal.id); }
    }
    return goal || null;
  }
  const stageTasks = (goalId, stageKey) => db.prepare('SELECT * FROM tasks WHERE goal_id = ? AND stage = ? ORDER BY created_at').all(goalId, stageKey);
  const listGoals = () => { activeGoal(); return db.prepare("SELECT * FROM goals ORDER BY status = 'stopped', position, created_at").all().map(goalView); };

  async function completeStage(goalId, evidence) {
    const goal = getGoal(goalId);
    if (!goal) throw new Error('Goal not found.');
    if (goal.status !== 'active') throw new Error(`This goal is ${goal.status}; only the active goal's current stage can be completed.`);
    if (!evidence?.trim()) throw new Error('Name the evidence for the done-check.');
    const stages = stagesFor(goal.kind); const stage = stages[goal.stage];
    if (stage.key === 'improve') throw new Error('The Improve stage is recurring and does not complete.');
    const tasks = stageTasks(goal.id, stage.key);
    if (tasks.some(task => ['queued', 'delivered', 'executing', 'finalizing', 'clearing'].includes(task.status))) throw new Error(`Tasks for the ${stage.name} stage are still queued or running.`);
    if (goal.kind === 'environment') {
      // The working environment's stages are checked against its records, not the agent's claim.
      const missing = await environmentCheck(cwd, stage.key);
      if (missing) throw new Error(`The ${stage.name} done-check is not met: ${missing}`);
    } else {
      if (!tasks.length) throw new Error(`No task has run for the ${stage.name} stage yet.`);
      const last = tasks.filter(task => task.last_run_at).sort((a, b) => String(b.last_run_at).localeCompare(String(a.last_run_at)))[0];
      if (last?.last_status !== 'completed') throw new Error(`The ${stage.name} stage's last task did not end STATUS: done.`);
    }
    if (stage.score) {
      const latest = await latestAssessment();
      const score = Number(latest?.ratings?.[stage.score]?.score);
      if (!(score >= 8)) throw new Error(`${stage.name} needs the weekly assessment to score 8 or higher; the latest scores ${Number.isFinite(score) ? score : 'unknown'}.`);
      evidence = `${evidence.trim()}\nAssessment ${latest.revision_id}: ${stage.name} ${score}/10.`;
    }
    const completed = [...JSON.parse(goal.completed), { stage: stage.key, name: stage.name, evidence: evidence.trim(), at: now() }];
    const nextIndex = goal.stage + 1;
    const nextStage = stages[nextIndex];
    // A goal that reaches its ongoing stage leaves the active slot for the next goal.
    const status = !nextStage ? 'maintaining' : nextStage.key === 'improve' ? 'improving' : 'active';
    updateGoal(goal.id, { stage: nextStage ? nextIndex : goal.stage, completed: JSON.stringify(completed), status });
    await journalOnce(cwd, `goal-stage-${goal.id}-${stage.key}-${completed.length}`, { kind: 'activity', source: 'goals', content: `Goal "${goal.title}": ${stage.name} stage done.\n${evidence.trim()}`, metadata: { goal_id: goal.id, stage: stage.key } });
    activeGoal(); schedule();
    return goalView(getGoal(goal.id));
  }

  async function reopenStage(goalId, evidence) {
    const goal = getGoal(goalId);
    if (!goal || goal.status !== 'improving') throw new Error('Only a goal in its Improve stage can reopen its Process stage.');
    const index = stagesFor(goal.kind).findIndex(stage => stage.key === 'process');
    // Reopened work becomes the next active goal so it runs through the stages again in order.
    db.prepare("UPDATE goals SET status = 'waiting' WHERE status = 'active'").run();
    updateGoal(goal.id, { stage: index, status: 'active', completed: JSON.stringify(JSON.parse(goal.completed).filter(item => stagesFor(goal.kind).findIndex(stage => stage.key === item.stage) < index)) });
    await journalOnce(cwd, `goal-reopen-${goal.id}-${Date.now()}`, { kind: 'activity', source: 'goals', content: `Goal "${goal.title}": Process stage reopened.\n${evidence}`, metadata: { goal_id: goal.id } });
    schedule();
    return goalView(getGoal(goal.id));
  }

  async function stopGoal(goalId, reason) {
    const goal = getGoal(goalId);
    if (!goal) throw new Error('Goal not found.');
    if (!reason?.trim()) throw new Error('Give the reason.');
    if (goal.kind === 'environment') throw new Error('The working environment goal cannot be stopped; it comes before every other goal.');
    await journalOnce(cwd, `goal-stopped-${goal.id}`, { kind: 'user_request', source: 'owner_decision', content: `The owner stopped the goal: ${goal.title}\nReason: ${reason.trim()}`, metadata: { goal_id: goal.id } });
    const queued = db.prepare("SELECT id FROM tasks WHERE goal_id = ? AND status IN ('queued', 'paused', 'failed')").all(goal.id);
    for (const { id } of queued) { db.prepare('DELETE FROM runs WHERE task_id = ?').run(id); db.prepare('DELETE FROM tasks WHERE id = ?').run(id); }
    updateGoal(goal.id, { status: 'stopped', stop_reason: reason.trim() });
    activeGoal(); schedule();
    return goalView(getGoal(goal.id));
  }

  function setGoal(input) {
    if (input.goal_id) {
      const goal = getGoal(input.goal_id);
      if (!goal) throw new Error('Goal not found.');
      if (goal.kind === 'environment' && input.position) throw new Error('The working environment goal always comes first.');
      updateGoal(goal.id, { ...(input.title ? { title: input.title } : {}), ...(input.outcome ? { outcome: input.outcome } : {}), ...(input.position ? { position: input.position } : {}) });
      return goalView(getGoal(goal.id));
    }
    if (!input.title?.trim() || !input.outcome?.trim()) throw new Error('Give the goal a title and its outcome.');
    const position = input.position || (db.prepare('SELECT MAX(position) AS p FROM goals').get().p || 0) + 1;
    const id = randomUUID();
    db.prepare('INSERT INTO goals (id, title, kind, outcome, source, position, stage, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, input.title.trim(), 'function', input.outcome.trim(), input.source || 'owner_request', position, 'waiting', now(), now());
    activeGoal(); schedule();
    return goalView(getGoal(id));
  }

  // ---- The agent's goal review ---------------------------------------------------
  // Pace: hourly and daily run on the clock but skip when nothing changed since the last
  // review; yolo starts a review as soon as every task of the current stage is done or
  // blocked, once per such state. A review that changes nothing waits for a change.
  // The agent runner (tasks and goal reviews) has its own harness, Codex unless the owner picks Claude;
  // M3NT0R's coaching and assessment keep the service's harness.
  const agentRun = () => ({ agentHarness: setting('agent_harness') || 'codex', fullAccess: setting('full_access') === 'true' });
  const pace = () => ({ pace: setting('goal_pace') || 'daily', time: setting('goal_pace_time') || '08:00', next_review_at: setting('goal_next_review_at'), reviewing_job_id: setting('goal_review_job'), last_review_at: setting('goal_last_review_at') });
  function newestMtime(dir, filter = () => true) {
    try { return Math.max(0, ...readdirSync(dir).filter(filter).map(name => statSync(path.join(dir, name)).mtimeMs)); } catch { return 0; }
  }
  function reviewState(goal) {
    const stage = stagesFor(goal.kind)[goal.stage];
    const tasks = stageTasks(goal.id, stage.key).map(task => [task.id, task.status, task.last_run_at]);
    let answered = 0;
    try { answered = JSON.parse(readFileSync(path.join(directory, 'user_questions.json'), 'utf8')).questions.filter(q => q.status !== 'pending').length; } catch {}
    const goals = db.prepare('SELECT id, status, stage, position FROM goals ORDER BY id').all();
    return JSON.stringify({ goal: goal.id, stage: goal.stage, tasks, answered, goals, assessment: newestMtime(path.join(directory, 'assessment')) });
  }
  const BLOCKED_OR_DONE = new Set(['completed', 'done', 'failed', 'paused']);
  let reviewTimer = null, reviewStarting = false;
  function considerReview() {
    if (!enabled() || reviewStarting || setting('goal_review_job')) return;
    const goal = activeGoal();
    if (!goal) return;
    const state = reviewState(goal);
    if (state === setting('goal_review_state')) { armClock(); return; } // nothing changed since the last review
    const { pace: mode } = pace();
    if (mode === 'yolo') {
      const stage = stagesFor(goal.kind)[goal.stage];
      if (stageTasks(goal.id, stage.key).every(task => BLOCKED_OR_DONE.has(task.status))) startReview(goal, state);
      return;
    }
    const due = setting('goal_next_review_at');
    if (due && new Date(due) <= new Date()) startReview(goal, state); else armClock();
  }
  function nextClock(from = new Date()) {
    const { pace: mode, time } = pace();
    if (mode === 'hourly') return new Date(from.getTime() + 3600000);
    const [h, m] = time.split(':').map(Number); const next = new Date(from); next.setHours(h, m, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  function armClock() {
    clearTimeout(reviewTimer);
    if (pace().pace === 'yolo') return;
    let due = setting('goal_next_review_at');
    if (!due) { due = nextClock().toISOString(); setSetting('goal_next_review_at', due); }
    reviewTimer = setTimeout(() => {
      // The clock fired: if nothing changed, skip without a model call and wait for the next slot.
      const goal = activeGoal();
      if (goal && reviewState(goal) === setting('goal_review_state')) { setSetting('goal_next_review_at', nextClock().toISOString()); armClock(); return; }
      considerReview();
    }, Math.min(Math.max(new Date(due) - Date.now(), 0) + 50, 2 ** 31 - 1));
  }
  async function startReview(goal, state) {
    reviewStarting = true;
    const jobId = randomUUID();
    setSetting('goal_review_job', jobId);
    try {
      const view = goalView(goal);
      const tasks = stageTasks(goal.id, view.stage.key).map(task => ({ task_id: task.id, title: task.title, status: task.status, success: task.success, last_status: task.last_status, last_result: String(task.last_result || '').slice(-1500), last_error: task.last_error, pause_reason: task.pause_reason }));
      const others = db.prepare("SELECT * FROM goals WHERE status IN ('waiting', 'improving', 'maintaining') ORDER BY position").all().map(g => ({ goal_id: g.id, title: g.title, status: g.status }));
      const question = `Goal: ${view.title} (goal_id ${view.id})\nOutcome: ${view.outcome}\nCurrent stage ${view.stage.index} of ${view.stages.length}: ${view.stage.name} (stage key "${view.stage.key}")\nWork: ${view.stage.work}\nDone when: ${view.stage.done_check}`;
      const record = goal.kind === 'environment' ? await readEnvironment(cwd) : null;
      const stageRecord = record && { infrastructure: record.sources, observability: record.plate, process: record.processes }[view.stage.key];
      const stillMissing = goal.kind === 'environment' ? await environmentCheck(cwd, view.stage.key) : null;
      await startGoalReviewJob({ jobId, question, context: { ...(stageRecord ? { stage_record: stageRecord, done_check_missing: stillMissing || 'nothing; the record meets the done-check' } : {}), stage_tasks: tasks, completed_stages: view.completed, other_goals: others } }, { cwd, harness, mcpUrl, ...agentRun() });
      setSetting('goal_review_state', state);
      setSetting('goal_last_review_at', now());
      if (pace().pace !== 'yolo') setSetting('goal_next_review_at', nextClock().toISOString());
      followReview(jobId);
    } catch (error) {
      setSetting('goal_review_job', null);
      setSetting('goal_review_error', `Could not start the goal review: ${error.message}`);
    } finally { reviewStarting = false; }
  }
  function followReview(jobId) {
    let fsWatcher = null, liveness = null, busy = false;
    const check = async () => {
      if (busy) return; busy = true;
      try {
        let job; try { job = await getM3ntorResult(jobId); } catch (error) { job = { status: 'failed', error: error.message }; }
        if (!terminal.has(job.status)) return;
        fsWatcher?.close(); clearInterval(liveness);
        // The review's own changes are part of the state it leaves; only later changes start another.
        const goal = activeGoal();
        if (goal) setSetting('goal_review_state', reviewState(goal));
        setSetting('goal_review_job', null);
        setSetting('goal_review_error', job.status === 'complete' && reportedDone(job.output) ? null : `The last goal review did not finish: ${job.error || String(job.output || '').trim().split('\n').pop()}`);
        schedule();
      } finally { busy = false; }
    };
    try { fsWatcher = watch(jobDirectory(jobId), () => { check(); }); } catch {}
    liveness = setInterval(check, 60000);
    check();
  }
  if (setting('goal_review_job')) followReview(setting('goal_review_job'));

  schedule();

  const workerState = () => ({ enabled: enabled(), database: path.join(directory, 'action.sqlite3'), executing: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'executing'").get().n, next_run_at: db.prepare("SELECT MIN(next_run_at) AS at FROM tasks WHERE status = 'queued'").get()?.at || null });

  return {
    // Something outside the queue changed (an owner answer, a saved assessment).
    poke() { schedule(); },
    // The owner's Run: one goal review now, whatever the pace and even if nothing changed.
    async runReview() {
      if (setting('goal_review_job') || reviewStarting) throw new Error('A goal review is already running.');
      const goal = activeGoal();
      if (!goal) throw new Error('There is no active goal to review.');
      await startReview(goal, reviewState(goal));
      if (!setting('goal_review_job')) throw new Error(setting('goal_review_error') || 'The goal review did not start.');
      return pace();
    },
    goals: () => ({ goals: listGoals(), pace: pace(), review_error: setting('goal_review_error'), full_access: setting('full_access') === 'true', agent_harness: setting('agent_harness') || 'codex' }),
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
        // A goal's tasks belong to its current stage; a task for a stage it hasn't reached is refused.
        let goalFields = existing ? { goal_id: existing.goal_id, stage: existing.stage } : { goal_id: null, stage: null };
        if (input.goal_id) {
          const goal = getGoal(input.goal_id);
          if (!goal) throw new Error('Goal not found.');
          const current = stagesFor(goal.kind)[goal.stage];
          if (!['active', 'improving', 'maintaining'].includes(goal.status)) throw new Error(`The goal "${goal.title}" is ${goal.status}; its tasks start when it becomes the active goal.`);
          if (input.stage && input.stage !== current.key) throw new Error(`The goal "${goal.title}" is in its ${current.name} stage ("${current.key}"); tasks for the "${input.stage}" stage wait until it gets there.`);
          goalFields = { goal_id: goal.id, stage: current.key };
        }
        const contract = { success: input.success.trim(), constraints: input.constraints?.length ? JSON.stringify(input.constraints) : null, category: input.category || null, ...goalFields };
        const removeOnCompletion = input.remove_on_completion === true ? 1 : 0;
        if (removeOnCompletion && recurrence) throw new Error('remove_on_completion applies to one-off tasks only.');
        if (existing) update(id, { title: input.title, instruction: input.instruction, recurrence, next_run_at: nextRun, status: 'queued', consecutive_failures: 0, pause_reason: null, remove_on_completion: removeOnCompletion, ...contract });
        else db.prepare('INSERT INTO tasks (id, title, instruction, recurrence, next_run_at, status, created_at, updated_at, remove_on_completion, success, constraints, category, goal_id, stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.title, input.instruction, recurrence, nextRun, 'queued', now(), now(), removeOnCompletion, contract.success, contract.constraints, contract.category, contract.goal_id, contract.stage);
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
      if (name === 'list_goals') return { goals: listGoals(), pace: pace(), review_error: setting('goal_review_error') };
      if (name === 'set_goal') return { goal: setGoal(input), goals: listGoals() };
      if (name === 'complete_stage') return completeStage(input.goal_id, input.evidence).then(goal => ({ goal }));
      if (name === 'reopen_stage') return reopenStage(input.goal_id, input.evidence).then(goal => ({ goal }));
      if (name === 'stop_goal') return stopGoal(input.goal_id, input.reason).then(goal => ({ goal, goals: listGoals() }));
      if (name === 'set_pace') {
        if (!['hourly', 'daily', 'yolo'].includes(input.pace)) throw new Error('Pace is hourly, daily or yolo.');
        setSetting('goal_pace', input.pace);
        if (input.time) setSetting('goal_pace_time', input.time);
        setSetting('goal_next_review_at', input.pace === 'yolo' ? null : nextClock().toISOString());
        clearTimeout(reviewTimer); schedule();
        return pace();
      }
      if (name === 'set_agent_harness') { if (!['codex', 'claude'].includes(input.harness)) throw new Error('The agent runner is codex or claude.'); setSetting('agent_harness', input.harness); return agentRun(); }
      if (name === 'set_full_access') { setSetting('full_access', input.enabled === true ? 'true' : 'false'); return { full_access: setting('full_access') === 'true' }; }
      if (name === 'start_task_worker') { setEnabled(true); schedule(); return workerState(); }
      if (name === 'stop_task_worker') { setEnabled(false); clearTimeout(timer); return workerState(); }
      throw new Error('Unknown task tool.');
    },
  };
}
