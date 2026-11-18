// Goals: each goal is built through a fixed sequence of stages (see goal-flow spec).
// USER-AUTHORIZED — Marcus, November 17, 2026: the goal and stage order governs the goals
// M3NT0R sets, the work done on them and capabilities the owner asks to have built;
// one-off owner-directed tasks are outside it.

export const ENVIRONMENT_STAGES = [
  { key: 'infrastructure', name: 'Infrastructure', work: 'Check that each route the agent needs works: email, billing, records, calendar and the M3NT0R service. Fill gaps by reusing established routes.', done: 'Each needed route has been read back working this week.' },
  { key: 'observability', name: 'Observability', work: "Build and keep current the owner's plate: commitments (what, to whom, by when, status), work in progress and priorities, linked to their emails, agreements and billing.", done: 'The weekly assessment scores Observability 8 or higher on this week\'s evidence.', score: 'observability' },
  { key: 'process', name: 'Process', work: "State the owner's ordinary flows from inquiry and quote through delivery, billing and collection: trigger, steps, handoffs and completion. Confirm them against current work; ask the owner where records fall short.", done: 'The weekly assessment scores Process 8 or higher.', score: 'process' },
];
export const FUNCTION_STAGES = [
  { key: 'scope', name: 'Scope and plan', work: 'From the working environment, find past examples of this function (requests, outputs, what happened after) and the skills, tools and records involved. Write the plan.', done: 'The plan names the outcome, the sources and the examples found, and is visible in the owner view.' },
  { key: 'infrastructure', name: 'Infrastructure', work: 'Check that each tool and route the function needs works; fill gaps by reusing or extending what exists.', done: 'Each one has been read back working.' },
  { key: 'process', name: 'Process', work: 'Write how the owner does this work: trigger, steps, decisions, completion. Check it against the past examples and ask the owner where it is unclear.', done: 'The written flow matches the past examples, or each difference is answered by the owner.' },
  { key: 'observation', name: 'Observation', work: "Make the function's historic and current activity visible to the owner and the agent, reusing the journal and owner view.", done: 'Past examples and new runs of the function show in the owner view.' },
  { key: 'agency', name: 'Agency', work: 'Set what triggers the work and carry it through.', done: 'The first run started by its trigger completes without the owner starting it.' },
  { key: 'measurement', name: 'Measurement', work: 'Define the measure and record results (for estimation: estimate against actual hours, and whether the quote was accepted).', done: 'The first measured result is recorded.' },
  { key: 'improve', name: 'Improve', work: 'Compare results weekly. A repeated miss reopens the Process stage with the evidence.', done: 'Recurring; it does not end.' },
];
export const stagesFor = kind => kind === 'environment' ? ENVIRONMENT_STAGES : FUNCTION_STAGES;

const goalProps = { goal_id: { type: 'string' } };
export const goalTools = [
  { name: 'list_goals', description: 'Goals in order, each with its current stage, the stage\'s work and done-check, completed stages with their evidence, and the agent pace. One goal is active at a time; the working environment goal always comes first.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'set_goal', description: 'Create a function goal (a capability to build, such as estimation) or change an existing goal\'s title, outcome or position. New goals wait behind the active goal; position 1 is next after the working environment.', inputSchema: { type: 'object', properties: { goal_id: { type: 'string', description: 'Existing goal to update; omit to create.' }, title: { type: 'string' }, outcome: { type: 'string', description: 'What the owner gets when this capability works.' }, source: { type: 'string', enum: ['owner_request', 'm3ntor', 'use_case'], description: 'Where the goal came from.' }, position: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  { name: 'complete_stage', description: 'Claim the active goal\'s current stage done, naming the evidence for its done-check. Accepted only when the stage\'s tasks have finished and the last one ended STATUS: done; the working environment\'s Observability and Process stages also need the latest weekly assessment to score 8 or higher.', inputSchema: { type: 'object', properties: { ...goalProps, evidence: { type: 'string' } }, required: ['goal_id', 'evidence'], additionalProperties: false } },
  { name: 'reopen_stage', description: 'For a goal in its Improve stage: reopen its Process stage when results show a repeated miss, giving the evidence.', inputSchema: { type: 'object', properties: { ...goalProps, evidence: { type: 'string' } }, required: ['goal_id', 'evidence'], additionalProperties: false } },
  { name: 'stop_goal', description: 'Stop a goal with the owner\'s reason: its queued tasks are removed, the reason is journaled for M3NT0R, and the next goal becomes active.', inputSchema: { type: 'object', properties: { ...goalProps, reason: { type: 'string' } }, required: ['goal_id', 'reason'], additionalProperties: false } },
  { name: 'set_pace', description: 'How the agent works on goals: hourly, daily (at time HH:MM local) or yolo (as soon as every task of the current stage is done or blocked).', inputSchema: { type: 'object', properties: { pace: { type: 'string', enum: ['hourly', 'daily', 'yolo'] }, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } }, required: ['pace'], additionalProperties: false } },
];

export const GOAL_REVIEW_INSTRUCTION = `You are the business owner's local AI agent, connected to Clarity M3NT0R through the clarity_m3ntor MCP tools. This is your goal review. Work only on the goal and stage below.

1. Review what the stage's tasks produced (get_task gives each run and its steps).
2. Investigate any failed or paused task and decide what fixes it.
3. If the stage's done-check holds, call complete_stage with the evidence. Otherwise write the next task or tasks for THIS stage with set_task (goal_id and stage as given). Each task needs an instruction, a success definition its single run can check, and any constraints. Name specific items; reuse established tools and routes.
4. If only the owner can supply something, ask with user_question_set and leave the stage waiting.
5. Goals from M3NT0R or the owner that are not yet set can be added with set_goal.

Do not write tasks for later stages. Your final response is recorded: say what you reviewed, what you queued or completed, and what is waiting. End with exactly one final line: \`STATUS: done\` or \`STATUS: not done — <reason>\`.`;
