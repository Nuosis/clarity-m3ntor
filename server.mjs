import http from 'node:http';
import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { mkdirSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dimensions, categoricalScale } from './questions.mjs';
import { savePomaReassessment } from './assessment-store.mjs';
import { readJournal, addJournal, questionState, setUserQuestions, readUserQuestions, businessTools } from './business-journal.mjs';
import { coachIdentity } from './coach-identity.mjs';
import { m3ntorTools, askM3ntor, assessPoma, getM3ntorResult, jobDirectory, jobRoot } from './m3ntor-jobs.mjs';
import { utilityTools, reportUtility, searchUtility, revokeUtility, boostUtility, resolveUtility } from './clarity-utility.mjs';
import { clarityRequest } from './clarity-client.mjs';
import { startA2AReceiver } from './a2a-receiver.mjs';
import { taskTools, startTaskQueue } from './task-queue.mjs';
import { REVIEW_PROCESS_ID } from './inov8-review-process.mjs';
import { triggerFlowTools } from './trigger-flow.mjs';
import { readPilotPending, startAgencyPilotObserver } from './agency-pilot-observer.mjs';
import { goalTools } from './goals.mjs';
import { environmentTools, readEnvironment, seedSources, recordSource, setPlate, recordProcess, deleteProcess, environmentCheck } from './environment.mjs';

// Local loopback MCP for the owner's harness: M3NT0R coaching and business
// assessment (run as local background jobs), private records, utility cases,
// and the installation's A2A receiver.
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4317);
const base = `http://127.0.0.1:${port}`;
const cwd = path.resolve(process.env.M3NTOR_WORKSPACE || process.env.HOME || root);
const harness = process.env.M3NTOR_HARNESS || 'codex';
const mcpUrl = `${base}/mcp/local`;
const mcpSessions = new Map();
const mcpStreams = new Set();
const contextPath = path.join(cwd, '.clarity_coach', 'CONTEXT.md');

