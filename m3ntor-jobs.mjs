import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { readEnvironment } from './environment.mjs';
import { reviewDefinition } from './inov8-review-process.mjs';
import { extraInternalDefinitions } from './internal-flows.mjs';
import { spawn } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const terminal = new Set(['complete', 'failed', 'interrupted']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const jobRoot = path.resolve(process.env.M3NTOR_JOB_DIR || path.join(root, '.m3ntor-runtime', 'jobs'));
const harnessInput = { type: 'string', enum: ['codex', 'claude', 'antigravity'], description: 'Optional: which installed harness runs the job; omit to use the service\'s selection.' };
const assessmentInput = { type: 'object', properties: { context: { type: ['string', 'object'], description: 'Optional existing business assessment context or local source references, as text or structured JSON.' }, harness: harnessInput }, additionalProperties: false };

export const m3ntorTools = [
  {
    name: 'ask_m3ntor',
    description: 'Use when you need coaching on the owner\'s business productivity, or when your work shows a capability worth making a goal: ask M3NT0R. M3NT0R sets the goals (it creates, reorders and sharpens them with set_goal); you work the active goal. Supply a question and the business context it needs, including private details: M3NT0R runs locally on the owner\u2019s subscription and nothing is shared. It can read local files, search the web and the shared utility library, and read the journal; apart from goals it changes nothing, and you carry out what it recommends. Returns output or a running job_id; retrieve that same job with get_m3ntor_result.',
    inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'What you want M3NT0R\'s advice or decision on, in plain business terms.' }, context: { type: ['string', 'object'], description: 'Business context for the coach, including private details, as text or structured JSON.' }, harness: harnessInput }, required: ['question'], additionalProperties: false },
  },
  {
    name: 'assess_poma',
    description: 'Use for the owner\'s first business assessment at setup and for the weekly reassessment task: assess the business\'s Process, Observability, Measurement and triggered Agency. Runs the current assessment prompt from Clarity in the local harness, from local evidence, with category and 1\u201310 ratings and source-supported sales per total human hour, saved through save_poma_reassessment. Returns output or a running job_id; retrieve it with get_m3ntor_result. Does not schedule itself; the weekly run is a set_task task.',
    inputSchema: assessmentInput,
  },
  {
    name: 'reassess_poma',
    description: 'Use only where an existing task or instruction already names it: compatibility alias for assess_poma, running the same assessment with the same saving and results. Prefer assess_poma.',
    inputSchema: assessmentInput,
  },
  {
    name: 'get_m3ntor_result',
    description: 'Use after ask_m3ntor or assess_poma returned a job_id, to get that job\'s output: its status, prompt source and completed output or actual failure. It does not start or retry work. A finished assessment job is not proof it was saved; check the save evidence it returns.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string', description: 'The job_id returned by ask_m3ntor or assess_poma.' } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

export async function storeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export function jobDirectory(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Provide a valid M3NT0R job_id.');
  return path.join(jobRoot, id);
}

