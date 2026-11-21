import { createHash, randomUUID } from 'node:crypto';
import { REVIEW_PROCESS_ID } from './inov8-review-process.mjs';
import { M3NTOR_PROCESS_ID, POMA_PROCESS_ID } from './internal-flows.mjs';

const VALID_KINDS = new Set(['schedule', 'event', 'adapter', 'manual']);
const VALID_OVERLAP = new Set(['allow', 'skip', 'queue']);
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const triggerFlowTools = [
  {
    name: 'register_trigger',
    description: 'Register or update a trigger bound to a process flow (schedule, event, adapter, or manual). Events sent to this trigger via fire_trigger or POST /api/triggers/:id/fire are recorded in trigger_events and create traced flow_runs.',
    inputSchema: {
      type: 'object',
      properties: {
        trigger_id: { type: 'string', description: 'Optional stable trigger ID; omit to generate one.' },
        flow_id: { type: 'string', description: 'Process/flow ID this trigger starts.' },
        node_id: { type: 'string', description: 'Optional trigger node ID in the flow definition.' },
        kind: { type: 'string', enum: ['schedule', 'event', 'adapter', 'manual'] },
        name: { type: 'string', description: 'Human-readable trigger name.' },
        config: { type: 'object', description: 'Trigger configuration (schedule, adapter command/source, optional task_template).' },
        overlap_policy: { type: 'string', enum: ['allow', 'skip', 'queue'], description: 'What to do if a run for this flow is already active.' },
        enabled: { type: 'boolean', description: 'Whether the trigger accepts incoming events (default true).' },
      },
      required: ['flow_id', 'kind', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_triggers',
    description: 'List registered triggers, optionally filtered by flow_id, along with each trigger\'s latest receipt and disposition.',
    inputSchema: {
      type: 'object',
      properties: { flow_id: { type: 'string' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fire_trigger',
    description: 'Deliver an event into a registered trigger through the local receiver. Records a durable trigger_events receipt, enforces dedupe_key idempotency, creates a flow_runs trace when accepted, and optionally enqueues a task.',
    inputSchema: {
      type: 'object',
      properties: {
        trigger_id: { type: 'string' },
        payload: { type: 'object', description: 'Event input payload.' },
        dedupe_key: { type: 'string', description: 'Optional idempotency key; duplicate keys for the same trigger are recorded as duplicate and do not start a second run.' },
        correlation_id: { type: 'string', description: 'Optional correlation ID linking related events and runs.' },
        source_ref: { type: 'string', description: 'Optional source reference (message ID, URL, record ID).' },
        synthetic: { type: 'boolean', description: 'Mark true for bootstrap or diagnostic smoke checks so they stay distinct from real business runs.' },
        dry_run: { type: 'boolean', description: 'When true (default for synthetic), trace trigger >> eligibility >> terminal without launching a harness task.' },
      },
      required: ['trigger_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_flow_runs',
    description: 'List traced flow runs (and their trigger receipts/dispositions), optionally filtered by flow_id.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_flow_run',
    description: 'Read a single traced flow run with its trigger receipt, node-level evidence, traversed edges, and linked task/job references.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'clear_synthetic_traces',
    description: 'Remove synthetic=true verification traces and trigger events (by run_id or all synthetic rows) after readback.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'Optional specific synthetic run_id to remove; omit to remove all synthetic traces.' } },
      additionalProperties: false,
    },
  },
];

export function createTriggerFlow(db, { enqueueTask = null, resolveFlow = null } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      node_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      overlap_policy TEXT NOT NULL DEFAULT 'allow',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS triggers_flow ON triggers (flow_id);

    CREATE TABLE IF NOT EXISTS trigger_events (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      flow_id TEXT NOT NULL,
      correlation_id TEXT,
      dedupe_key TEXT,
      source_ref TEXT,
      synthetic INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT,
      disposition TEXT NOT NULL,
      reason TEXT,
      flow_run_id TEXT,
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trigger_events_trigger ON trigger_events (trigger_id, received_at);
    CREATE INDEX IF NOT EXISTS trigger_events_dedupe ON trigger_events (trigger_id, dedupe_key);

    CREATE TABLE IF NOT EXISTS flow_runs (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      flow_version TEXT,
      trigger_event_id TEXT,
      trigger_id TEXT,
      source TEXT,
      correlation_id TEXT,
      synthetic INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      terminal_node_id TEXT,
      definition_json TEXT,
      traversed_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS flow_runs_flow ON flow_runs (flow_id, started_at);

    CREATE TABLE IF NOT EXISTS flow_run_nodes (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id TEXT,
      job_id TEXT,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (run_id, node_id)
    );
  `);

  const parse = (raw, fallback = null) => {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  };

  function seedBuiltins() {
    const builtins = [
      { id: 'inov8-clock', flow_id: REVIEW_PROCESS_ID, node_id: 'trigger-clock', kind: 'schedule', name: 'Automatic cadence', config: { builtin: true } },
      { id: 'inov8-manual', flow_id: REVIEW_PROCESS_ID, node_id: 'trigger-manual', kind: 'manual', name: 'Manual Run', config: { builtin: true } },
      { id: 'inov8-answer', flow_id: REVIEW_PROCESS_ID, node_id: 'trigger-answer', kind: 'event', name: 'Owner answer', config: { builtin: true } },
      { id: 'inov8-recovery', flow_id: REVIEW_PROCESS_ID, node_id: 'trigger-recovery', kind: 'event', name: 'Recovery return', config: { builtin: true } },
      { id: 'poma-weekly', flow_id: POMA_PROCESS_ID, node_id: 'trigger-weekly', kind: 'schedule', name: 'Weekly POMA schedule', config: { builtin: true, schedule: { weekly: { day: 'monday', time: '08:00' } } } },
      { id: 'poma-manual', flow_id: POMA_PROCESS_ID, node_id: 'trigger-manual', kind: 'manual', name: 'Manual / Bootstrap POMA', config: { builtin: true } },
      { id: 'poma-event', flow_id: POMA_PROCESS_ID, node_id: 'trigger-event', kind: 'event', name: 'POMA trigger receiver', config: { builtin: true } },
      { id: 'm3ntor-ask', flow_id: M3NTOR_PROCESS_ID, node_id: 'trigger-ask', kind: 'event', name: 'MCP ask_m3ntor', config: { builtin: true } },
      { id: 'm3ntor-weekly', flow_id: M3NTOR_PROCESS_ID, node_id: 'trigger-weekly', kind: 'schedule', name: 'Weekly goal review consult', config: { builtin: true } },
    ];
    const at = now();
    const stmt = db.prepare(`INSERT OR IGNORE INTO triggers (id, flow_id, node_id, kind, name, config_json, overlap_policy, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'skip', 1, ?, ?)`);
    for (const item of builtins) {
      stmt.run(item.id, item.flow_id, item.node_id, item.kind, item.name, JSON.stringify(item.config), at, at);
    }
  }
  seedBuiltins();

  const formatTrigger = row => {
    if (!row) return null;
    const last = db.prepare('SELECT id, disposition, reason, flow_run_id, synthetic, received_at FROM trigger_events WHERE trigger_id = ? ORDER BY rowid DESC LIMIT 1').get(row.id);
    const count = db.prepare('SELECT COUNT(*) AS count FROM trigger_events WHERE trigger_id = ?').get(row.id)?.count || 0;
    return {
      id: row.id,
      flow_id: row.flow_id,
      node_id: row.node_id,
      kind: row.kind,
      name: row.name,
      config: parse(row.config_json, {}),
      overlap_policy: row.overlap_policy,
      enabled: row.enabled === 1,
      receiver_path: `/api/triggers/${encodeURIComponent(row.id)}/fire`,
      event_count: count,
      last_event: last ? { ...last, synthetic: last.synthetic === 1 } : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  };

  function registerTrigger(input) {
    if (!input?.flow_id?.trim()) throw new Error('flow_id is required.');
    if (!VALID_KINDS.has(input.kind)) throw new Error('kind must be schedule, event, adapter, or manual.');
    if (!input?.name?.trim()) throw new Error('name is required.');
    const overlap = input.overlap_policy || 'allow';
    if (!VALID_OVERLAP.has(overlap)) throw new Error('overlap_policy must be allow, skip, or queue.');
    const id = input.trigger_id?.trim() || randomUUID();
    const existing = db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
    const at = now();
    const config = JSON.stringify(input.config && typeof input.config === 'object' ? input.config : {});
    const enabled = input.enabled === false ? 0 : 1;
    if (existing) {
      db.prepare('UPDATE triggers SET flow_id = ?, node_id = ?, kind = ?, name = ?, config_json = ?, overlap_policy = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(input.flow_id.trim(), input.node_id || null, input.kind, input.name.trim(), config, overlap, enabled, at, id);
    } else {
      db.prepare('INSERT INTO triggers (id, flow_id, node_id, kind, name, config_json, overlap_policy, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.flow_id.trim(), input.node_id || null, input.kind, input.name.trim(), config, overlap, enabled, at, at);
    }
    return { trigger: formatTrigger(db.prepare('SELECT * FROM triggers WHERE id = ?').get(id)), created: !existing };
  }

  function syncBusinessTriggers(processes = []) {
    const at = now();
    const stmt = db.prepare(`INSERT OR IGNORE INTO triggers (id, flow_id, node_id, kind, name, config_json, overlap_policy, enabled, created_at, updated_at)
      VALUES (?, ?, 'trigger-0', 'event', ?, ?, 'allow', 1, ?, ?)`);
    let added = 0;
    for (const flow of processes || []) {
      if (!flow?.id || !flow?.name) continue;
      const id = `flow-${flow.id}`;
      const config = JSON.stringify({ business_flow: true, trigger_description: flow.trigger || '' });
      const res = stmt.run(id, flow.id, `${flow.name} trigger`, config, at, at);
      added += res.changes;
    }
    return { synced: added };
  }

  function listTriggers(flowId = null) {
    const rows = flowId
      ? db.prepare('SELECT * FROM triggers WHERE flow_id = ? ORDER BY created_at').all(flowId)
      : db.prepare('SELECT * FROM triggers ORDER BY created_at').all();
    return rows.map(formatTrigger);
  }

  function recordNode(runId, node) {
    db.prepare(`INSERT INTO flow_run_nodes (run_id, node_id, node_type, status, task_id, job_id, input_json, output_json, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id) DO UPDATE SET
        status = excluded.status, task_id = COALESCE(excluded.task_id, flow_run_nodes.task_id),
        job_id = COALESCE(excluded.job_id, flow_run_nodes.job_id),
        input_json = COALESCE(excluded.input_json, flow_run_nodes.input_json),
        output_json = COALESCE(excluded.output_json, flow_run_nodes.output_json),
        error = excluded.error, finished_at = excluded.finished_at`)
      .run(
        runId, node.node_id, node.node_type || 'operation', node.status,
        node.task_id || null, node.job_id || null,
        node.input !== undefined ? JSON.stringify(node.input) : null,
        node.output !== undefined ? JSON.stringify(node.output) : null,
        node.error || null, node.started_at || now(), node.finished_at || null,
      );
  }

  function receiveTrigger(input) {
    const triggerId = input?.trigger_id?.trim();
    if (!triggerId) throw new Error('trigger_id is required.');
    const triggerRow = db.prepare('SELECT * FROM triggers WHERE id = ?').get(triggerId);
    if (!triggerRow) throw new Error(`Trigger "${triggerId}" is not registered.`);
    const trigger = formatTrigger(triggerRow);
    const eventId = randomUUID();
    const receivedAt = now();
    const synthetic = input.synthetic === true ? 1 : 0;
    const dedupeKey = input.dedupe_key ? String(input.dedupe_key).trim() : null;
    const correlationId = input.correlation_id ? String(input.correlation_id).trim() : eventId;
    const sourceRef = input.source_ref ? String(input.source_ref).trim() : null;
    const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};

    const saveEvent = (disposition, reason, flowRunId = null) => {
      db.prepare(`INSERT INTO trigger_events (id, trigger_id, flow_id, correlation_id, dedupe_key, source_ref, synthetic, payload_json, disposition, reason, flow_run_id, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(eventId, trigger.id, trigger.flow_id, correlationId, dedupeKey, sourceRef, synthetic, JSON.stringify(payload), disposition, reason, flowRunId, receivedAt);
    };

    if (dedupeKey) {
      const prior = db.prepare("SELECT id, flow_run_id FROM trigger_events WHERE trigger_id = ? AND dedupe_key = ? AND disposition = 'accepted' LIMIT 1").get(trigger.id, dedupeKey);
      if (prior) {
        saveEvent('duplicate', `Duplicate dedupe_key "${dedupeKey}" (original event ${prior.id})`, prior.flow_run_id);
        return { accepted: false, disposition: 'duplicate', event_id: eventId, trigger_id: trigger.id, flow_id: trigger.flow_id, original_event_id: prior.id, flow_run_id: prior.flow_run_id };
      }
    }

    if (!trigger.enabled) {
      saveEvent('skipped', 'Trigger is disabled');
      return { accepted: false, disposition: 'skipped', reason: 'Trigger is disabled', event_id: eventId, trigger_id: trigger.id, flow_id: trigger.flow_id, flow_run_id: null };
    }

    if (trigger.overlap_policy === 'skip') {
      const active = db.prepare("SELECT id FROM flow_runs WHERE flow_id = ? AND status = 'running' LIMIT 1").get(trigger.flow_id);
      if (active) {
        saveEvent('skipped', `Flow run ${active.id} is already running`);
        return { accepted: false, disposition: 'skipped', reason: `Flow run ${active.id} is already running`, event_id: eventId, trigger_id: trigger.id, flow_id: trigger.flow_id, flow_run_id: null };
      }
    }

    const runId = randomUUID();
    const resolved = resolveFlow ? resolveFlow(trigger.flow_id) : null;
    const flowVersion = resolved?.version || (resolved ? hash(resolved) : null);
    const triggerNodeId = trigger.node_id || `trigger-${trigger.kind}`;
    const dryRun = input.dry_run === true || (synthetic === 1 && input.dry_run !== false);
    const traversed = [`${triggerNodeId}--eligibility`];

    saveEvent('accepted', dryRun ? 'Accepted (synthetic/dry-run trace)' : 'Accepted', runId);

    let runStatus = 'completed';
    let terminalNodeId = 'terminal-received';
    let finishedAt = now();
    let enqueuedTask = null;

    if (!dryRun && trigger.config?.task_template && enqueueTask) {
      const tpl = trigger.config.task_template;
      const result = enqueueTask({
        title: tpl.title || `Triggered: ${trigger.name}`,
        instruction: tpl.instruction || `Handle trigger "${trigger.name}" for flow ${trigger.flow_id}.`,
        success: tpl.success || 'Flow outcome completed and recorded.',
        constraints: tpl.constraints,
        category: tpl.category || 'triggered_flow',
        process_ids: [trigger.flow_id],
        trigger_input: { trigger_id: trigger.id, event_id: eventId, correlation_id: correlationId, source_ref: sourceRef, payload },
      });
      enqueuedTask = result?.task || null;
      runStatus = 'running';
      terminalNodeId = null;
      finishedAt = null;
      traversed.push('eligibility--agent');
    } else {
      traversed.push(`eligibility--${terminalNodeId}`);
    }

    db.prepare(`INSERT INTO flow_runs (id, flow_id, flow_version, trigger_event_id, trigger_id, source, correlation_id, synthetic, status, terminal_node_id, definition_json, traversed_json, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, trigger.flow_id, flowVersion, eventId, trigger.id, trigger.kind, correlationId, synthetic, runStatus, terminalNodeId, resolved ? JSON.stringify(resolved) : null, JSON.stringify(traversed), receivedAt, finishedAt);

    recordNode(runId, {
      node_id: triggerNodeId, node_type: 'trigger', status: 'completed',
      input: { trigger_id: trigger.id, source_ref: sourceRef, correlation_id: correlationId, payload },
      started_at: receivedAt, finished_at: receivedAt,
    });
    recordNode(runId, {
      node_id: 'eligibility', node_type: 'decision', status: 'completed',
      output: { decision: 'accepted', overlap_policy: trigger.overlap_policy, synthetic: synthetic === 1 },
      started_at: receivedAt, finished_at: receivedAt,
    });
    if (enqueuedTask) {
      recordNode(runId, {
        node_id: 'agent', node_type: 'agent', status: 'started',
        task_id: enqueuedTask.id, input: { payload }, started_at: receivedAt,
      });
    } else {
      recordNode(runId, {
        node_id: terminalNodeId, node_type: 'terminal', status: 'completed',
        output: { disposition: dryRun ? 'synthetic_verified' : 'recorded', synthetic: synthetic === 1 },
        started_at: receivedAt, finished_at: finishedAt,
      });
    }

    return {
      accepted: true,
      disposition: 'accepted',
      event_id: eventId,
      flow_run_id: runId,
      trigger_id: trigger.id,
      flow_id: trigger.flow_id,
      correlation_id: correlationId,
      synthetic: synthetic === 1,
      status: runStatus,
      task_id: enqueuedTask?.id || null,
    };
  }

  function listFlowRuns(flowId = null, limit = 50) {
    const rows = flowId
      ? db.prepare('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY rowid DESC LIMIT ?').all(flowId, limit)
      : db.prepare('SELECT * FROM flow_runs ORDER BY rowid DESC LIMIT ?').all(limit);
    return rows.map(row => ({
      id: row.id,
      process_id: row.flow_id,
      flow_id: row.flow_id,
      trigger_id: row.trigger_id,
      trigger_event_id: row.trigger_event_id,
      source: row.source,
      decision: row.status === 'skipped' ? 'skipped' : 'proceeded',
      status: row.status,
      terminal_node_id: row.terminal_node_id,
      synthetic: row.synthetic === 1,
      correlation_id: row.correlation_id,
      version: row.flow_version,
      created_at: row.started_at,
      finished_at: row.finished_at,
    }));
  }

  function getFlowRun(runId) {
    const row = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(runId);
    if (!row) return null;
    const nodeRows = db.prepare('SELECT * FROM flow_run_nodes WHERE run_id = ? ORDER BY rowid').all(runId);
    const nodes = {};
    for (const item of nodeRows) {
      nodes[item.node_id] = {
        node_type: item.node_type,
        status: item.status,
        task_id: item.task_id,
        job_id: item.job_id,
        input: parse(item.input_json),
        output: parse(item.output_json),
        error: item.error,
        started_at: item.started_at,
        finished_at: item.finished_at,
      };
    }
    const eventRow = row.trigger_event_id ? db.prepare('SELECT * FROM trigger_events WHERE id = ?').get(row.trigger_event_id) : null;
    return {
      id: row.id,
      process_id: row.flow_id,
      flow_id: row.flow_id,
      trigger_id: row.trigger_id,
      trigger_event: eventRow ? { ...eventRow, synthetic: eventRow.synthetic === 1, payload: parse(eventRow.payload_json) } : null,
      source: row.source,
      status: row.status,
      terminal_node_id: row.terminal_node_id,
      synthetic: row.synthetic === 1,
      correlation_id: row.correlation_id,
      version: row.flow_version,
      definition: parse(row.definition_json),
      traversed: parse(row.traversed_json, []),
      nodes,
      created_at: row.started_at,
      finished_at: row.finished_at,
    };
  }

  function clearSyntheticTraces(runId = null) {
    if (runId) {
      const target = db.prepare('SELECT id, trigger_event_id FROM flow_runs WHERE id = ? AND synthetic = 1').get(runId);
      if (!target) return { removed_runs: 0, removed_events: 0 };
      db.prepare('DELETE FROM flow_run_nodes WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM flow_runs WHERE id = ?').run(runId);
      const events = db.prepare('DELETE FROM trigger_events WHERE (flow_run_id = ? OR id = ?) AND synthetic = 1').run(runId, target.trigger_event_id || '');
      return { removed_runs: 1, removed_events: events.changes };
    }
    const syntheticIds = db.prepare('SELECT id FROM flow_runs WHERE synthetic = 1').all().map(r => r.id);
    for (const id of syntheticIds) db.prepare('DELETE FROM flow_run_nodes WHERE run_id = ?').run(id);
    const runs = db.prepare('DELETE FROM flow_runs WHERE synthetic = 1').run();
    const events = db.prepare('DELETE FROM trigger_events WHERE synthetic = 1').run();
    return { removed_runs: runs.changes, removed_events: events.changes };
  }

  function call(name, input = {}) {
    if (name === 'register_trigger') return registerTrigger(input);
    if (name === 'list_triggers') return { triggers: listTriggers(input.flow_id || null) };
    if (name === 'fire_trigger') return receiveTrigger(input);
    if (name === 'list_flow_runs') return { runs: listFlowRuns(input.flow_id || null, input.limit || 50) };
    if (name === 'get_flow_run') {
      const run = getFlowRun(input.run_id);
      if (!run) throw new Error(`Flow run "${input.run_id}" not found.`);
      return run;
    }
    if (name === 'clear_synthetic_traces') return clearSyntheticTraces(input.run_id || null);
    return null;
  }

  return { registerTrigger, syncBusinessTriggers, listTriggers, receiveTrigger, listFlowRuns, getFlowRun, clearSyntheticTraces, call };
}