const a2aStatusTool = { name: 'a2a_status', description: 'Use when checking whether other agents can reach the owner\'s agent, or when an expected agent-to-agent message has not arrived: returns this installation\'s Clarity A2A receiver state: stream connection (connecting, connected, ready, reconnecting, rejected, not_registered), agent handle, pending messages replayed on connect, last message and last error. Each received message is run in the owner\'s harness and answered with an A2A reply; per-message records are in .clarity_coach/a2a/messages.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } };

// Every saved assessment revision leaves one pending question in which the agent
// asks the owner whether it has been useful for getting their work done, and if so
// what has felt most useful; the answer is the owner testimony for utility reporting.
async function askAssessmentUtility(input, receipt) {
  const revision = String(receipt.revisionId || input.revision_id).toLowerCase();
  const id = `poma-utility-${revision}`;
  // Asked in the agent's own voice, in this order: whether it has been useful, then how
  // the owner wants it to improve. One of each per revision; answers are never reset.
  const questions = [
    { id, question: 'Have I been useful in getting your work done? If yes, what has felt the most useful?', source: 'm3ntor_assessment' },
    { id: `poma-improve-${revision}`, question: 'How would you like me to improve? What should I do better, or start doing for you?', source: 'm3ntor_assessment' },
  ];
  try {
    const state = await setUserQuestions(cwd, { questions, only_if_absent: true });
    toolsChanged();
    return { id, status: state.questions.find(item => item.id === id)?.status || 'unknown', improvement_id: questions[1].id, improvement_status: state.questions.find(item => item.id === questions[1].id)?.status || 'unknown' };
  } catch (error) { return { id, status: 'failed', error: error.message }; }
}

// Submit the separate non-sensitive summary to Clarity. Submission is required: the exact
// payload is kept in a pending file until Clarity accepts it, retried with backoff and at
// every start, and the outcome is recorded in the assessment's receipt.
const reassessmentDir = () => path.join(cwd, '.clarity_coach', 'reassessments');
function submissionPayload(input, profile, assessedAt) {
  return {
    revision_id: input.revision_id, status: input.status === 'draft' ? 'draft' : 'final',
    // Only category and score leave the machine; rationales cite private sources.
    assessed_at: assessedAt, coaching_summary: input.coaching_summary, profile,
    ratings: Object.fromEntries(Object.entries(input.ratings || {}).map(([area, rating]) => [area, { category: rating?.category, score: rating?.score }])),
  };
}
async function recordSubmission(revisionId, submission) {
  const directory = reassessmentDir();
  await writeFile(path.join(directory, `${revisionId}.submission.json`), JSON.stringify(submission, null, 2), { mode: 0o600 });
  const receiptFile = path.join(directory, `${revisionId}.json`);
  const receipt = await readJson(receiptFile, null);
  if (receipt) await writeFile(receiptFile, JSON.stringify({ ...receipt, submitted: submission.saved === true, submitted_at: submission.submitted_at || null }, null, 2), { mode: 0o600 });
}
// One submission at a time per revision, so a retry cannot overtake a newer save of it.
const revisionLocks = new Map();
function withRevisionLock(revisionId, action) {
  const previous = revisionLocks.get(revisionId) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  // The stored copy swallows failures (the caller handles the returned promise), so a
  // failed submission can never become an unhandled rejection that stops the service.
  const settled = next.catch(() => {}).finally(() => { if (revisionLocks.get(revisionId) === settled) revisionLocks.delete(revisionId); });
  revisionLocks.set(revisionId, settled);
  return next;
}
async function submitPayload(payload) {
  return withRevisionLock(String(payload.revision_id).toLowerCase(), () => submitPayloadNow(payload));
}
async function submitPayloadNow(payload) {
  const revisionId = String(payload.revision_id).toLowerCase();
  const pendingFile = path.join(reassessmentDir(), `${revisionId}.pending-submission.json`);
  let submission;
  try {
    const response = await clarityRequest('POST', '/agent/mentor/assessments', payload);
    submission = { saved: response.saved === true, created: response.created, agent_id: response.agent_id, updated_at: response.assessment?.updated_at, submitted_at: new Date().toISOString() };
  } catch (error) { submission = { saved: false, error: error.message, attempted_at: new Date().toISOString() }; }
  try {
    if (submission.saved) await unlink(pendingFile).catch(() => {});
    else { await writeFile(pendingFile, JSON.stringify(payload, null, 2), { mode: 0o600 }); scheduleSubmissionRetry(); }
    await recordSubmission(revisionId, submission);
  } catch (error) { submission.receipt_error = error.message; }
  return submission;
}
async function submitAssessment(cwd_, input, profile, assessedAt) {
  return submitPayload(submissionPayload(input, profile, assessedAt));
}
// When the owner says what has been most useful, the owner's agent researches how that
// solution works here, well enough for another agent to replicate it, and submits it
// to the shared utility library. One task per answered question.
const researchLocks = new Map();
function queueUseCaseResearch(questionId, answer) {
  const previous = researchLocks.get(questionId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => queueUseCaseResearchNow(questionId, answer));
  const settled = next.catch(() => {}).finally(() => { if (researchLocks.get(questionId) === settled) researchLocks.delete(questionId); });
  researchLocks.set(questionId, settled);
  return next;
}
async function queueUseCaseResearchNow(questionId, answer) {
  if (!String(questionId).startsWith('poma-utility-') || !String(answer || '').trim()) return null;
  const existing = (await taskQueue.call('list_tasks', {})).tasks.find(task => task.category === 'use_case' && task.instruction.includes(questionId));
  if (existing) return existing.id;
  const created = await taskQueue.call('set_task', {
    title: 'Write up what has been most useful',
    category: 'use_case',
    instruction: `The owner answered "Have I been useful in getting your work done? If yes, what has felt the most useful?" with: "${answer.trim()}" (question ${questionId}).\n\nIf the owner said nothing has been useful, journal that with add_journal and stop. Otherwise research the solution they named as it works in this business: find it in the journal, tasks, local files, scripts, configuration and earlier agent sessions. Work out what it does, what triggers it, the steps it takes, the tools and access it needs, and the result it produces, in enough detail that another business's agent could replicate it. First search_utility for it: when a case already matches, boost it with boost_utility (with variant_id when a variant matches), report the case_id and stop. Otherwise submit it with report_utility: a new UUID submission_id; title; summary; process (the steps); prerequisites; agent_actions; outcome; owner_feedback (the owner's words above); poma_labels; tags; evidence (kind owner_reported, with limitations); source_kind user_reported. Keep it non-sensitive: no names of people or customers, contact details, amounts, credentials, hostnames or file paths. If the receipt says similar_exists, resolve it with resolve_utility (variant with only the distinct aspects, boost, or distinct). Report the case_id returned.`,
    success: 'report_utility or boost_utility returned a case_id (a held submission resolved with resolve_utility) for a replicable, non-sensitive write-up of the solution the owner named (or the owner said nothing was useful and that is journaled).',
    constraints: ['Read-only research: change nothing in the business while researching.', 'Share only the non-sensitive write-up; private records stay local.'],
  });
  return created.task.id;
}

let retryTimer = null, retryDelay = 60000;
function scheduleSubmissionRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    let left = 1;
    try { left = await retryPendingSubmissions(); } catch (error) { console.error('Assessment submission retry failed:', error.message); }
    if (left) { retryDelay = Math.min(retryDelay * 2, 3600000); scheduleSubmissionRetry(); } else retryDelay = 60000;
  }, retryDelay);
}
// Returns how many submissions are still pending. A pending file is removed only if it is
// unchanged since it was read, so a newer save of the same revision is never discarded.
async function retryPendingSubmissions() {
  let files = [];
  try { files = (await readdir(reassessmentDir())).filter(name => name.endsWith('.pending-submission.json')); } catch {}
  let left = 0;
  for (const file of files) {
    const pendingFile = path.join(reassessmentDir(), file);
    try {
      const done = await withRevisionLock(file.replace('.pending-submission.json', ''), async () => {
        let raw; try { raw = await readFile(pendingFile, 'utf8'); } catch { return true; }
        const payload = JSON.parse(raw);
        let submission;
        try {
          const response = await clarityRequest('POST', '/agent/mentor/assessments', payload);
          submission = { saved: response.saved === true, created: response.created, agent_id: response.agent_id, updated_at: response.assessment?.updated_at, submitted_at: new Date().toISOString(), retried: true };
        } catch (error) { submission = { saved: false, error: error.message, attempted_at: new Date().toISOString() }; }
        if (submission.saved && await readFile(pendingFile, 'utf8').catch(() => null) === raw) await unlink(pendingFile).catch(() => {});
        await recordSubmission(String(payload.revision_id).toLowerCase(), submission);
        return submission.saved;
      });
      if (!done) left++;
    } catch (error) { left++; console.error(`Assessment submission retry for ${file} failed:`, error.message); }
  }
  return left;
}

