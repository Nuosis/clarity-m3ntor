import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const queues = new Map();
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const businessDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const root = cwd => path.join(cwd, '.clarity_coach');
const journalFile = (cwd, date) => path.join(root(cwd), 'journal', `${date}.json`);
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10) !== date) throw new Error('Use a calendar date in YYYY-MM-DD format.');
  return date;
}
async function load(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch(e) { if (e.code !== 'ENOENT') throw e; return fallback; } }
async function store(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value,null,2)+'\n', { mode: 0o600 }); await rename(temporary,file);
}
export async function serializeBusinessWrites(cwd, action) {
  const key = path.resolve(cwd);
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action); queues.set(key,current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}
async function journal(cwd,date) { return load(journalFile(cwd,date), { date, timeZone:timeZone(), revision:'empty', entries:[] }); }
export async function readJournal(cwd, input = {}, now = new Date()) {
  const today = businessDate(now);
  const first = validDate(input.date || input.from_date || today);
  const last = validDate(input.date || input.to_date || (input.from_date ? today : first));
  if (first > last) throw new Error('The start date must not follow the end date.');
  const entries = {}, revisions = {};
  for (let date=first; date<=last;) {
    const day=await journal(cwd,date); entries[`${date}_entries`]=day.entries; revisions[date]=day.revision;
    const next=new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate()+1); date=next.toISOString().slice(0,10);
  }
  return { entries, revisions, today };
}
// Internal storage callers hold serializeBusinessWrites; public addJournal
// acquires it below. A supplied entry ID supports a repeat-safe reassessment.
export async function appendJournalInWrite(cwd,input,now,entryId) {
  const date=validDate(input.date || businessDate(now));
  if (!input.content?.trim()) throw new Error('A business-related journal entry is required.');
  const day=await journal(cwd,date);
  const index=entryId ? day.entries.findIndex(entry=>entry.id===entryId) : -1;
  const previous=index<0 ? null : day.entries[index];
  const entry={ id:entryId || randomUUID(), createdAt:previous?.createdAt || now.toISOString(), kind:input.kind || 'activity', content:input.content, source:input.source || 'local_harness' };
  if (input.metadata) entry.metadata=input.metadata;
  const reused=!!previous && JSON.stringify(previous)===JSON.stringify(entry);
  if (!reused) {
    if (index<0) day.entries.push(entry); else day.entries[index]=entry;
    day.revision=randomUUID(); await store(journalFile(cwd,date),day);
  }
  return { entry, date, path:journalFile(cwd,date), ...(entryId ? { reused } : {}) };
}
const questionFile = cwd => path.join(root(cwd),'user_questions.json');
export async function questionState(cwd, now=new Date()) {
  const state=await load(questionFile(cwd), { questions:[], deferUntil:null });
  return { ...state, pending:state.questions.filter(q=>q.status==='pending'), deferred:!!state.deferUntil && Date.parse(state.deferUntil)>now.getTime() };
}
async function defer(cwd,state,now,content) {
  // USER-AUTHORIZED — Marcus, November 15, 2026: after declining Coach
  // questions, do not ask again for four hours unless the user raises them.
  state.deferUntil=new Date(now.getTime()+4*60*60*1000).toISOString();
  state.lastDeclinedAt=now.toISOString(); delete state.pending; delete state.deferred;
  await store(questionFile(cwd),state);
  const result=await appendJournalInWrite(cwd,{kind:'question_deferral',content:content || 'User declined Coach questions for now.',metadata:{deferUntil:state.deferUntil,exception:'User directly brings up the questions.'}},now);
  return { ...result, deferUntil:state.deferUntil };
}
export async function addJournal(cwd,input,now=new Date()) {
  return serializeBusinessWrites(cwd,async()=> input.user_declined_questions === true ? defer(cwd,await questionState(cwd,now),now,input.content) : appendJournalInWrite(cwd,input,now));
}
export async function setUserQuestions(cwd,input,now=new Date()) {
  return serializeBusinessWrites(cwd,async()=> {
    const state=await questionState(cwd,now);
    const action=input.action || 'set';
    if (action==='defer') return defer(cwd,state,now,input.reason);
    if (action==='set') {
      const incoming=input.questions || (input.question ? [{question:input.question,id:input.question_id}] : []);
      if (!incoming.length) throw new Error('Provide at least one business-related question.');
      let skipped=0;
      for (const item of incoming) {
        if (!item.question?.trim()) throw new Error('Question text is required.');
        const existing=state.questions.find(q=>item.id ? q.id===item.id : q.status==='pending' && q.question===item.question);
        // only_if_absent: an existing question (answered or not) is kept unchanged.
        if (existing && input.only_if_absent) { skipped++; continue; }
        if (existing) Object.assign(existing,{question:item.question,status:'pending',updatedAt:now.toISOString()});
        else state.questions.push({id:item.id || randomUUID(),question:item.question,source:item.source || input.source || 'local_harness',status:'pending',createdAt:now.toISOString(),updatedAt:now.toISOString()});
      }
      if (skipped===incoming.length) return questionState(cwd,now); // nothing changed: no write or journal entry
    } else if (action==='answer' || action==='dismiss') {
      const existing=state.questions.find(q=>q.id===input.question_id);
      if (!existing) throw new Error('The question was not found.');
      if (action==='answer' && !input.answer?.trim()) throw new Error('Provide the user’s answer.');
      Object.assign(existing,{status:action==='answer'?'answered':'dismissed',answer:input.answer || input.reason || '',updatedAt:now.toISOString()});
    } else throw new Error('Use set, answer, dismiss, or defer.');
    delete state.pending;delete state.deferred;await store(questionFile(cwd),state);
    await appendJournalInWrite(cwd,{kind:'activity',content:action==='set'?'Recorded business questions for the user.':action==='answer'?`The owner answered: ${state.questions.find(q=>q.id===input.question_id)?.question || 'a business question'}\nAnswer: ${input.answer}`:'Dismissed a business question.',metadata:{questionId:input.question_id || null}},now);
    return questionState(cwd,now);
  });
}
export async function readUserQuestions(cwd,session,input={},now=new Date()) {
  const today=businessDate(now); const day=await journal(cwd,today); const state=await questionState(cwd,now);
  // USER-AUTHORIZED — Marcus, November 15, 2026: always read today’s
  // journal for context before asking outstanding Coach questions.
  const journalRead=session?.journalDate===today && session?.journalRevision===day.revision;
  const canOffer=journalRead && state.pending.length>0 && (!state.deferred || input.user_initiated===true);
  return { pending_count:state.pending.length, questions:journalRead?state.pending:[], can_offer_questions:canOffer, needs_today_journal:!journalRead, defer_until:state.deferUntil, user_initiated:input.user_initiated===true, instruction:!journalRead?'Read today’s journal first with read_journal.':state.deferred && !input.user_initiated?'Do not ask again before defer_until unless the user directly brings up Coach questions.':input.user_initiated===true && state.pending.length?'The user directly raised Coach questions. Discuss them in response to that request; the deferral remains for unsolicited offers.':state.pending.length?'Briefly ask whether the user has time to answer some Coach questions. If no, record the decline with user_question_set(action="defer") or add_journal(user_declined_questions=true). Continue the user’s work.':'No outstanding Coach questions; do not prompt about questions.' };
}

