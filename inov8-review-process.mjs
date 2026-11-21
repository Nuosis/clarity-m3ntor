import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getM3ntorResult, jobDirectory, jobRoot } from './m3ntor-jobs.mjs';

export const REVIEW_PROCESS_ID = 'inov8-goal-review';
export const reviewHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const NODE_TYPES = {
  trigger: { label: 'Trigger', definition: 'Entry event that can initiate a flow run.' },
  decision: { label: 'Decision', definition: 'Evaluates conditions and routes the run along one branch.' },
  operation: { label: 'Operation', definition: 'Deterministic service step that reads or updates local records.' },
  agent: { label: 'Agentic', definition: 'LLM-driven step that reasons over context and acts through tools.' },
  process: { label: 'Process', definition: 'Invokes or depends on another process flow (documented or undocumented).' },
  terminal: { label: 'Terminal', definition: 'End state that terminates the run with a recorded disposition.' },
};

const nodes = [
  { id: 'trigger-clock', type: 'trigger', label: 'Automatic cadence', binding: 'considerReview · armClock', configuration: 'cadence', detail: 'Hourly and daily reviews use the clock. On change reviews wait for the current stage’s tasks to settle.', column: 0.5, row: 0 },
  { id: 'trigger-manual', type: 'trigger', label: 'Manual Run', binding: 'runReview', detail: 'An explicit Run can start a review while automatic reviews are paused. It requires an active goal and no overlapping review.', column: 1.5, row: 0 },
  { id: 'trigger-answer', type: 'trigger', label: 'Owner answer', binding: 'questionsSettled', detail: 'An answer or dismissal can start a review when no owner questions remain pending, the worker is enabled and no review overlaps.', column: 2.5, row: 0 },
  { id: 'trigger-recovery', type: 'trigger', label: 'Recovery return', binding: 'startStuckReview · followConsult · resumeStuck', detail: 'An unsettled stage or a consultation return can reach stuck-mode review. A healthy continuation can settle the wait.', column: 3.5, row: 0 },
  { id: 'eligibility', type: 'decision', label: 'Review eligible?', binding: 'Review entry functions', detail: 'Automatic review considers the worker, active goal, overlap, owner wait, meaningful change and cadence. Manual, answer and recovery paths apply their own conditions.', column: 2, row: 1 },
  { id: 'skip', type: 'terminal', label: 'Skip review', binding: 'Review entry functions', detail: 'Terminal outcome: an ineligible trigger ends the run with a recorded skip decision and no harness job.', column: 0.5, row: 1 },
  { id: 'context', type: 'operation', label: 'Build context', binding: 'startReview', detail: 'Build the review input from the goal and stage, previous conclusions, changed tasks, owner direction, process references and continuations.', column: 2, row: 2 },
  { id: 'agent', type: 'agent', label: 'Agent review', binding: 'startGoalReviewJob · m3ntor-worker', configuration: 'agent', detail: 'Agentic harness run: reviews the active goal’s current stage (in the undocumented goal-implementation lifecycle), recent changes, owner direction, tasks and continuations, then acts through MCP tools to queue/update tasks, ask the owner, advance the stage or trigger recovery. Tool activity shown here comes from its saved event stream.', column: 2, row: 3 },
  { id: 'settlement', type: 'operation', label: 'Consume result', binding: 'followReview · settleReview', detail: 'Save the review result and inspect the actual goal, task, question and continuation records for its disposition.', column: 2, row: 4 },
  { id: 'work-underway', type: 'terminal', label: 'Work underway', binding: 'judgeStuck · reviewWork', detail: 'Terminal outcome: the run ends because the stage has a task queued, running or finalizing.', column: 0, row: 5 },
  { id: 'healthy-wait', type: 'terminal', label: 'Healthy wait', binding: 'judgeStuck · reviewWork', detail: 'Terminal outcome: the run ends because a registered continuation is waiting with an accountable owner, checkpoint and return route.', column: 1, row: 5 },
  { id: 'stage-changed', type: 'terminal', label: 'Stage changed', binding: 'followReview', detail: 'Terminal outcome: the run ends because the active goal or its current stage changed during review.', column: 2, row: 5 },
  { id: 'owner-wait', type: 'terminal', label: 'Owner wait', binding: 'judgeStuck · askOwnerStuck', detail: 'Terminal outcome: the run ends because an owner question is pending.', column: 3, row: 5 },
  { id: 'recovery', type: 'terminal', label: 'Recovery', binding: 'judgeStuck · followConsult', detail: 'Terminal outcome: the run ends in recovery or awaiting a consultation return.', column: 4, row: 5 },
];
export const reviewEdge = (from, to) => from + '--' + to;
const edges = [
  ...nodes.filter(node => node.type === 'trigger').map(node => [node.id, 'eligibility']),
  ['eligibility', 'skip', 'Skip'], ['eligibility', 'context', 'Proceed'],
  ['context', 'agent'], ['agent', 'settlement'],
  ...nodes.filter(node => node.type === 'terminal' && node.id !== 'skip').map(node => ['settlement', node.id]),
].map(([from, to, label]) => ({ id: reviewEdge(from, to), from, to, label }));
const definition = { id: REVIEW_PROCESS_ID, name: 'inov8 goal review', kind: 'internal', definition_version: 2, node_types: NODE_TYPES, nodes, edges };
export const reviewDefinition = { ...definition, version: reviewHash(definition) };