const ratingSchema = { type: 'object', description: 'This dimension\'s rating.', properties: { category: { type: 'string', enum: categoricalScale.map(item => item.category), description: 'The categorical level the evidence supports.' }, score: { type: 'integer', minimum: 1, maximum: 10, description: 'Score from 1 to 10 within that category.' }, rationale: { type: 'string', description: 'The evidence for the rating (kept local; never submitted).' } }, required: ['category', 'score', 'rationale'], additionalProperties: false };
const ratingsSchema = { type: 'object', description: 'One rating per POMA dimension.', properties: Object.fromEntries(dimensions.map(key => [key, ratingSchema])), required: dimensions, additionalProperties: false };
const textOrJson = description => ({ type: ['string', 'object', 'array'], description: `${description} Text or structured JSON.` });
const tools = [
  { name: 'save_poma_reassessment', description: 'Use at the end of an assessment run (assess_poma), including when your harness filesystem is read-only: save the prepared business POMA assessment through this local service. Use the task revision_id UUID consistently. Saves one dated private revision, appends/updates its context section and journal entry, and saves a SEPARATE non-sensitive coaching summary locally. Workspace paths are fixed by this MCP connection. Repeating the same revision reconciles it without duplicates; prior revisions/unrelated context stay intact. After the local save it submits ONLY the coaching_summary, each area\'s category and score (never rationales) and coaching_profile to Clarity with this installation\'s token; resubmitting the same revision updates it. Returns actual per-artifact saved states, paths, the Clarity submission receipt or its failure.', inputSchema: { type: 'object', properties: { revision_id: { type: 'string', format: 'uuid', description: 'The assessment\'s revision UUID from its task; reuse it when retrying the same assessment.' }, ratings: ratingsSchema, evidence: textOrJson('Local evidence and source references, including explicit gaps.'), coverage: textOrJson('Business/process/source/period coverage and exclusions.'), uncertainty: textOrJson('Evidence limits and uncertainty for the business-linked ratings.'), comparison: textOrJson('Actual business change versus newly discovered evidence or corrected interpretation.'), productivity: textOrJson('Supported calculation or labelled estimate with scope, period, currency, definitions and total-human-hour coverage, or specific missing evidence.'), status: { type: 'string', description: 'Actual assessment lifecycle status; defaults to final.' }, harness: { type: 'string', enum: ['codex', 'claude'], description: 'Actual local harness, when known.' }, context_update: { type: 'string', description: 'Detailed reassessment Markdown section; do not replace unrelated existing CONTEXT.' }, journal_entry: { type: 'string', description: 'Business-related reassessment journal entry.' }, coaching_summary: { type: 'string', description: 'SEPARATE non-sensitive coaching summary; exclude raw context, financial/working-hours details, private identifiers, paths and credentials.' }, owner_summary: { type: 'string', description: 'The summary the owner reads in the owner view, in Markdown with two sections: what is working, and where we should focus next. Plain language at reading grade 10 or below; no IDs, status labels, scores already shown, or instructions to agents.' }, coaching_profile: { type: 'object', description: 'Non-sensitive registration/coaching profile submitted with the summary.', properties: { industry: { type: 'string', description: 'The business\'s industry.' }, products_services: { type: 'string', description: 'What it sells.' }, service_area: { type: 'string', description: 'Where it serves customers (region, not addresses).' }, condensed_context: { type: 'string', description: 'A short non-sensitive description of the business.' } }, additionalProperties: false } }, required: ['revision_id','ratings','evidence','coverage','uncertainty','comparison','productivity','context_update','journal_entry','coaching_summary','owner_summary'], additionalProperties: false } },
  { name: 'get_task', description: 'Read a task’s saved contract, run history, and any registered continuation with its owner, checkpoint, return route, and event or failure evidence. Use when resuming a task or deciding what can proceed.', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task, from list_tasks or set_task.' }, since: { type: 'string', format: 'date-time', description: 'Only runs that finished after this time or are still running (for example the last review\'s finished_at); omit for every run.' } }, required: ['task_id'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'list_assessments', description: 'Use when you need the owner\'s current POMA ratings or how they changed, e.g. before coaching or checking a stage that needs a score: returns saved assessments, newest first, with revision, date, status, ratings and report.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 26, description: 'How many to return; default 2 (latest and previous).' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'list_running_jobs', description: 'Use before starting an assessment, coaching run or goal review, to avoid starting a duplicate, or when checking what the agent is doing now: returns M3NT0R jobs queued or running (assessment, coaching, tasks, A2A), newest first.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'read_answered_questions', description: 'Use before planning, coaching or asking the owner anything, so their earlier answers direct the work and are not asked again: returns the owner\u2019s answered and dismissed Coach questions, newest first (up to 50), with their answers.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'revoke_utility', description: 'Use when a case this business submitted with report_utility turns out wrong, sensitive or no longer true: revoke it from the Clarity utility library. Cases submitted by others are refused.', inputSchema: { type: 'object', properties: { case_id: { type: 'string', description: 'The case_id that report_utility returned.' } }, required: ['case_id'], additionalProperties: false } },
  { name: 'get_coaching_context', description: 'Use at the start of business work when you need to know the owner\'s business: returns the owner\u2019s private local business context (.clarity_coach/CONTEXT.md) and the coach identity. Read today\u2019s journal before offering outstanding Coach questions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
];
function json(res, status, value, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); }
async function body(req) {
  let raw = '';
  for await (const part of req) { raw += part; if (raw.length > 2_000_000) throw new Error('Request is too large.'); }
  return raw ? JSON.parse(raw) : {};
}
function toolsChanged() {
  const notification = `event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})}\n\n`;
  for (const stream of mcpStreams) stream.res.write(notification);
}
const questionInstructions = 'At the start of a session, read today’s business journal with read_journal and check user_question_read. Before offering outstanding questions, today’s journal must have been read. When permitted and questions are pending, briefly ask whether the user has time to answer some Coach questions; continue their work if not. Record a no using user_question_set(action="defer") or add_journal(user_declined_questions=true): no more offers for four hours unless the user directly raises these questions. Set new business questions with user_question_set. Local journal and question contents are never report attachments.';
// M3NT0R coaching jobs connect to /mcp/coach, which offers read tools plus set_goal.
// USER-AUTHORIZED — Marcus, November 18, 2026: M3NT0R sets the goals and inov8 (the
// hourly goal loop) implements them, so set_goal is offered only on the coaching connection.
const COACH_TOOLS = new Set(['search_utility', 'read_journal', 'get_coaching_context', 'user_question_read', 'list_tasks', 'get_task', 'list_assessments', 'read_answered_questions', 'list_goals', 'read_environment', 'set_goal']);
const COACH_ONLY_TOOLS = new Set(['set_goal']);
async function mcp(req, res, coach = false) {
  const sessionId = req.headers['mcp-session-id'];
  const session = mcpSessions.get(sessionId);
  if (req.method === 'DELETE') {
    mcpSessions.delete(sessionId);
    for (const stream of mcpStreams) if (stream.sessionId === sessionId) stream.res.end();
    res.writeHead(204); return res.end();
  }
  if (req.method === 'GET') {
    if (!session) return json(res,404,{error:'Initialize this MCP session first.'});
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
    res.write(': connected\n\n');
    const stream={res,sessionId};mcpStreams.add(stream);
    const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);
    req.on('close',()=>{clearInterval(heartbeat);mcpStreams.delete(stream);});return;
  }
  const call = await body(req);
  if (!('id' in call)) { res.writeHead(202); return res.end(); }
  let result;
  if (call.method === 'initialize') {
    const id=randomUUID();mcpSessions.set(id,{createdAt:new Date().toISOString()});
    result={protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'clarity_m3ntor',version:'0.8.0'},instructions:'Use the local business context and coaching tools to support your owner. '+questionInstructions+' Ask M3NT0R with ask_m3ntor or assess the owner\u2019s business with assess_poma (reassess_poma is a compatibility alias for the same prompt). Save assessment artifacts through save_poma_reassessment, including from a read-only harness; retrieve either running job with get_m3ntor_result.'};
    return json(res,200,{jsonrpc:'2.0',id:call.id,result},{'Mcp-Session-Id':id});
  }
  if (call.method !== 'ping' && !session) return json(res,404,{error:'MCP session is missing or expired; initialize again.'});
  if (call.method === 'ping') result = {};
  else if (call.method === 'tools/list') {
    const all = [...m3ntorTools, ...utilityTools, a2aStatusTool, ...taskTools, ...goalTools, ...triggerFlowTools, ...environmentTools, ...tools, ...businessTools(await questionState(cwd))];
    result = { tools: all.filter(tool => coach ? COACH_TOOLS.has(tool.name) : !COACH_ONLY_TOOLS.has(tool.name)) };
  }
  else if (call.method === 'tools/call') {
    try {
      const { name, arguments: input = {} } = call.params;
      if (coach && !COACH_TOOLS.has(name)) throw new Error('This coaching connection offers only M3NT0R\'s read tools and set_goal.');
      if (!coach && COACH_ONLY_TOOLS.has(name)) throw new Error('M3NT0R sets the goals: ask it with ask_m3ntor, describing the capability and why.');
      if (coach && name === 'set_goal') input.source = 'm3ntor';
      if (name === 'ask_m3ntor' || name === 'assess_poma' || name === 'reassess_poma') {
        const job = await (name === 'ask_m3ntor' ? askM3ntor : assessPoma)(input, { cwd, harness, mcpUrl });
        if (name === 'ask_m3ntor') taskQueue.noteAction(job.job_id);
        result = { ...(job.status === 'failed' || job.status === 'interrupted' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(job) }] };
      } else if (name === 'get_m3ntor_result') {
        const job = await getM3ntorResult(input.job_id);
        result = { ...(job.status === 'failed' || job.status === 'interrupted' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(job) }] };
      } else if (name === 'save_poma_reassessment') {
        const { coaching_profile: coachingProfile = {}, ...localInput } = input;
        const receipt = await savePomaReassessment(cwd, localInput, { assessmentId: 'local', harness });
        if (receipt.saved) receipt.submission = await submitAssessment(cwd, input, coachingProfile, receipt.assessedAt);
        receipt.submitted = receipt.submission?.saved === true;
        if (receipt.saved) receipt.utility_question = await askAssessmentUtility(input, receipt);
        // The working environment's source list starts from the first saved assessment's information centres.
        if (receipt.saved) { await seedSources(cwd).catch(error => console.error('Seeding the source list failed:', error.message)); taskQueue.poke(); }
        result = { ...(!receipt.saved || !receipt.submitted ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } else if (taskTools.some(tool => tool.name === name) || goalTools.some(tool => tool.name === name) || triggerFlowTools.some(tool => tool.name === name)) {
        result = { content: [{ type: 'text', text: JSON.stringify(await taskQueue.call(name, input)) }] };
      } else if (name === 'a2a_status') {
        result = { content: [{ type: 'text', text: JSON.stringify(a2aReceiver.status()) }] };
      } else if (['report_utility', 'search_utility', 'boost_utility', 'resolve_utility'].includes(name)) {
        const response = await ({ report_utility: reportUtility, search_utility: searchUtility, boost_utility: boostUtility, resolve_utility: resolveUtility })[name](input);
        result = { content: [{ type: 'text', text: JSON.stringify(response) }] };
      } else if (name === 'read_journal') {
        const journal=await readJournal(cwd,input);
        if (Object.hasOwn(journal.revisions,journal.today)) { session.journalDate=journal.today;session.journalRevision=journal.revisions[journal.today]; }
        result={content:[{type:'text',text:JSON.stringify(journal.entries)}]};
      } else if (name === 'add_journal') {
        const added=await addJournal(cwd,input);
        if(input.user_declined_questions) toolsChanged();
        result={content:[{type:'text',text:JSON.stringify(added)}]};
      } else if (name === 'user_question_set' || name === 'suser_question_set') {
        // Questions asked while inov8 reviews a goal are inov8's: the service knows the review is waiting on them.
        const asking=(input.action || 'set')==='set';
        const updated=await setUserQuestions(cwd,asking && taskQueue.reviewing() ? { ...input, source: 'inov8', ...(input.questions ? { questions: input.questions.map(q => ({ ...q, source: 'inov8' })) } : {}) } : input);toolsChanged();taskQueue.poke();
        if (input.action === 'answer') await queueUseCaseResearch(input.question_id, input.answer).catch(error => console.error('Use case research task failed:', error.message));
        if (['answer', 'dismiss'].includes(input.action)) taskQueue.questionsSettled({ channel: 'local_tool', action: input.action, question_id: input.question_id });
        result={content:[{type:'text',text:JSON.stringify(updated)}]};
      } else if (name === 'user_question_read' || /^user_questions_\d+$/.test(name)) {
        result={content:[{type:'text',text:JSON.stringify(await readUserQuestions(cwd,session,input))}]};
      } else if (name === 'read_environment') {
        const record = await readEnvironment(cwd);
        result = { content: [{ type: 'text', text: JSON.stringify({ ...record, internal_processes: taskQueue.internalProcesses(), missing: { infrastructure: await environmentCheck(cwd, 'infrastructure'), observability: await environmentCheck(cwd, 'observability'), process: await environmentCheck(cwd, 'process') } }) }] };
      } else if (['record_source', 'set_plate', 'record_process', 'delete_process'].includes(name)) {
        const saved = await ({ record_source: recordSource, set_plate: setPlate, record_process: recordProcess, delete_process: deleteProcess })[name](cwd, input);
        taskQueue.poke();
        result = { content: [{ type: 'text', text: JSON.stringify(saved) }] };
      } else if (name === 'get_task') {
        const detail = taskQueue.detail(input.task_id);
        if (!detail) throw new Error('Task not found.');
        if (input.since) detail.runs = detail.runs.filter(run => !run.finished_at || run.finished_at > new Date(input.since).toISOString());
        for (const run of detail.runs) run.process = await jobProcess(run.job_id);
        result = { content: [{ type: 'text', text: JSON.stringify(detail) }] };
      } else if (name === 'list_assessments') {
        result = { content: [{ type: 'text', text: JSON.stringify((await assessments()).slice(0, input.limit || 2)) }] };
      } else if (name === 'list_running_jobs') {
        result = { content: [{ type: 'text', text: JSON.stringify(await runningJobs()) }] };
      } else if (name === 'read_answered_questions') {
        const state = await questionState(cwd);
        result = { content: [{ type: 'text', text: JSON.stringify(state.questions.filter(q => q.status !== 'pending').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 50)) }] };
      } else if (name === 'revoke_utility') {
        try { result = { content: [{ type: 'text', text: JSON.stringify(await revokeUtility(input.case_id)) }] }; }
        catch (error) { throw new Error(/HTTP 403/.test(error.message) ? 'Only use cases this business submitted can be revoked.' : error.message); }
      } else if (name === 'get_coaching_context') {
        let existingContext = '';
        try { existingContext = await readFile(contextPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        result = { content: [{ type: 'text', text: JSON.stringify({ coach: coachIdentity, contextPath, existingContext, localOnly: true }) }] };
      } else throw new Error('Unknown tool.');
    } catch (e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
  } else if (call.method === 'resources/list') result = { resources: [] };
  else if (call.method === 'prompts/list') result = { prompts: [] };
  else return json(res, 200, { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found' } });
  json(res, 200, { jsonrpc: '2.0', id: call.id, result });
}
// ---- Owner view: read-mostly API for the UI in ui/ -----------------------------
const clarityDir = path.join(cwd, '.clarity_coach');
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } }
async function assessments() {
  let days = [];
  try { days = (await readdir(path.join(clarityDir, 'assessment'))).filter(name => name.endsWith('.json')).sort().reverse(); } catch {}
  const list = [];
  for (const day of days.slice(0, 26)) for (const item of (await readJson(path.join(clarityDir, 'assessment', day), { assessments: [] })).assessments || []) {
    let report = '';
    if (item.revisionId) try { report = await readFile(path.join(clarityDir, 'reports', `${item.revisionId}.md`), 'utf8'); } catch {}
    list.push({ revision_id: item.revisionId, assessed_at: item.assessedAt, status: item.status, ratings: item.ratings, summary: item.summary || '', owner_summary: item.owner_summary || '', report });
  }
  return list.sort((a, b) => String(b.assessed_at).localeCompare(String(a.assessed_at)));
}
async function journalDays(days = 14) {
  const to = new Date(); const from = new Date(to.getTime() - (days - 1) * 86400000);
  const { entries } = await readJournal(cwd, { from_date: from.toLocaleDateString('en-CA'), to_date: to.toLocaleDateString('en-CA') });
  return Object.entries(entries).map(([key, items]) => ({ date: key.replace('_entries', ''), entries: items })).filter(day => day.entries.length).reverse();
}
// What the agent did in a run, from its job transcript: tool steps and the final result.
async function jobProcess(jobId) {
  if (!jobId) return null;
  const directory = jobDirectory(jobId); const steps = [];
  let raw = '';
  try { raw = await readFile(path.join(directory, 'harness.stdout.jsonl'), 'utf8'); } catch {}
  for (const line of raw.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    for (const part of event.message?.content || []) if (part?.type === 'tool_use') steps.push({ tool: part.name.replace(/^mcp__clarity_m3ntor__/, ''), input: JSON.stringify(part.input || {}).slice(0, 300) });
    const item = event.item;
    if (event.type === 'item.completed' && ['mcp_tool_call', 'command_execution', 'web_search'].includes(item?.type)) steps.push({ tool: item.tool || item.type, input: String(item.command || JSON.stringify(item.arguments || item.query || '')).slice(0, 300) });
    if (steps.length >= 200) break;
  }
  let output = ''; try { output = await readFile(path.join(directory, 'output.txt'), 'utf8'); } catch {}
  const state = await readJson(path.join(directory, 'state.json'), {});
  return { status: state.status, started_at: state.started_at, finished_at: state.finished_at, error: state.error || null, steps, output };
}
// M3NT0R jobs still queued or running (assessment, coaching, tasks, A2A), newest first.
async function runningJobs() {
  let names = [];
  try { names = await readdir(jobRoot); } catch { return []; }
  const recent = [];
  for (const name of names) {
    try { const info = await stat(path.join(jobRoot, name, 'state.json')); if (Date.now() - info.mtimeMs < 2 * 86400000) recent.push(name); } catch {}
  }
  const jobs = [];
  for (const name of recent) {
    try {
      const job = await getM3ntorResult(name);
      if (['queued', 'running'].includes(job.status)) jobs.push({ job_id: job.job_id, task: job.task, status: job.status, stage: job.stage, started_at: job.started_at || job.created_at });
    } catch {}
  }
  return jobs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

// Saved run history for the owner's activity timeline; reading never starts work.
async function activityHistory() {
  const names = await readdir(jobRoot).catch(() => []);
  const since = Date.now() - 14 * 86400000;
  const jobs = await Promise.all(names.map(async id => {
    try {
      const state = await readJson(path.join(jobDirectory(id), 'state.json'), {});
      const at = state.started_at || state.created_at;
      if (!at || new Date(state.finished_at || at).getTime() < since) return null;
      const job = await getM3ntorResult(id);
      const output = job.output || '';
      const summary = output.split(/\n\s*\n/).find(part => part.trim() && !/^STATUS:|^Turn summary:/i.test(part.trim())) || '';
      return { job_id: id, task: job.task, status: job.status, started_at: at,
        finished_at: job.finished_at, summary: (job.error || summary).slice(0, 600) };
    } catch { return null; }
  }));
  return jobs.filter(Boolean).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

async function overview() {
  const { tasks, worker } = await taskQueue.call('list_tasks', {});
  const questions = await questionState(cwd);
  const journal = await journalDays();
  return {
    worker, tasks, a2a: a2aReceiver.status(), running: await runningJobs(),
    context: await readFile(contextPath, 'utf8').catch(() => ''),
    questions: { pending: questions.pending, answered: questions.questions.filter(q => q.status !== 'pending').slice(-20).reverse(), deferred_until: questions.deferred ? questions.deferUntil : null },
    assessments: await assessments(),
    ...taskQueue.goals(),
    internal_processes: taskQueue.internalProcesses(),
    triggers: taskQueue.listTriggers(),
    environment: await readEnvironment(cwd),
    journal, activity: await activityHistory(),
  };
}
// Live updates for the owner view: one change event whenever .clarity_coach changes.
const uiListeners = new Set();
let uiChangeTimer = null;
mkdirSync(clarityDir, { recursive: true, mode: 0o700 });
mkdirSync(jobRoot, { recursive: true, mode: 0o700 });
const notifyUi = () => { clearTimeout(uiChangeTimer); uiChangeTimer = setTimeout(() => { for (const res of uiListeners) res.write('event: changed\ndata: {}\n\n'); }, 300); };
try { watch(jobRoot, { recursive: true }, notifyUi); } catch (error) { console.error('Job change watch unavailable:', error.message); }
// When the owner view's own files change, open pages reload to pick up the new version.
let uiReloadTimer = null;
try { watch(path.join(root, 'ui'), () => { clearTimeout(uiReloadTimer); uiReloadTimer = setTimeout(() => { for (const res of uiListeners) res.write('event: reload\ndata: {}\n\n'); }, 300); }); } catch {}
try { watch(clarityDir, { recursive: true }, () => { clearTimeout(uiChangeTimer); uiChangeTimer = setTimeout(() => { for (const res of uiListeners) res.write('event: changed\ndata: {}\n\n'); }, 300); }); }
catch (error) { console.error('Owner view change watch unavailable:', error.message); }
async function ownerApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n'); uiListeners.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); uiListeners.delete(res); });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/activity/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/activity/'.length));
    jobDirectory(id);
    const result = await getM3ntorResult(id);
    return json(res, 200, { job_id: id, status: result.status, output: result.output || '', error: result.error || null, started_at: result.started_at, finished_at: result.finished_at });
  }
  if (req.method === 'GET' && url.pathname === '/api/overview') return json(res, 200, await overview());
  if (req.method === 'GET' && url.pathname === '/api/triggers') {
    return json(res, 200, { triggers: taskQueue.listTriggers(url.searchParams.get('flow_id') || null) });
  }
  if (req.method === 'POST' && url.pathname === '/api/triggers') {
    return json(res, 200, taskQueue.registerTrigger(await body(req)));
  }
  if (req.method === 'POST' && parts[1] === 'triggers' && parts[2] && parts[3] === 'fire' && parts.length === 4) {
    const input = await body(req);
    return json(res, 200, taskQueue.receiveTrigger({ ...input, trigger_id: decodeURIComponent(parts[2]) }));
  }
  if (parts[1] === 'processes' && parts[2]) {
    const processId = decodeURIComponent(parts[2]);
    if (req.method === 'GET' && parts[3] === 'runs' && parts.length === 4) {
      const unified = taskQueue.listFlowRuns(processId);
      if (processId === REVIEW_PROCESS_ID) {
        const legacy = await taskQueue.reviewRuns();
        const seen = new Set(unified.map(item => item.id));
        const merged = [...unified, ...legacy.filter(item => !seen.has(item.id))].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return json(res, 200, { runs: merged });
      }
      return json(res, 200, { runs: unified });
    }
    if (req.method === 'GET' && parts[3] === 'runs' && parts.length === 5) {
      const runId = decodeURIComponent(parts[4]);
      const run = taskQueue.getFlowRun(runId) || (processId === REVIEW_PROCESS_ID ? await taskQueue.reviewRun(runId) : null);
      return run ? json(res, 200, run) : json(res, 404, { error: 'Flow run not found.' });
    }
    if (processId === REVIEW_PROCESS_ID && req.method === 'POST' && parts[3] === 'configuration' && parts.length === 4) {
      return json(res, 200, { configuration: taskQueue.configureReview(await body(req)) });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/agency-pilot/source-status') {
    const pending = await readPilotPending(cwd);
    return json(res, 200, { observer: pending ? { state: pending.state, last_error: pending.last_error, connected_at: pending.connected_at, updated_at: pending.updated_at } : null, queue: taskQueue.agencyPilotSources() });
  }
  // The owner's pending Coach questions, for the harness session-start hook.
  if (req.method === 'GET' && url.pathname === '/api/questions/pending') {
    const state = await questionState(cwd);
    return json(res, 200, { pending: state.pending.map(q => ({ id: q.id, question: q.question, source: q.source, created_at: q.createdAt })), deferred_until: state.deferred ? state.deferUntil : null });
  }
  if (req.method === 'GET' && parts[1] === 'tasks' && parts[2]) {
    const detail = taskQueue.detail(parts[2]);
    if (!detail) return json(res, 404, { error: 'Task not found.' });
    for (const run of detail.runs) run.process = await jobProcess(run.job_id);
    return json(res, 200, detail);
  }
  if (req.method === 'POST' && parts[1] === 'questions' && parts[2]) {
    const input = await body(req);
    if (!['answer', 'dismiss'].includes(input.action)) throw new Error('Use answer or dismiss.');
    await setUserQuestions(cwd, { action: input.action, question_id: parts[2], answer: input.answer, reason: input.reason });
    toolsChanged(); taskQueue.poke();
    if (input.action === 'answer') await queueUseCaseResearch(parts[2], input.answer).catch(error => console.error('Use case research task failed:', error.message));
    if (['answer', 'dismiss'].includes(input.action)) taskQueue.questionsSettled({ channel: 'owner_view', action: input.action, question_id: parts[2] });
    return json(res, 200, await overview());
  }
  if (req.method === 'GET' && url.pathname === '/api/use-cases') {
    const labels = url.searchParams.getAll('label').filter(Boolean);
    const tags = (url.searchParams.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean);
    const source = url.searchParams.get('source') || undefined;
    try {
      const found = await searchUtility({ query: url.searchParams.get('q') || '', poma_labels: labels, tags, ...(source ? { source_kind: source } : {}), limit: 50 });
      if (found.status !== 'ok' || !Array.isArray(found.results)) return json(res, 502, { error: `The use case library is unavailable: ${found.error || found.status || 'no results returned'}` });
      return json(res, 200, { cases: (found.results || []).map(item => ({ ...item.case, boosts: item.case?.boosts ?? item.boosts ?? 0, own: item.own === true })), mode: found.retrieval_mode });
    } catch (error) { return json(res, 502, { error: `The use case library is unavailable: ${error.message}` }); }
  }
  if (req.method === 'POST' && parts[1] === 'use-cases' && parts[2] && parts[3] === 'revoke') {
    try { return json(res, 200, await revokeUtility(parts[2])); }
    catch (error) { return json(res, /HTTP 403/.test(error.message) ? 403 : 502, { error: /HTTP 403/.test(error.message) ? 'Only use cases your business submitted can be revoked.' : error.message }); }
  }
  if (req.method === 'POST' && parts[1] === 'goals' && parts[2] && parts[3] === 'stop') {
    const input = await body(req);
    await taskQueue.call('stop_goal', { goal_id: parts[2], reason: input.reason });
    return json(res, 200, await overview());
  }
  if (req.method === 'POST' && url.pathname === '/api/notes') {
    const input = await body(req);
    if (!input.note?.trim()) throw new Error('Write something first.');
    await addJournal(cwd, { kind: 'owner_note', source: 'owner_note', content: input.note.trim() });
    taskQueue.poke();
    return json(res, 200, await overview());
  }
  if (req.method === 'POST' && url.pathname === '/api/goals/run') {
    await taskQueue.runReview('owner_view');
    return json(res, 200, await overview());
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const input = await body(req);
    if (input.pace) taskQueue.call('set_pace', { pace: input.pace, ...(input.time ? { time: input.time } : {}) });
    if (input.agent_harness) taskQueue.call('set_agent_harness', { harness: input.agent_harness });
    if (typeof input.full_access === 'boolean') taskQueue.call('set_full_access', { enabled: input.full_access });
    return json(res, 200, await overview());
  }
  return json(res, 404, { error: 'Not found.' });
}
const UI_FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/processes.js': ['processes.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/logo.svg': ['logo.svg', 'image/svg+xml'], '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/favicon-32.png': ['favicon-32.png', 'image/png'], '/favicon.ico': ['favicon.ico', 'image/x-icon'] };

