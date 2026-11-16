import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dimensions, categoricalScale } from './questions.mjs';
import { savePomaReassessment } from './assessment-store.mjs';
import { readJournal, addJournal, questionState, setUserQuestions, readUserQuestions, businessTools } from './business-journal.mjs';
import { coachIdentity } from './coach-identity.mjs';
import { m3ntorTools, askM3ntor, assessPoma, getM3ntorResult } from './m3ntor-jobs.mjs';
import { utilityTools, reportUtility, searchUtility } from './clarity-utility.mjs';
import { clarityRequest } from './clarity-client.mjs';
import { startA2AReceiver } from './a2a-receiver.mjs';

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

const a2aStatusTool = { name: 'a2a_status', description: 'Current state of this installation\'s Clarity A2A receiver: stream connection (connecting, connected, ready, reconnecting, rejected, not_registered), agent handle, pending messages replayed on connect, last message and last error. Each received message is run in the owner\'s harness and answered with an A2A reply; per-message records are in .clarity_coach/a2a/messages.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } };

// Submit the separate non-sensitive summary to Clarity and keep the receipt beside the local one.
async function submitAssessment(cwd, input, profile, assessedAt) {
  let submission;
  try {
    const response = await clarityRequest('POST', '/agent/mentor/assessments', {
      revision_id: input.revision_id, status: input.status === 'final' ? 'final' : 'draft',
      // Only category and score leave the machine; rationales cite private sources.
      assessed_at: assessedAt, coaching_summary: input.coaching_summary, profile,
      ratings: Object.fromEntries(Object.entries(input.ratings || {}).map(([area, rating]) => [area, { category: rating?.category, score: rating?.score }])),
    });
    submission = { saved: response.saved === true, created: response.created, agent_id: response.agent_id, updated_at: response.assessment?.updated_at, submitted_at: new Date().toISOString() };
  } catch (error) { submission = { saved: false, error: error.message, attempted_at: new Date().toISOString() }; }
  const file = path.join(cwd, '.clarity_coach', 'reassessments', `${input.revision_id}.submission.json`);
  try { await writeFile(file, JSON.stringify(submission, null, 2), { mode: 0o600 }); submission.receipt_path = file; }
  catch (error) { submission.receipt_error = error.message; }
  return submission;
}

const ratingSchema = { type: 'object', properties: { category: { type: 'string', enum: categoricalScale.map(item => item.category) }, score: { type: 'integer', minimum: 1, maximum: 10 }, rationale: { type: 'string' } }, required: ['category', 'score', 'rationale'], additionalProperties: false };
const ratingsSchema = { type: 'object', properties: Object.fromEntries(dimensions.map(key => [key, ratingSchema])), required: dimensions, additionalProperties: false };
const tools = [
  { name: 'save_poma_reassessment', description: 'Save a prepared business POMA reassessment through this local service, including when your harness filesystem is read-only. Use the task revision_id UUID consistently. Saves one dated private revision, appends/updates its context section and journal entry, and saves a SEPARATE non-sensitive coaching summary locally. Workspace paths are fixed by this MCP connection. Repeating the same revision reconciles it without duplicates; prior revisions/unrelated context stay intact. After the local save it submits ONLY the coaching_summary, each area\'s category and score (never rationales) and coaching_profile to Clarity with this installation\'s token; resubmitting the same revision updates it. Returns actual per-artifact saved states, paths, the Clarity submission receipt or its failure.', inputSchema: { type: 'object', properties: { revision_id: { type: 'string', format: 'uuid' }, ratings: ratingsSchema, evidence: { description: 'Local evidence and source references, including explicit gaps.' }, coverage: { description: 'Business/process/source/period coverage and exclusions.' }, uncertainty: { description: 'Evidence limits and uncertainty for the business-linked ratings.' }, comparison: { description: 'Actual business change versus newly discovered evidence or corrected interpretation.' }, productivity: { description: 'Supported calculation or labelled estimate with scope, period, currency, definitions and total-human-hour coverage, or specific missing evidence.' }, status: { type: 'string', description: 'Actual assessment lifecycle status; defaults to draft.' }, harness: { type: 'string', enum: ['codex', 'claude'], description: 'Actual local harness, when known.' }, context_update: { type: 'string', description: 'Detailed reassessment Markdown section; do not replace unrelated existing CONTEXT.' }, journal_entry: { type: 'string', description: 'Business-related reassessment journal entry.' }, coaching_summary: { type: 'string', description: 'SEPARATE non-sensitive coaching summary; exclude raw context, financial/working-hours details, private identifiers, paths and credentials.' }, coaching_profile: { type: 'object', description: 'Non-sensitive registration/coaching profile submitted with the summary: industry, products_services, service_area, condensed_context.', properties: { industry: { type: 'string' }, products_services: { type: 'string' }, service_area: { type: 'string' }, condensed_context: { type: 'string' } }, additionalProperties: false } }, required: ['revision_id','ratings','evidence','coverage','uncertainty','comparison','productivity','context_update','journal_entry','coaching_summary'], additionalProperties: false } },
  { name: 'get_coaching_context', description: 'Retrieve the owner\u2019s private local business context (.clarity_coach/CONTEXT.md) and the coach identity. Read today\u2019s journal before offering outstanding Coach questions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
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
const questionInstructions = 'At the start of a session, read today’s business journal with read_journal and check user_question_read. Before offering outstanding questions, today’s journal must have been read. When permitted and questions are pending, briefly ask whether the user has time to answer some Coach questions; continue their work if not. Record a no using suser_question_set(action="defer") or add_journal(user_declined_questions=true): no more offers for four hours unless the user directly raises these questions. Set new business questions with suser_question_set. Local journal and question contents are never report attachments.';
async function mcp(req, res) {
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
  else if (call.method === 'tools/list') result = { tools: [...m3ntorTools, ...utilityTools, a2aStatusTool, ...tools, ...businessTools(await questionState(cwd))] };
  else if (call.method === 'tools/call') {
    try {
      const { name, arguments: input = {} } = call.params;
      if (name === 'ask_m3ntor' || name === 'assess_poma' || name === 'reassess_poma') {
        const job = await (name === 'ask_m3ntor' ? askM3ntor : assessPoma)(input, { cwd, harness, mcpUrl });
        result = { ...(job.status === 'failed' || job.status === 'interrupted' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(job) }] };
      } else if (name === 'get_m3ntor_result') {
        const job = await getM3ntorResult(input.job_id);
        result = { ...(job.status === 'failed' || job.status === 'interrupted' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(job) }] };
      } else if (name === 'save_poma_reassessment') {
        const { coaching_profile: coachingProfile = {}, ...localInput } = input;
        const receipt = await savePomaReassessment(cwd, localInput, { assessmentId: 'local', harness });
        if (receipt.saved) receipt.submission = await submitAssessment(cwd, input, coachingProfile, receipt.assessedAt);
        receipt.submitted = receipt.submission?.saved === true;
        result = { ...(!receipt.saved || !receipt.submitted ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } else if (name === 'a2a_status') {
        result = { content: [{ type: 'text', text: JSON.stringify(a2aReceiver.status()) }] };
      } else if (name === 'report_utility' || name === 'search_utility') {
        const response = await (name === 'report_utility' ? reportUtility(input) : searchUtility(input));
        result = { content: [{ type: 'text', text: JSON.stringify(response) }] };
      } else if (name === 'read_journal') {
        const journal=await readJournal(cwd,input);
        if (Object.hasOwn(journal.revisions,journal.today)) { session.journalDate=journal.today;session.journalRevision=journal.revisions[journal.today]; }
        result={content:[{type:'text',text:JSON.stringify(journal.entries)}]};
      } else if (name === 'add_journal') {
        const added=await addJournal(cwd,input);
        if(input.user_declined_questions) toolsChanged();
        result={content:[{type:'text',text:JSON.stringify(added)}]};
      } else if (name === 'suser_question_set') {
        const updated=await setUserQuestions(cwd,input);toolsChanged();
        result={content:[{type:'text',text:JSON.stringify(updated)}]};
      } else if (name === 'user_question_read' || /^user_questions_\d+$/.test(name)) {
        result={content:[{type:'text',text:JSON.stringify(await readUserQuestions(cwd,session,input))}]};
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
const server = http.createServer(async (req, res) => {
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, 403, { error: 'Use the local Clarity M3NT0R address.' });
    if (req.headers.origin && ![base, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: 'This service accepts local requests only.' });
    const url = new URL(req.url, base);
    if (url.pathname === '/mcp/local') return await mcp(req, res);
    return json(res, 404, { error: 'Not found. The MCP endpoint is /mcp/local.' });
  } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message }); }
});
// This service holds the installation's A2A stream for as long as it runs.
const a2aReceiver = startA2AReceiver({ cwd, harness, mcpUrl });
server.listen(port, '127.0.0.1', () => console.log(`Clarity M3NT0R MCP → ${mcpUrl}`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
  for (const stream of mcpStreams) stream.res.end();
  server.close(() => process.exit(0));
});
