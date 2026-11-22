import { NODE_TYPES, reviewEdge, reviewHash } from './inov8-review-process.mjs';

export const GOAL_IMPLEMENTATION_PROCESS_ID = 'poma-goal-implementation';
export const POMA_PROCESS_ID = 'poma-assessment';
export const M3NTOR_PROCESS_ID = 'm3ntor-coaching';
export const ADHOC_PROCESS_ID = 'ad-hoc-task';

const buildDefinition = ({ id, name, nodes, edges }) => {
  const def = {
    id,
    name,
    kind: 'internal',
    definition_version: 1,
    node_types: NODE_TYPES,
    nodes,
    edges: edges.map(([from, to, label]) => ({ id: reviewEdge(from, to), from, to, ...(label ? { label } : {}) })),
  };
  return { ...def, version: reviewHash(def) };
};

export const pomaAssessmentDefinition = buildDefinition({
  id: POMA_PROCESS_ID,
  name: 'POMA business assessment',
  nodes: [
    { id: 'trigger-weekly', type: 'trigger', label: 'Weekly schedule', binding: 'set_task (weekly Mon 08:00)', detail: 'Scheduled weekly reassessment task runs POMA discovery, updates goals via M3NT0R, and delivers results to the owner.', column: 0.5, row: 0 },
    { id: 'trigger-manual', type: 'trigger', label: 'Manual / Bootstrap', binding: 'assess_poma · reassess_poma', detail: 'Explicit baseline or ad-hoc POMA assessment started via MCP or bootstrap.', column: 1.5, row: 0 },
    { id: 'trigger-event', type: 'trigger', label: 'Trigger receiver', binding: 'POST /api/triggers/poma-event/fire', detail: 'Local webhook or MCP fire_trigger event starting an assessment run.', column: 2.5, row: 0 },
    { id: 'fetch-prompt', type: 'operation', label: 'Fetch server prompt', binding: 'GET /agent/mentor/prompts/poma-assessment', detail: 'Freshly fetches the single server-owned POMA assessment prompt with the installation clrtok_ token; no bundled fallback.', column: 1.5, row: 1 },
    { id: 'discover-assess', type: 'agent', label: 'Agent discovery & scoring', binding: 'assessPoma · m3ntor-worker', detail: 'Local harness reads private context, journals, prior assessments, agent sessions, customer communication channels, and business sources; computes productivity and 1–10 ratings for Process, Observability, Measurement, and Agency.', column: 1.5, row: 2 },
    { id: 'save-submit', type: 'operation', label: 'Save & submit summary', binding: 'save_poma_reassessment', detail: 'Saves detailed private assessment, CONTEXT.md update, journal entry, and report locally; submits only the separate non-sensitive coaching summary and ratings to Clarity; queues owner feedback questions.', column: 1.5, row: 3 },
    { id: 'submit-ok', type: 'decision', label: 'Saved & submitted?', binding: 'savePomaReassessment · submitAssessment', detail: 'Checks both local per-artifact save receipts and the Clarity .submission.json receipt.', column: 1.5, row: 4 },
    { id: 'terminal-saved', type: 'terminal', label: 'Saved & submitted', binding: 'save_poma_reassessment', detail: 'Terminal outcome: private records saved locally and separate non-sensitive summary accepted by Clarity.', column: 0.5, row: 5 },
    { id: 'terminal-retry', type: 'terminal', label: 'Retry pending', binding: 'submitPayload · scheduleSubmissionRetry', detail: 'Terminal outcome: submission failed or partial save occurred; pending payload retained for backoff retry under the same revision_id.', column: 2.5, row: 5 },
  ],
  edges: [
    ['trigger-weekly', 'fetch-prompt'],
    ['trigger-manual', 'fetch-prompt'],
    ['trigger-event', 'fetch-prompt'],
    ['fetch-prompt', 'discover-assess'],
    ['discover-assess', 'save-submit'],
    ['save-submit', 'submit-ok'],
    ['submit-ok', 'terminal-saved', 'Yes'],
    ['submit-ok', 'terminal-retry', 'Retry / Error'],
  ],
});

