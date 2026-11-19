#!/usr/bin/env node
// Session-start hook for the owner's Claude Code and Codex sessions: when Coach questions are
// waiting on the owner, put them in the session's opening context so the agent raises them.
// Usage (registered by install-session-hook.mjs): node session-start-hook.mjs --port <port>
// Silent when nothing is pending, when the owner deferred questions, inside the service's own
// harness runs (M3NTOR_JOB_ID), or when the service is not responding.
const portFlag = process.argv.indexOf('--port');
const port = (portFlag >= 0 ? process.argv[portFlag + 1] : undefined) || process.env.M3NTOR_PORT;
if (process.env.M3NTOR_JOB_ID || !port) process.exit(0);
let data;
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/questions/pending`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) process.exit(0);
  data = await response.json();
} catch { process.exit(0); }
if (!data.pending?.length || data.deferred_until) process.exit(0);
const list = data.pending.map((q, i) => `${i + 1}. (question_id ${q.id})\n${q.question}`).join('\n\n');
const one = data.pending.length === 1;
const paused = data.pending.some(q => q.source === 'inov8') ? ` inov8's goal work is paused until ${one ? 'it is' : 'they are'} answered.` : '';
const context = `Clarity M3NT0R: ${one ? '1 Coach question is' : `${data.pending.length} Coach questions are`} waiting on the owner.${paused}

At the start of this session, before other work: read today's business journal with the clarity_m3ntor read_journal tool, then tell the owner ${one ? 'the question below is' : 'the questions below are'} waiting and ask whether they have time to answer now. Show each question as written. Record each answer with user_question_set (action "answer", the question_id, the owner's words). If the owner says not now, record it with user_question_set (action "defer") and continue their work.

${list}`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
