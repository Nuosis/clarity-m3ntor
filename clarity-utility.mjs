import { clarityRequest } from './clarity-client.mjs';
const pomaLabels = { type: 'array', items: { type: 'string', enum: ['Process', 'Observability', 'Measurement', 'Agency'] } };
const strings = { type: 'array', items: { type: 'string' } };
const sourceKind = { type: 'string', enum: ['user_reported', 'web_documented'] };
const reportFields = ['submission_id', 'title', 'summary', 'process', 'prerequisites', 'agent_actions', 'outcome', 'owner_feedback', 'productivity', 'poma_labels', 'tags', 'business_context', 'evidence', 'source_kind', 'source_url', 'source_date', 'agent_id'];
const searchFields = ['query', 'poma_labels', 'tags', 'source_kind', 'limit'];

export const utilityTools = [
  {
    name: 'report_utility',
    description: 'Report a non-sensitive utility case to Clarity: how agentic work was useful, the process, prerequisites, actions, outcome and evidence limits. Keep owner testimony, measured results and web examples distinct. Supply a UUID submission_id and reuse that ID when reconciling the same submission. Send summaries and source references; keep raw sessions, private records and credentials local. Returns the actual API receipt or failure.',
    inputSchema: {
      type: 'object',
      properties: {
        submission_id: { type: 'string', format: 'uuid' }, title: { type: 'string' }, summary: { type: 'string' }, process: { type: 'string' },
        prerequisites: strings, agent_actions: strings, outcome: { type: 'string' }, owner_feedback: { type: 'string' },
        productivity: { type: 'object', additionalProperties: true }, poma_labels: pomaLabels, tags: strings,
        business_context: { type: 'object', additionalProperties: true },
        evidence: { type: 'object', properties: { kind: { type: 'string', enum: ['owner_reported', 'measured', 'demonstrated'] }, limitations: strings, source_refs: strings }, required: ['kind'], additionalProperties: false },
        source_kind: sourceKind, source_url: { type: 'string' }, source_date: { type: 'string' }, agent_id: { type: 'string', format: 'uuid' },
      },
      required: ['submission_id', 'title', 'summary', 'process', 'prerequisites', 'agent_actions', 'outcome', 'poma_labels', 'tags', 'evidence', 'source_kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_utility',
    description: 'Search Clarity utility cases for relevant agentic practices. Supply a query and optional POMA labels, tags, source_kind or result limit. Returns the API search results with their evidence and limitations; a failed request is not an empty collection.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, poma_labels: pomaLabels, tags: strings, source_kind: sourceKind, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

const select = (input, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
export const reportUtility = input => clarityRequest('POST', '/agent/utility/cases', select(input, reportFields));
export const searchUtility = input => clarityRequest('POST', '/agent/utility/search', select(input, searchFields));
export const revokeUtility = caseId => clarityRequest('POST', `/agent/utility/cases/${encodeURIComponent(caseId)}/revoke`, {});
