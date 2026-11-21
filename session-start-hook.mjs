#!/usr/bin/env node
// Session-start hook for the owner's Claude Code, Codex, and Antigravity sessions: when Coach
// questions are waiting on the owner, put them in the session's opening context so the agent raises them.
// Usage (registered by install-session-hook.mjs): node session-start-hook.mjs --port <port> [--format antigravity]
// Silent when nothing is pending, when the owner deferred questions, inside the service's own
// harness runs (M3NTOR_JOB_ID), or when the service is not responding.
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = arg('port') || process.env.M3NTOR_PORT;
const antigravity = ['antigravity', 'agy'].includes(arg('format') || arg('harness') || '');
const done = (payload = null) => {
  if (payload) process.stdout.write(JSON.stringify(payload));
  else if (antigravity) process.stdout.write('{}');
  process.exit(0);
};
if (process.env.M3NTOR_JOB_ID || !port) done();
let data;
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/questions/pending`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) done();
  data = await response.json();
} catch { done(); }
if (!data.pending?.length || data.deferred_until) done();
const list = data.pending.map((q, i) => `${i + 1}. (question_id ${q.id})\n${q.question}`).join('\n\n');
const one = data.pending.length === 1;
const paused = data.pending.some(q => q.source === 'inov8') ? ` inov8's goal work is paused until ${one ? 'it is' : 'they are'} answered.` : '';
const context = `Clarity M3NT0R: ${one ? '1 Coach question is' : `${data.pending.length} Coach questions are`} waiting on the owner.${paused}

At the start of this session, before other work: read today's business journal with the clarity_m3ntor read_journal tool, then tell the owner ${one ? 'the question below is' : 'the questions below are'} waiting and ask whether they have time to answer now. Show each question as written. Record each answer with user_question_set (action "answer", the question_id, the owner's words). If the owner says not now, record it with user_question_set (action "defer") and continue their work.

${list}`;
done(antigravity
  ? { injectSteps: [{ systemMessage: { systemMessage: context } }] }
  : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
