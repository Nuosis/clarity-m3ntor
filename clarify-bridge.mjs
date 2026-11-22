import { mkdir, watch } from 'node:fs';
import { mkdir as mkdirAsync } from 'node:fs/promises';
import path from 'node:path';
import { loadProfile, profilePath, readToken } from './clarity-client.mjs';
import { readEnvironment } from './environment.mjs';
import { storeJson } from './m3ntor-jobs.mjs';

const DEFAULT_CLARIFY_WS_URL = 'wss://ccs.claritycustomsoftware.com/api/m3ntor/ws';

// Persistent outbound WebSocket from local M3NT0R to Clarify.
// Authenticates with the existing M3NT0R clrtok_ token in the first JSON frame
// (never in URLs or logs), advertises enabled local flows + active waiting_event
// correlations, accepts delegated tasks/events into the local trigger-flow-task
// engine, and streams task status transitions back to Clarify.
export function startClarifyBridge({ cwd, taskQueue, wsUrl = null }) {
  const root = path.join(cwd, '.clarity_coach', 'clarify_bridge');
  const statusFile = path.join(root, 'bridge.json');
  let status = { state: 'starting', url: null, advertised_flows: [], waiting_tasks: 0, updated_at: null };
  let socket = null;
  let delay = 1000;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let manifestTimer = null;
  let closed = false;
  let waitingProfile = false;
  let profileWatcher = null;
  let ready = false;
  let outboxReady = false;
  let lastManifestHash = '';
  let profile = null;

  const setStatus = async patch => {
    status = { ...status, ...patch, updated_at: new Date().toISOString() };
    try {
      await mkdirAsync(root, { recursive: true, mode: 0o700 });
      await storeJson(statusFile, status);
    } catch (error) {
      console.error('Clarify bridge status write failed:', error.message);
    }
  };

  const resolveUrl = loadedProfile => (
    wsUrl
    || process.env.M3NTOR_CLARIFY_WS_URL
    || loadedProfile?.clarify_ws_url
    || DEFAULT_CLARIFY_WS_URL
  );

  const sendJson = frame => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      console.error('Clarify bridge send failed:', error.message);
      return false;
    }
  };

  async function buildManifest() {
    const env = await readEnvironment(cwd).catch(() => ({ processes: { processes: [] } }));
    const triggers = taskQueue.listTriggers();
    const flows = (env.processes?.processes || [])
      .filter(flow => flow.delegate_from_clarify === true && flow.id && flow.name)
      .map(flow => ({
        flow_id: flow.id,
        name: flow.name,
        trigger: flow.trigger || '',
        completion: flow.completion || '',
        status: flow.status || 'unverified',
        trigger_ids: triggers.filter(t => t.flow_id === flow.id && t.enabled).map(t => t.id),
      }));
    const waitingTasks = taskQueue.waitingEventTasks();
    return { flows, waiting_tasks: waitingTasks };
  }

  async function syncManifest({ force = false } = {}) {
    if (closed) return;
    const manifest = await buildManifest();
    const serialized = JSON.stringify(manifest);
    await setStatus({
      advertised_flows: manifest.flows.map(f => ({ flow_id: f.flow_id, name: f.name })),
      waiting_tasks: manifest.waiting_tasks.length,
    });
    if (!ready || (!force && serialized === lastManifestHash)) return;
    if (sendJson({
      type: 'manifest',
      installation_id: profile?.agent_id || null,
      agent_handle: profile?.agent_handle || null,
      organization_id: profile?.organization_id || null,
      flows: manifest.flows,
      waiting_tasks: manifest.waiting_tasks,
    })) {
      lastManifestHash = serialized;
    }
  }

  function scheduleManifestSync() {
    if (closed) return;
    clearTimeout(manifestTimer);
    manifestTimer = setTimeout(() => { syncManifest().catch(error => console.error('Clarify manifest sync failed:', error.message)); }, 250);
  }

  function flushStatusOutbox() {
    if (!outboxReady) return;
    while (outboxReady) {
      const batch = taskQueue.pendingClarifyStatuses(200);
      if (!batch.length) break;
      for (const item of batch) {
        if (!sendJson(item.frame)) return;
        taskQueue.ackClarifyStatus(item.id);
      }
    }
  }

  const unsubscribe = taskQueue.subscribeTaskChanges(event => {
    if (closed) return;
    if (event.clarify_delegation_id) {
      const frame = {
        type: 'task_status',
        delegation_id: event.clarify_delegation_id,
        local_task_id: event.task_id,
        flow_id: event.flow_id,
        flow_run_id: event.flow_run_id,
        status: event.status,
        checkpoint: event.checkpoint || null,
        result_summary: event.result ? String(event.result).slice(-2000) : null,
        error: event.error || null,
        child_task_id: event.child_task_id || null,
        wait_trigger_id: event.wait_trigger_id || null,
        wait_correlation_id: event.wait_correlation_id || null,
      };
      taskQueue.queueClarifyStatus(frame);
      flushStatusOutbox();
    }
    if (['waiting_event', 'queued', 'partial', 'completed', 'done', 'deleted'].includes(event.status)) {
      scheduleManifestSync();
    }
  });

  function clearHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function retry(reason) {
    if (closed) return;
    ready = false;
    outboxReady = false;
    clearHeartbeat();
    setStatus({ state: 'reconnecting', last_error: reason, retry_in_ms: delay });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 60000);
  }

  function watchProfile(accept) {
    if (waitingProfile || closed) return;
    waitingProfile = true;
    const directory = path.dirname(profilePath());
    mkdir(directory, { recursive: true, mode: 0o700 }, () => {
      if (closed) return;
      let opened = false;
      const check = async () => {
        if (opened || closed) return;
        try {
          const candidate = await loadProfile();
          if (!opened && accept(candidate)) {
            opened = true;
            profileWatcher?.close();
            profileWatcher = null;
            waitingProfile = false;
            connect();
          }
        } catch {}
      };
      try {
        profileWatcher = watch(directory, check);
        check();
      } catch {
        waitingProfile = false;
      }
    });
  }

  async function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'ready') {
      ready = true;
      outboxReady = false;
      delay = 1000;
      lastManifestHash = '';
      await setStatus({
        state: 'connected',
        connected_at: new Date().toISOString(),
        last_error: null,
        installation_id: frame.installation_id || profile?.agent_id || null,
        agent_handle: frame.agent_handle || profile?.agent_handle || null,
      });
      await syncManifest({ force: true });
      if (ready && socket?.readyState === WebSocket.OPEN) {
        outboxReady = true;
        flushStatusOutbox();
      }
      clearHeartbeat();
      heartbeatTimer = setInterval(() => { sendJson({ type: 'ping' }); }, 15000);
      return;
    }
    if (frame.type === 'pong') return;
    if (frame.type === 'error' && frame.code === 'unauthorized') {
      ready = false;
      outboxReady = false;
      const used = JSON.stringify(profile);
      await setStatus({ state: 'rejected', last_error: frame.message || 'Unauthorized token' });
      try { socket?.close(1000, 'unauthorized'); } catch {}
      watchProfile(candidate => JSON.stringify(candidate) !== used && Boolean(candidate.token_command || candidate.token_env));
      return;
    }
    if (frame.type === 'delegate_task') {
      try {
        const receipt = taskQueue.recordClarifyDelegation(frame);
        sendJson({
          type: 'ack',
          delegation_id: frame.delegation_id,
          local_task_id: receipt.local_task_id,
          flow_id: receipt.flow_id,
          flow_run_id: receipt.flow_run_id,
          status: receipt.status,
          duplicate: receipt.duplicate === true,
        });
        await setStatus({
          last_delegation_id: frame.delegation_id,
          last_delegation_at: new Date().toISOString(),
          last_local_task_id: receipt.local_task_id,
        });
        scheduleManifestSync();
      } catch (error) {
        console.error('Clarify delegate_task failed:', error.message);
        sendJson({
          type: 'task_status',
          delegation_id: frame.delegation_id,
          status: 'failed',
          error: error.message,
        });
        await setStatus({ last_error: error.message });
      }
    }
  }

  async function connect() {
    if (closed) return;
    if (process.env.M3NTOR_CLARIFY_BRIDGE_DISABLED === '1') {
      await setStatus({ state: 'disabled' });
      return;
    }
    try { profile = await loadProfile(); }
    catch {
      await setStatus({ state: 'not_registered', profile: profilePath() });
      watchProfile(candidate => Boolean(candidate.agent_handle && (candidate.token_command || candidate.token_env)));
      return;
    }
    let token;
    try { token = await readToken(profile); }
    catch (error) { return retry(`token read failed: ${error.message}`); }
    const targetUrl = resolveUrl(profile);
    await setStatus({ state: 'connecting', url: targetUrl, agent_handle: profile.agent_handle });
    let ws;
    try {
      ws = new WebSocket(targetUrl);
    } catch (error) {
      return retry(`WebSocket init failed: ${error.message}`);
    }
    socket = ws;
    ws.addEventListener('open', () => {
      if (closed || socket !== ws) return;
      sendJson({
        type: 'auth',
        token,
        installation_id: profile.agent_id,
        agent_handle: profile.agent_handle,
        organization_id: profile.organization_id,
      });
    });
    ws.addEventListener('message', event => {
      if (closed || socket !== ws) return;
      try {
        const frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        handleFrame(frame).catch(error => console.error('Clarify frame handler error:', error.message));
      } catch (error) {
        console.error('Clarify bridge invalid JSON:', error.message);
      }
    });
    ws.addEventListener('error', () => {
      if (closed || socket !== ws) return;
      // Close event handles reconnect.
    });
    ws.addEventListener('close', event => {
      if (closed || socket !== ws) return;
      socket = null;
      if (status.state === 'rejected') return;
      retry(`closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
    });
  }

  connect().catch(error => setStatus({ state: 'error', last_error: error.message }));

  return {
    status: () => status,
    syncManifest: () => syncManifest({ force: true }),
    close() {
      closed = true;
      ready = false;
      outboxReady = false;
      unsubscribe();
      clearTimeout(reconnectTimer);
      clearTimeout(manifestTimer);
      clearHeartbeat();
      profileWatcher?.close();
      try { socket?.close(1000, 'shutdown'); } catch {}
      socket = null;
    },
  };
}
