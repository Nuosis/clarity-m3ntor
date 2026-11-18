// The working environment's records: what the agent runs on (sources), what is on the
// owner's plate, and how the business does its work (processes). The service checks each
// stage's done-check against these records; the agent writes them through the MCP tools.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DAY = 86400000;
export const HOMES = ['todos', 'flows', 'failures'];
const HOME_NAMES = { todos: 'business to-dos', flows: 'documented flows', failures: 'where failures reach the owner' };
const files = cwd => {
  const dir = path.join(cwd, '.clarity_coach', 'environment');
  return { dir, sources: path.join(dir, 'sources.json'), plate: path.join(dir, 'plate.json'), processes: path.join(dir, 'processes.json') };
};
async function load(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } }
async function save(cwd, file, value) {
  await mkdir(files(cwd).dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
  return value;
}
// Read-modify-write of these records happens one at a time.
let writes = Promise.resolve();
const serial = action => { const next = writes.catch(() => {}).then(action); writes = next.catch(() => {}); return next; };
const now = () => new Date().toISOString();
const recent = (at, days) => at && Date.now() - new Date(at).getTime() <= days * DAY;

export async function readEnvironment(cwd) {
  const f = files(cwd);
  return { sources: await load(f.sources, { sources: [] }), plate: await load(f.plate, { commitments: [], priorities: [], updated_at: null }), processes: await load(f.processes, { processes: [] }) };
}

// Seed the source list once from the assessment's "Information centres" table in CONTEXT.md.
// Whether each source is needed is left undecided for the agent to set.
export function seedSources(cwd) { return serial(() => seedSourcesNow(cwd)); }
async function seedSourcesNow(cwd) {
  const f = files(cwd);
  const existing = await load(f.sources, null);
  if (existing?.sources?.length) return existing;
  let context = '';
  try { context = await readFile(path.join(cwd, '.clarity_coach', 'CONTEXT.md'), 'utf8'); } catch {}
  const start = context.indexOf('## Information centres');
  if (start < 0) return existing || { sources: [] };
  const rows = context.slice(start).split('\n').slice(1).filter(line => line.startsWith('|')).slice(2);
  const sources = [];
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 4 || !cells[0]) continue;
    sources.push({ id: randomUUID(), name: cells[0], purpose: cells[1], route: cells[2], assessment_note: cells[3], needed: null, read_back: null });
  }
  return save(cwd, f.sources, { sources, seeded_from: 'CONTEXT.md Information centres', seeded_at: now() });
}

export function recordSource(cwd, input) { return serial(() => recordSourceNow(cwd, input)); }
async function recordSourceNow(cwd, input) {
  const f = files(cwd);
  const record = await load(f.sources, { sources: [] });
  let source = input.source_id ? record.sources.find(item => item.id === input.source_id) : null;
  if (input.source_id && !source) throw new Error('Source not found.');
  if (!source) {
    if (!input.name?.trim()) throw new Error('Give the new source a name.');
    source = { id: randomUUID(), name: input.name.trim(), needed: null, read_back: null };
    record.sources.push(source);
  }
  for (const key of ['name', 'purpose', 'route', 'account']) if (input[key] !== undefined) source[key] = input[key];
  if (input.needed !== undefined) { source.needed = input.needed; source.needed_reason = input.needed_reason || source.needed_reason || null; }
  // A source can be the business's home for its to-dos, its documented flows, or where failures reach the owner.
  if (input.home_for !== undefined) {
    if (!Array.isArray(input.home_for) || input.home_for.some(item => !HOMES.includes(item))) throw new Error(`home_for lists any of: ${HOMES.join(', ')}.`);
    source.home_for = input.home_for;
  }
  if (input.notice_test) source.notice_test = { ok: input.notice_test.ok === true, what: input.notice_test.what || '', at: now() };
  // The service stamps the read-back time; an agent cannot backdate one.
  if (input.read_back) source.read_back = { ok: input.read_back.ok === true, what: input.read_back.what || '', at: now() };
  return save(cwd, f.sources, record);
}