export function businessTools(state) {
  return [
    {name:'read_journal',description:'Read the local business journal. Default: today. Optionally supply date or from_date/to_date for an inclusive date range. Returns <YYYY-MM-DD>_entries for each date. Always read today’s journal for context before raising outstanding Coach questions.',inputSchema:{type:'object',properties:{date:{type:'string'},from_date:{type:'string'},to_date:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'add_journal',description:'Add only business-related learnings, successes, struggles, user requests, activities, and related observations to the local journal. For a user declining Coach questions, set user_declined_questions=true: records the decline and suppresses further offers for four hours unless the user directly raises them. Journal content stays local.',inputSchema:{type:'object',properties:{content:{type:'string'},kind:{type:'string'},date:{type:'string'},source:{type:'string'},user_declined_questions:{type:'boolean'}},required:['content'],additionalProperties:false}},
    {name:'user_question_set',description:'Set business questions arising from work with your coach; update an existing question, record its answer, dismiss it, or defer the offer. Write each question for the owner, in Markdown: exactly one decision per question (when several decisions are needed, set several questions), plain language at reading grade 10 or below, your recommended answer, short bullets the owner can confirm or correct line by line, and a one-line way to reply. No IDs, status codes, revision numbers, field names or evidence detail; keep evidence in the journal or task result. action="defer" records the user’s decline in today’s journal and sets now+4 hours; do not ask again until then unless the user directly brings it up. Read today’s journal before asking outstanding questions; user_question_read returns the current permission to offer.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['set','answer','dismiss','defer']},questions:{type:'array',items:{type:'object',properties:{id:{type:'string'},question:{type:'string'},source:{type:'string'}},required:['question'],additionalProperties:false}},question:{type:'string'},question_id:{type:'string'},answer:{type:'string'},reason:{type:'string'},source:{type:'string'}},additionalProperties:false}},
    {name:'user_question_read',description:'Read current pending Coach questions and whether it is appropriate to offer them. First read today’s journal. When allowed, ask if the user has time. A no is journaled and defers offers by four hours. Set user_initiated=true only when the user directly raises these questions; this bypasses the current deferral for that request.',inputSchema:{type:'object',properties:{user_initiated:{type:'boolean'}},additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:`user_questions_${state.pending.length}`,description:`There are ${state.pending.length} outstanding business questions from working with your coach.${state.deferred?` The user declined; do not offer them again before ${state.deferUntil} unless the user directly raises them.`:''} Always read today’s journal first with read_journal, then use user_question_read to check current questions and whether to ask if the user has time. Set questions using user_question_set. This count reflects discovery time; the read tool returns current state.`,inputSchema:{type:'object',properties:{user_initiated:{type:'boolean'}},additionalProperties:false},annotations:{readOnlyHint:true}},
  ];
}
