#!/usr/bin/env node
// Session-start hook for the owner's Claude Code, Codex, and Antigravity sessions:
// surfaces the concise Operating Context header from .clarity_coach/CONTEXT.md (or a pointer to it)
// and any pending Coach questions waiting on the owner.
// Usage (registered by install-session-hook.mjs): node session-start-hook.mjs --port <port> [--format antigravity]
// Silent inside the service's own harness runs (M3NTOR_JOB_ID) or when the service is not responding.
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
  let response = await fetch(`http://127.0.0.1:${port}/api/session-start`, { signal: AbortSignal.timeout(3000) });
  if (response.status === 404) {
    response = await fetch(`http://127.0.0.1:${port}/api/questions/pending`, { signal: AbortSignal.timeout(3000) });
  }
  if (!response.ok) done();
  data = await response.json();
} catch { done(); }

const parts = [];
if (typeof data.operating_context === 'string' && data.operating_context.trim()) {
  parts.push(`Clarity M3NT0R — Operating Context (${data.context_path || '.clarity_coach/CONTEXT.md'}; consult full file or clarity_m3ntor.get_coaching_context for POMA history):\n\n${data.operating_context.trim()}`);
} else if (data.context_path) {
  parts.push(`Clarity M3NT0R — Business & Agent Operating Context: read ${data.context_path} (or call clarity_m3ntor.get_coaching_context) to understand the owner's environment and how they expect agents to operate.`);
}

if (data.pending?.length && !data.deferred_until) {
  const list = data.pending.map((q, i) => `${i + 1}. (question_id ${q.id})\n${q.question}`).join('\n\n');
  const one = data.pending.length === 1;
  const paused = data.pending.some(q => q.source === 'inov8') ? ` inov8's goal work is paused until ${one ? 'it is' : 'they are'} answered.` : '';
  parts.push(`Clarity M3NT0R: ${one ? '1 Coach question is' : `${data.pending.length} Coach questions are`} waiting on the owner.${paused}

At the start of this session, before other work: read today's business journal with the clarity_m3ntor read_journal tool, then tell the owner ${one ? 'the question below is' : 'the questions below are'} waiting and ask whether they have time to answer now. Show each question as written. Record each answer with user_question_set (action "answer", the question_id, the owner's words). If the owner says not now, record it with user_question_set (action "defer") and continue their work.

${list}`);
}

if (!parts.length) done();
const context = parts.join('\n\n---\n\n');
done(antigravity
  ? { injectSteps: [{ systemMessage: { systemMessage: context } }] }
  : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