export function setPlate(cwd, input) { return serial(() => setPlateNow(cwd, input)); }
async function setPlateNow(cwd, input) {
  if (!Array.isArray(input.commitments)) throw new Error('Give the full list of commitments.');
  for (const item of input.commitments) if (!item.what || !item.to_whom || !item.status) throw new Error('Each commitment needs what, to_whom and status.');
  const previous = await load(files(cwd).plate, {});
  const surfaced = [...(previous.failures_surfaced || []), ...(input.failures_surfaced || []).map(item => ({ ...item, recorded_at: now() }))];
  return save(cwd, files(cwd).plate, { commitments: input.commitments, priorities: input.priorities || [], routine_task_id: input.routine_task_id || null, failures_surfaced: surfaced, updated_at: now() });
}

export function recordProcess(cwd, input) { return serial(() => recordProcessNow(cwd, input)); }
async function recordProcessNow(cwd, input) {
  const f = files(cwd);
  const record = await load(f.processes, { processes: [] });
  let flow = input.process_id ? record.processes.find(item => item.id === input.process_id) : null;
  if (input.process_id && !flow) throw new Error('Process not found.');
  if (!flow) { if (!input.name?.trim()) throw new Error('Give the process a name.'); flow = { id: randomUUID(), name: input.name.trim() }; record.processes.push(flow); }
  for (const key of ['name', 'trigger', 'steps', 'handoffs', 'completion', 'signals', 'failure_conditions', 'documented_at', 'examples']) if (input[key] !== undefined) flow[key] = input[key];
  flow.updated_at = now();
  return save(cwd, f.processes, record);
}

// Done-checks the service applies; each returns null when met, otherwise what is missing.
export async function environmentCheck(cwd, stageKey) {
  const { sources, plate, processes } = await readEnvironment(cwd);
  if (stageKey === 'infrastructure') {
    if (!sources.sources.length) return 'No sources are recorded.';
    const undecided = sources.sources.filter(item => item.needed === null || item.needed === undefined);
    if (undecided.length) return `Decide whether these sources are needed: ${undecided.map(item => item.name).join(', ')}.`;
    const needed = sources.sources.filter(item => item.needed);
    if (!needed.length) return 'No source is marked needed.';
    const missing = needed.filter(item => !(item.read_back?.ok && recent(item.read_back.at, 7)));
    if (missing.length) return `These needed sources have no successful read-back in the last 7 days: ${missing.map(item => item.name).join(', ')}.`;
    const homeless = HOMES.filter(home => !needed.some(item => item.home_for?.includes(home)));
    if (homeless.length) return `Record which needed source is the home for: ${homeless.map(home => HOME_NAMES[home]).join('; ')}. If none exists, ask the owner where to keep it.`;
    const channels = needed.filter(item => item.home_for?.includes('failures'));
    if (!channels.some(item => item.notice_test?.ok && recent(item.notice_test.at, 7))) return 'Send a test notice to the owner through the failure channel and record its delivery (record_source notice_test).';
    return null;
  }
  if (stageKey === 'observability') {
    if (!recent(plate.updated_at, 7)) return 'The plate has not been updated in the last 7 days.';
    if (!plate.commitments.length) return 'The plate lists no commitments.';
    const unplaced = plate.commitments.filter(item => !item.sources?.length || !item.process || !item.step);
    if (unplaced.length) return `These items need their process, step and source links: ${unplaced.map(item => item.what).join('; ')}.`;
    if (!plate.routine_task_id) return 'The list was not refreshed by a recurring routine task.';
    if (!plate.failures_surfaced?.some(item => item.receipt)) return 'The routine has not yet sent a failure (real or test) to the owner through the failure channel with a delivery receipt.';
    return null;
  }
  if (stageKey === 'process') {
    if (!processes.processes.length) return 'No processes are recorded.';
    const incomplete = processes.processes.filter(item => !item.trigger || !item.steps?.length || !item.completion || !item.examples?.length || !item.signals?.length || !item.failure_conditions?.length);
    return incomplete.length ? `These processes need a trigger, steps, completion, step signals, failure conditions and at least one example: ${incomplete.map(item => item.name).join(', ')}.` : null;
  }
  return null;
}

