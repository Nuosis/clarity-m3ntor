import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const terminal = new Set(['complete', 'failed', 'interrupted']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const jobRoot = path.resolve(process.env.M3NTOR_JOB_DIR || path.join(root, '.m3ntor-runtime', 'jobs'));
const assessmentInput = { type: 'object', properties: { context: { description: 'Optional existing business assessment context or local source references, as text or structured JSON.' }, harness: { type: 'string', enum: ['codex', 'claude'], description: 'Optional existing harness; otherwise uses the service or assessment selection.' } }, additionalProperties: false };

export const m3ntorTools = [
  {
    name: 'ask_m3ntor',
    description: 'Ask M3NT0R to coach your local AI on the owner’s business productivity. Supply a question and non-sensitive business-linked POMA context. Fetches the current mentor prompt from Clarity and starts the selected existing local harness. Returns output or a running job_id; retrieve that same job with get_m3ntor_result.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, context: { description: 'Non-sensitive context for the coach, as text or structured JSON.' }, harness: { type: 'string', enum: ['codex', 'claude'], description: 'Optional existing harness; otherwise uses the service or assessment selection.' } }, required: ['question'], additionalProperties: false },
  },
  {
    name: 'assess_poma',
    description: 'Assess the owner’s BUSINESS Process, Observability, Measurement and triggered Agency. Fetches the current unified assessment prompt from Clarity for both baseline and later/weekly assessments, and runs the existing local harness. Uses local evidence, independent category/1–10 ratings, source-supported sales per TOTAL human hour, stable revision identity and existing private save/result tools. No question required; returns output or a running job_id. Does not install a scheduler.',
    inputSchema: assessmentInput,
  },
  {
    name: 'reassess_poma',
    description: 'Compatibility alias for assess_poma: uses the SAME current unified business assessment prompt, local harness, private save and result mechanics. No separate reassessment prompt or question required.',
    inputSchema: assessmentInput,
  },
  {
    name: 'get_m3ntor_result',
    description: 'Retrieve an existing coaching or business-POMA reassessment job, its task identity, prompt provenance and completed output or actual failure. Does not launch or retry work. Harness completion alone does not prove local assessment saving; use the returned save evidence and local artifact readback.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
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

async function createJob(input, { cwd, harness, mcpUrl }, task) {
  const selected = input.harness || process.env.M3NTOR_HARNESS || harness || 'codex';
  if (!['codex', 'claude'].includes(selected)) throw new Error('Select an existing codex or claude harness.');
  const waitMs = Number(process.env.M3NTOR_WAIT_MS ?? 1500);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('M3NTOR_WAIT_MS must be a non-negative number.');
  const id = randomUUID();
  const directory = jobDirectory(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const request = {
    job_id: id, task: task.identity, question: task.question, context: input.context ?? '', harness: selected,
    cwd: path.resolve(process.env.M3NTOR_WORKSPACE || cwd), mcp_url: mcpUrl,
    prompt_source: { prompt_id: task.promptId },
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
