// Delegates M3NT0R's A2A status, inbox, read, reply, send, and ack operations
// to the standalone `a2a-connect` loopback daemon (default http://127.0.0.1:4318),
// verifying that the daemon's registered handle and Clarity API URL match this
// installation's M3NT0R profile before exposing its operations.

import { loadProfile } from './clarity-client.mjs';

const DEFAULT_A2A_URL = 'http://127.0.0.1:4318';
const CLARITY_OPERATOR_ORGANIZATION_ID = '9816c057-b5d3-43a2-848f-99365ee6255e';
const ACCEPTED_SENDER = 'm-codex';
const INSTALL_HINT = 'pipx install "git+https://github.com/Nuosis/a2a-connect.git" && a2a-connect init --handle <handle> --api-key <clrtok_...> && a2a-connect install-service';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function senderPolicyCompatible(health) {
  const rules = health?.allowed_senders;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  return rules.every(rule => {
    const handle = String(rule?.handle || '').trim().toLowerCase();
    const orgId = String(rule?.org_id || '').trim().toLowerCase();
    return handle === ACCEPTED_SENDER && orgId === CLARITY_OPERATOR_ORGANIZATION_ID;
  });
}

function normalizeUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '').toLowerCase();
}

function resolveBaseUrl(rawUrl) {
  const candidate = (rawUrl || process.env.M3NTOR_A2A_URL || DEFAULT_A2A_URL).trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(candidate); }
  catch { throw new Error(`Invalid M3NTOR_A2A_URL: ${candidate}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`M3NTOR_A2A_URL must be a loopback address, got: ${candidate}`);
  }
  return candidate;
}

export const a2aTools = [
  {
    name: 'a2a_status',
    description: 'Check Clarity A2A connection state, registered handle, delivery mode, unread count, and stream status (delegated to standalone a2a-connect).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'a2a_inbox',
    description: 'List Clarity A2A messages in the local inbox (defaults to unread inbound messages waiting for this live harness).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['unread', 'read', 'replied', 'acked', 'sent', 'all'], default: 'unread' },
        from_agent: { type: 'string', description: 'Optional sender handle filter (e.g. M-CODEX).' },
        thread_id: { type: 'string', description: 'Optional thread ID filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'a2a_read',
    description: 'Read a full Clarity A2A message (including structured JSON payload) and its complete conversation thread, marking unread inbound messages read.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Clarity A2A message UUID.' },
        thread_id: { type: 'string', description: 'Conversation thread ID.' },
        mark_read: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'a2a_reply',
    description: 'Reply to an inbound Clarity A2A request message and mark it completed (idempotent per message_id).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Inbound Clarity A2A message UUID.' },
        message: { type: 'string', description: 'Reply text to send back.' },
        payload: { type: 'object', description: 'Optional structured JSON payload.' },
      },
      required: ['message_id', 'message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'a2a_send',
    description: 'Send a new Clarity A2A message to another registered agent (e.g. M-CODEX), optionally continuing a thread.',
    inputSchema: {
      type: 'object',
      properties: {
        to_agent: { type: 'string', description: 'Target registered agent handle.' },
        message: { type: 'string', description: 'Message text to send.' },
        thread_id: { type: 'string', description: 'Optional thread_id to continue.' },
        payload: { type: 'object', description: 'Optional structured JSON payload.' },
      },
      required: ['to_agent', 'message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'a2a_ack',
    description: 'Acknowledge an inbound Clarity A2A message without sending a reply (marks it completed).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Inbound Clarity A2A message UUID.' },
        note: { type: 'string', description: 'Optional local acknowledgement note.' },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
];

export const A2A_TOOL_NAMES = new Set(a2aTools.map(tool => tool.name));

export function createA2AClient({ baseUrl } = {}) {
  const a2aUrl = resolveBaseUrl(baseUrl);

  async function readLocalProfile() {
    try { return await loadProfile(); }
    catch { return null; }
  }

  async function requestJson(method, endpoint, body = null, timeoutMs = 10000) {
    let response;
    try {
      response = await fetch(`${a2aUrl}${endpoint}`, {
        method,
        headers: body !== null ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`Standalone a2a-connect daemon is not reachable at ${a2aUrl} (${error.message}). Start it with \`a2a-connect run\` or \`a2a-connect install-service\`.`);
    }
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!response.ok) {
      throw new Error(parsed.error || `a2a-connect HTTP ${response.status}`);
    }
    return parsed;
  }

  async function verifyIdentity(health) {
    const profile = await readLocalProfile();
    if (!profile) {
      return { ok: false, reason: 'not_registered', message: 'M3NT0R installation is not registered with Clarity; cannot verify a2a-connect identity.' };
    }
    const expectedHandle = String(profile.agent_handle || '').trim();
    const actualHandle = String(health.handle || '').trim();
    if (expectedHandle && actualHandle.toLowerCase() !== expectedHandle.toLowerCase()) {
      return {
        ok: false,
        reason: 'identity_mismatch',
        expected_handle: expectedHandle,
        actual_handle: actualHandle,
        message: `a2a-connect at ${a2aUrl} is bound to handle '${actualHandle}', not this M3NT0R installation's handle '${expectedHandle}'.`,
      };
    }
    const expectedApi = normalizeUrl(profile.api_url);
    const actualApi = normalizeUrl(health.api_base);
    if (expectedApi && actualApi && expectedApi !== actualApi) {
      return {
        ok: false,
        reason: 'identity_mismatch',
        expected_api_base: profile.api_url,
        actual_api_base: health.api_base,
        message: `a2a-connect at ${a2aUrl} targets '${health.api_base}', not this M3NT0R installation's Clarity API '${profile.api_url}'.`,
      };
    }
    return { ok: true, profile };
  }

  async function requireVerifiedDaemon() {
    const health = await requestJson('GET', '/health', null, 2000);
    const check = await verifyIdentity(health);
    if (!check.ok) throw new Error(check.message);
    return health;
  }

  async function callMcpRead(args) {
    let sessionId = null;
    try {
      const response = await fetch(`${a2aUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a2a_read', arguments: args } }),
        signal: AbortSignal.timeout(10000),
      });
      sessionId = response.headers.get('mcp-session-id');
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error?.message || `a2a-connect HTTP ${response.status}`);
      const toolRes = data.result || {};
      const text = toolRes.content?.[0]?.text || '{}';
      if (toolRes.isError) throw new Error(text);
      return JSON.parse(text);
    } catch (error) {
      if (error.name === 'TypeError' || error.name === 'AbortError' || /fetch failed/i.test(error.message)) {
        throw new Error(`Standalone a2a-connect daemon is not reachable at ${a2aUrl} (${error.message}). Start it with \`a2a-connect run\` or \`a2a-connect install-service\`.`);
      }
      throw error;
    } finally {
      if (sessionId) {
        fetch(`${a2aUrl}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId }, signal: AbortSignal.timeout(2000) }).catch(() => {});
      }
    }
  }

  async function status() {
    let health;
    try {
      health = await requestJson('GET', '/health', null, 2000);
    } catch (error) {
      return {
        delegated: true,
        a2a_url: a2aUrl,
        online: false,
        state: 'offline',
        unread_count: 0,
        last_error: error.message,
        install_hint: INSTALL_HINT,
      };
    }
    const check = await verifyIdentity(health);
    if (!check.ok) {
      return {
        delegated: true,
        a2a_url: a2aUrl,
        online: false,
        state: check.reason,
        unread_count: 0,
        expected_handle: check.expected_handle,
        actual_handle: check.actual_handle,
        last_error: check.message,
      };
    }
    const upstreamReady = health.stream?.state === 'ready';
    const policyOk = senderPolicyCompatible(health);
    return {
      delegated: true,
      a2a_url: a2aUrl,
      online: true,
      upstream_ready: upstreamReady,
      sender_policy_compatible: policyOk,
      state: health.stream?.state || 'ready',
      ...health,
    };
  }

  async function inbox({ status: filter = 'unread', limit = 25, from_agent, thread_id } = {}) {
    await requireVerifiedDaemon();
    const params = new URLSearchParams({ status: String(filter || 'unread'), limit: String(limit || 25) });
    if (from_agent) params.set('from_agent', String(from_agent));
    if (thread_id) params.set('thread_id', String(thread_id));
    return requestJson('GET', `/api/inbox?${params.toString()}`, null, 5000);
  }

  async function unreadSummary() {
    try {
      await requireVerifiedDaemon();
      const data = await requestJson('GET', '/api/inbox?status=unread&limit=5', null, 1500);
      return {
        count: Number(data.unread_count || 0),
        messages: (data.messages || []).map(m => ({
          id: m.id,
          thread_id: m.thread_id,
          from_agent: m.from_agent,
          kind: m.kind,
          preview: String(m.message || '').replace(/\s+/g, ' ').trim().slice(0, 140),
          created_at: m.created_at,
        })),
      };
    } catch {
      return { count: 0, messages: [] };
    }
  }

  async function call(name, args = {}) {
    if (name === 'a2a_status') return status();
    if (name === 'a2a_inbox') return inbox(args);
    await requireVerifiedDaemon();
    if (name === 'a2a_read') {
      if (args.thread_id && !args.message_id) {
        const markRead = args.mark_read === false ? 'false' : 'true';
        return requestJson('GET', `/api/threads/${encodeURIComponent(String(args.thread_id))}?mark_read=${markRead}`, null, 10000);
      }
      return callMcpRead(args);
    }
    if (name === 'a2a_reply') {
      return requestJson('POST', '/api/reply', {
        message_id: String(args.message_id || ''),
        message: String(args.message || ''),
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
      }, 30000);
    }
    if (name === 'a2a_send') {
      return requestJson('POST', '/api/send', {
        to_agent: String(args.to_agent || ''),
        message: String(args.message || ''),
        ...(args.thread_id ? { thread_id: String(args.thread_id) } : {}),
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
      }, 30000);
    }
    if (name === 'a2a_ack') {
      return requestJson('POST', '/api/ack', {
        message_id: String(args.message_id || ''),
        ...(args.note !== undefined ? { note: String(args.note) } : {}),
      }, 15000);
    }
    throw new Error(`Unknown A2A tool: ${name}`);
  }

  // Subscribe to a2a-connect's MCP SSE stream and forward pushed notifications
  // to M3NT0R's connected MCP harnesses and Owner UI.
  function startNotificationRelay(onNotification) {
    let stopped = false;
    let controller = null;
    let delay = 1500;
    let timer = null;

    async function loop() {
      if (stopped) return;
      let sessionId = null;
      try {
        await requireVerifiedDaemon();
        const initRes = await fetch(`${a2aUrl}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'clarity_m3ntor_relay', version: '0.8.0' } } }),
          signal: AbortSignal.timeout(5000),
        });
        sessionId = initRes.headers.get('mcp-session-id');
        if (!initRes.ok || !sessionId) throw new Error(`MCP init HTTP ${initRes.status}`);
        await fetch(`${a2aUrl}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
          signal: AbortSignal.timeout(5000),
        });
        await fetch(`${a2aUrl}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: 'a2a://inbox' } }),
          signal: AbortSignal.timeout(5000),
        });
        controller = new AbortController();
        const sseRes = await fetch(`${a2aUrl}/mcp`, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId },
          signal: controller.signal,
        });
        if (!sseRes.ok || !sseRes.body) throw new Error(`MCP SSE HTTP ${sseRes.status}`);
        delay = 1500;
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of sseRes.body) {
          if (stopped) break;
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            try { onNotification(JSON.parse(data)); } catch {}
          }
        }
      } catch {
        // Reconnect with backoff when a2a-connect is temporarily offline or restarts.
      } finally {
        controller = null;
        if (sessionId) {
          fetch(`${a2aUrl}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId }, signal: AbortSignal.timeout(1500) }).catch(() => {});
        }
        if (!stopped) {
          timer = setTimeout(loop, delay);
          delay = Math.min(delay * 2, 30000);
        }
      }
    }

    loop();
    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (controller) controller.abort();
      },
    };
  }

  return { a2aUrl, status, inbox, unreadSummary, call, startNotificationRelay };
}
