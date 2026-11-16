import { readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { storeJson } from './m3ntor-jobs.mjs';

// This worker owns one detached job; recovery inside the harness stays with it.
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
  const input = `${prompt}\n\n## ${request.task === 'poma_reassessment' ? 'Current business POMA reassessment task' : 'Current coaching request'}\n\n${request.question}\n\n## Supplied context\n\n${context}\n`;
  await writeFile(path.join(directory, 'harness-input.md'), input, { mode: 0o600 });
  await storeJson(path.join(directory, 'command.json'), { command: request.harness, args, cwd: request.cwd, model: 'Inherited from the existing harness configuration', authentication: 'Inherited; no credential or account override' });
  const stdoutLog = createWriteStream(path.join(directory, 'harness.stdout.jsonl'), { mode: 0o600 });
  const stderrLog = createWriteStream(path.join(directory, 'harness.stderr.log'), { mode: 0o600 });
  const recoveryLog = createWriteStream(path.join(directory, 'harness.recovery.jsonl'), { mode: 0o600 });
  const child = spawn(request.harness, args, { cwd: request.cwd, env: process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let buffer = '', stderrBuffer = '', stderr = '', output = '', harnessError = '', stoppedFor = '', spawnError;
  let progressVersion = 0, retryProgressVersion = -1, lastRetry;
  const seenProgress = new Set();
  const seenModelText = new Set();
  const streamedText = new Map();
  const claudeOperations = new Map();
  const retryAttempts = [];
  const audit = (kind, detail) => recoveryLog.write(JSON.stringify({ at: new Date().toISOString(), kind, progress_version: progressVersion, ...detail }) + '\n');
  let killTimer;
  const stopWaste = reason => {
    if (stoppedFor) return;
    stoppedFor = reason;
    // USER-AUTHORIZED — Marcus, November 4, 2026: stop hard rejections and
    // demonstrated no-progress retry loops; preserve productive recovery.
    audit('stop', { reason });
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
  };
  const normalized = value => {
    if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').trim();
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])]));
    return value;
  };
  const progress = (kind, material) => {
    const key = JSON.stringify(normalized({ kind, material }));
    if (seenProgress.has(key)) return;
    seenProgress.add(key);
    progressVersion += 1;
    audit('progress', { progress_kind: kind });
  };
  const modelText = value => {
    const text = normalized(value);
    // Replayed text and its streamed prefixes are the same information,
    // regardless of message identity or how the transport chunks it.
    if (!text || [...seenModelText].some(previous => previous.startsWith(text))) return;
    seenModelText.add(text);
    progress('model_text', { type: 'text', text });
  };
  const errorContent = error => error && typeof error === 'object' ? { type: error.type, code: error.code, message: error.message, status: error.status, details: error.details } : error;
  const hardRejection = text => /\b429\b|usage[ _-]?limit|rate[ _-]?limit|quota[ _-]?(?:exceed|exhaust)|insufficient[ _-]?quota|\bexceeded(?:\s+(?:your|the|current|available))*\s+quota\b/i.test(text);
  const retryNotice = (source, text, incoming = {}) => {
    const explicit = incoming.attempt ?? incoming.retry_attempt ?? incoming.attempt_number;
    const match = text.match(/\battempt\s*[:#]?\s*(\d+)\b/i) || text.match(/\b(?:retrying|reconnecting)\b[\s.…:(#-]*(\d+)\b/i);
    const attempt = explicit !== undefined && /^\d+$/.test(String(explicit)) ? String(Number(explicit)) : match ? String(Number(match[1])) : null;
    const requestId = incoming.request_id || incoming.error?.request_id || null;
    const current = { attempt, request_id: requestId };
    // Ordinals shared by stderr and JSON describe the same attempt. A request
    // ID distinguishes equal ordinals only when both notices supply one.
    const same = retryAttempts.find(previous => (attempt !== null && attempt === previous.attempt && (!requestId || !previous.request_id || requestId === previous.request_id)) || (attempt === null && requestId && requestId === previous.request_id));
    const distinct = lastRetry && !same && ((attempt !== null && lastRetry.attempt !== null) || (requestId && lastRetry.request_id));
    audit('retry_notice', { source, ...current, duplicate: !!same, distinct: !!distinct });
    if (same) {
      if (!same.request_id && requestId) same.request_id = requestId;
      return;
    }
    // An unnumbered repeated log line alone cannot establish another attempt.
    if (attempt === null && !requestId) return;
    if (distinct && retryProgressVersion === progressVersion) {
      stopWaste('Distinct harness retry attempts made no intervening substantive progress. Stopped the wasting loop; evidence retained.');
      return;
    }
    retryAttempts.push(current);
    lastRetry = current;
    retryProgressVersion = progressVersion;
  };
  const onEvent = incoming => {
    if (incoming.type === 'thread.started') state.harness_session_id = incoming.thread_id;
    if (incoming.session_id) state.harness_session_id = incoming.session_id;
    const item = incoming.item;
    if (['item.completed', 'item.updated'].includes(incoming.type) && ['agent_message', 'reasoning'].includes(item?.type) && item.text?.trim()) modelText(item.text);
    if (incoming.type === 'item.completed' && item?.type === 'agent_message') output = item.text || output;
    if (incoming.type === 'item.completed') {
      // Only operation/result content defines progress, not envelope IDs,
      // timestamps or execution duration. Business result data stays intact.
      if (item?.type === 'command_execution') progress('work_item', { type: item.type, command: item.command, status: item.status, exit_code: item.exit_code, output: item.aggregated_output ?? item.output });
      if (item?.type === 'mcp_tool_call') progress('work_item', { type: item.type, server: item.server, tool: item.tool, arguments: item.arguments, status: item.status, result: item.result, error: errorContent(item.error) });
      if (item?.type === 'web_search') progress('work_item', { type: item.type, status: item.status, query: item.query, action: item.action, result: item.result, results: item.results });
      if (item?.type === 'file_change') progress('work_item', { type: item.type, status: item.status, changes: item.changes });
    }
    if (incoming.type === 'stream_event') {
      const event = incoming.event;
      if (event?.type === 'message_start') streamedText.clear();
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        streamedText.set(event.index, (streamedText.get(event.index) || '') + event.delta.text);
        modelText([...streamedText].sort(([left], [right]) => left - right).map(([, text]) => text).join(''));
      }
    }
    if (incoming.type === 'assistant' || incoming.type === 'user') {
      if (incoming.type === 'assistant') modelText((incoming.message?.content || []).filter(part => part.type === 'text').map(part => part.text || '').join(''));
      for (const part of incoming.message?.content || []) {
        // Transport IDs correlate a result with its operation; the semantic
        // progress key contains only that operation and the returned content.
        if (incoming.type === 'assistant' && part.type === 'tool_use' && part.id) claudeOperations.set(part.id, { name: part.name, input: part.input });
        if (part.type === 'tool_result') progress('tool_result', { type: part.type, operation: claudeOperations.get(part.tool_use_id), content: part.content, is_error: part.is_error });
      }
    }
    if (incoming.type === 'result') {
      output = typeof incoming.result === 'string' ? incoming.result : output;
      if (incoming.is_error || (incoming.subtype && incoming.subtype !== 'success')) harnessError = incoming.result || incoming.subtype;
    }
    if (incoming.type === 'turn.failed') harnessError = incoming.error?.message || JSON.stringify(incoming.error || incoming);
    const isError = incoming.type === 'error' || incoming.type === 'turn.failed' || incoming.is_error;
    const isRetry = incoming.type === 'system' && incoming.subtype === 'api_retry';
    const evidence = JSON.stringify(incoming);
    if ((isError || isRetry) && hardRejection(evidence)) {
      audit('hard_rejection', { source: 'stdout', event_type: incoming.type });
      stopWaste('The harness reported a hard quota/usage rejection. Stopped immediately; evidence retained.');
    } else if (isRetry || (isError && /\breconnecting\b|\bretrying\b/i.test(evidence))) {
      retryNotice('stdout', evidence, incoming);
    }
  };
  const consumeStderr = line => {
    const retry = /^\s*(?:error:\s*)?(?:reconnecting|retrying)\b/i.test(line);
    if (hardRejection(line) && (retry || /^\s*(?:error\b|you(?:'ve| have)\b|usage[ _-]?limit|rate[ _-]?limit|quota\b|insufficient[ _-]?quota)/i.test(line))) {
      audit('hard_rejection', { source: 'stderr' });
      stopWaste('The harness reported a hard quota/usage rejection on stderr. Stopped immediately; evidence retained.');
    } else if (retry) retryNotice('stderr', line);
  };
  const consumeLine = line => { try { onEvent(JSON.parse(line)); } catch {} };
  const result = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  stdoutLog.on('error', error => { harnessError = `Could not persist harness stdout: ${error.message}`; stopWaste(harnessError); });
  stderrLog.on('error', error => { harnessError = `Could not persist harness stderr: ${error.message}`; stopWaste(harnessError); });
  recoveryLog.on('error', error => { harnessError = `Could not persist recovery evidence: ${error.message}`; stopWaste(harnessError); });
  child.stdout.on('data', chunk => {
    stdoutLog.write(chunk);
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { consumeLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
  });
  child.stderr.on('data', chunk => {
    stderrLog.write(chunk);
    stderr = (stderr + chunk.toString()).slice(-12000);
    stderrBuffer += chunk.toString();
    let end;
    while ((end = stderrBuffer.search(/[\r\n]/)) >= 0) { consumeStderr(stderrBuffer.slice(0, end)); stderrBuffer = stderrBuffer.slice(end + 1); }
  });
  child.stdin.on('error', error => { harnessError ||= `Harness stdin failed: ${error.message}`; });
  await save({ status: 'running', stage: 'harness', harness_pid: child.pid, harness_started_at: new Date().toISOString() });
  child.stdin.end(input);
  const outcome = await result;
  if (killTimer) clearTimeout(killTimer);
  if (buffer.trim()) consumeLine(buffer);
  if (stderrBuffer.trim()) consumeStderr(stderrBuffer);
  stdoutLog.end(); stderrLog.end(); recoveryLog.end();
  await Promise.all([finished(stdoutLog), finished(stderrLog), finished(recoveryLog)]);
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