export function createReviewLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_review_traces (
      id TEXT PRIMARY KEY, job_id TEXT UNIQUE, source TEXT NOT NULL, correlation TEXT,
      decision TEXT NOT NULL, reason TEXT NOT NULL, skip_key TEXT,
      goal_id TEXT, stage TEXT, created_at TEXT NOT NULL, finished_at TEXT,
      definition TEXT NOT NULL, configuration TEXT NOT NULL, version TEXT NOT NULL,
      configuration_version TEXT NOT NULL, evidence TEXT NOT NULL, traversed TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS goal_review_trace_source ON goal_review_traces (source, created_at);
  `);
  const get = id => db.prepare('SELECT * FROM goal_review_traces WHERE id = ?').get(id);
  const latestKey = source => db.prepare('SELECT skip_key FROM goal_review_traces WHERE source = ? ORDER BY rowid DESC LIMIT 1').get(source)?.skip_key;
  const summary = row => ({
    id: row.id, process_id: REVIEW_PROCESS_ID, job_id: row.job_id, source: row.source, decision: row.decision, reason: row.reason,
    created_at: row.created_at, finished_at: row.finished_at, version: row.version, configuration_version: row.configuration_version,
  });
  return {
    record({ jobId = null, origin, decision, reason, goal, stage, config, semantic }) {
      const configVersion = reviewHash(config);
      const correlation = origin.correlation || null;
      const skipKey = decision === 'skipped' && semantic ? reviewHash([reason, correlation, goal?.id, stage, configVersion, semantic]) : null;
      if (skipKey && skipKey === latestKey(origin.source)) return null;
      const id = jobId || randomUUID();
      const at = new Date().toISOString();
      const trigger = 'trigger-' + origin.source;
      const input = { correlation, goal_id: goal?.id || null, stage: stage || null };
      const evidence = {
        [trigger]: { status: 'completed', started_at: at, finished_at: at, input },
        eligibility: { status: decision === 'skipped' ? 'skipped' : 'completed', started_at: at, finished_at: at, reason, input },
        ...(decision === 'skipped' ? { skip: { status: 'skipped', finished_at: at, reason } } : {}),
      };
      const traversed = [reviewEdge(trigger, 'eligibility'), ...(decision === 'skipped' ? [reviewEdge('eligibility', 'skip')] : [])];
      db.prepare(`INSERT INTO goal_review_traces (id, job_id, source, correlation, decision, reason, skip_key, goal_id, stage, created_at, finished_at,
        definition, configuration, version, configuration_version, evidence, traversed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, jobId, origin.source, JSON.stringify(correlation), decision, reason, skipKey, input.goal_id, input.stage, at,
          decision === 'skipped' ? at : null, JSON.stringify(reviewDefinition), JSON.stringify(config), reviewDefinition.version,
          configVersion, JSON.stringify(evidence), JSON.stringify(traversed));
      return id;
    },
    node(id, nodeId, evidence, { from, finished = false } = {}) {
      const row = get(id);
      if (!row) return;
      const nodes = JSON.parse(row.evidence);
      const traversed = new Set(JSON.parse(row.traversed));
      nodes[nodeId] = { ...nodes[nodeId], ...evidence };
      if (from) traversed.add(reviewEdge(from, nodeId));
      db.prepare('UPDATE goal_review_traces SET evidence = ?, traversed = ?, finished_at = ? WHERE id = ?')
        .run(JSON.stringify(nodes), JSON.stringify([...traversed]), finished ? new Date().toISOString() : row.finished_at, id);
    },
    list() { return db.prepare('SELECT id, job_id, source, decision, reason, created_at, finished_at, version, configuration_version FROM goal_review_traces ORDER BY rowid DESC').all().map(summary); },
    detail(id) {
      const row = get(id);
      return row && { ...summary(row), correlation: JSON.parse(row.correlation), goal_id: row.goal_id, stage: row.stage,
        definition: JSON.parse(row.definition), configuration: JSON.parse(row.configuration), nodes: JSON.parse(row.evidence), traversed: JSON.parse(row.traversed) };
    },
  };
}