const server = http.createServer(async (req, res) => {
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, 403, { error: 'Use the local Clarity M3NT0R address.' });
    if (req.headers.origin && ![base, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: 'This service accepts local requests only.' });
    const url = new URL(req.url, base);
    if (url.pathname === '/mcp/local') return await mcp(req, res);
    if (url.pathname === '/mcp/coach') return await mcp(req, res, true);
    if (url.pathname.startsWith('/api/')) return await ownerApi(req, res, url);
    const file = UI_FILES[url.pathname];
    if (file && req.method === 'GET') { res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(await readFile(path.join(root, 'ui', file[0]))); }
    return json(res, 404, { error: 'Not found.' });
  } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message }); }
});
// This service holds the installation's A2A stream for as long as it runs.
const a2aReceiver = startA2AReceiver({ cwd, harness, mcpUrl });
// The owner's action queue runs due tasks for as long as this service runs.
await seedSources(cwd).catch(error => console.error('Seeding the source list failed:', error.message));
const taskQueue = startTaskQueue({ cwd, harness, mcpUrl, latestAssessment: async () => (await assessments())[0] || null });
// The existing pilot CASE opts this installation into its bounded source observer.
// No separate receiver identity, inbox claim, auth configuration or execution engine.
const agencyPilotObserver = await startAgencyPilotObserver({ cwd }).catch(error => {
  console.error('Agency pilot observer stopped:', error.message);
  return { stop() {} };
});
retryPendingSubmissions().then(left => { if (left) scheduleSubmissionRetry(); }, error => { console.error('Assessment submission retry failed:', error.message); scheduleSubmissionRetry(); });
server.listen(port, '127.0.0.1', () => console.log(`Clarity M3NT0R MCP → ${mcpUrl} · owner view → ${base}/`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
  const observerStopped = Promise.resolve(agencyPilotObserver.stop()).catch(error => console.error('Agency pilot observer shutdown failed:', error.message));
  taskQueue.close();
  for (const stream of mcpStreams) stream.res.end();
  for (const res of uiListeners) res.end();
  server.close(() => { observerStopped.finally(() => process.exit(0)); });
});
