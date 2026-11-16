import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { steps, scale, dimensions, promptFor, categoricalScale, ratingPromptFor } from './questions.mjs';
import { coachReport, validateRatings } from './coach-report.mjs';
import { inspectBridge, establishBridge } from './bridge.mjs';
import { savePomaAssessment, savePomaReassessment, reconcileReassessmentContext } from './assessment-store.mjs';
import { readJournal, addJournal, questionState, setUserQuestions, readUserQuestions, businessTools, serializeBusinessWrites } from './business-journal.mjs';
import { coachIdentity } from './coach-identity.mjs';
import { m3ntorTools, askM3ntor, assessPoma, getM3ntorResult } from './m3ntor-jobs.mjs';
import { utilityTools, reportUtility, searchUtility } from './clarity-utility.mjs';

const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.join(root, '.data');
const port = Number(process.env.PORT || 4317);
const base = `http://127.0.0.1:${port}`;
const parentThread = process.env.CODEX_THREAD_ID || '';
const records = new Map();
const localCwd = path.resolve(process.env.M3NTOR_WORKSPACE || process.env.HOME || root);
const localWorkspace = { id: 'local', local: true, cwd: localCwd, harness: process.env.M3NTOR_HARNESS || 'codex', status: 'draft', answers: {} };
const jobs = new Map();
const listeners = new Set();
const mcpSessions = new Map();
const mcpStreams = new Set();
await mkdir(data, { recursive: true, mode: 0o700 });
for (const f of await readdir(data)) {
  if (!f.endsWith('.json')) continue;
  const a = JSON.parse(await readFile(path.join(data, f), 'utf8'));
  if (a.run?.status === 'running') { a.automatic = false; a.run = { ...a.run, status: 'interrupted', detail: 'The service restarted. Your saved answers remain available.' }; }
  if (!a.events) {
    a.events = Object.entries(a.answers).flatMap(([stage, answer]) => [
      { id: randomUUID(), role: 'coach', kind: 'question', stage, text: steps.find(s => s.id === stage)?.question || stage, at: answer.recordedAt },
      { id: randomUUID(), role: a.harness, kind: 'answer', stage, text: answer.text, at: answer.recordedAt },
    ]);
  }
  records.set(a.id, a);
}
function publish(a) {
  const message = `data: ${JSON.stringify({ assessment: summary(a) })}\n\n`;
  for (const res of listeners) res.write(message);
}
function event(a, role, kind, text, extra = {}) {
  a.events ||= [];
  const item = { id: randomUUID(), role, kind, text, stage: a.run?.stage, at: new Date().toISOString(), ...extra };
  a.events.push(item); publish(a); return item;
}
async function save(a) {
  a.updatedAt = new Date().toISOString();
  const tmp = path.join(data, `${a.id}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(a, null, 2), { mode: 0o600 });
  await rename(tmp, path.join(data, `${a.id}.json`));
  publish(a);
}
const contextPath = a => path.join(a.cwd, '.clarity_coach', 'CONTEXT.md');
const summary = a => ({ ...a, contextPath: contextPath(a), mcpUrl: `${base}/mcp/${a.id}` });
function json(res, status, value, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); }
async function body(req) {
  let raw = '';
  for await (const part of req) { raw += part; if (raw.length > 2_000_000) throw new Error('Request is too large.'); }
  return raw ? JSON.parse(raw) : {};
}
function stop(a, detail) {
  const child = jobs.get(a.id);
  if (child) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  jobs.delete(a.id);
  a.automatic = false;
  a.run = { ...a.run, status: 'stopped', detail };
  event(a, 'system', 'status', detail);
  return save(a);
}
async function advance(a) {
  if (!a.automatic || jobs.has(a.id)) return;
  if (a.interviewVersion === 2 && a.shareableReport && a.completedAt) { a.automatic = false; await save(a); return; }
  try { await run(a, 'interview'); }
  catch (e) { a.automatic = false; a.run = { ...a.run, status: 'error', detail: e.message }; event(a, 'system', 'status', e.message); await save(a); }
}
async function availability(name) {
  try {
    const args = name === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
    const out = await exec(name, args, { timeout: 8000, maxBuffer: 500_000 });
    if (name === 'claude') {
      const result = JSON.parse(out.stdout);
      return { installed: true, signedIn: result.loggedIn === true, label: result.loggedIn ? 'Signed in' : 'Sign-in required' };
    }
    return { installed: true, signedIn: true, label: /ChatGPT/i.test(out.stdout + out.stderr) ? 'Signed in with ChatGPT' : 'Signed in' };
  } catch (e) { return { installed: e.code !== 'ENOENT', signedIn: false, label: e.code === 'ENOENT' ? 'Not installed' : 'Sign-in unavailable' }; }
}
async function run(a, stage) {
  if (jobs.has(a.id)) throw new Error('This harness is already answering a question.');
  const whole = stage === 'interview';
  const step = stage === 'ratings' ? { id: 'ratings', question: 'Update all four POMA areas with both categories and 1–10 scores using the saved findings.' } : whole ? { id: 'interview', question: 'Complete the initial business, access, recurring-work, Agency and POM interview. Save detailed context locally and prepare a non-sensitive report for Coach.' } : steps.find(s => s.id === stage);
  if (!step) throw new Error('Unknown question.');
  if (!whole && stage !== 'connection' && !a.connectedAt) throw new Error('Connect the harness first.');
  const index = steps.indexOf(step);
  if (index > 0 && steps.slice(0, index).some(s => !a.answers[s.id])) throw new Error('Answer the preceding questions first.');
  if (whole && a.interviewVersion !== 2) {
    a.revisions ||= [];
    a.revisions.push({ at: new Date().toISOString(), answers: structuredClone(a.answers), ratings: a.ratings, submission: a.submission, status: a.status });
    delete a.submission; delete a.ratings; delete a.completedAt;
    a.status = 'draft'; a.interviewVersion = 2;
  }
  const prompt = stage === 'ratings' ? ratingPromptFor(a) : promptFor({ ...a, port, contextPath: contextPath(a) });
  const mcp = `${base}/mcp/${a.id}`;
  let args;
  if (a.harness === 'codex') {
    // USER-AUTHORIZED — Marcus, November 15, 2026: connect the harness so Coach
    // can initiate these questions and persist the answers through its local MCP.
    args = ['-c', `mcp_servers.clarity_m3ntor.url=${JSON.stringify(mcp)}`, '-c', 'mcp_servers.clarity_m3ntor.required=true', '-c', 'mcp_servers.clarity_m3ntor.tools.get_coaching_context.approval_mode="approve"', '-c', 'mcp_servers.clarity_m3ntor.tools.record_answer.approval_mode="approve"', 'exec'];
    for (const name of ['save_context','finish_interview','check_bridge','establish_bridge','revise_ratings','read_journal','add_journal','suser_question_set','user_question_read']) args.unshift('-c', `mcp_servers.clarity_m3ntor.tools.${name}.approval_mode="approve"`);
    if (a.sessionId) args.push('resume');
    args.push('--json', '--skip-git-repo-check');
    if (a.sessionId) args.push(a.sessionId);
    args.push('-');
  } else {
    args = ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--mcp-config', JSON.stringify({ mcpServers: { clarity_m3ntor: { type: 'http', url: mcp } } }), '--allowedTools', 'mcp__clarity_m3ntor__get_coaching_context,mcp__clarity_m3ntor__record_answer,mcp__clarity_m3ntor__save_context,mcp__clarity_m3ntor__finish_interview,mcp__clarity_m3ntor__check_bridge,mcp__clarity_m3ntor__establish_bridge,mcp__clarity_m3ntor__revise_ratings,mcp__clarity_m3ntor__read_journal,mcp__clarity_m3ntor__add_journal,mcp__clarity_m3ntor__suser_question_set,mcp__clarity_m3ntor__user_question_read'];
    if (a.sessionId) args.push('--resume', a.sessionId);
  }
  a.run = { status: 'running', stage, startedAt: new Date().toISOString(), detail: 'Starting your harness…', output: '' };
  const runInfo = a.run;
  event(a, 'coach', 'question', step.question);
  await save(a);
  const child = spawn(a.harness, args, { cwd: a.cwd, detached: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  jobs.set(a.id, child);
  let buffer = '';
  let stderr = '';
  const messageItems = new Map();
  const streamMessage = (id, text, replace = false) => {
    let item = messageItems.get(id);
    if (!item) { item = event(a, a.harness, 'message', text); messageItems.set(id, item); }
    else { item.text = replace ? text : item.text + text; publish(a); }
  };
  const onEvent = async incoming => {
    if (a.run !== runInfo || a.run.status !== 'running') return;
    if (incoming.type === 'item.completed' && incoming.item?.type === 'mcp_tool_call' && incoming.item.tool === 'record_answer') publish(a);
    if (incoming.type === 'thread.started') a.sessionId = incoming.thread_id;
    if (incoming.session_id) a.sessionId = incoming.session_id;
    if (incoming.type === 'item.started') {
      const item = incoming.item;
      a.run.detail = item?.type === 'mcp_tool_call' ? 'Connected to Coach · exchanging context' : 'Reading business context';
      if (['mcp_tool_call','command_execution','web_search'].includes(item?.type)) event(a, a.harness, 'activity', item.type === 'mcp_tool_call' ? `Using ${item.tool || item.name || 'Coach MCP'}` : item.type === 'web_search' ? 'Looking up a source' : 'Reading local context');
    }
    if (['item.completed','item.updated'].includes(incoming.type) && incoming.item?.type === 'agent_message') {
      a.run.output = incoming.item.text;
      streamMessage(incoming.item.id, incoming.item.text, true);
    }
    if (incoming.type === 'stream_event' && incoming.event?.type === 'content_block_delta' && incoming.event.delta?.type === 'text_delta') streamMessage(`claude-${incoming.event.index}`, incoming.event.delta.text);
    if (incoming.type === 'assistant') {
      a.run.output = (incoming.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (!messageItems.size && a.run.output) streamMessage(incoming.message?.id || 'assistant', a.run.output, true);
    }
    if (incoming.type === 'result') {
      a.run.output = incoming.result || a.run.output;
      if (incoming.is_error) a.run.detail = incoming.result || 'The harness reported an error.';
    }
    publish(a);
    const serialized = JSON.stringify(incoming);
    // USER-AUTHORIZED — Marcus, November 4, 2026: stop rejected-call loops immediately.
    // Match actual error events, never historical text returned by a tool or agent.
    if (((incoming.type === 'error' || incoming.type === 'turn.failed' || incoming.is_error) && /429|usage.?limit|rate.?limit|quota.?exceed/i.test(serialized)) || (incoming.type === 'system' && incoming.subtype === 'api_retry')) {
      await stop(a, 'The provider rejected the call. The harness was stopped; no automatic retry.');
    }
  };
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { void onEvent(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
  child.on('error', async e => { if (jobs.get(a.id) === child) jobs.delete(a.id); if (a.run !== runInfo) return; a.automatic = false; a.run.status = 'error'; a.run.detail = e.message; event(a, 'system', 'status', e.message); await save(a); });
  child.on('close', async code => {
    if (jobs.get(a.id) === child) jobs.delete(a.id);
    if (a.run !== runInfo || a.run.status === 'stopped') return;
    if ((whole && a.finishedRunStartedAt === a.run.startedAt) || (!whole && (a.answers[stage]?.runStartedAt === a.run.startedAt || a.ratingsUpdatedRunStartedAt === a.run.startedAt))) {
      a.run.status = 'complete'; a.run.detail = 'Answer saved.';
      if (whole) { a.automatic = false; event(a, 'coach', 'status', 'Local context and the non-sensitive POM + Agency report are ready.'); }
    } else {
      a.automatic = false;
      a.run.status = 'error';
      a.run.detail = code === 0 ? 'The harness finished without saving an answer through MCP. Its response is available below.' : `The harness exited (${code}). ${stderr.slice(-1800)}`;
      event(a, 'system', 'status', a.run.detail);
    }
    await save(a);
    if (!whole) await advance(a);
  });
  child.stdin.end(prompt);
}
const ratingSchema = { type: 'object', properties: { category: { type: 'string', enum: categoricalScale.map(item => item.category) }, score: { type: 'integer', minimum: 1, maximum: 10 }, rationale: { type: 'string' } }, required: ['category', 'score', 'rationale'], additionalProperties: false };
const ratingsSchema = { type: 'object', properties: Object.fromEntries(dimensions.map(key => [key, ratingSchema])), required: dimensions, additionalProperties: false };
const sectionsSchema = { type: 'object', properties: Object.fromEntries(steps.map(step => [step.id, { type: 'string' }])), required: steps.map(step => step.id), additionalProperties: false };
const tools = [
  { name: 'save_poma_reassessment', description: 'Save a prepared business POMA reassessment through this local service, including when your harness filesystem is read-only. Use the task revision_id UUID consistently. Saves one dated private revision, appends/updates its context section and journal entry, and saves a SEPARATE non-sensitive coaching summary locally. Workspace paths are fixed by this MCP connection. Repeating the same revision reconciles it without duplicates; prior revisions/unrelated context stay intact. Returns actual per-artifact saved states, paths and receipt or honest partial effects. No interview or new approval step; nothing is submitted to a remote server.', inputSchema: { type: 'object', properties: { revision_id: { type: 'string', format: 'uuid' }, ratings: ratingsSchema, evidence: { description: 'Local evidence and source references, including explicit gaps.' }, coverage: { description: 'Business/process/source/period coverage and exclusions.' }, uncertainty: { description: 'Evidence limits and uncertainty for the business-linked ratings.' }, comparison: { description: 'Actual business change versus newly discovered evidence or corrected interpretation.' }, productivity: { description: 'Supported calculation or labelled estimate with scope, period, currency, definitions and total-human-hour coverage, or specific missing evidence.' }, status: { type: 'string', description: 'Actual assessment lifecycle status; defaults to draft.' }, harness: { type: 'string', enum: ['codex', 'claude'], description: 'Actual local harness, when known.' }, context_update: { type: 'string', description: 'Detailed reassessment Markdown section; do not replace unrelated existing CONTEXT.' }, journal_entry: { type: 'string', description: 'Business-related reassessment journal entry.' }, coaching_summary: { type: 'string', description: 'SEPARATE non-sensitive coaching summary; exclude raw context, financial/working-hours details, private identifiers, paths and credentials.' } }, required: ['revision_id','ratings','evidence','coverage','uncertainty','comparison','productivity','context_update','journal_entry','coaching_summary'], additionalProperties: false } },
  { name: 'revise_ratings', description: 'Update an existing completed POMA report from its recorded findings only. Supply both a category and a 1–10 score for each area with non-sensitive rationales, and review them for sensitivity. Saves the report, appends the updated assessment to local CONTEXT.md, and saves a dated JSON revision. Does not repeat the interview or send the report.', inputSchema: { type: 'object', properties: { ratings: ratingsSchema, privacyReviewed: { type: 'boolean' } }, required: ['ratings','privacyReviewed'], additionalProperties: false } },
  { name: 'get_coaching_context', description: 'Retrieve local business context, previous findings, Coach identity, and any active interview assignment. With no active interview, support the owner’s current work using the journal and outstanding-question tools.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'record_answer', description: 'Save a non-sensitive progress summary for one interview section. Publish sections progressively during the continuous interview. Keep detailed or sensitive context in local CONTEXT.md. Each POMA area has a categorical assessment and a 1–10 score, with a rationale supporting both.', inputSchema: { type: 'object', properties: { stage: { type: 'string', enum: steps.map(s => s.id) }, answer: { type: 'string' }, ratings: ratingsSchema }, required: ['stage', 'answer'], additionalProperties: false } },
  { name: 'save_context', description: 'Create or update the owner’s private .clarity_coach/CONTEXT.md beneath the selected business workspace. Supply the complete merged Markdown, preserving useful existing context. This content stays local and is never included in the Coach export. Store detailed findings here; exclude credentials and keys.', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } },
  { name: 'check_bridge', description: 'Inspect the existing A2A bridge installation and current service state. Returns bounded last-observed health separately from current service state. Does not prove a fresh communication round trip.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'establish_bridge', description: 'Reuse an existing running A2A bridge or apply its documented installation using the established local source and configuration. Preserves existing identity/authentication and returns missing setup inputs when unavailable. Do not repeat an unsuccessful setup blindly.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'finish_interview', description: 'Finish after all interview sections and local CONTEXT.md are saved. Prepare a separate non-sensitive Coach report with a summary, each section, and both categorical and 1–10 ratings/rationales for all four POMA areas. Review all supplied text for sensitivity and set privacyReviewed true only after that review. Exclude private messages, identities, financial details, internal identifiers and paths. This report alone is eligible for sharing; submission remains a separate user action.', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, sections: sectionsSchema, ratings: ratingsSchema, privacyReviewed: { type: 'boolean' } }, required: ['summary','sections','ratings','privacyReviewed'], additionalProperties: false } },
];
function toolsChanged(cwd) {
  const notification = `event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})}\n\n`;
  for (const stream of mcpStreams) if (path.resolve(stream.cwd) === path.resolve(cwd)) stream.res.write(notification);
}
const questionInstructions = 'At the start of a session, read today’s business journal with read_journal and check user_question_read. Before offering outstanding questions, today’s journal must have been read. When permitted and questions are pending, briefly ask whether the user has time to answer some Coach questions; continue their work if not. Record a no using suser_question_set(action="defer") or add_journal(user_declined_questions=true): no more offers for four hours unless the user directly raises these questions. Set new business questions with suser_question_set. Local journal and question contents are never report attachments.';
async function mcp(req, res, a) {
  const sessionId = req.headers['mcp-session-id'];
  const session = mcpSessions.get(sessionId);
  if (req.method === 'DELETE') {
    mcpSessions.delete(sessionId);
    for (const stream of mcpStreams) if (stream.sessionId === sessionId) stream.res.end();
    res.writeHead(204); return res.end();
  }
  if (req.method === 'GET') {
    if (!session || session.cwd !== a.cwd) return json(res,404,{error:'Initialize this MCP session first.'});
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
    res.write(': connected\n\n');
    const stream={res,cwd:a.cwd,sessionId};mcpStreams.add(stream);
    const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);
    req.on('close',()=>{clearInterval(heartbeat);mcpStreams.delete(stream);});return;
  }
  const call = await body(req);
  if (!('id' in call)) { res.writeHead(202); return res.end(); }
  let result;
  if (call.method === 'initialize') {
    const id=randomUUID();mcpSessions.set(id,{cwd:a.cwd,createdAt:new Date().toISOString()});
    const assignment = a.run?.status === 'running' ? a.run.stage === 'ratings' ? 'Update only the existing POMA ratings from recorded findings, with both categorical and numeric assessments. Save the revision and return; do not repeat the interview.' : 'Complete the full interview assignment in one continuous session, saving local context and the separate non-sensitive report.' : 'Use the local business context and coaching tools to support your owner. Do not restart the interview without a request.';
    result={protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'clarity_m3ntor',version:'0.7.0'},instructions:assignment+' '+questionInstructions+' Ask M3NT0R with ask_m3ntor or assess the owner’s business with assess_poma (reassess_poma is a compatibility alias for the same prompt). Save assessment artifacts through save_poma_reassessment, including from a read-only harness; retrieve either running job with get_m3ntor_result.'};
    return json(res,200,{jsonrpc:'2.0',id:call.id,result},{'Mcp-Session-Id':id});
  }
  if (call.method !== 'ping' && (!session || session.cwd !== a.cwd)) return json(res,404,{error:'MCP session is missing or expired; initialize again.'});
  if (call.method === 'ping') result = {};
  else if (call.method === 'tools/list') result = { tools: [...m3ntorTools, ...utilityTools, ...tools.filter(tool => !a.local || ['get_coaching_context','save_poma_reassessment'].includes(tool.name)), ...businessTools(await questionState(a.cwd))] };
  else if (call.method === 'tools/call') {
    try {
      const { name, arguments: input = {} } = call.params;
      if (name === 'ask_m3ntor' || name === 'assess_poma' || name === 'reassess_poma') {
        const job = await (name === 'ask_m3ntor' ? askM3ntor : assessPoma)(input, { cwd: a.cwd, harness: a.harness, mcpUrl: `${base}/mcp/${a.id}` });
        result = { ...(job.status === 'failed' || job.status === 'interrupted' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(job) }] };
      } else if (name === 'get_m3ntor_result') {
        const job = await getM3ntorResult(input.job_id);
        result = { ...(job.status === 'failed' || job.status === 'interrupted' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(job) }] };
      } else if (name === 'save_poma_reassessment') {
        const receipt = await savePomaReassessment(a.cwd, input, { assessmentId: a.id, harness: a.harness });
        result = { ...(!receipt.saved ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } else if (name === 'report_utility' || name === 'search_utility') {
        const response = await (name === 'report_utility' ? reportUtility(input) : searchUtility(input));
        result = { content: [{ type: 'text', text: JSON.stringify(response) }] };
      } else if (a.local && !['get_coaching_context', 'read_journal', 'add_journal', 'suser_question_set', 'user_question_read'].includes(name) && !/^user_questions_\d+$/.test(name)) {
        throw new Error('This tool requires an assessment-scoped MCP connection. Local coaching does not require an interview.');
      } else if (name === 'read_journal') {
        const journal=await readJournal(a.cwd,input);
        if (Object.hasOwn(journal.revisions,journal.today)) { session.journalDate=journal.today;session.journalRevision=journal.revisions[journal.today]; }
        result={content:[{type:'text',text:JSON.stringify(journal.entries)}]};
      } else if (name === 'add_journal') {
        const added=await addJournal(a.cwd,input);
        if(input.user_declined_questions) toolsChanged(a.cwd);
        result={content:[{type:'text',text:JSON.stringify(added)}]};
      } else if (name === 'suser_question_set') {
        const updated=await setUserQuestions(a.cwd,input);toolsChanged(a.cwd);
        result={content:[{type:'text',text:JSON.stringify(updated)}]};
      } else if (name === 'user_question_read' || /^user_questions_\d+$/.test(name)) {
        result={content:[{type:'text',text:JSON.stringify(await readUserQuestions(a.cwd,session,input))}]};
      } else if (name === 'get_coaching_context') {
        if (!a.local) { a.mcpSeenAt = new Date().toISOString(); await save(a); }
        let existingContext = '';
        try { existingContext = await readFile(contextPath(a), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        result = { content: [{ type: 'text', text: JSON.stringify({ assessmentId: a.id, assignment: a.run?.status === 'running' ? (a.run.stage === 'ratings' ? ratingPromptFor(a) : promptFor({ ...a, port, contextPath: contextPath(a) })) : 'No interview assignment is active. Support the owner’s current work; read today’s journal before offering outstanding Coach questions.', coach: coachIdentity, sections: steps, previousAnswers: a.answers, scale, contextPath: contextPath(a), existingContext, localOnly: true }) }] };
      } else if (name === 'record_answer') {
        if (a.run?.status !== 'running' || !steps.some(step => step.id === input.stage)) throw new Error('Save a valid section during the running interview.');
        if (!input.answer?.trim()) throw new Error('An answer is required.');
        if (input.stage === 'connection' && !a.mcpSeenAt) throw new Error('Call get_coaching_context first.');
        if (input.stage === 'assessment') {
          validateRatings(input.ratings);
          a.ratings = input.ratings;
        }
        a.answers[input.stage] = { text: input.answer, recordedAt: new Date().toISOString(), runStartedAt: a.run.startedAt };
        a.currentSection = input.stage;
        event(a, a.harness, 'answer', input.answer, { stage: input.stage });
        if (input.stage === 'connection') a.connectedAt = new Date().toISOString();
        await save(a);
        result = { content: [{ type: 'text', text: JSON.stringify({ saved: true, stage: input.stage, assessmentId: a.id }) }] };
      } else if (name === 'revise_ratings') {
        if (a.run?.status !== 'running' || a.run.stage !== 'ratings') throw new Error('Revise ratings during the requested rating-update run.');
        validateRatings(input.ratings);
        const candidate = { ...a.shareableReport, ratings: input.ratings, privacyReviewed: input.privacyReviewed, revisionId: randomUUID() };
        const text = dimensions.map(key => `${key}: ${input.ratings[key].category} · ${input.ratings[key].score}/10 — ${input.ratings[key].rationale}`).join('\n\n');
        candidate.sections = { ...candidate.sections, assessment: text };
        coachReport({ ...a, shareableReport: candidate });
        const file = contextPath(a);
        const now = new Date().toISOString();
        await serializeBusinessWrites(a.cwd, async () => {
          const previous = await readFile(file, 'utf8');
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeFile(temporary, `${previous}\n\n## POMA assessment update — ${now}\n\n${text}\n`, { mode: 0o600 }); await rename(temporary, file);
        });
        a.context = { ...a.context, savedAt: now, runStartedAt: a.run.startedAt };
        a.ratings = input.ratings; a.shareableReport = candidate;
        a.answers.assessment = { text, recordedAt: now, runStartedAt: a.run.startedAt };
        a.completedAt = now; a.ratingsUpdatedRunStartedAt = a.run.startedAt;
        if (a.submission) { a.submissionHistory ||= []; a.submissionHistory.push(a.submission); delete a.submission; }
        a.status = 'draft'; a.assessmentFile = await savePomaAssessment(a);
        event(a, a.harness, 'answer', text, { stage: 'assessment' });
        await save(a);
        result = { content: [{ type: 'text', text: JSON.stringify({ updated: true, contextSaved: true, assessmentFile: a.assessmentFile.path, submitted: false }) }] };
      } else if (name === 'save_context') {
        if (a.run?.status !== 'running' || !input.content?.trim()) throw new Error('Provide local context during the running interview.');
        const file = contextPath(a);
        await serializeBusinessWrites(a.cwd, async () => {
          await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          let current = '';
          try { current = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const content = reconcileReassessmentContext(current, input.content);
          const temporary = file + '.' + randomUUID() + '.tmp';
          await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file);
        });
        a.context = { path: file, savedAt: new Date().toISOString(), runStartedAt: a.run.startedAt, localOnly: true };
        await save(a);
        result = { content: [{ type: 'text', text: JSON.stringify({ saved: true, path: file, localOnly: true }) }] };
      } else if (name === 'check_bridge' || name === 'establish_bridge') {
        a.bridge = await (name === 'check_bridge' ? inspectBridge() : establishBridge());
        await save(a);
        result = { content: [{ type: 'text', text: JSON.stringify(a.bridge) }] };
      } else if (name === 'finish_interview') {
        if (a.run?.status !== 'running') throw new Error('Finish the running interview.');
        if (steps.some(step => a.answers[step.id]?.runStartedAt !== a.run.startedAt)) throw new Error('Record the findings for all interview sections before finishing.');
        if (a.context?.runStartedAt !== a.run.startedAt) throw new Error('Save this interview’s local CONTEXT.md before finishing.');
        // USER-AUTHORIZED — Marcus, November 15, 2026: share only non-sensitive data.
        const candidate = { summary: input.summary, sections: input.sections, ratings: input.ratings, privacyReviewed: input.privacyReviewed, revisionId: randomUUID() };
        coachReport({ ...a, shareableReport: candidate });
        a.shareableReport = candidate; a.ratings = input.ratings;
        a.finishedRunStartedAt = a.run.startedAt; a.completedAt = new Date().toISOString();
        a.assessmentFile = await savePomaAssessment(a);
        await save(a);
        result = { content: [{ type: 'text', text: JSON.stringify({ completed: true, localContextSaved: true, assessmentFile: a.assessmentFile.path, nonSensitiveReportReady: true, submitted: false }) }] };
      } else throw new Error('Unknown tool.');
    } catch (e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
  } else if (call.method === 'resources/list') result = { resources: [] };
  else if (call.method === 'prompts/list') result = { prompts: [] };
  else return json(res, 200, { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found' } });
  json(res, 200, { jsonrpc: '2.0', id: call.id, result });
}
async function submit(a) {
  if (a.submission) return a.submission;
  // USER-AUTHORIZED — Marcus, November 15, 2026: only the separately prepared
  // non-sensitive report may leave this local service; never export raw state.
  const exported = coachReport(a);
  const followupUrl = `${base}/api/assessments/${a.id}/followups`;
  const payload = { ...exported, followupUrl };
  const payloadFile = path.join(data, `${a.id}.submission.payload`);
  const messageFile = path.join(data, `${a.id}.submission.message`);
  await writeFile(payloadFile, JSON.stringify(payload), { mode: 0o600 });
  const text = `Clarity Coach POM + Agency report — submitted for coaching. Recommendations are draft.\n\n${exported.summary}\n\n${exported.sections.map(section => section.title.toUpperCase() + '\n' + section.text).join('\n\n')}\n\nRATINGS\n${dimensions.map(key => `${key}: ${exported.ratings[key].category} · ${exported.ratings[key].score}/10 — ${exported.ratings[key].rationale}`).join('\n')}\n\n${coachIdentity.name}: review this non-sensitive report and issue follow-up questions or recommendations. Deliver your response to the report UI with HTTP POST ${followupUrl}, JSON {"kind":"question" or "recommendation","text":"your response"}. Assessment ID: ${a.id}. Detailed CONTEXT.md and the local transcript are not shared. Do not repeat the interview or create a separate implementation task.`;
  await writeFile(messageFile, text, { mode: 0o600 });
  a.submission = { status: 'sending', requestedAt: new Date().toISOString(), recipient: coachIdentity.name, idempotencyKey: `clarity-coach-${a.id}-${exported.revisionId}`, nonSensitiveOnly: true };
  await save(a);
  try {
    const args = ['send', '--to', coachIdentity.name, '--message-file', messageFile, '--payload-file', payloadFile, '--idempotency-key', a.submission.idempotencyKey];
    if (parentThread) args.push('--thread', parentThread);
    const result = await exec('a2a-bridge', args, { cwd: root, timeout: 30000, maxBuffer: 2_000_000 });
    let receipt; try { receipt = JSON.parse(result.stdout); } catch { receipt = { output: result.stdout }; }
    a.submission = { ...a.submission, status: 'submitted', receipt, submittedAt: new Date().toISOString() };
    a.status = 'submitted';
  } catch (e) {
    a.submission = { ...a.submission, status: 'delivery_uncertain', detail: 'Delivery could not be confirmed. The report is saved. Reconcile the receipt before retrying.' };
  }
  await save(a); return a.submission;
}
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return json(res, 403, { error: 'Use the local Clarity Coach address.' });
    if (req.headers.origin && ![base, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: 'This service accepts local requests only.' });
    const url = new URL(req.url, base);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'mcp') {
      const a = parts[1] === 'local' ? [...records.values()].filter(item=>item.cwd===localCwd).sort((x,y)=>y.updatedAt.localeCompare(x.updatedAt))[0] || localWorkspace : records.get(parts[1]); if (!a) return json(res, 404, { error: 'Assessment not found.' });
      return await mcp(req, res, a);
    }
    if (url.pathname === '/api/state') return json(res, 200, { assessments: [...records.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(summary), steps, scale, categoricalScale, coach:coachIdentity, base, defaultCwd: process.env.HOME });
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n'); listeners.add(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
      req.on('close', () => { clearInterval(heartbeat); listeners.delete(res); }); return;
    }
    if (url.pathname === '/api/onboard' && req.method === 'POST') {
      const input = await body(req);
      // USER-AUTHORIZED — Marcus, November 15, 2026: obtain consent in the
      // welcome modal before connecting selected local harnesses automatically.
      if (input.consent !== true) throw new Error('Consent to connect your selected local harnesses is required.');
      const chosen = [...new Set(input.harnesses || [])];
      if (!chosen.length || chosen.some(name => !['codex','claude'].includes(name))) throw new Error('Choose Codex, Claude Code, or both.');
      const cwd = path.resolve(input.cwd || process.env.HOME);
      if (!(await stat(cwd)).isDirectory()) throw new Error('Choose an existing business workspace folder.');
      const cohortId = randomUUID();
      const assessments = [];
      for (const harness of chosen) {
        let a = [...records.values()].sort((x,y) => y.createdAt.localeCompare(x.createdAt)).find(a => a.harness === harness && a.cwd === cwd && !a.answers.assessment && !a.submission);
        if (!a) { a = { id: randomUUID(), harness, cwd, status: 'draft', createdAt: new Date().toISOString(), answers: {}, followups: [], events: [] }; records.set(a.id, a); }
        a.cohortId = cohortId;
        a.consent = { acceptedAt: new Date().toISOString(), harnesses: chosen, purpose: 'Complete the interview, save local CONTEXT.md, establish the A2A bridge, and prepare a non-sensitive POM + Agency report.' };
        a.automatic = true;
        event(a, 'coach', 'status', 'Connection permission received. Beginning your business assessment.');
        await save(a); assessments.push(a);
      }
      json(res, 202, { cohortId, assessments: assessments.map(summary) });
      for (const a of assessments) void advance(a);
      return;
    }
    if (url.pathname === '/api/bridge') return json(res, 200, await inspectBridge());
    if (url.pathname === '/api/harnesses') {
      const [codex, claude] = await Promise.all([availability('codex'), availability('claude')]);
      return json(res, 200, { codex, claude });
    }
    if (url.pathname === '/api/assessments' && req.method === 'POST') {
      const input = await body(req);
      if (!['codex','claude'].includes(input.harness)) throw new Error('Choose Codex or Claude Code.');
      const cwd = path.resolve(input.cwd || process.env.HOME);
      if (!(await stat(cwd)).isDirectory()) throw new Error('Choose an existing business workspace folder.');
      const a = { id: randomUUID(), harness: input.harness, cwd, status: 'draft', createdAt: new Date().toISOString(), answers: {}, followups: [] };
      records.set(a.id, a); await save(a); return json(res, 201, summary(a));
    }
    if (parts[0] === 'api' && parts[1] === 'assessments' && records.has(parts[2])) {
      const a = records.get(parts[2]);
      if (req.method === 'GET' && parts.length === 3) return json(res, 200, summary(a));
      if (req.method === 'POST') {
        const input = await body(req);
        if (parts[3] === 'run') { await run(a, input.stage === 'ratings' ? 'ratings' : 'interview'); return json(res, 202, summary(a)); }
        if (parts[3] === 'stop') { await stop(a, 'Stopped by you. Saved answers are retained.'); return json(res, 200, summary(a)); }
        if (parts[3] === 'resume') {
          if (!a.consent) throw new Error('Connect through the welcome dialog first.');
          a.automatic = true; await save(a); json(res, 202, summary(a)); void advance(a); return;
        }
        if (parts[3] === 'submit') { await submit(a); return json(res, 200, summary(a)); }
        if (parts[3] === 'snapshot') { a.assessmentFile = await savePomaAssessment(a); await save(a); return json(res, 200, summary(a)); }
        if (parts[3] === 'followups') {
          if (!['question','recommendation'].includes(input.kind) || !input.text?.trim()) throw new Error('Provide a question or recommendation.');
          a.followups.push({ id: randomUUID(), from: input.from || coachIdentity.name, kind: input.kind, text: input.text, createdAt: new Date().toISOString() });
          if (input.kind === 'question') { await setUserQuestions(a.cwd,{question:input.text,source:input.from || coachIdentity.name}); toolsChanged(a.cwd); }
          await save(a); return json(res, 201, summary(a));
        }
      }
    }
    const staticFiles = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'], '/logo.svg': ['logo.svg','image/svg+xml'] };
    const file = staticFiles[url.pathname];
    if (file) { res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(await readFile(path.join(root,'public',file[0]))); }
    return json(res, 404, { error: 'Not found.' });
  } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Clarity Coach → ${base}`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => {
  await Promise.all([...records.values()].filter(a => jobs.has(a.id)).map(a => stop(a, 'Local service stopped. Saved answers retained.')));
  for (const res of listeners) res.end();
  for (const stream of mcpStreams) stream.res.end();
  server.close(() => process.exit(0));
});