const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export async function getM3ntorResult(id) {
  const directory = jobDirectory(id);
  let state;
  try { state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error(`M3NT0R job ${id} was not found.`); throw e; }
  let launch;
  try { launch = JSON.parse(await readFile(path.join(directory, 'launch.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const workerPid = state.worker_pid || launch?.worker_pid;
  const result = { ...state, worker_pid: workerPid, local_only: true };
  if (!terminal.has(state.status) && workerPid && !alive(workerPid)) {
    result.status = 'interrupted';
    result.error = 'The background worker is no longer running and no terminal result was recorded. No retry was started.';
    result.harness_alive = alive(state.harness_pid);
  }
  if (result.status === 'complete') result.output = await readFile(path.join(directory, 'output.txt'), 'utf8');
  return result;
}

export async function askM3ntor(input, environment) {
  if (typeof input.question !== 'string' || !input.question.trim()) throw new Error('A M3NT0R question is required.');
  return createJob(input, environment, {
    identity: 'coaching', question: input.question,
    promptId: 'coach',
  });
}

export async function assessPoma(input, environment) {
  return createJob(input, environment, {
    identity: 'poma_assessment', question: 'Perform an evidence-based assessment of the owner’s business POMA and source-supported productivity. Establish a baseline when no prior assessment exists; otherwise compare business change and current evidence with prior valid findings. Save private dated revisions and a separate non-sensitive coaching summary.',
    promptId: 'poma-assessment',
  });
}
export const reassessPoma = assessPoma;

// A task from the owner's action queue, run in the owner's harness with this MCP.
export async function startTaskJob(task, environment) {
  const constraints = task.constraints ? JSON.parse(task.constraints) : [];
  const priorTasks = Array.isArray(task.prior_tasks) ? task.prior_tasks : [];
  const priorSummary = priorTasks.length
    ? `\n\nPrior tasks in this flow run (oldest to newest — retain and build on this work):\n${priorTasks.map((item, idx) => `${idx + 1}. [${item.task_id}] ${item.title} (${item.status}${item.node_id ? ` · node ${item.node_id}` : ''})${item.checkpoint ? `\n   Checkpoint: ${item.checkpoint}` : ''}${item.last_result ? `\n   Outcome: ${String(item.last_result).trim().slice(0, 1200)}` : ''}`).join('\n')}`
    : '';
  const question = `Task: ${task.instruction}\n\nSuccess means: ${task.success || 'the task above is carried out.'}${constraints.length ? `\n\nConstraints for this task:\n${constraints.map(item => `- ${item}`).join('\n')}` : ''}${task.checkpoint ? `\n\nResumption checkpoint:\n${task.checkpoint}` : ''}${priorSummary}`;
  const rawProcessIds = typeof task.process_ids === 'string' ? JSON.parse(task.process_ids) : task.process_ids || [];
  const processIds = [...new Set([...(task.flow_id ? [task.flow_id] : []), ...rawProcessIds])];
  const internalMap = new Map([reviewDefinition, ...extraInternalDefinitions].map(def => [def.id, def]));
  const needsBusiness = processIds.some(id => !internalMap.has(id));
  const { processes } = needsBusiness ? await readEnvironment(environment.cwd) : { processes: { processes: [] } };
  const snapshots = processIds.map(id => {
    const definition = internalMap.get(id) || processes.processes.find(flow => flow.id === id);
    if (!definition) {
      const error = new Error(`Bound process ${id} was not found. Restore the record or correct this task's flow_id/process_ids before retrying; no harness was started.`);
      error.code = 'PROCESS_NOT_FOUND';
      throw error;
    }
    const contentSha256 = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    return { process_id: id, kind: internalMap.has(id) ? 'internal' : 'business', version: definition.version || contentSha256, content_sha256: contentSha256, updated_at: definition.updated_at || null, definition };
  });
  const triggerInput = typeof task.trigger_input === 'string' ? JSON.parse(task.trigger_input) : task.trigger_input || null;
  const rawHarness = environment.agentHarness || process.env.M3NTOR_HARNESS || environment.harness || 'codex';
  const harness = rawHarness === 'agy' ? 'antigravity' : rawHarness;
  const fullAccess = environment.fullAccess === true;
  const executionEnvironment = {
    harness,
    full_access: fullAccess,
    permission_mode: harness === 'claude'
      ? (fullAccess ? 'bypassPermissions' : 'acceptEdits')
      : harness === 'antigravity'
        ? (fullAccess ? 'dangerously-skip-permissions' : 'accept-edits')
        : (fullAccess ? 'dangerously-bypass-approvals-and-sandbox' : 'workspace-write'),
    network_access: true,
  };
  const context = {
    task_id: task.id, title: task.title, category: task.category, goal_id: task.goal_id || null, stage: task.stage || null,
    flow_id: task.flow_id || null, flow_run_id: task.flow_run_id || null, node_id: task.node_id || null,
    parent_task_id: task.parent_task_id || null, trigger_mode: task.trigger_mode || 'immediate',
    wait_trigger_id: task.wait_trigger_id || null, wait_correlation_id: task.wait_correlation_id || null,
    checkpoint: task.checkpoint || null,
    instruction: task.instruction, requested_outcome: task.success || 'the task above is carried out.',
    trigger_input: triggerInput,
    ...(priorTasks.length ? { prior_tasks: priorTasks } : {}),
    ...(task.flow_run ? { flow_run: { id: task.flow_run.id, flow_id: task.flow_run.flow_id, status: task.flow_run.status, traversed: task.flow_run.traversed, nodes: task.flow_run.nodes } } : {}),
    ...(task.continuation_event ? { continuation_event: task.continuation_event } : {}),
    process_ids: processIds, processes: snapshots, execution_environment: executionEnvironment,
  };
  return createJob({ context, harness: environment.agentHarness }, environment, { identity: 'scheduled_task', question, promptId: null, jobId: task.job_id });
}

// The agent's review of its active goal, run in the owner's harness with the local tools.
export async function startGoalReviewJob({ jobId, question, context, reviewTrace }, environment) {
  return createJob({ context, harness: environment.agentHarness }, environment, { identity: 'goal_review', question, promptId: null, jobId, reviewTrace });
}

// An incoming A2A message for this installation's agent, run in the owner's harness.
export async function startA2AJob(message, environment) {
  const question = `From agent: ${message.from_agent}\nSession: ${message.session_id}\nMessage ID: ${message.id}\n\n${message.message}`;
  return createJob({ context: message.payload && Object.keys(message.payload).length ? message.payload : '' }, environment, { identity: 'a2a_message', question, promptId: null });
}

// The owner's answered questions, newest first (most recent 50), from the workspace's question store.
async function answeredQuestions(cwd) {
  try {
    const state = JSON.parse(await readFile(path.join(cwd, '.clarity_coach', 'user_questions.json'), 'utf8'));
    return (state.questions || []).filter(q => q.status === 'answered' && q.answer)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 50)
      .map(q => ({ question: q.question, answer: q.answer, answered_at: q.updatedAt }));
  } catch { return []; }
}

async function createJob(input, { cwd, harness, mcpUrl, fullAccess = false }, task) {
  const rawSelected = input.harness || process.env.M3NTOR_HARNESS || harness || 'codex';
  const selected = rawSelected === 'agy' ? 'antigravity' : rawSelected;
  if (!['codex', 'claude', 'antigravity'].includes(selected)) throw new Error('Select an existing codex, claude, or antigravity harness.');
  const waitMs = Number(process.env.M3NTOR_WAIT_MS ?? 1500);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('M3NTOR_WAIT_MS must be a non-negative number.');
  const id = task.jobId || randomUUID(); // a caller may persist the id before launch
  const directory = jobDirectory(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // M3NT0R (coaching and assessment) always receives the owner's answers to its questions.
  const ownerAnswers = ['coaching', 'poma_assessment', 'poma_reassessment'].includes(task.identity) ? await answeredQuestions(path.resolve(process.env.M3NTOR_WORKSPACE || cwd)) : [];
  const request = {
    job_id: id, task: task.identity, question: task.question, context: input.context ?? '', harness: selected, owner_answers: ownerAnswers,
    // Coaching jobs get the read-only endpoint of this same service.
    cwd: path.resolve(process.env.M3NTOR_WORKSPACE || cwd), mcp_url: task.identity === 'coaching' ? mcpUrl.replace(/\/mcp\/local$/, '/mcp/coach') : mcpUrl,
    prompt_source: task.promptId ? { prompt_id: task.promptId } : { local: task.identity },
    ...(task.reviewTrace ? { review_trace: task.reviewTrace } : {}),
    // The owner's Full access setting applies only to the owner's own work: tasks and goal reviews.
    full_access: fullAccess === true && ['scheduled_task', 'goal_review'].includes(task.identity),
  };
  await storeJson(path.join(directory, 'request.json'), request);
  const state = { job_id: id, task: task.identity, status: 'queued', created_at: new Date().toISOString(), harness: selected, prompt_source: request.prompt_source };
  await storeJson(path.join(directory, 'state.json'), state);
  const log = await open(path.join(directory, 'worker.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(root, 'm3ntor-worker.mjs'), directory], {
      cwd: root, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await storeJson(path.join(directory, 'launch.json'), { worker_pid: child.pid, launched_at: new Date().toISOString() });
    child.unref();
  } catch (e) {
    await storeJson(path.join(directory, 'state.json'), { ...state, status: 'failed', finished_at: new Date().toISOString(), error: `Background worker launch failed: ${e.message}`, code: e.code });
  } finally { await log.close(); }
  const deadline = Date.now() + waitMs;
  let result = await getM3ntorResult(id);
  while (!terminal.has(result.status) && Date.now() < deadline) {
    await sleep(Math.min(100, deadline - Date.now()));
    result = await getM3ntorResult(id);
  }
  return result;
}