export const m3ntorCoachingDefinition = buildDefinition({
  id: M3NTOR_PROCESS_ID,
  name: 'M3NT0R coaching consult',
  nodes: [
    { id: 'trigger-ask', type: 'trigger', label: 'MCP ask_m3ntor', binding: 'ask_m3ntor', detail: 'Owner\'s local agent asks M3NT0R a coaching question with full local business context.', column: 0.5, row: 0 },
    { id: 'trigger-weekly', type: 'trigger', label: 'Weekly goal review', binding: 'Weekly assessment task', detail: 'Invoked after weekly POMA reassessment to evaluate stage movement and apply goal changes.', column: 1.5, row: 0 },
    { id: 'trigger-inov8', type: 'trigger', label: 'inov8 goal proposal', binding: 'inov8 goal review', detail: 'Invoked when inov8 identifies a capability worth adding or a goal needing adjustment.', column: 2.5, row: 0 },
    { id: 'fetch-prompt', type: 'operation', label: 'Fetch coach prompt', binding: 'GET /agent/mentor/prompts/coach', detail: 'Freshly fetches the server-owned M3NT0R coach prompt with the installation clrtok_ token.', column: 1.5, row: 1 },
    { id: 'coach-run', type: 'agent', label: 'M3NT0R agent consult', binding: 'askM3ntor · m3ntor-worker', detail: 'Read-only local harness run with full private context, journal, utility library search, web search, and set_goal (on the coaching MCP connection only); modifies no local business files.', column: 1.5, row: 2 },
    { id: 'run-ok', type: 'decision', label: 'Completed with advice?', binding: 'getM3ntorResult', detail: 'Checks whether the detached harness exited cleanly with non-empty final output and no quota/retry loop stop.', column: 1.5, row: 3 },
    { id: 'terminal-advised', type: 'terminal', label: 'Advice returned', binding: 'get_m3ntor_result', detail: 'Terminal outcome: non-empty coaching response saved in private job state and retrievable by job_id.', column: 0.5, row: 4 },
    { id: 'terminal-failed', type: 'terminal', label: 'Failed / interrupted', binding: 'get_m3ntor_result', detail: 'Terminal outcome: harness failed or worker exited without final output; diagnostics retained in private job directory.', column: 2.5, row: 4 },
  ],
  edges: [
    ['trigger-ask', 'fetch-prompt'],
    ['trigger-weekly', 'fetch-prompt'],
    ['trigger-inov8', 'fetch-prompt'],
    ['fetch-prompt', 'coach-run'],
    ['coach-run', 'run-ok'],
    ['run-ok', 'terminal-advised', 'Yes'],
    ['run-ok', 'terminal-failed', 'No'],
  ],
});

export const adhocTaskDefinition = buildDefinition({
  id: ADHOC_PROCESS_ID,
  name: 'Ad-hoc owner task',
  nodes: [
    { id: 'trigger-manual', type: 'trigger', label: 'Immediate / manual', binding: 'set_task (immediate)', detail: 'One-off owner-directed task queued to run immediately.', column: 0.5, row: 0 },
    { id: 'trigger-schedule', type: 'trigger', label: 'Datetime trigger', binding: 'set_task (run_at / recurrence)', detail: 'Task scheduled to start or resume at a specific date/time or recurrence.', column: 1.5, row: 0 },
    { id: 'trigger-event', type: 'trigger', label: 'Event trigger', binding: 'POST /api/triggers/ad-hoc-event/fire', detail: 'Event-driven task waiting for a registered trigger event before running or resuming.', column: 2.5, row: 0 },
    { id: 'agent', type: 'agent', label: 'Execute task', binding: 'startTaskJob · m3ntor-worker', detail: 'Local harness executes the task with its flow snapshot, triggering input, and any prior task chain from earlier segments of this flow run.', column: 1.5, row: 1 },
    { id: 'outcome', type: 'decision', label: 'Flow completed?', binding: 'settleTask · handoff_task', detail: 'Checks whether the task completed the flow, handed off a partial flow to a new event/datetime-triggered follow-up task, or failed.', column: 1.5, row: 2 },
    { id: 'terminal-completed', type: 'terminal', label: 'Completed', binding: 'STATUS: done', detail: 'Terminal outcome: task success criteria met and flow run completed.', column: 0.5, row: 3 },
    { id: 'terminal-waiting', type: 'terminal', label: 'Waiting for resumption', binding: 'handoff_task · STATUS: partial', detail: 'Flow paused mid-run with a new follow-up task armed on an event or datetime trigger.', column: 1.5, row: 3 },
    { id: 'terminal-failed', type: 'terminal', label: 'Failed', binding: 'STATUS: not done', detail: 'Terminal outcome: task failed or ended partial without creating a follow-up task.', column: 2.5, row: 3 },
  ],
  edges: [
    ['trigger-manual', 'agent'],
    ['trigger-schedule', 'agent'],
    ['trigger-event', 'agent'],
    ['agent', 'outcome'],
    ['outcome', 'terminal-completed', 'Done'],
    ['outcome', 'terminal-waiting', 'Partial handoff'],
    ['outcome', 'terminal-failed', 'Failed'],
  ],
});