const ref = { type: 'object', properties: { ref: { type: 'string', description: 'Where it is: message, agreement, record or file reference.' }, date: { type: 'string' } }, required: ['ref'], additionalProperties: false };
export const environmentTools = [
  { name: 'read_environment', description: 'The working environment records: sources the agent runs on (with whether each is needed and its last read-back), the owner\'s plate (commitments and priorities) and the business processes.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'record_source', description: 'Add or update a source in the working environment: its route and account, whether it is needed (with the reason), and a read-back you just performed (ok and what was read). The service stamps the read-back time.', inputSchema: { type: 'object', properties: { source_id: { type: 'string' }, name: { type: 'string' }, purpose: { type: 'string' }, route: { type: 'string' }, account: { type: 'string' }, needed: { type: 'boolean' }, needed_reason: { type: 'string' }, home_for: { type: 'array', items: { type: 'string', enum: ['todos', 'flows', 'failures'] }, description: 'This source is where the business keeps its to-dos, documents its flows, or where failures reach the owner.' }, notice_test: { type: 'object', description: 'For the failure channel: a test notice you just sent to the owner and its delivery read-back.', properties: { ok: { type: 'boolean' }, what: { type: 'string' } }, required: ['ok', 'what'], additionalProperties: false }, read_back: { type: 'object', properties: { ok: { type: 'boolean' }, what: { type: 'string', description: 'What was read, e.g. "5 most recent inbox messages, newest dated 2026-11-17".' } }, required: ['ok', 'what'], additionalProperties: false } }, additionalProperties: false } },
  { name: 'set_plate', description: 'Replace the commitments list: each piece of current work placed at its process step (what, for whom, due, status, process, step, source links), and the owner\'s priorities. Called by the recurring routine task that refreshes it, giving its routine_task_id. The service stamps the update time.', inputSchema: { type: 'object', properties: { commitments: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, to_whom: { type: 'string' }, due: { type: 'string' }, status: { type: 'string' }, process: { type: 'string', description: 'Name of the recorded process.' }, step: { type: 'string' }, sources: { type: 'array', items: ref } }, required: ['what', 'to_whom', 'status'], additionalProperties: false } }, priorities: { type: 'array', items: { type: 'string' } }, failures_surfaced: { type: 'array', description: 'Failures this run sent to the owner (each once, until resolved or changed).', items: { type: 'object', properties: { what: { type: 'string' }, process: { type: 'string' }, step: { type: 'string' }, since: { type: 'string' }, channel: { type: 'string' }, receipt: { type: 'string', description: 'Delivery read-back.' } }, required: ['what', 'channel', 'receipt'], additionalProperties: false } }, routine_task_id: { type: 'string', description: 'The recurring task that ran this refresh.' } }, required: ['commitments'], additionalProperties: false } },
  { name: 'record_process', description: 'Add or update one business process: trigger, steps, handoffs, completion, the signal that shows each step happened and where it appears, and past examples.', inputSchema: { type: 'object', properties: { process_id: { type: 'string' }, name: { type: 'string' }, trigger: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, handoffs: { type: 'array', items: { type: 'string' } }, completion: { type: 'string' }, failure_conditions: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, condition: { type: 'string', description: 'The expected signal that has not appeared, e.g. "no customer reply".' }, after: { type: 'string', description: 'How long before it counts as failed, e.g. "5 business days".' } }, required: ['step', 'condition', 'after'], additionalProperties: false } }, documented_at: { type: 'string', description: 'Link to where the business documents this flow, when it does.' }, signals: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, signal: { type: 'string', description: 'What shows this step happened, e.g. "quote email sent to the customer".' }, source: { type: 'string', description: 'The source it appears in.' } }, required: ['step', 'signal', 'source'], additionalProperties: false } }, examples: { type: 'array', items: ref } }, additionalProperties: false } },
];