async function jsonFile(directory, name) {
  try { return JSON.parse(await readFile(path.join(directory, name), 'utf8')); } catch { return null; }
}

export async function historicReviewList(knownIds) {
  const names = await readdir(jobRoot).catch(() => []);
  const history = await Promise.all(names.filter(id => !knownIds.has(id)).map(async id => {
    try {
      const state = await jsonFile(jobDirectory(id), 'state.json');
      if (state?.task !== 'goal_review') return null;
      return { id, job_id: id, source: null, decision: null, version: null, status: state.status,
        created_at: state.created_at || state.started_at, finished_at: state.finished_at || null, historical: true };
    } catch { return null; }
  }));
  return history.filter(Boolean);
}

async function reviewToolActivity(directory) {
  const stdout = await readFile(path.join(directory, 'harness.stdout.jsonl'), 'utf8').catch(() => '');
  const starts = new Map(), operations = new Map(), tools = [];
  for (const [index, raw] of stdout.split('\n').entries()) {
    if (!raw.trim()) continue;
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    const line = index + 1;
    const item = event.item;
    if (event.type === 'item.started' && item?.id) starts.set(item.id, line);
    if (event.type === 'item.completed' && ['mcp_tool_call', 'command_execution', 'web_search', 'file_change'].includes(item?.type)) {
      const command = item.type === 'command_execution';
      const label = item.type === 'mcp_tool_call' ? item.tool : command ? (/\brg\s/.test(item.command || '') ? 'Shell · rg' : 'Shell command')
        : item.type === 'web_search' ? 'Web search' : 'File change';
      tools.push({ label, server: item.server, kind: item.type, status: item.status || 'completed', exit_code: item.exit_code,
        start_line: starts.get(item.id), result_line: line });
    }
    if (event.type === 'assistant' || event.type === 'user') {
      for (const part of event.message?.content || []) {
        if (part.type === 'tool_use' && part.id) operations.set(part.id, { label: part.name, line });
        if (part.type === 'tool_result') {
          const operation = operations.get(part.tool_use_id);
          tools.push({ label: operation?.label || 'Tool result', kind: 'tool_result', status: part.is_error ? 'failed' : 'completed',
            start_line: operation?.line, result_line: line });
        }
      }
    }
  }
  return tools;
}

export async function reviewRunDetail(id, recorded) {
  if (recorded && !recorded.job_id) return recorded;
  const directory = jobDirectory(id);
  const [request, state] = await Promise.all([jsonFile(directory, 'request.json'), jsonFile(directory, 'state.json')]);
  if (!recorded && state?.task !== 'goal_review' && request?.task !== 'goal_review') return null;
  const result = recorded ?? { id, process_id: REVIEW_PROCESS_ID, job_id: id, source: null, decision: null, correlation: null,
    version: null, configuration_version: null, definition: null, configuration: null, historical: true,
    goal_id: request?.context?.goal_id || null, created_at: state?.created_at || state?.started_at || null,
    finished_at: state?.finished_at || null, nodes: {}, traversed: [] };
  if (!state && !request) return result;
  const [command, tools, job] = await Promise.all([
    jsonFile(directory, 'command.json'), reviewToolActivity(directory), getM3ntorResult(id).catch(() => state),
  ]);
  const recordedAgent = result.nodes.agent;
  const startedAt = state?.harness_pid && state.harness_started_at || null;
  const failed = ['failed', 'interrupted'].includes(job?.status);
  const completed = job?.status === 'complete' && startedAt;
  const agentStatus = failed ? 'failed' : completed ? 'completed' : startedAt ? 'started' : recordedAgent?.status || null;
  const agent = {
    status: agentStatus, queued_at: state?.created_at, worker_started_at: state?.started_at, started_at: startedAt,
    finished_at: state?.finished_at || recordedAgent?.finished_at || null, error: job?.error || recordedAgent?.error, harness: request?.harness || state?.harness,
    full_access: request?.full_access, model: command?.model, tools,
    input_ref: request ? 'request.json · context' : null, command_ref: command ? 'command.json' : null,
    output_ref: completed && typeof job.output === 'string' ? 'output.txt' : null, tool_ref: tools.length ? 'harness.stdout.jsonl' : null,
  };
  result.status = job?.status;
  result.nodes.agent = { ...recordedAgent, ...agent };
  if (request && result.nodes.context) result.nodes.context.output_ref = 'request.json · context';
  if (!result.historical && agentStatus && result.nodes.context?.status === 'completed') {
    result.traversed = [...new Set([...result.traversed, reviewEdge('context', 'agent')])];
  }
  return result;
}