export const goalImplementationDefinition = buildDefinition({
  id: GOAL_IMPLEMENTATION_PROCESS_ID,
  name: 'POMA goal implementation',
  nodes: [
    { id: 'trigger-goal-created', type: 'trigger', label: 'Goal created / approved', binding: 'set_goal · POST /api/goals/approve · POST /api/triggers/goal-created/fire', detail: 'Starts when a new function goal is created by M3NT0R or directly approved by the owner. Enters the POMA implementation lifecycle at Scope and plan.', column: 0.5, row: 0 },
    { id: 'trigger-review-restarted', type: 'trigger', label: 'Readiness restarted', binding: 'restart_goal_review · POST /api/triggers/goal-review-restarted/fire', detail: 'New failure context or owner direction restarts readiness review at Scope and plan while retaining prior accepted proof.', column: 1.5, row: 0 },
    { id: 'trigger-stage-reopened', type: 'trigger', label: 'Process reopened', binding: 'reopen_stage · POST /api/triggers/goal-reopened/fire', detail: 'Triggered from a completed goal’s weekly Improve check after two consecutive misses, reopening the Process stage.', column: 2.5, row: 0 },
    { id: 'stage-scope', type: 'process', label: '1. Scope and plan', binding: 'inov8-goal-review · complete_stage(scope)', detail: 'Find past examples, sources, skills and tools from the working environment and write the visible plan.', column: 1.5, row: 1 },
    { id: 'stage-infrastructure', type: 'process', label: '2. Infrastructure', binding: 'inov8-goal-review · complete_stage(infrastructure)', detail: 'Verify every tool and route the function needs works and read back working connections.', column: 1.5, row: 2 },
    { id: 'stage-process', type: 'process', label: '3. Process', binding: 'inov8-goal-review · record_process · complete_stage(process)', detail: 'Define an actionable, implementable process (trigger, inputs, outputs, steps, decisions, handoffs, completion) and validate logic with representative dummy inputs.', column: 1.5, row: 3 },
    { id: 'stage-observation', type: 'process', label: '4. Observation', binding: 'inov8-goal-review · complete_stage(observation)', detail: 'Verify observation plumbing with clearly labelled dummy data or synthetic flows through the journal and owner view.', column: 1.5, row: 4 },
    { id: 'stage-agency', type: 'process', label: '5. Agency', binding: 'inov8-goal-review · complete_stage(agency)', detail: 'Set the defined trigger in motion through the background task harness and complete an actual live run with trigger and completion receipts.', column: 1.5, row: 5 },
    { id: 'stage-measurement', type: 'process', label: '6. Measurement', binding: 'inov8-goal-review · complete_stage(measurement)', detail: 'Define the business measure and record the first real measured result.', column: 1.5, row: 6 },
    { id: 'stage-improve', type: 'process', label: '7. Weekly Improve', binding: 'ensureImproveTask · reopen_stage', detail: 'Recurring weekly comparison against the measured result; two consecutive misses reopen Process.', column: 0.5, row: 7 },
    { id: 'terminal-completed', type: 'terminal', label: 'Goal completed', binding: 'complete_stage(measurement)', detail: 'Terminal implementation outcome: goal marked inactive, completion journaled, weekly Improve scheduled, and next waiting goal promoted.', column: 1.5, row: 7 },
    { id: 'terminal-stopped', type: 'terminal', label: 'Goal stopped', binding: 'stop_goal · POST /api/goals/:id/stop', detail: 'Terminal outcome: owner stopped the goal with their reason; queued tasks removed and next waiting goal promoted.', column: 2.5, row: 7 },
  ],
  edges: [
    ['trigger-goal-created', 'stage-scope'],
    ['trigger-review-restarted', 'stage-scope'],
    ['trigger-stage-reopened', 'stage-process'],
    ['stage-scope', 'stage-infrastructure'],
    ['stage-infrastructure', 'stage-process'],
    ['stage-process', 'stage-observation'],
    ['stage-observation', 'stage-agency'],
    ['stage-agency', 'stage-measurement'],
    ['stage-measurement', 'terminal-completed', 'Completed'],
    ['terminal-completed', 'stage-improve', 'Weekly check'],
    ['stage-improve', 'trigger-stage-reopened', 'Repeated miss'],
    ['stage-scope', 'terminal-stopped', 'Owner stopped'],
    ['stage-infrastructure', 'terminal-stopped'],
    ['stage-process', 'terminal-stopped'],
    ['stage-observation', 'terminal-stopped'],
    ['stage-agency', 'terminal-stopped'],
    ['stage-measurement', 'terminal-stopped'],
  ],
});

export const extraInternalDefinitions = [goalImplementationDefinition, pomaAssessmentDefinition, m3ntorCoachingDefinition, adhocTaskDefinition];
