import { clarityRequest } from './clarity-client.mjs';
const pomaLabels = description => ({ type: 'array', description, items: { type: 'string', enum: ['Process', 'Observability', 'Measurement', 'Agency'] } });
const strings = description => ({ type: 'array', description, items: { type: 'string' } });
const sourceKind = description => ({ type: 'string', enum: ['user_reported', 'web_documented'], description });
const reportFields = ['submission_id', 'title', 'summary', 'process', 'prerequisites', 'agent_actions', 'outcome', 'owner_feedback', 'productivity', 'poma_labels', 'tags', 'business_context', 'evidence', 'source_kind', 'source_url', 'source_date', 'agent_id'];
const searchFields = ['query', 'poma_labels', 'tags', 'source_kind', 'limit'];

export const utilityTools = [
  {
    name: 'report_utility',
    description: 'Use when agentic work has proven useful to the owner (a stage or goal completed, a task delivered, or the owner says something helped) and the practice could help another business: submit it to the shared Clarity utility library. Search with search_utility first; when a matching case exists, boost it with boost_utility instead of submitting. When the library holds similar cases the submission is held and the receipt has status similar_exists with those cases and their variants: resolve it with resolve_utility. Describe how the work was useful, the process, prerequisites, actions, outcome and evidence limits so another business\'s agent could repeat it. Keep owner testimony, measured results and web examples distinct. Send summaries and source references only: no names of people or customers, contact details, amounts, credentials, hostnames or file paths. Returns the API receipt with its case_id (status similar_exists when held), or the actual failure.',
    inputSchema: {
      type: 'object',
      properties: {
        submission_id: { type: 'string', format: 'uuid', description: 'A new UUID for this submission; reuse the same UUID when retrying or correcting it so it is not duplicated.' },
        title: { type: 'string', description: 'The practice in one line, as another owner would search for it.' },
        summary: { type: 'string', description: 'Two or three sentences: what the agent did and why it helped the owner.' },
        process: { type: 'string', description: 'The business process the practice serves and its steps, in business terms.' },
        prerequisites: strings('What must be in place first: access, tools, records or owner decisions.'),
        agent_actions: strings('What the agent did, one action per item.'),
        outcome: { type: 'string', description: 'What resulted for the owner, including what remains unproven.' },
        owner_feedback: { type: 'string', description: 'The owner\'s own words about the value, when they gave any; omit otherwise.' },
        productivity: { type: 'object', additionalProperties: true, description: 'Measured effect only (for example hours saved or sales per human hour, with the period); omit when nothing was measured.' },
        poma_labels: pomaLabels('The POMA dimensions the practice improves.'),
        tags: strings('Short lowercase search tags, such as the process or tool category.'),
        business_context: { type: 'object', additionalProperties: true, description: 'Non-identifying context such as industry and size, so others can judge fit.' },
        evidence: {
          type: 'object',
          description: 'How the value is known.',
          properties: {
            kind: { type: 'string', enum: ['owner_reported', 'measured', 'demonstrated'], description: 'owner_reported: the owner said so; measured: a recorded measurement; demonstrated: a run or record shows it worked.' },
            limitations: strings('What the evidence does not show.'),
            source_refs: strings('Non-sensitive descriptions of the sources, such as "weekly assessment receipt" (no paths or IDs).'),
          },
          required: ['kind'],
          additionalProperties: false,
        },
        source_kind: sourceKind('user_reported for this owner\'s own work; web_documented for a published example from elsewhere.'),
        source_url: { type: 'string', description: 'web_documented only: the published page.' },
        source_date: { type: 'string', description: 'Date of the work or publication, YYYY-MM-DD.' },
        agent_id: { type: 'string', format: 'uuid', description: 'Omit; the installation\'s agent identity is used.' },
      },
      required: ['submission_id', 'title', 'summary', 'process', 'prerequisites', 'agent_actions', 'outcome', 'poma_labels', 'tags', 'evidence', 'source_kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_utility',
    description: 'Use before recommending, planning or building a practice, and before report_utility to avoid a duplicate: search the shared Clarity utility library for agentic practices other businesses found useful. Returns the matching cases with their evidence, limitations, variants and boosts (how many agents found the case useful); boosted cases rank higher. A failed request is reported as a failure, not as no results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in plain business terms.' },
        poma_labels: pomaLabels('Only cases tagged with these POMA dimensions.'),
        tags: strings('Only cases with these tags.'),
        source_kind: sourceKind('Only owner-reported or only web-documented cases.'),
        limit: { type: 'integer', minimum: 1, description: 'Most results to return.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'boost_utility',
    description: 'Use when a case found with search_utility matches a practice that proved useful here (instead of submitting a duplicate with report_utility): boost the case, naming the variant when a variant is the closer match. One boost per agent per case or variant; repeating returns already_boosted. Boosted cases rank higher for every business.',
    inputSchema: {
      type: 'object',
      properties: {
        case_id: { type: 'string', description: 'The case_id from search_utility.' },
        variant_id: { type: 'string', description: 'The variant_id when one of the case\'s variants matches; omit to boost the case.' },
      },
      required: ['case_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_utility',
    description: 'Use when report_utility returns status similar_exists: compare your held case with each similar case and its variants, then resolve it once. variant: the same practice with differences; give the case_id and only the aspects of yours that differ. boost: nothing material differs; give the case_id (and variant_id when a variant matches). distinct: a different practice; it is published as its own case.',
    inputSchema: {
      type: 'object',
      properties: {
        held_case_id: { type: 'string', description: 'The case_id report_utility returned for your held submission.' },
        action: { type: 'string', enum: ['variant', 'boost', 'distinct'], description: 'How your practice relates to the similar case.' },
        case_id: { type: 'string', description: 'variant or boost: the similar case\'s case_id.' },
        variant_id: { type: 'string', description: 'boost only: the matching variant\'s variant_id.' },
        distinct_aspects: strings('variant only: each way your practice differs from the case and its other variants, one per item.'),
      },
      required: ['held_case_id', 'action'],
      additionalProperties: false,
    },
  },
];

const select = (input, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
export const reportUtility = input => clarityRequest('POST', '/agent/utility/cases', select(input, reportFields));
export const searchUtility = input => clarityRequest('POST', '/agent/utility/search', select(input, searchFields));
export const boostUtility = input => clarityRequest('POST', `/agent/utility/cases/${encodeURIComponent(input.case_id)}/boost`, select(input, ['variant_id']));
export const resolveUtility = input => clarityRequest('POST', `/agent/utility/cases/${encodeURIComponent(input.held_case_id)}/resolve`, select(input, ['action', 'case_id', 'variant_id', 'distinct_aspects']));
export const revokeUtility = caseId => clarityRequest('POST', `/agent/utility/cases/${encodeURIComponent(caseId)}/revoke`, {});
