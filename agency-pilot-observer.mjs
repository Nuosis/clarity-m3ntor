import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// USER-AUTHORIZED — Marcus, November 20, 2026: only the next original customer
// case of this pilot, SAME local inov8 task, M-Codex delivery, D5 implementation.
// No synthetic/owner input, historical substitution, inbox claim or new auth route.
export const AGENCY_PILOT_TASK = 'bf145c4b-d440-4aeb-bd35-d0c9af1e1127';
export const pilotDirectory = cwd => path.join(cwd, '.clarity_coach', 'infrastructure', 'customer-request-delivery', 'AGENCY-PILOT-01');
export const pilotPendingFile = cwd => path.join(pilotDirectory(cwd), 'SOURCE-PENDING.json');
export async function readPilotPending(cwd) {
  try { return JSON.parse(await readFile(pilotPendingFile(cwd), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function store(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export async function startAgencyPilotObserver({ cwd, resume = false }) {
  const directory = pilotDirectory(cwd);
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(path.join(directory, 'CASE.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'not_configured', stop() {} }; throw error; }
  if (checkpoint.pilot !== 'AGENCY-PILOT-01' || checkpoint.task_id !== AGENCY_PILOT_TASK) throw new Error('Agency pilot checkpoint/task mismatch; checkpoint retained.');
  if (checkpoint.case) return { state: 'case_already_selected', stop() {} };
  const file = pilotPendingFile(cwd);
  const state = await readPilotPending(cwd) || {
    pilot: checkpoint.pilot, task_id: AGENCY_PILOT_TASK, draft_status: 'unknown',
    case_checkpoint: path.join(directory, 'CASE.json'),
    original_cursor: checkpoint.coverage?.latest_email_cursor ?? null,
    permission: checkpoint.permission, notifications: {}, events: {},
  };
  // A failed SSH/read is retained, never placed in an unchanged reconnect loop.
  if (state.state === 'stopped_error' && !resume) return { state: state.state, stop() {} };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, 'SOURCE-OBSERVER.lock');
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(lockFile, 'utf8'));
    try { process.kill(owner.pid, 0); return { state: 'already_running', pid: owner.pid, stop() {} }; }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    await unlink(lockFile);
    lock = await open(lockFile, 'wx', 0o600);
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  let child, caseWatcher, stopped = false, writes = Promise.resolve();
  const persist = () => store(file, { ...state, updated_at: new Date().toISOString() });
  const serial = action => { const next = writes.then(action); writes = next.catch(() => {}); return next; };
  async function finish(error = null, finalState = 'stopped') {
    if (stopped) return;
    stopped = true;
    caseWatcher?.close(); child?.stdin.end(); child?.kill('SIGTERM');
    await serial(async () => { state.state = error ? 'stopped_error' : finalState; state.last_error = error; await persist(); });
    await unlink(lockFile);
  }
  try {
    state.state = 'connecting'; state.last_error = null; await persist();
    caseWatcher = watch(directory, (_event, filename) => {
      if (String(filename) !== 'CASE.json') return;
      readFile(path.join(directory, 'CASE.json'), 'utf8').then(text => {
        if (JSON.parse(text).case) return finish(null, 'case_selected');
      }).catch(() => { finish('CASE checkpoint could not be read; pending retained.').catch(console.error); });
    });
    const source = await readFile(new URL('./agency-pilot-source.py', import.meta.url));
    const bootstrap = `import base64;exec(compile(base64.b64decode("${source.toString('base64')}"),"agency-pilot-source.py","exec"))`;
    child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=2', 'claire', `docker exec -i claire-api-1 python -u -c '${bootstrap}'`], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Do not save remote stderr: an upstream driver error could contain a DSN.
    let stderrPresent = false;
    child.stderr.on('data', () => { stderrPresent = true; });
    child.stdin.on('error', () => { finish('Observer input connection closed.').catch(console.error); });
    child.on('error', error => { finish(`SSH observer could not start (${error.code || 'spawn error'}).`).catch(console.error); });
    child.on('close', (code, signal) => { if (!stopped) finish(`SSH observer ended (exit ${code}, signal ${signal || 'none'}, stderr ${stderrPresent ? 'present; not retained' : 'empty'}).`).catch(console.error); });
    const lines = createInterface({ input: child.stdout });
    const fetchNotification = id => child.stdin.write(JSON.stringify({ message_id: id }) + '\n');
    (async () => {
      try {
        for await (const line of lines) {
          if (stopped) break;
          const event = JSON.parse(line);
          await serial(async () => {
            if (event.type === 'ready') {
              state.state = 'waiting_for_original_source'; state.connected_at = new Date().toISOString(); await persist();
              // Reconcile only exact IDs durably received before a disconnect.
              for (const [id, notification] of Object.entries(state.notifications)) if (notification.state === 'notified') fetchNotification(id);
            } else if (event.type === 'notification') {
              if (state.notifications[event.message_id]?.state === 'resolved') return;
              state.notifications[event.message_id] = { state: 'notified', received_at: new Date().toISOString() };
              await persist(); fetchNotification(event.message_id);
            } else if (event.type === 'handoff' || event.type === 'unrelated') {
              if (!state.notifications[event.message_id]) throw new Error('Unnotified handoff rejected; no mailbox scan is allowed.');
              if (event.type === 'handoff') {
                const id = event.source.id;
                // Eligibility is the SAME task's decision from original evidence;
                // observing an intake or a draft does not select/activate a case.
                state.events[id] ??= { ...event, received_at: state.notifications[event.message_id].received_at, eligibility: 'pending_same_task_decision' };
              }
              state.notifications[event.message_id].state = 'resolved';
              await persist();
            } else throw new Error('Unknown observer protocol event.');
          });
        }
      } catch (error) { await finish(`Observer stopped while retaining pending correlation (${error.name}).`); }
    })();
    return { state: 'connecting', stop: () => finish() };
  } catch (error) { await finish(`Observer setup failed (${error.code || error.name}).`); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const observer = await startAgencyPilotObserver({ cwd: path.resolve(process.env.M3NTOR_WORKSPACE || process.env.HOME), resume: process.argv.includes('--resume') });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { observer.stop().catch(console.error); });
}
