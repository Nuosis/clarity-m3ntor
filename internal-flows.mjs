import { NODE_TYPES, reviewEdge, reviewHash } from './inov8-review-process.mjs';

export const POMA_PROCESS_ID = 'poma-assessment';
export const M3NTOR_PROCESS_ID = 'm3ntor-coaching';

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

export const extraInternalDefinitions = [pomaAssessmentDefinition, m3ntorCoachingDefinition];
