import { mkdir, readFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { clarityRequest, loadProfile, profilePath, readToken } from './clarity-client.mjs';
import { getM3ntorResult, jobDirectory, startA2AJob, storeJson } from './m3ntor-jobs.mjs';

// Receives this installation's A2A messages from Clarity's push stream
// (GET /agent/agent_messages/stream, Server-Sent Events) with the installation
// token, runs each one through the owner's harness and posts the reply.
// Message lifecycle on Clarity: pending -> processing (handed to the harness)
// -> completed | failed (reply posted). A local ledger per message keeps
// reconnects and service restarts from starting the same work twice.
const terminal = new Set(['complete', 'failed', 'interrupted']);

// USER-AUTHORIZED — Marcus, November 16, 2026: the installation accepts A2A
// requests only from M-CODEX, performs them read-only and never shares
// sensitive data; requests from any other agent are ignored. The sender's
// organization is stamped by Clarity from the sender's key and cannot be set
// by the sender.
const CLARITY_OPERATOR_ORGANIZATION_ID = '9816c057-b5d3-43a2-848f-99365ee6255e';
const ACCEPTED_SENDER = 'm-codex';
const acceptedSender = message => String(message.from_agent || '').trim().toLowerCase() === ACCEPTED_SENDER
  && message.metadata?.sender_organization_id === CLARITY_OPERATOR_ORGANIZATION_ID;

export function startA2AReceiver({ cwd, harness, mcpUrl, onResponse }) {
  const root = path.join(cwd, '.clarity_coach', 'a2a');
  const ledgerDir = path.join(root, 'messages');
  const statusFile = path.join(root, 'receiver.json');
  let status = { state: 'starting', updated_at: null };
  let delay = 1000;
  let profile;
  const watchers = new Map();
  const inFlight = new Set(); // message ids being started in this process
  let waiting = false;

  const setStatus = async patch => {
    status = { ...status, ...patch, updated_at: new Date().toISOString() };
    try { await storeJson(statusFile, status); } catch (error) { console.error('A2A status write failed:', error.message); }
  };
  const ledgerFile = id => path.join(ledgerDir, `${id}.json`);
  const readLedger = async id => { try { return JSON.parse(await readFile(ledgerFile(id), 'utf8')); } catch { return null; } };
  const writeLedger = (id, value) => storeJson(ledgerFile(id), { ...value, updated_at: new Date().toISOString() });

  async function setRemoteStatus(id, state, delivery, lastError) {
    await clarityRequest('POST', '/agent/agent_messages/id/status', { id, status: state, delivery_status: delivery, ...(lastError ? { last_error: lastError.slice(0, 2000) } : {}) });
  }

  const retryDelays = new Map();
  const retryTimers = new Map(); // one queued delivery retry per message

  // Returns 'pending' (job still running), 'done' (reply settled or waiting for a
  // repaired credential) or 'retry' (delivery failed; try again later).
  async function reply(entry) {
    const job = await getM3ntorResult(entry.job_id);
    if (!terminal.has(job.status)) return 'pending';
    const ok = job.status === 'complete';
    const text = ok ? job.output : `The owner's agent could not complete this request: ${job.error || job.status}`;
    try {
      const sent = await clarityRequest('POST', '/agent/agent_messages/reply', {
        id: entry.message_id, from_agent: profile.agent_handle, message: text,
        metadata: { m3ntor_job_id: entry.job_id, job_status: job.status }, idempotency_key: `m3ntor-reply-${entry.message_id}`,
      });
      await setRemoteStatus(entry.message_id, ok ? 'completed' : 'failed', ok ? 'completed' : 'failed', ok ? null : text);
      await writeLedger(entry.message_id, { ...entry, status: ok ? 'replied' : 'replied_failure', job_status: job.status, reply_id: sent.id, replied_at: new Date().toISOString() });
      retryDelays.delete(entry.message_id);
      return 'done';
    } catch (error) {
      await writeLedger(entry.message_id, { ...entry, status: 'reply_failed', reply_error: error.message });
      console.error(`A2A reply for ${entry.message_id} failed:`, error.message);
      // Only transport failures and server errors are retried; a rejected credential
      // resumes after repair on the next connection, and other 4xx answers are final.
      return /request failed|HTTP 5\d\d/.test(error.message) ? 'retry' : 'done';
    }
  }

  // Reply when the detached job finishes; job state changes arrive as file events.
  // An event during a running check triggers one more check, so none is lost.
  function follow(entry) {
    if (watchers.has(entry.message_id)) return;
    let busy = false, again = false;
    const finish = () => { watchers.get(entry.message_id)?.close(); watchers.delete(entry.message_id); };
    const check = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        let outcome;
        do { again = false; outcome = await reply(entry); } while (outcome === 'pending' && again);
        if (outcome === 'done') { finish(); clearTimeout(retryTimers.get(entry.message_id)); retryTimers.delete(entry.message_id); }
        if (outcome === 'retry' && !retryTimers.has(entry.message_id)) {
          finish();
          const wait = Math.min((retryDelays.get(entry.message_id) || 2500) * 2, 300000);
          retryDelays.set(entry.message_id, wait);
          retryTimers.set(entry.message_id, setTimeout(async () => {
            retryTimers.delete(entry.message_id);
            const current = (await readLedger(entry.message_id)) || entry;
            if (!String(current.status).startsWith('replied')) follow(current);
          }, wait));
        }
      } finally { busy = false; }
    };
    watchers.set(entry.message_id, watch(jobDirectory(entry.job_id), () => { check(); }));
    check();
  }

  async function handle(message) {
    if (!message?.id || message.status !== 'pending' || inFlight.has(message.id)) return;
    inFlight.add(message.id);
    try {
      // A reply to this agent is information, never a new request: answering it
      // would start an endless reply exchange between two receivers.
      if (message.kind === 'response' || message.message_type === 'reply') await acceptResponse(message);
      else if (!acceptedSender(message)) await ignore(message);
      else await start(message);
    } finally { inFlight.delete(message.id); }
  }

  // Not from M-CODEX: record it and mark it handled so it is not replayed; no job, no reply.
  // A redelivered ignored message repeats the idempotent acknowledgment, so a failed one recovers.
  async function ignore(message) {
    if ((await readLedger(message.id))?.status !== 'ignored') await writeLedger(message.id, { message_id: message.id, from_agent: message.from_agent, sender_organization_id: message.metadata?.sender_organization_id ?? null, session_id: message.session_id, received_at: new Date().toISOString(), status: 'ignored' });
    await setRemoteStatus(message.id, 'ignored', 'delivered');
    await setStatus({ last_ignored_id: message.id, last_ignored_from: message.from_agent });
  }

  async function acceptResponse(message) {
    const entry = { message_id: message.id, kind: 'response', from_agent: message.from_agent, parent_message_id: message.parent_message_id, session_id: message.session_id, message: message.message, received_at: new Date().toISOString() };
    // Store the response locally first; it is acknowledged on Clarity only after
    // that succeeds, so a failure leaves it pending for replay on reconnect.
    if (onResponse) {
      try { await onResponse(message); }
      catch (error) {
        await writeLedger(message.id, { ...entry, status: 'response_store_failed', error: error.message });
        console.error('A2A response handler failed:', error.message);
        return;
      }
    }
    await writeLedger(message.id, { ...entry, status: 'response_received' });
    await setRemoteStatus(message.id, 'completed', 'delivered');
    await setStatus({ last_response_id: message.id, last_response_at: new Date().toISOString() });
  }

  async function start(message) {
    const existing = await readLedger(message.id);
    if (existing?.job_id) { if (!String(existing.status).startsWith('replied')) follow(existing); return; }
    const entry = { message_id: message.id, from_agent: message.from_agent, session_id: message.session_id, received_at: new Date().toISOString(), status: 'received' };
    await writeLedger(message.id, entry);
    // Link the job in the ledger before telling Clarity the message is processing:
    // until then it stays pending and a reconnect replays it to the same ledger.
    const job = await startA2AJob(message, { cwd, harness, mcpUrl });
    const started = { ...entry, status: 'processing', job_id: job.job_id };
    await writeLedger(message.id, started);
    try { await setRemoteStatus(message.id, 'processing', 'delivered'); }
    catch (error) { console.error(`A2A processing status for ${message.id} failed:`, error.message); }
    await setStatus({ last_message_id: message.id, last_message_at: started.received_at });
    follow(started);
  }

  async function resumeLedger() {
    let files = [];
    try { files = await readdir(ledgerDir); } catch {}
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const entry = await readLedger(file.slice(0, -5));
      if (entry?.job_id && !String(entry.status).startsWith('replied')) follow(entry);
    }
  }

  async function connect() {
    try { profile = await loadProfile(); }
    catch { return waitForRegistration(); }
    let response;
    try {
      const token = await readToken(profile);
      const url = new URL(`agent/agent_messages/stream?to_agent=${encodeURIComponent(profile.agent_handle)}`, profile.api_url.endsWith('/') ? profile.api_url : profile.api_url + '/');
      await setStatus({ state: 'connecting', agent_handle: profile.agent_handle });
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    } catch (error) { return retry(`connect failed: ${error.message}`); }
    if (response.status === 401 || response.status === 403) {
      // A rejected credential is not retried; reconnect once register.mjs rewrites the profile.
      const used = JSON.stringify(profile);
      await setStatus({ state: 'rejected', http_status: response.status, last_error: await response.text().catch(() => '') });
      return watchProfile(candidate => JSON.stringify(candidate) !== used && Boolean(candidate.token_command || candidate.token_env));
    }
    if (!response.ok || !response.body) return retry(`HTTP ${response.status}`);
    await setStatus({ state: 'connected', connected_at: new Date().toISOString(), last_error: null });
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event:\s?(.*)$/m.exec(block)?.[1] || 'message';
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (event === 'ready') { delay = 1000; await setStatus({ state: 'ready', ready_at: new Date().toISOString(), replayed_pending: JSON.parse(data || '{}').pending }); await resumeLedger(); }
          else if (event === 'message' && data) {
            try { await handle(JSON.parse(data)); }
            catch (error) { console.error('A2A message handling failed:', error.message); await setStatus({ last_error: error.message }); }
          }
        }
      }
    } catch (error) { return retry(`stream ended: ${error.message}`); }
    return retry('stream closed');
  }

  function retry(reason) {
    setStatus({ state: 'reconnecting', last_error: reason, retry_in_ms: delay });
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 60000);
  }

  // Not registered yet: start as soon as register.mjs writes the profile.
  async function waitForRegistration() {
    await setStatus({ state: 'not_registered', profile: profilePath() });
    return watchProfile(candidate => Boolean(candidate.agent_handle && (candidate.token_command || candidate.token_env)));
  }

  // One profile write raises several file events; only the first accepted one reconnects.
  async function watchProfile(accept) {
    if (waiting) return;
    waiting = true;
    const directory = path.dirname(profilePath());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let opened = false;
    const check = async () => {
      if (opened) return;
      try {
        const candidate = await loadProfile();
        if (!opened && accept(candidate)) { opened = true; watcher.close(); waiting = false; connect(); }
      } catch {}
    };
    const watcher = watch(directory, check);
    check(); // a profile written before the watcher existed still counts
  }

  (async () => {
    await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    connect();
  })().catch(error => setStatus({ state: 'error', last_error: error.message }));

  return { status: () => status };
}
