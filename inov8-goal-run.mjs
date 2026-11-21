import { randomUUID } from 'node:crypto';
import { ENVIRONMENT_STAGES, FUNCTION_STAGES } from './goals.mjs';
import { reviewEdge, reviewHash } from './inov8-review-process.mjs';

export const GOAL_RUN_PROCESS_ID = 'inov8-goal-run';
const firstAgencyIndex = FUNCTION_STAGES.findIndex(stage => stage.key === 'agency');
export const goalRunStages = kind => kind === 'environment' ? ENVIRONMENT_STAGES : FUNCTION_STAGES.slice(0, firstAgencyIndex + 1);
export const goalRunBoundary = kind => goalRunStages(kind).at(-1).key;

function defineGoalRun(kind) {
  const environment = kind === 'environment';
  const stages = goalRunStages(kind).map((stage, index) => ({
    id: 'stage-' + stage.key, type: 'stage', stage: stage.key, label: stage.name,
    work: stage.work, done: stage.done, column: 1.8, row: index + 1,
  }));
  const spine = [
    { id: 'intake', type: 'trigger', label: environment ? 'Working environment goal' : 'M3NT0R goal', column: 1.8, row: 0,
      detail: 'An admitted review starts or resumes work on the active goal.' },
    ...stages,
    { id: 'success', type: 'outcome', label: environment ? 'Setup succeeded' : 'First agentic pass succeeded', column: 1.8, row: stages.length + 1,
      detail: environment ? 'The existing Observability acceptance completes the setup run.' : 'The existing Agency acceptance completes the first-pass run.' },
  ];
  const nodes = [...spine,
    { id: 'checkpoint', type: 'decision', label: 'Run checkpoint', column: 3.3, row: 0, detail: 'The run retains its current stage and evidence between reviews.' },
    { id: 'waiting', type: 'outcome', label: 'Waiting', column: 3.3, row: 1, detail: 'The same run can wait for a source return or owner input.' },
    { id: 'recovery', type: 'outcome', label: 'Recovery', column: 3.3, row: 2, detail: 'Recovery resumes the affected work and retains prior evidence.' },
  ];
  const edges = [
    ...spine.slice(1).map((node, index) => [spine[index].id, node.id]),
    ['intake', 'checkpoint'], ['checkpoint', 'waiting'], ['checkpoint', 'recovery'],
  ].map(([from, to]) => ({ id: reviewEdge(from, to), from, to }));
  const definition = {
    id: GOAL_RUN_PROCESS_ID, name: 'inov8 goal run', kind: 'internal', goal_kind: kind, definition_version: 1, nodes, edges,
  };
  return { ...definition, version: reviewHash(definition) };
}

const definitions = {
  function: defineGoalRun('function'),
  environment: defineGoalRun('environment'),
};
export const goalRunDefinition = (kind = 'function') => definitions[kind] || definitions.function;

export function createGoalRunLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inov8_goal_runs (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL UNIQUE, goal_title TEXT NOT NULL, goal_kind TEXT NOT NULL,
      lifecycle TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      initial_stage TEXT NOT NULL, initial_proof TEXT NOT NULL, origin TEXT NOT NULL,
      definition TEXT NOT NULL, configuration TEXT NOT NULL, configuration_version TEXT NOT NULL,
      final_proof TEXT, success TEXT, stop_reason TEXT);
    CREATE TABLE IF NOT EXISTS inov8_goal_run_tasks (
      goal_run_id TEXT NOT NULL REFERENCES inov8_goal_runs(id), task_id TEXT NOT NULL, stage TEXT NOT NULL,
      title TEXT NOT NULL, PRIMARY KEY (goal_run_id, task_id, stage));
    CREATE TABLE IF NOT EXISTS inov8_goal_run_task_jobs (
      goal_run_id TEXT NOT NULL REFERENCES inov8_goal_runs(id), task_id TEXT NOT NULL, stage TEXT NOT NULL,
      run_id TEXT NOT NULL, job_id TEXT NOT NULL, started_at TEXT NOT NULL,
      PRIMARY KEY (goal_run_id, run_id));
  `);
  const forGoal = goalId => db.prepare('SELECT * FROM inov8_goal_runs WHERE goal_id = ?').get(goalId);
  const linkTask = (runId, task) => db.prepare('INSERT OR IGNORE INTO inov8_goal_run_tasks (goal_run_id, task_id, stage, title) VALUES (?, ?, ?, ?)')
    .run(runId, task.id, task.stage, task.title);
  return {
    forGoal,
    get: id => db.prepare('SELECT * FROM inov8_goal_runs WHERE id = ?').get(id),
    list: () => db.prepare('SELECT * FROM inov8_goal_runs ORDER BY rowid DESC').all(),
    admit(goal, stage, origin, configuration) {
      const existing = forGoal(goal.id);
      const proof = JSON.parse(goal.completed);
      const boundary = goalRunBoundary(goal.kind);
      if (existing && existing.lifecycle !== 'open') return null;
      if (!goalRunStages(goal.kind).some(item => item.key === stage) || proof.some(item => item.stage === boundary)) return null;
      if (existing) return existing;
      db.prepare(`INSERT INTO inov8_goal_runs (id, goal_id, goal_title, goal_kind, lifecycle, started_at, initial_stage, initial_proof,
        origin, definition, configuration, configuration_version) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_id) DO NOTHING`)
        .run(randomUUID(), goal.id, goal.title, goal.kind, new Date().toISOString(), stage, JSON.stringify(proof),
          JSON.stringify(origin), JSON.stringify(goalRunDefinition(goal.kind)), JSON.stringify(configuration), reviewHash(configuration));
      const admitted = forGoal(goal.id);
      return admitted?.lifecycle === 'open' ? admitted : null;
    },
    complete(goal, proof, receipt) {
      db.prepare(`UPDATE inov8_goal_runs SET lifecycle = 'succeeded', finished_at = ?, final_proof = ?, success = ?
        WHERE goal_id = ? AND lifecycle = 'open'`)
        .run(receipt.accepted_at, JSON.stringify(proof), JSON.stringify(receipt), goal.id);
    },
    stop(goal, proof, reason) {
      db.prepare(`UPDATE inov8_goal_runs SET lifecycle = 'stopped', finished_at = ?, final_proof = ?, stop_reason = ?
        WHERE goal_id = ? AND lifecycle = 'open'`)
        .run(new Date().toISOString(), JSON.stringify(proof), reason, goal.id);
    },
    linkTask,
    linkJob(runId, task, runIdForTask, jobId, at) {
      linkTask(runId, task);
      db.prepare(`INSERT OR IGNORE INTO inov8_goal_run_task_jobs (goal_run_id, task_id, stage, run_id, job_id, started_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(runId, task.id, task.stage, runIdForTask, jobId, at);
    },
    tasks: runId => db.prepare('SELECT * FROM inov8_goal_run_tasks WHERE goal_run_id = ? ORDER BY rowid').all(runId),
    taskJobs: runId => db.prepare('SELECT * FROM inov8_goal_run_task_jobs WHERE goal_run_id = ? ORDER BY rowid').all(runId),
  };
}
