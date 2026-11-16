import { readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { storeJson } from './m3ntor-jobs.mjs';

// This worker is detached from the HTTP server. It owns one job and never retries it.
process.umask(0o077);
const directory = process.argv[2];
let state;
const save = async patch => {
  state = { ...state, ...patch, updated_at: new Date().toISOString() };
  await storeJson(path.join(directory, 'state.json'), state);
};
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";

async function fetchPrompt(source) {
  let stdout = '';
  let stderr = '';
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '--', source.ssh_host, 'sh', '-s'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdin.on('error', () => {}); // The close/spawn result owns an early SSH failure.
  child.stdin.end(`cat -- ${quote(source.path)}\n`);
  const outcome = await result;
  await writeFile(path.join(directory, 'prompt-fetch.stderr.log'), stderr, { mode: 0o600 });
  await writeFile(path.join(directory, 'fetched-prompt.md'), stdout, { mode: 0o600 });
  await save({ prompt_fetch_exit_code: outcome.code, prompt_fetch_signal: outcome.signal });
  if (outcome.code !== 0) throw new Error(`Prompt fetch failed (${outcome.code ?? outcome.signal}): ${stderr.trim()}`);
  if (!stdout.trim()) throw new Error('The server M3NT0R prompt was empty.');
  return stdout;
}

async function runHarness(request, prompt) {
  const outputFile = path.join(directory, 'output.txt');
  const args = request.harness === 'codex'
    ? ['-c', `mcp_servers.clarity_m3ntor.url=${JSON.stringify(request.mcp_url)}`, 'exec', '--json', '--skip-git-repo-check', '-o', outputFile, '-']
    : ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--mcp-config', JSON.stringify({ mcpServers: { clarity_m3ntor: { type: 'http', url: request.mcp_url } } })];
  const context = typeof request.context === 'string' ? request.context : JSON.stringify(request.context, null, 2);
  const input = `${prompt}\n\n## Current coaching request\n\n${request.question}\n\n## Supplied context\n\n${context}\n`;
  await writeFile(path.join(directory, 'harness-input.md'), input, { mode: 0o600 });
  await storeJson(path.join(directory, 'command.json'), { command: request.harness, args, cwd: request.cwd, model: 'Inherited from the existing harness configuration', authentication: 'Inherited; no credential or account override' });
  const stdoutLog = createWriteStream(path.join(directory, 'harness.stdout.jsonl'), { mode: 0o600 });
  const stderrLog = createWriteStream(path.join(directory, 'harness.stderr.log'), { mode: 0o600 });
  const child = spawn(request.harness, args, { cwd: request.cwd, env: process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let buffer = '', stderr = '', output = '', harnessError = '', stoppedFor = '', spawnError;
  let killTimer;
  const stopWaste = reason => {
    if (stoppedFor) return;
    stoppedFor = reason;
    // USER-AUTHORIZED — Marcus, November 4, 2026: stop rejected-call/retry
    // loops immediately, retain evidence, and do not automatically restart.
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
  };
  const onEvent = incoming => {
    if (incoming.type === 'thread.started') state.harness_session_id = incoming.thread_id;
    if (incoming.session_id) state.harness_session_id = incoming.session_id;
    if (incoming.type === 'item.completed' && incoming.item?.type === 'agent_message') output = incoming.item.text || output;
    if (incoming.type === 'result') {
      output = typeof incoming.result === 'string' ? incoming.result : output;
      if (incoming.is_error || (incoming.subtype && incoming.subtype !== 'success')) harnessError = incoming.result || incoming.subtype;
    }
    if (incoming.type === 'turn.failed') harnessError = incoming.error?.message || JSON.stringify(incoming.error || incoming);
    const isError = incoming.type === 'error' || incoming.type === 'turn.failed' || incoming.is_error;
    if ((isError && /429|usage.?limit|rate.?limit|quota.?exceed|reconnecting|retrying/i.test(JSON.stringify(incoming))) || (incoming.type === 'system' && incoming.subtype === 'api_retry')) {
      stopWaste('The harness reported a rejected call or retry. Stopped without an automatic retry.');
    }
  };
  const consumeLine = line => { try { onEvent(JSON.parse(line)); } catch {} };
  const result = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  stdoutLog.on('error', error => { harnessError = `Could not persist harness stdout: ${error.message}`; stopWaste(harnessError); });
  stderrLog.on('error', error => { harnessError = `Could not persist harness stderr: ${error.message}`; stopWaste(harnessError); });
  child.stdout.on('data', chunk => {
    stdoutLog.write(chunk);
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { consumeLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
  });
  child.stderr.on('data', chunk => {
    stderrLog.write(chunk);
    stderr = (stderr + chunk.toString()).slice(-12000);
    if (/^(?:Error:\s*)?(?:Reconnecting|Retrying)\b/im.test(stderr) || /^error[^\n]*(?:429|usage.?limit|rate.?limit|quota.?exceed)/im.test(stderr)) stopWaste('The harness reported a rejected call or retry on stderr. Stopped without an automatic retry.');
  });
  child.stdin.on('error', error => { harnessError ||= `Harness stdin failed: ${error.message}`; });
  await save({ status: 'running', stage: 'harness', harness_pid: child.pid, harness_started_at: new Date().toISOString() });
  child.stdin.end(input);
  const outcome = await result;
  if (killTimer) clearTimeout(killTimer);
  if (buffer.trim()) consumeLine(buffer);
  stdoutLog.end(); stderrLog.end();
  await Promise.all([finished(stdoutLog), finished(stderrLog)]);
  if (request.harness === 'codex') {
    try { output = await readFile(outputFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  // Preserve partial final text on failures, but only complete jobs return it as advice.
  await writeFile(outputFile, output || '', { mode: 0o600 });
  const failure = stoppedFor || spawnError?.message || harnessError || (outcome.code !== 0 ? `Harness exited (${outcome.code ?? outcome.signal}). ${stderr.trim()}` : !output?.trim() ? 'The harness exited without a coaching response.' : '');
  await save({ status: failure ? 'failed' : 'complete', stage: 'finished', finished_at: new Date().toISOString(), exit_code: outcome.code, signal: outcome.signal, ...(failure ? { error: failure, spawn_error_code: spawnError?.code } : {}) });
}

try {
  const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
  state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  await save({ status: 'running', stage: 'fetch_prompt', worker_pid: process.pid, started_at: new Date().toISOString() });
  const prompt = await fetchPrompt(request.prompt_source);
  await save({ prompt: { ...request.prompt_source, fetched_at: new Date().toISOString(), sha256: createHash('sha256').update(prompt).digest('hex') } });
  await runHarness(request, prompt);
} catch (error) {
  console.error(error.stack || error.message);
  if (state) await save({ status: 'failed', stage: 'finished', finished_at: new Date().toISOString(), error: error.message, code: error.code });
  process.exitCode = 1;
}
