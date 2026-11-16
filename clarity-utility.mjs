import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';

const exec = promisify(execFile);
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

async function request(method, route, data) {
  // Use the established A2A route; never install or substitute authentication.
  let config;
  try { config = JSON.parse(await readFile(path.join(os.homedir(), '.config', 'a2a-bridge', 'config.json'), 'utf8')); }
  catch { throw new Error('The existing ~/.config/a2a-bridge/config.json could not be read. No alternative authentication was selected.'); }
  if (typeof config.api_url !== 'string' || !Array.isArray(config.hmac_secret_command) || !config.hmac_secret_command.length || config.hmac_secret_command.some(arg => typeof arg !== 'string')) throw new Error('The existing A2A configuration lacks api_url or a valid hmac_secret_command argv.');
  let secret;
  try {
    const result = await exec(config.hmac_secret_command[0], config.hmac_secret_command.slice(1), { timeout: 30000, env: process.env });
    secret = result.stdout.trim();
  } catch (error) {
    // Child-process errors can contain stdout, stderr and command arguments.
    // Return only a diagnostic code, never the secret or its command output.
    throw new Error(`The established A2A secret command failed (${error.code || error.name}).`);
  }
  if (!secret) throw new Error('The established A2A secret command returned no secret.');
  const body = data === undefined ? '' : JSON.stringify(data);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const url = new URL(route.replace(/^\/+/, ''), config.api_url.endsWith('/') ? config.api_url : config.api_url + '/');
  let response;
  try {
    response = await fetch(url, {
      method, headers: { Authorization: `Bearer ${signature}.${timestamp}`, 'Content-Type': 'application/json' },
      ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
    });
  } catch (error) { throw new Error(`Clarity utility API request failed (${error.name}). No automatic retry was started.`); }
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Clarity utility API returned non-JSON data (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(`Clarity utility API failed (HTTP ${response.status}): ${JSON.stringify(result)}`);
  return result;
}

const select = (input, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
export const reportUtility = input => request('POST', '/agent/utility/cases', select(input, reportFields));
export const searchUtility = input => request('POST', '/agent/utility/search', select(input, searchFields));
