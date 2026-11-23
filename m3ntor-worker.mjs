import { readFile, writeFile } from 'node:fs/promises';
import { GOAL_REVIEW_INSTRUCTION } from './goals.mjs';
import { createWriteStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { jobRoot, storeJson } from './m3ntor-jobs.mjs';
import { clarityRequest } from './clarity-client.mjs';

const execFileAsync = promisify(execFile);

// This worker owns one detached job; recovery inside the harness stays with it.
process.umask(0o077);
const directory = process.argv[2];
let state;
const save = async patch => {
  state = { ...state, ...patch, updated_at: new Date().toISOString() };
  await storeJson(path.join(directory, 'state.json'), state);
};

// USER-AUTHORIZED — Marcus, November 20, 2026: necessary dependency diagnosis and
// repair within existing authority are part of completing the assigned outcome.
const TASK_INSTRUCTION = `You are the business owner's local AI agent, connected to Clarity M3NT0R through the clarity_m3ntor MCP tools. The task below comes from the owner's action queue and is now due. Carry it out within the owner's existing authority, access and policies, keeping private business records local. Diagnose and repair necessary dependencies within that authority, preserve failure evidence, then retry the affected step after a relevant causal change and verify the assigned outcome. Do not retry unchanged failures. If a diagnostic task finishes with recovery pending, carry its findings and concrete next action back to the parent outcome. Escalate only specific missing authority, credentials, owner-held business decisions or genuine outcome expansion. This scheduled-task harness is one-shot: your final response exits it and interrupts native child agents. Match the execution and return route to this one-shot lifetime: prefer direct authorized execution for settled, bounded remaining work, or an established durable route with a persisted result and wake-capable return. If this flow is only partially complete and must wait for an external event or a future date/time before continuing, call clarity_m3ntor.handoff_task on this task_id with a durable checkpoint, next_instruction, and an event trigger (trigger_id, optional correlation_id) and/or datetime trigger (run_at) so a linked follow-up task resumes with this task's history; then end with \`STATUS: partial — <reason>\`. (Legacy continuation routes using record_task_continuation remain supported when already bound.) Execution ownership survives handoff; a model turn solely to keep descendants alive is not progress. Reuse saved terminal work and any supplied prior_tasks before resuming; carry the supplied execution_environment owner settings into any required execution continuation without changing accounts, credentials or billing. An inherited environment or permission mismatch is an execution dependency to correct within existing owner settings, not a reason to repeat business discovery or ask for already granted authority. A delegation receipt or pending executor is not completed work. Your final response is recorded as this run's result: state what was done, the evidence (job IDs, save receipts), and anything that failed or still needs the owner. Keep to its constraints. End with exactly one final line: \`STATUS: done\` if its definition of success is met, \`STATUS: partial — <reason>\` if you handed off a partially completed flow via handoff_task, or \`STATUS: not done — <reason>\` if it failed.`;

// M3NT0R coaching jobs (Claude): only these built-in tools exist in the session, so
// write permissions the owner granted elsewhere cannot apply; MCP is /mcp/coach (read tools,
// plus set_goal because M3NT0R sets the goals).
const COACH_BUILTIN_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch';
const COACH_MCP_TOOLS = ['search_utility', 'read_journal', 'get_coaching_context', 'user_question_read', 'list_tasks', 'get_task', 'list_assessments', 'read_answered_questions', 'list_goals', 'read_environment', 'set_goal'];
const COACH_TOOLS = [COACH_BUILTIN_TOOLS, ...COACH_MCP_TOOLS.map(name => `mcp__clarity_m3ntor__${name}`)].join(',');

const A2A_CLAUDE_TOOLS = 'Read,Grep,Glob';
const A2A_INSTRUCTION = `You are the business owner's local AI agent, connected to Clarity M3NT0R. M-CODEX, Clarity's operator agent, sent the request below through Clarity A2A. Perform it read-only: you may read workspace records, M3NT0R state/job logs, and local harness sessions (Claude projects, Codex sessions, Antigravity transcripts) to answer support or review questions, but do not create, change, send or delete anything, and do not start other work. Your final response is sent back to M-CODEX as the reply. Never include sensitive data in it: no credentials, tokens or keys; no personal names, contact details or other identifiers of people; no customer, employee or supplier records; no financial figures, prices or account details; no file paths, hostnames or private message content. Answer with non-sensitive summaries, counts, categories or yes/no findings, and say plainly when the request can only be answered with sensitive data.`;

// Session and M3NT0R runtime directories Claude's read-only A2A sandbox may read
// even when M3NTOR_WORKSPACE is a project directory outside $HOME. Auth/credential
// parent directories (~/.claude, ~/.codex) are intentionally excluded.
function a2aReadableDirs(cwd) {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(home, '.codex');
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  const resolvedCwd = path.resolve(cwd);
  const seen = new Set();
  return [
    path.join(claudeHome, 'projects'),
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
    path.join(home, '.gemini', 'antigravity-cli', 'brain'),
    jobRoot,
    path.join(home, '.clarity_coach'),
  ].filter(dir => {
    const abs = path.resolve(dir);
    if (seen.has(abs) || abs === resolvedCwd || !existsSync(abs)) return false;
    seen.add(abs);
    return true;
  });
}

async function fetchPrompt(source) {
  if (source.local === 'a2a_message') return A2A_INSTRUCTION;
  if (source.local === 'scheduled_task') return TASK_INSTRUCTION;
  if (source.local === 'goal_review') return GOAL_REVIEW_INSTRUCTION;
  let prompt;
  try { prompt = await clarityRequest('GET', `/agent/mentor/prompts/${encodeURIComponent(source.prompt_id)}`); }
  catch (error) {
    await save({ prompt_fetch_error: error.message });
    throw new Error(`Prompt fetch failed: ${error.message}`);
  }
  if (typeof prompt?.content !== 'string' || !prompt.content.trim()) throw new Error('The server M3NT0R prompt was empty.');
  await writeFile(path.join(directory, 'fetched-prompt.md'), prompt.content, { mode: 0o600 });
  await save({ prompt_provenance: { prompt_id: prompt.prompt_id, sha256: prompt.sha256, published_at: prompt.published_at, fetched_at: prompt.fetched_at } });
  return prompt.content;
}

// Background Codex jobs run with approval policy "never", so an MCP tool that would ask
// for approval is refused. Jobs this service starts approve the service's own tools.
const LOCAL_TOOLS = ['ask_m3ntor', 'assess_poma', 'reassess_poma', 'get_m3ntor_result', 'report_utility', 'search_utility', 'a2a_status', 'clarify_bridge_status',
  'set_task', 'handoff_task', 'list_tasks', 'clear_task', 'start_task_worker', 'stop_task_worker', 'record_task_continuation', 'resume_task_continuation',
  'register_trigger', 'list_triggers', 'fire_trigger', 'list_flow_runs', 'get_flow_run', 'clear_synthetic_traces',
  'save_poma_reassessment', 'get_coaching_context',
  'read_journal', 'add_journal', 'user_question_set', 'user_question_read',
  'list_goals', 'complete_stage', 'reopen_stage', 'stop_goal', 'set_pace', 'run_goal_review',
  'read_environment', 'record_source', 'set_plate', 'record_process', 'delete_process',
  'get_task', 'list_assessments', 'list_running_jobs', 'read_answered_questions', 'revoke_utility', 'boost_utility', 'resolve_utility'];
const codexApprove = (server, names) => names.flatMap(name => ['-c', `mcp_servers.${server}.tools.${name}.approval_mode="approve"`]);

// Codex for A2A jobs: the apps, plugins and remote_plugin features are turned
// off (removing connector and plugin-provided MCP servers), and every remaining
// server, listed from the job's own working directory so workspace config is
// included, is disabled. The owner's config, provider, model and login stay.
// A listing failure fails the job so a request never runs without this.
const CODEX_FEATURES_OFF = ['--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin'];
async function codexMcpOff(cwd) {
  const { stdout } = await execFileAsync('codex', [...CODEX_FEATURES_OFF, 'mcp', 'list', '--json'], { cwd, timeout: 30000, maxBuffer: 2_000_000 });
  return JSON.parse(stdout).flatMap(server => ['-c', `mcp_servers.${server.name}=${server.transport?.type === 'stdio' ? '{command="/usr/bin/true",enabled=false}' : '{url="http://127.0.0.1:9/",enabled=false}'}`]);
}

async function runHarness(request, prompt) {
  const outputFile = path.join(directory, 'output.txt');
  // A2A requests run read-only with NO MCP servers: the harness would otherwise
  // inherit every configured server (clarity_m3ntor and others), several of which write.
  const readOnly = request.task === 'a2a_message';
  // M3NT0R coaching runs locally with the owner's full context: it may read files,
  // search the web and the shared utility library, and read the journal; it sets the
  // goals and otherwise changes nothing; the owner's agent carries out what it recommends.
  const coachArgs = request.task !== 'coaching' ? null : request.harness === 'codex'
    ? [...(await codexMcpOff(request.cwd)), '-c', `mcp_servers.m3ntor_coach={url=${JSON.stringify(request.mcp_url)}}`, ...codexApprove('m3ntor_coach', COACH_MCP_TOOLS), 'exec', ...CODEX_FEATURES_OFF, '--sandbox', 'read-only', '--json', '--skip-git-repo-check', '-o', outputFile, '-']
    : ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { clarity_m3ntor: { type: 'http', url: request.mcp_url } } }), '--tools', COACH_BUILTIN_TOOLS, '--permission-mode', 'dontAsk', '--allowedTools', COACH_TOOLS];
  const args = coachArgs || (request.harness === 'codex'
    ? (readOnly
      ? [...(await codexMcpOff(request.cwd)), 'exec', ...CODEX_FEATURES_OFF, '--sandbox', 'read-only', '--json', '--skip-git-repo-check', '-o', outputFile, '-']
      // Tasks and goal reviews read the owner's sources over their established routes
      // (SSH, HTTPS), so they get network access; Codex's default exec sandbox has none.
      : request.full_access
        // Full access (owner setting): no sandbox and no approvals; the job acts with the owner's full permissions.
        ? ['-c', `mcp_servers.clarity_m3ntor.url=${JSON.stringify(request.mcp_url)}`, ...codexApprove('clarity_m3ntor', LOCAL_TOOLS), 'exec', '--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check', '-o', outputFile, '-']
        : ['-c', `mcp_servers.clarity_m3ntor.url=${JSON.stringify(request.mcp_url)}`, ...codexApprove('clarity_m3ntor', LOCAL_TOOLS), '-c', 'sandbox_workspace_write.network_access=true', 'exec', '--sandbox', 'workspace-write', '--json', '--skip-git-repo-check', '-o', outputFile, '-'])
    : (readOnly
      ? ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }), '--tools', A2A_CLAUDE_TOOLS, '--permission-mode', 'dontAsk', '--allowedTools', A2A_CLAUDE_TOOLS, ...a2aReadableDirs(request.cwd).flatMap(dir => ['--add-dir', dir])]
      : request.full_access
        ? ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--mcp-config', JSON.stringify({ mcpServers: { clarity_m3ntor: { type: 'http', url: request.mcp_url } } }), '--permission-mode', 'bypassPermissions']
        // Like Codex's workspace sandbox with network: shell, files and web, so tasks can reach the owner's sources.
        : ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--mcp-config', JSON.stringify({ mcpServers: { clarity_m3ntor: { type: 'http', url: request.mcp_url } } }), '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__clarity_m3ntor,Bash,Read,Grep,Glob,Edit,Write,WebFetch,WebSearch']));
  const context = typeof request.context === 'string' ? request.context : JSON.stringify(request.context, null, 2);
  const assessment = ['poma_assessment', 'poma_reassessment'].includes(request.task);
  const persistence = assessment ? `\n## Local persistence identity\n\nUse revision_id ${request.job_id} with clarity_m3ntor.save_poma_reassessment for this task. Reuse that same ID when reconciling a save. The local service writes the authorized artifacts even if this harness filesystem is read-only; retain actual per-artifact receipts.\n` : '';
  const heading = assessment ? 'Current business POMA assessment task' : request.task === 'a2a_message' ? 'Incoming A2A message' : request.task === 'scheduled_task' ? 'Scheduled task' : request.task === 'goal_review' ? 'inov8 goal review' : 'Current coaching request';
  // The owner's own answers are direction from the owner: M3NT0R incorporates them as fully as possible.
  const answers = request.owner_answers?.length
    ? `\n## The owner's answers to your earlier questions\n\nThese are the owner's own words. Incorporate them as fully as possible: let them shape what you assess, recommend and prioritise, and where they conflict with your own inference, follow the owner and say how you did.\n\n${request.owner_answers.map(a => `- Q (${a.answered_at?.slice(0, 10) || 'date unknown'}): ${a.question}\n  A: ${a.answer}`).join('\n')}\n`
    : '';
  const input = `${prompt}\n\n## ${heading}\n\n${request.question}\n${answers}\n## Supplied context\n\n${context}\n${persistence}`;
  await writeFile(path.join(directory, 'harness-input.md'), input, { mode: 0o600 });
  await storeJson(path.join(directory, 'command.json'), { command: request.harness, args, cwd: request.cwd, model: 'Inherited from the existing harness configuration', authentication: 'Inherited; no credential or account override' });
  const stdoutLog = createWriteStream(path.join(directory, 'harness.stdout.jsonl'), { mode: 0o600 });
  const stderrLog = createWriteStream(path.join(directory, 'harness.stderr.log'), { mode: 0o600 });
  const recoveryLog = createWriteStream(path.join(directory, 'harness.recovery.jsonl'), { mode: 0o600 });
  // M3NTOR_JOB_ID marks the service's own harness runs, so the owner's session-start hook stays quiet in them.
  const child = spawn(request.harness, args, { cwd: request.cwd, env: { ...process.env, M3NTOR_JOB_ID: request.job_id }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
