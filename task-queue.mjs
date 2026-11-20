import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getM3ntorResult, jobDirectory, startTaskJob, startGoalReviewJob } from './m3ntor-jobs.mjs';
import { stagesFor, STUCK_INSTRUCTION } from './goals.mjs';
import { environmentCheck, readEnvironment } from './environment.mjs';
import { appendJournalInWrite, businessDate, questionState, readJournal, serializeBusinessWrites, setUserQuestions } from './business-journal.mjs';

// Journal entries with fixed ids, so a retried write updates the same entry.
const journalOnce = (cwd, entryId, input) => serializeBusinessWrites(cwd, () => appendJournalInWrite(cwd, input, new Date(), entryId));
// A task's job ends with `STATUS: done` or `STATUS: not done — <reason>`.
// The last STATUS line decides, even if the agent adds a closing summary after it.
const statusLine = output => String(output || '').split('\n').map(line => line.replace(/[*`_]/g, '').trim()).reverse().find(line => /^status:/i.test(line)) || '';
const reportedDone = output => /^status:\s*done\b/i.test(statusLine(output));

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
// The getting-unstuck method ships with the package and goes to every stuck-mode review.
const UNSTUCK_SKILL = readFileSync(new URL('./skills/getting-unstuck/SKILL.md', import.meta.url), 'utf8').replace(/^---[\s\S]*?---\s*/, '');

const recurrenceSchema = {
  type: 'object',
  description: 'Omit for a one-off task. weekly runs on a weekday at HH:MM in the service\'s local time; interval_minutes repeats after each run.',
  properties: {
    weekly: { type: 'object', description: 'Run once a week.', properties: { day: { type: 'string', enum: WEEKDAYS, description: 'The weekday.' }, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'Local time, HH:MM.' } }, required: ['day', 'time'], additionalProperties: false },
    interval_minutes: { type: 'integer', minimum: 5, description: 'Minutes to wait after each run before the next.' },
  },
  additionalProperties: false,
};
const TASK_STATUSES = ['queued', 'delivered', 'executing', 'completed', 'failed', 'paused', 'done'];

export const taskTools = [
  { name: 'set_task', description: 'Use when work should run in the owner\'s harness now, later or on a schedule: the next work for the active goal\'s stage, the weekly assessment, a recurring routine, or one-off work the owner directs. Creates or updates a task in the owner\'s action queue; the service runs it when due and records the result. Supplying an existing task_id updates that task instead of adding another; use this to reuse a matching recurring task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Existing task to update; omit to create.' }, title: { type: 'string', description: 'Short name the owner sees in the task list.' }, instruction: { type: 'string', description: 'The task: what the owner\'s agent should do when it runs.' }, success: { type: 'string', description: 'Definition of success: what must be true for the run to count as done.' }, constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints unique to this task.' }, category: { type: 'string', enum: ['assessment', 'use_case', 'other'], description: 'assessment for the weekly reassessment, use_case for researching an owner-reported use case.' }, run_at: { type: 'string', format: 'date-time', description: 'First run time; omit to run now (one-off) or at the next recurrence.' }, recurrence: recurrenceSchema, remove_on_completion: { type: 'boolean', description: 'One-off tasks only: after a successful run, journal the result and remove the task from the list (used for one-off work whose record belongs in the journal).' }, goal_id: { type: 'string', description: 'The active goal this task works on; omit for one-off work the owner directs.' }, stage: { type: 'string', description: 'With goal_id: the goal\'s current stage key (list_goals). Tasks for a stage the goal has not reached are refused.' } }, required: ['title', 'instruction', 'success'], additionalProperties: false } },
  { name: 'list_tasks', description: 'Use before set_task, to reuse a matching task instead of adding a duplicate, and when checking what is queued, running or failed: lists tasks with status, next run time, last run and its result or error.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: TASK_STATUSES, description: 'Only tasks in this status; omit for all.' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'clear_task', description: 'Use when a task is finished for good or the owner decides against it: action done marks it finished and stops any recurrence (history kept); action delete removes it and its run history. A running job is not stopped. When the owner has decided against a task, give their reason: it is journaled so M3NT0R can take it into account on its next weekly run.', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task, from list_tasks.' }, action: { type: 'string', enum: ['done', 'delete'], description: 'done keeps its history; delete removes it and its runs.' }, reason: { type: 'string', description: 'The owner\'s decision and reason, when they directed this.' } }, required: ['task_id', 'action'], additionalProperties: false } },
  { name: 'start_task_worker', description: 'Use at setup, or when the owner wants queued tasks to run again after stopping them: start running due tasks (persists across service restarts) and return the worker state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'stop_task_worker', description: 'Use when the owner wants tasks paused, or to stop runaway or wasteful work: stop starting new tasks (persists across restarts). Jobs already running finish and their results are still recorded.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
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
  for (const [name, type] of [['remove_on_completion', 'INTEGER NOT NULL DEFAULT 0'], ['success', 'TEXT'], ['constraints', 'TEXT'], ['category', 'TEXT'], ['goal_id', 'TEXT'], ['stage', 'TEXT'], ['set_at', 'TEXT']]) if (!columns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
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
    const error = ok ? null : job.status === 'complete' ? `The task reported it was not done: ${statusLine(job.output) || 'no STATUS line'}` : (job.error || job.status);
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
    if (ok) journalCompleted(task, job.job_id, finished, job.output);
    const failures = ok ? 0 : task.consecutive_failures + 1;
    const next = task.recurrence ? nextFor(task, new Date()) : null;
    const status = !ok && failures >= MAX_CONSECUTIVE_FAILURES ? 'paused' : next ? 'queued' : ok ? 'completed' : 'failed';
    update(taskId, {
      status, job_id: null, consecutive_failures: failures, next_run_at: status === 'queued' ? next : null,
      pause_reason: status === 'paused' ? `${failures} consecutive failed runs; state kept. Fix the cause, then set_task this task_id to resume.` : null,
      last_run_at: finished, last_status: ok ? 'completed' : 'failed', last_result: ok ? job.output : null, last_error: error,
    });
  }

  // Every completed run goes into the journal: the task, its success definition and the result.
  function journalCompleted(task, jobId, finishedAt, output) {
    const goal = task.goal_id ? getGoal(task.goal_id) : null;
    const content = `Completed: ${task.title}${goal ? `\nGoal: ${goal.title}${task.stage ? ` (${task.stage})` : ''}` : ''}\nTask: ${task.instruction}\nSuccess means: ${task.success || ''}\n\nResult:\n${String(output || '').trim()}`;
    return journalOnce(cwd, `task-completed-${task.id}-${jobId}`, { date: businessDate(new Date(finishedAt)), kind: 'activity', source: 'action_queue', content, metadata: { task_id: task.id, job_id: jobId } })
      .catch(error => console.error('Journaling a completed task failed:', error.message));
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
  // USER-AUTHORIZED — Marcus, November 18, 2026: a completed goal is journaled and marked
  // inactive, and inactive goals are not rendered. Goals finished before then become inactive.
  // The entry has a fixed id and date (the last stage's completion), so writing it again changes nothing.
  const journalGoalCompleted = async goal => {
    const done = JSON.parse(goal.completed);
    const at = done.at(-1)?.at || goal.updated_at;
    const date = businessDate(new Date(at));
    // Entries written before this keying used the stage count as their id; one written at or after
    // this completion already records it.
    const day = (await readJournal(cwd, { date })).entries[`${date}_entries`] || [];
    if (day.some(entry => entry.id === `goal-completed-${goal.id}-${done.length}` && entry.createdAt >= at)) return null;
    // Keyed by the completion time, so a goal that is reopened and completes again keeps both entries.
    return journalOnce(cwd, `goal-completed-${goal.id}-${at}`, { date: businessDate(new Date(at)), kind: 'success', source: 'goals', content: `Goal completed: ${goal.title}\nOutcome: ${goal.outcome}\n${done.map(item => `- ${item.name}: ${item.evidence}`).join('\n')}`, metadata: { goal_id: goal.id } });
  };
  // A completed function goal's Improve stage is a weekly comparison the service schedules itself,
  // so it never depends on an agent remembering to write it. Its instruction carries the reopen rule.
  const improveTaskId = goal => `improve-${goal.id}`;
  // An Improve task an agent wrote before the service scheduled them is reused, never duplicated.
  const findImproveTask = goal => get(improveTaskId(goal)) || db.prepare("SELECT * FROM tasks WHERE goal_id = ? AND stage = 'improve' ORDER BY created_at LIMIT 1").get(goal.id);
  function ensureImproveTask(goal) {
    const done = JSON.parse(goal.completed);
    const measured = done.find(item => item.stage === 'measurement')?.evidence || 'the measured result recorded at Measurement';
    const recurrence = JSON.stringify({ weekly: { day: 'monday', time: setting('goal_pace_time') || '08:00' } });
    const fields = {
      title: `Improve: ${goal.title}`,
      instruction: `Weekly Improve check for the completed goal "${goal.title}" (goal_id ${goal.id}).\nOutcome it must keep delivering: ${goal.outcome}\nMeasured result at completion: ${measured}\n\n1. Read this goal's runs and records from the last week and compare the results with the outcome and the measured result.\n2. Read the journal for the last 21 days (read_journal from_date/to_date) and find this goal's previous Improve check.\n3. Record this week's comparison with add_journal: content starting "Improve check: ${goal.title}: met" or "Improve check: ${goal.title}: missed", then the evidence.\n4. If this week missed and the previous Improve check also missed, call reopen_stage with this goal_id and the evidence of both misses.`,
      success: 'This week\'s comparison is journaled as met or missed, and a second consecutive miss has reopened the goal\'s Process stage.',
      recurrence, goal_id: goal.id, stage: 'improve', category: 'other',
    };
    const existing = findImproveTask(goal);
    // A running task keeps its in-flight status; settling it schedules the next weekly run.
    if (existing && ['delivered', 'executing', 'finalizing', 'clearing'].includes(existing.status)) update(existing.id, fields);
    else if (existing) update(existing.id, { ...fields, status: 'queued', next_run_at: nextFor({ recurrence }, new Date()), consecutive_failures: 0, pause_reason: null });
    else db.prepare('INSERT INTO tasks (id, title, instruction, recurrence, next_run_at, status, created_at, updated_at, success, category, goal_id, stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(improveTaskId(goal), fields.title, fields.instruction, recurrence, nextFor({ recurrence }, new Date()), 'queued', now(), now(), fields.success, fields.category, goal.id, 'improve');
  }
  db.prepare("UPDATE goals SET status = 'inactive', updated_at = ? WHERE status IN ('improving', 'maintaining')").run(now());
  // A completed function goal missing its weekly Improve check (completed before this, or interrupted) gets one.
  for (const goal of db.prepare("SELECT * FROM goals WHERE status = 'inactive' AND kind = 'function'").all()) {
    // An existing row counts only if it recurs; a cleared recurring check (status done) stays the owner's decision.
    if (stagesFor(goal.kind)[goal.stage]?.key === 'improve' && !findImproveTask(goal)?.recurrence) ensureImproveTask(goal);
  }
  // Every start re-writes completed goals' entries, so a missed or failed write is recovered.
  for (const goal of db.prepare("SELECT * FROM goals WHERE status = 'inactive' AND completed != '[]'").all()) {
    journalGoalCompleted(goal).catch(error => console.error('Journaling a completed goal failed:', error.message));
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
    // A recurring routine waiting for its next run is ongoing work, not unfinished work.
    if (tasks.some(task => ['delivered', 'executing', 'finalizing', 'clearing'].includes(task.status) || (task.status === 'queued' && !task.recurrence))) throw new Error(`Tasks for the ${stage.name} stage are still queued or running.`);
    if (goal.kind === 'environment') {
      // The working environment's stages are checked against its records, not the agent's claim.
      const missing = await environmentCheck(cwd, stage.key);
      if (missing) throw new Error(`The ${stage.name} done-check is not met: ${missing}`);
      if (stage.key === 'observability') {
        // The list must come from a recurring routine task's own completed run, not a hand edit.
        const { plate } = await readEnvironment(cwd);
        const routine = get(plate.routine_task_id);
        if (!routine?.recurrence) throw new Error('The Observability done-check is not met: the commitments list was not refreshed by a recurring routine task.');
        const run = db.prepare("SELECT * FROM runs WHERE task_id = ? AND status = 'completed' AND started_at <= ? AND finished_at >= ? ORDER BY finished_at DESC LIMIT 1").get(routine.id, plate.updated_at, plate.updated_at);
        if (!run) throw new Error('The Observability done-check is not met: the latest commitments list was not written during a completed run of the routine task.');
      }
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
    if (goal.kind === 'environment' && stage.key === 'process') {
      const { processes } = await readEnvironment(cwd);
      await setUserQuestions(cwd, { only_if_absent: true, source: 'process_setup', questions: [{
        id: `process-review-${goal.id}`,
        question: `We have sketched ${processes.processes.length} business processes in the Process tab. Would you like to review them? You can ask your agent to add, read, change or delete flows through MCP. These are unverified sketches; reviewing them is optional and does not block environment setup.`,
      }] });
    }
    const completed = [...JSON.parse(goal.completed), { stage: stage.key, name: stage.name, evidence: evidence.trim(), at: now() }];
    const nextIndex = goal.stage + 1;
    const nextStage = stages[nextIndex];
    // The last stage that ends (the recurring Improve stage does not) completes the goal:
    // it is marked inactive and the next waiting goal takes the active slot.
    const goalCompleted = !nextStage || nextStage.key === 'improve';
    // A function goal stays at its Improve stage, which the service runs as a weekly comparison.
    updateGoal(goal.id, { stage: nextStage ? nextIndex : goal.stage, completed: JSON.stringify(completed), status: goalCompleted ? 'inactive' : 'active' });
    // A stage reached with no work planned for it gets a review now, whatever the pace.
    const nextGoal = activeGoal();
    if (nextGoal && !stageTasks(nextGoal.id, stagesFor(nextGoal.kind)[nextGoal.stage].key).length) setSetting('goal_next_review_at', now());
    await journalOnce(cwd, `goal-stage-${goal.id}-${stage.key}-${completed.at(-1).at}`, { kind: 'activity', source: 'goals', content: `Goal "${goal.title}": ${stage.name} stage done.\n${evidence.trim()}`, metadata: { goal_id: goal.id, stage: stage.key } });
    if (goalCompleted && nextStage) ensureImproveTask(getGoal(goal.id));
    if (goalCompleted) await journalGoalCompleted(getGoal(goal.id));
    activeGoal(); schedule();
    return goalView(getGoal(goal.id));
  }

  async function reopenStage(goalId, evidence) {
    const goal = getGoal(goalId);
    if (!goal || goal.status !== 'inactive' || goal.kind !== 'function') throw new Error('Only a completed function goal can reopen its Process stage.');
    const index = stagesFor(goal.kind).findIndex(stage => stage.key === 'process');
    // Reopened work becomes the next active goal so it runs through the stages again in order.
    db.prepare("UPDATE goals SET status = 'waiting' WHERE status = 'active'").run();
    updateGoal(goal.id, { stage: index, status: 'active', completed: JSON.stringify(JSON.parse(goal.completed).filter(item => stagesFor(goal.kind).findIndex(stage => stage.key === item.stage) < index)) });
    // The weekly Improve check pauses until the goal completes again (a run in progress still records its result),
    // and the reopened stages' earlier tasks become history, so each stage is checked on new work.
    const reopened = stagesFor(goal.kind).slice(index).map(stage => stage.key).filter(key => key !== 'improve');
    const marks = ['improve', ...reopened].map(() => '?').join(', ');
    // The Improve check and set-aside tasks stop recurring. A running one stays in flight, so the queue still
    // runs one task at a time, and settles once without a next run; the rest are marked done.
    db.prepare(`UPDATE tasks SET recurrence = NULL, next_run_at = NULL, updated_at = ? WHERE goal_id = ? AND stage IN (${marks}) AND status IN ('delivered', 'executing')`).run(now(), goal.id, 'improve', ...reopened);
    db.prepare(`UPDATE tasks SET status = 'done', next_run_at = NULL, updated_at = ? WHERE goal_id = ? AND stage IN (${marks}) AND status NOT IN ('completed', 'done', 'delivered', 'executing', 'finalizing', 'clearing')`).run(now(), goal.id, 'improve', ...reopened);
    const setAside = reopened.map(() => '?').join(', ');
    db.prepare(`UPDATE tasks SET stage = stage || '-before-reopen', updated_at = ? WHERE goal_id = ? AND stage IN (${setAside})`).run(now(), goal.id, ...reopened);
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
  // The owner's notes from the last 14 days (the free-text box in the owner view), newest first.
  function ownerNotes() {
    const notes = [];
    try {
      for (const file of readdirSync(path.join(directory, 'journal')).filter(name => name.endsWith('.json')).sort().slice(-14)) {
        for (const entry of JSON.parse(readFileSync(path.join(directory, 'journal', file), 'utf8')).entries || []) if (entry.source === 'owner_note') notes.push({ note: entry.content, at: entry.createdAt });
      }
    } catch {}
    return notes.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  function reviewState(goal) {
    const stage = stagesFor(goal.kind)[goal.stage];
    const tasks = stageTasks(goal.id, stage.key).map(task => [task.id, task.status, task.last_run_at]);
    let answered = 0;
    try { answered = JSON.parse(readFileSync(path.join(directory, 'user_questions.json'), 'utf8')).questions.filter(q => q.status !== 'pending').length; } catch {}
    const goals = db.prepare('SELECT id, status, stage, position FROM goals ORDER BY id').all();
    return JSON.stringify({ goal: goal.id, stage: goal.stage, tasks, answered, notes: ownerNotes().length, goals, assessment: newestMtime(path.join(directory, 'assessment')) });
  }
  const BLOCKED_OR_DONE = new Set(['completed', 'done', 'failed', 'paused']);
  let reviewTimer = null, reviewStarting = false;
  // A question inov8 asked that the owner has not answered pauses reviews until it is answered
  // (the owner's Run still starts one).
  function waitingOnOwner() {
    try { return JSON.parse(readFileSync(path.join(directory, 'user_questions.json'), 'utf8')).questions.some(q => q.status === 'pending' && q.source === 'inov8'); } catch { return false; }
  }
  function considerReview() {
    if (!enabled() || reviewStarting || setting('goal_review_job') || waitingOnOwner()) return;
    const goal = activeGoal();
    if (!goal) return;
    const state = reviewState(goal);
    if (state === setting('goal_review_state')) { armClock(); return; } // nothing changed since the last review
    const { pace: mode } = pace();
    if (mode === 'yolo') {
      const stage = stagesFor(goal.kind)[goal.stage];
      // A recurring routine waiting for its next run, after a run, has settled (as in completeStage).
      if (stageTasks(goal.id, stage.key).every(task => BLOCKED_OR_DONE.has(task.status) || (task.status === 'queued' && task.recurrence && task.last_run_at))) startReview(goal, state);
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
      if (goal && (waitingOnOwner() || reviewState(goal) === setting('goal_review_state'))) { setSetting('goal_next_review_at', nextClock().toISOString()); armClock(); return; }
      considerReview();
    }, Math.min(Math.max(new Date(due) - Date.now(), 0) + 50, 2 ** 31 - 1));
  }
  // ask_m3ntor during a review: the service waits for that job before deciding the stage is stuck.
  function noteAction(jobId) { if (jobId && setting('goal_review_job')) setSetting('goal_m3ntor_job', jobId); }
  // Work under way toward the stage's done-check: a stage task queued or running, or a question
  // inov8 asked that the owner has not answered. A request to M3NT0R is not: it only advises.
  async function underWay(goal) {
    const stage = stagesFor(goal.kind)[goal.stage];
    if (stageTasks(goal.id, stage.key).some(task => ['queued', 'delivered', 'executing', 'finalizing'].includes(task.status))) return true;
    return (await questionState(cwd)).pending.some(q => q.source === 'inov8');
  }
  const STUCK_REASON = 'the last review left nothing under way toward the done-check: no stage task queued or running and no question waiting on the owner.';
  async function startReview(goal, state) {
    reviewStarting = true;
    const jobId = randomUUID();
    setSetting('goal_review_job', jobId);
    setSetting('goal_review_stage', `${goal.id}:${goal.stage}`);
    setSetting('goal_review_started_at', now());
    try {
      const view = goalView(goal);
      // The last review's conclusions stand; the review gets what changed since, not the stage's whole history.
      const sameStage = setting('goal_review_handoff_stage') === `${goal.id}:${goal.stage}`;
      const stuck = sameStage && setting('goal_stuck') === '1';
      setSetting('goal_review_mode', stuck ? 'stuck' : 'normal');
      setSetting('goal_stuck', null);
      const since = sameStage ? setting('goal_review_finished_at') : null;
      const tasks = stageTasks(goal.id, view.stage.key).map(task => ({ task_id: task.id, title: task.title, status: task.status, success: task.success, last_status: task.last_status, last_run_at: task.last_run_at, last_error: task.last_error, pause_reason: task.pause_reason, ...(since ? {} : { last_result: String(task.last_result || '').slice(-1500) }) }));
      const others = db.prepare("SELECT * FROM goals WHERE status IN ('waiting', 'inactive') ORDER BY position").all().map(g => ({ goal_id: g.id, title: g.title, status: g.status }));
      let question = `Goal: ${view.title} (goal_id ${view.id})\nOutcome: ${view.outcome}\nCurrent stage ${view.stage.index} of ${view.stages.length}: ${view.stage.name} (stage key "${view.stage.key}")\nWork: ${view.stage.work}\nDone when: ${view.stage.done_check}`;
      if (stuck) question += `\n\n${STUCK_INSTRUCTION}\n\n${UNSTUCK_SKILL}`;
      const record = goal.kind === 'environment' ? await readEnvironment(cwd) : null;
      const stageRecord = record && { infrastructure: record.sources, observability: record.plate, process: record.processes }[view.stage.key];
      const stillMissing = goal.kind === 'environment' ? await environmentCheck(cwd, view.stage.key) : null;
      // The owner's answers are direction: the review gets the latest ones (newest first); new marks those since the last review.
      let ownerAnswers = [];
      try { ownerAnswers = JSON.parse(readFileSync(path.join(directory, 'user_questions.json'), 'utf8')).questions.filter(q => q.status === 'answered' && q.answer).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 20).map(q => ({ question: q.question, answer: q.answer, answered_at: q.updatedAt, ...(since ? { new: String(q.updatedAt) > since } : {}) })); } catch {}
      const notes = ownerNotes().slice(0, 20).map(note => ({ ...note, ...(since ? { new: String(note.at) > since } : {}) }));
      const latest = view.stage.score ? await latestAssessment() : null;
      const changes = since ? {
        since,
        task_runs: db.prepare('SELECT runs.task_id, tasks.title, runs.status, runs.started_at, runs.finished_at, runs.result, runs.error FROM runs JOIN tasks ON tasks.id = runs.task_id WHERE tasks.goal_id = ? AND tasks.stage = ? AND (runs.finished_at > ? OR runs.finished_at IS NULL) ORDER BY runs.started_at').all(goal.id, view.stage.key, since)
          .map(run => ({ ...run, result: run.result ? String(run.result).slice(-1500) : null })),
        new_owner_answers: ownerAnswers.filter(a => a.new).length,
        new_owner_notes: notes.filter(n => n.new).length,
        assessment: latest ? { revision_id: latest.revision_id, [view.stage.score]: latest.ratings?.[view.stage.score]?.score ?? null, new: String(latest.assessed_at || '') > since } : null,
      } : null;
      const lastReview = since ? { finished_at: since, conclusions: setting('goal_review_handoff') } : null;
      const stuckContext = stuck ? { reason: STUCK_REASON, score: latest && view.stage.score ? latest.ratings?.[view.stage.score]?.score ?? null : null, done_check_missing: stillMissing || null } : null;
      await startGoalReviewJob({ jobId, question, context: { ...(lastReview ? { last_review: lastReview, changes_since_last_review: changes } : {}), ...(stuckContext ? { stuck: stuckContext } : {}), owner_answers: ownerAnswers, owner_notes: notes, ...(stageRecord ? { stage_record: stageRecord, done_check_missing: stillMissing || 'nothing; the record meets the done-check' } : {}), stage_tasks: tasks, completed_stages: view.completed, other_goals: others } }, { cwd, harness, mcpUrl, ...agentRun() });
      setSetting('goal_review_state', state);
      setSetting('goal_last_review_at', now());
      if (pace().pace !== 'yolo') setSetting('goal_next_review_at', nextClock().toISOString());
      followReview(jobId);
    } catch (error) {
      setSetting('goal_review_job', null);
      setSetting('goal_review_error', `Could not start the goal review: ${error.message}`);
    } finally { reviewStarting = false; }
  }
  // inov8 cannot get the stage moving: the service puts the question to the owner, with the review's own account.
  async function askOwnerStuck(goal, reason, output) {
    const stage = stagesFor(goal.kind)[goal.stage];
    const account = String(output || '').replace(/\n*\**STATUS:[^\n]*\s*$/i, '').trim().slice(0, 1500);
    const question = `inov8 is stuck on the "${goal.title}" goal at its ${stage.name} stage: ${reason}\nDone when: ${stage.done}\n\nIts last review said:\n${account || '(no account)'}\n\nWhat should change? Give inov8 direction, or say the goal or its done-check should change.`;
    const id = `inov8-stuck-${goal.id}-${stage.key}-${Date.now()}`;
    await setUserQuestions(cwd, { action: 'set', questions: [{ id, question, source: 'inov8' }] });
    setSetting('goal_stuck_question', id);
    await journalOnce(cwd, `goal-stuck-${id}`, { kind: 'activity', source: 'goals', content: `Goal "${goal.title}": stuck at ${stage.name}; asked the owner. ${reason}`, metadata: { goal_id: goal.id, stage: stage.key, question_id: id } });
  }
  // After a review: keep its account for the next one, then judge the stage by what the review left.
  // Nothing under way toward the done-check means the stage is stuck: a stuck-mode review starts at
  // once (after any M3NT0R answer the review asked for). A stuck-mode review that again leaves nothing
  // under way makes the service ask the owner; reviews then wait for the answer.
  async function settleReview(goal, job, moved) {
    const reviewed = job.status === 'complete' && reportedDone(job.output);
    if (!goal || !reviewed) return {};
    const stage = stagesFor(goal.kind)[goal.stage];
    const wasStuck = setting('goal_review_mode') === 'stuck';
    setSetting('goal_review_handoff', String(job.output || '').slice(0, 6000));
    setSetting('goal_review_handoff_stage', `${goal.id}:${goal.stage}`);
    setSetting('goal_review_finished_at', now());
    return judgeStuck(goal, stage, job.output, wasStuck, moved);
  }
  async function judgeStuck(goal, stage, output, wasStuck, moved = false) {
    if (moved || await underWay(goal)) { setSetting('goal_stuck', null); return {}; }
    if (wasStuck) {
      setSetting('goal_stuck', null); setSetting('goal_review_mode', 'normal');
      await askOwnerStuck(goal, `a review working on getting it unstuck again left nothing under way toward the done-check.`, output);
      return {};
    }
    setSetting('goal_stuck', '1');
    await journalOnce(cwd, `goal-stuck-${goal.id}-${stage.key}-${setting('goal_review_finished_at')}`, { kind: 'activity', source: 'goals', content: `Goal "${goal.title}": ${stage.name} is stuck; ${STUCK_REASON} A review working on getting it unstuck starts now.`, metadata: { goal_id: goal.id, stage: stage.key } });
    const consult = setting('goal_m3ntor_job');
    if (consult) {
      let job; try { job = await getM3ntorResult(consult); } catch { job = null; }
      if (job && !terminal.has(job.status)) return { waitFor: consult };
    }
    return { startStuck: true };
  }
  // Start the stuck-mode review now, unless one is running or the worker is stopped.
  function startStuckReview() {
    const goal = activeGoal();
    if (!goal || !enabled() || reviewStarting || setting('goal_review_job') || setting('goal_stuck') !== '1') return;
    startReview(goal, reviewState(goal));
  }
  // The stuck-mode review waits for the M3NT0R answer the last review asked for.
  function followConsult(jobId) {
    let fsWatcher = null, liveness = null;
    const check = async () => {
      let job; try { job = await getM3ntorResult(jobId); } catch { job = { status: 'failed' }; }
      if (!terminal.has(job.status)) return;
      fsWatcher?.close(); clearInterval(liveness);
      setSetting('goal_m3ntor_job', null);
      startStuckReview();
    };
    try { fsWatcher = watch(jobDirectory(jobId), () => { check(); }); } catch {}
    liveness = setInterval(check, 60000);
    check();
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
        // A review that moved the goal to a new stage without queuing work for it leaves that
        // stage unplanned: the next review starts now, whatever the pace.
        const moved = goal && setting('goal_review_stage') !== `${goal.id}:${goal.stage}`;
        const unplanned = moved && !stageTasks(goal.id, stagesFor(goal.kind)[goal.stage].key).length;
        let settled = {};
        try { settled = await settleReview(goal, job, moved); } catch (error) { console.error('Goal review settle failed:', error.message); }
        if (goal && !unplanned) setSetting('goal_review_state', reviewState(goal));
        if (unplanned) setSetting('goal_next_review_at', new Date().toISOString());
        setSetting('goal_review_job', null);
        setSetting('goal_review_error', job.status === 'complete' && reportedDone(job.output) ? null : `The last goal review did not finish: ${job.error || statusLine(job.output) || 'no STATUS line'}`);
        if (settled.waitFor) followConsult(settled.waitFor);
        else if (settled.startStuck) startStuckReview();
        schedule();
      } finally { busy = false; }
    };
    try { fsWatcher = watch(jobDirectory(jobId), () => { check(); }); } catch {}
    liveness = setInterval(check, 60000);
    check();
  }
  if (setting('goal_review_job')) followReview(setting('goal_review_job'));
  else resumeStuck().catch(error => console.error('Stuck check failed:', error.message));
  // At startup: a stuck stage resumes its stuck-mode review. A stage whose last review left nothing
  // under way, with nothing new since (no task run, owner answer or note), is judged now.
  async function resumeStuck() {
    const goal = activeGoal();
    if (!goal || setting('goal_review_handoff_stage') !== `${goal.id}:${goal.stage}`) return;
    if (setting('goal_stuck') === '1') {
      const consult = setting('goal_m3ntor_job');
      if (consult) return followConsult(consult);
      return startStuckReview();
    }
    const since = setting('goal_review_finished_at');
    const stage = stagesFor(goal.kind)[goal.stage];
    if (!since) return;
    const ran = db.prepare('SELECT COUNT(*) AS n FROM runs JOIN tasks ON tasks.id = runs.task_id WHERE tasks.goal_id = ? AND tasks.stage = ? AND (runs.finished_at > ? OR runs.finished_at IS NULL)').get(goal.id, stage.key, since).n;
    const answered = (await questionState(cwd)).questions.some(q => q.status !== 'pending' && String(q.updatedAt) > since);
    if (ran || answered || ownerNotes().some(note => String(note.at) > since)) return;
    const judged = await judgeStuck(goal, stage, setting('goal_review_handoff'), setting('goal_review_mode') === 'stuck');
    if (judged.waitFor) followConsult(judged.waitFor); else if (judged.startStuck) startStuckReview();
  }
  // Completed runs from before this was journaled (fixed entry ids, so repeats change nothing).
  for (const run of db.prepare("SELECT runs.job_id, runs.finished_at, runs.result, runs.task_id FROM runs JOIN tasks ON tasks.id = runs.task_id WHERE runs.status = 'completed' AND runs.finished_at IS NOT NULL AND tasks.remove_on_completion = 0").all()) {
    journalCompleted(get(run.task_id), run.job_id, run.finished_at, run.result);
  }

  schedule();

  const workerState = () => ({ enabled: enabled(), database: path.join(directory, 'action.sqlite3'), executing: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'executing'").get().n, next_run_at: db.prepare("SELECT MIN(next_run_at) AS at FROM tasks WHERE status = 'queued'").get()?.at || null });

  return {
    // Something outside the queue changed (an owner answer, a saved assessment).
    poke() { schedule(); },
    noteAction,
    // An answer or dismissal that leaves no question waiting on the owner starts a review now, whatever the pace.
    questionsSettled() {
      let pending = true;
      try { pending = JSON.parse(readFileSync(path.join(directory, 'user_questions.json'), 'utf8')).questions.some(q => q.status === 'pending'); } catch {}
      if (pending || !enabled() || reviewStarting || setting('goal_review_job')) return;
      const goal = activeGoal();
      if (goal) startReview(goal, reviewState(goal));
    },
    reviewing: () => Boolean(setting('goal_review_job')),
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
          if (goal.status !== 'active') throw new Error(`The goal "${goal.title}" is ${goal.status}; its tasks start when it becomes the active goal.`);
          if (input.stage && input.stage !== current.key) throw new Error(`The goal "${goal.title}" is in its ${current.name} stage ("${current.key}"); tasks for the "${input.stage}" stage wait until it gets there.`);
          goalFields = { goal_id: goal.id, stage: current.key };
        }
        const contract = { success: input.success.trim(), constraints: input.constraints?.length ? JSON.stringify(input.constraints) : null, category: input.category || null, ...goalFields };
        const removeOnCompletion = input.remove_on_completion === true ? 1 : 0;
        if (removeOnCompletion && recurrence) throw new Error('remove_on_completion applies to one-off tasks only.');
        if (existing) update(id, { title: input.title, instruction: input.instruction, recurrence, next_run_at: nextRun, status: 'queued', consecutive_failures: 0, pause_reason: null, remove_on_completion: removeOnCompletion, set_at: now(), ...contract });
        else db.prepare('INSERT INTO tasks (id, title, instruction, recurrence, next_run_at, status, created_at, updated_at, remove_on_completion, success, constraints, category, goal_id, stage, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.title, input.instruction, recurrence, nextRun, 'queued', now(), now(), removeOnCompletion, contract.success, contract.constraints, contract.category, contract.goal_id, contract.stage, now());
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
      if (name === 'run_goal_review') return this.runReview();
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
      if (name === 'start_task_worker') { setEnabled(true); schedule(); resumeStuck().catch(error => console.error('Stuck check failed:', error.message)); return workerState(); }
      if (name === 'stop_task_worker') { setEnabled(false); clearTimeout(timer); return workerState(); }
      throw new Error('Unknown task tool.');
    },
  };
}
