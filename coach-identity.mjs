// USER-AUTHORIZED — Marcus, November 15, 2026: the coach is a separate
// agent, not M-CODEX. Never fall back to the old recipient.
const configuredName=(process.env.CLARITY_COACH_AGENT || 'M3NT0R').trim();
if (configuredName.toUpperCase()==='M-CODEX') throw new Error('Coach must use its own agent identity.');
export const coachIdentity={name:configuredName,role:'Coach for agents',runtimeStatus:'not verified',workingName:true};
