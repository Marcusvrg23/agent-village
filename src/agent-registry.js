import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export const DEFAULT_CONFIG = Object.freeze({ maxConcurrentAgents: 3, activeWindowMs: 45_000 });
export const STATES = ['idle', 'planning', 'exploring', 'working', 'reviewing', 'testing', 'waiting', 'integrating', 'done', 'failed'];
const ACTIVE = new Set(['planning', 'exploring', 'working', 'reviewing', 'testing', 'integrating']);
const phase = { LEAD: 'working', EXPLORER: 'exploring', WORKER: 'working', REVIEWER: 'reviewing', QA: 'testing', GENERIC: 'working' };
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const identity = (value) => typeof value === 'string' && /^[a-zA-Z0-9_./:@ -]{1,180}$/.test(value) ? value : null;
const shortId = (value) => value ? `agent-${hash(value).slice(0, 12)}` : null;
const emptyUsage = () => ({ input: null, cachedInput: null, output: null, total: null });

export function mapAgentRole({ role, agentPath, isRoot = false, activityRole } = {}) {
  // Metadata wins; an unknown nickname never becomes a made-up role.
  const match = (value) => {
    const tokens = String(value ?? '').toLowerCase().split(/[^a-z]+/);
    if (tokens.some((t) => ['qa', 'test', 'tests', 'tester'].includes(t))) return 'QA';
    if (tokens.some((t) => ['review', 'reviewer', 'security'].includes(t))) return 'REVIEWER';
    if (tokens.includes('explorer')) return 'EXPLORER';
    if (tokens.includes('worker')) return 'WORKER';
    if (tokens.some((t) => ['root', 'default', 'main', 'lead', 'coordinator'].includes(t))) return 'LEAD';
    return null;
  };
  return match(role) ?? (isRoot ? 'LEAD' : null) ?? match(agentPath?.split('/').at(-1)) ??
    (['EXPLORER', 'WORKER', 'REVIEWER', 'QA'].includes(activityRole) ? activityRole : 'GENERIC');
}

export function normalizeState(event = {}, kind = '') {
  if (STATES.includes(kind)) return kind;
  if (/failed|error|abort/.test(kind) || event.state === 'ERROR') return 'failed';
  if (/complete|finished|stopped/.test(kind) || event.sourceSubtype === 'task_complete') return 'done';
  if (/wait|interacted/.test(kind) || /Waiting/.test(event.summary ?? '')) return 'waiting';
  if (/plan/.test(kind)) return 'planning';
  if (/integrat/.test(kind)) return 'integrating';
  if (event.state === 'DONE') return 'waiting'; // Tool completion does not complete the agent's task.
  if (event.state === 'ACTIVE' || kind === 'started') return phase[event.role] ?? 'working';
  return 'idle';
}

export function readUsage(raw) {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const number = (...values) => values.find((v) => Number.isSafeInteger(v) && v >= 0) ?? null;
  return {
    input: number(raw.input_tokens, raw.input),
    cachedInput: number(raw.cached_input_tokens, raw.cached_input, raw.input_tokens_details?.cached_tokens),
    output: number(raw.output_tokens, raw.output),
    total: number(raw.total_tokens, raw.total),
  };
}

function endpoint(value) {
  if (typeof value === 'string') return identity(value);
  return identity(value?.agent_thread_id ?? value?.thread_id ?? value?.agent_id ?? value?.agent_path ?? value?.id);
}

export function communicationEndpoints(record) {
  const p = record?.payload ?? {};
  if (record?.type === 'response_item' && p.type === 'agent_message') {
    const from = endpoint(p.author), to = endpoint(p.recipient);
    return from && to ? { from, to, kind: 'message', label: 'Mensagem recebida' } : null;
  }
  if (record?.type === 'inter_agent_communication_metadata') {
    const from = endpoint(p.sender_agent_id ?? p.sender ?? p.author ?? p.from);
    const to = endpoint(p.recipient_agent_id ?? p.recipient ?? p.to);
    return from && to ? { from, to, kind: 'message', label: 'Comunicação observada' } : null;
  }
  return null; // trigger_turn alone is not evidence of a directed link.
}

// One bounded, read-only metadata lookup on session switch; the V0 tail stays untouched.
export async function readSessionMetadata(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(512_000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const record = JSON.parse(line);
        if (record.type === 'session_meta') return record;
      } catch { /* Incomplete metadata is unavailable, never guessed. */ }
    }
    return null;
  } finally { await handle.close(); }
}

export class AgentRegistry {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!Number.isInteger(this.config.maxConcurrentAgents) || this.config.maxConcurrentAgents < 1) throw new Error('Invalid maxConcurrentAgents');
    this.agents = new Map();
    this.aliases = new Map();
    this.seen = new Set();
    this.communications = [];
    this.selected = null;
    this.duplicates = 0;
  }

  select(id) {
    this.selected = identity(id);
    if (this.selected) this.ensure(this.selected);
  }

  resolve(id) { return this.aliases.get(id) ?? id; }

  ensure(id, data = {}) {
    id = identity(id);
    if (!id) return null;
    id = this.resolve(id);
    if (!this.agents.has(id)) this.agents.set(id, {
      id, label: id.startsWith('/') ? id.split('/').at(-1) : shortId(id), agentPath: id.startsWith('/') ? id : null,
      parentId: null, metadataRole: null, role: mapAgentRole({ agentPath: id.startsWith('/') ? id : null }),
      roleEvidence: 'unavailable', state: 'idle', task: 'N/A', updatedAt: null,
      activities: [], tools: new Set(), usage: emptyUsage(), usageAt: null, isRoot: false,
    });
    const agent = this.agents.get(id);
    Object.assign(agent, data);
    return agent;
  }

  alias(alias, id) {
    if (!alias || alias === id) return;
    const existing = this.agents.get(alias);
    if (existing && this.agents.has(id)) {
      const target = this.agents.get(id);
      target.activities = [...target.activities, ...existing.activities].slice(-30);
      for (const tool of existing.tools) target.tools.add(tool);
      if (!target.updatedAt || existing.updatedAt > target.updatedAt) {
        Object.assign(target, { updatedAt: existing.updatedAt, state: existing.state, task: existing.task });
      }
      this.agents.delete(alias);
      for (const agent of this.agents.values()) if (agent.parentId === alias) agent.parentId = id;
    }
    this.aliases.set(alias, id);
  }

  attach(child, parentId) {
    const parent = this.ensure(parentId);
    if (!child || !parent || child.id === parent.id) return;
    let cursor = parent;
    const seen = new Set();
    while (cursor) {
      if (cursor.id === child.id || seen.has(cursor.id)) return;
      seen.add(cursor.id);
      cursor = this.agents.get(this.resolve(cursor.parentId));
    }
    child.parentId = parent.id;
  }

  metadata(record) {
    const p = record?.payload ?? {};
    const id = identity(p.id ?? p.session_id);
    if (!id || (this.selected && id !== this.selected)) return; // Ignore inherited session headers.
    const spawn = p.source?.subagent?.thread_spawn ?? {};
    const agentPath = identity(p.agent_path ?? spawn.agent_path);
    const parentId = identity(p.parent_thread_id ?? spawn.parent_thread_id ?? p.forked_from_id);
    const agent = this.ensure(id, {
      agentPath: agentPath ?? (parentId ? null : '/root'),
      label: identity(p.agent_nickname ?? spawn.agent_nickname) ?? agentPath?.split('/').at(-1) ?? (parentId ? shortId(id) : 'Lead'),
      metadataRole: identity(p.agent_role ?? spawn.agent_role), isRoot: !parentId,
    });
    this.alias(agent.agentPath, id);
    if (parentId) {
      this.attach(agent, parentId);
      const parentPath = agentPath?.slice(0, agentPath.lastIndexOf('/'));
      if (parentPath) {
        const parent = this.ensure(parentId, { agentPath: parentPath, role: mapAgentRole({ agentPath: parentPath }), roleEvidence: 'child parent metadata' });
        parent.label = parentPath.split('/').at(-1);
        this.alias(parentPath, parent.id);
      }
    }
    agent.role = mapAgentRole({ role: agent.metadataRole, agentPath: agent.agentPath, isRoot: agent.isRoot });
    agent.roleEvidence = 'session metadata';
  }

  recordActivity(agent, event, timestamp, kind = '') {
    if (!agent) return;
    const state = normalizeState(event, kind);
    if (agent.role === 'GENERIC' && event?.role && event.role !== 'LEAD') {
      agent.role = mapAgentRole({ activityRole: event.role });
      agent.roleEvidence = agent.role === 'GENERIC' ? 'unavailable' : 'observed tool activity';
    }
    // Only normalized operational summaries cross the privacy boundary.
    const summary = event?.summary ?? ({ started: 'Agente iniciado', interacted: 'Interação observada', completed: 'Agente concluído' }[kind] ?? 'Estado observado');
    agent.activities.push({ timestamp, state, summary, role: event?.role ?? agent.role });
    agent.activities = agent.activities.slice(-30);
    if (!agent.updatedAt || timestamp >= agent.updatedAt) Object.assign(agent, { state, task: summary, updatedAt: timestamp });
  }

  connect(from, to, kind, label, timestamp, eventKey) {
    const source = this.ensure(from), target = this.ensure(to);
    if (!source || !target || source.id === target.id) return;
    this.communications.push({ id: eventKey, from: source.id, to: target.id, kind, label, timestamp });
    this.communications = this.communications.slice(-30);
  }

  ingest(line, normalized) {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (!record || typeof record !== 'object') return;
    const p = record.payload ?? {};
    const key = hash(`${this.selected}|${record.type}|${p.type}|${p.event_id ?? record.id ?? line}`);
    if (this.seen.has(key)) { this.duplicates++; return; }
    this.seen.add(key);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value);
    const milliseconds = Date.parse(record.timestamp) || p.occurred_at_ms;
    const timestamp = Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
    if (record.type === 'session_meta') { this.metadata(record); return; }
    let agent = this.agents.get(this.resolve(this.selected));
    if (!agent) return;

    if (record.type === 'event_msg' && p.type === 'sub_agent_activity') {
      const id = identity(p.agent_thread_id ?? p.agent_id ?? p.agent_path);
      if (!id) return;
      const agentPath = identity(p.agent_path);
      const child = this.ensure(id, { agentPath, label: agentPath?.split('/').at(-1) ?? shortId(id) });
      this.alias(agentPath, child.id);
      child.role = mapAgentRole({ role: p.agent_role, agentPath, activityRole: child.role });
      child.roleEvidence = 'sub_agent_activity';
      const parentPath = agentPath?.slice(0, agentPath.lastIndexOf('/'));
      const explicitParent = identity(p.parent_thread_id ?? p.parent_agent_id ?? p.parent_agent_path);
      // A canonical hierarchical path is relationship evidence; names alone are not.
      const parent = explicitParent ?? (parentPath && this.aliases.has(parentPath) ? this.resolve(parentPath) : null);
      if (parent) this.attach(child, parent);
      this.recordActivity(child, { role: child.role }, timestamp, p.kind);
      if (child.parentId && p.kind === 'started') this.connect(child.parentId, child.id, 'delegation', 'Delegação iniciada', timestamp, key);
      if (child.parentId && ['completed', 'finished'].includes(p.kind)) this.connect(child.id, child.parentId, 'completion', 'Trabalho concluído', timestamp, key);
      return;
    }

    const communication = communicationEndpoints(record);
    if (communication) {
      this.connect(communication.from, communication.to, communication.kind, communication.label, timestamp, key);
      return;
    }
    if (record.type === 'response_item' && ['reasoning', 'message', 'agent_message'].includes(p.type)) return;

    let usage = null;
    if (record.type === 'token_usage_record') {
      const owner = identity(p.thread_id ?? p.session_id);
      if (owner && this.resolve(owner) !== agent.id) return;
      usage = p.thread_token_usage;
    } else if (record.type === 'event_msg' && p.type === 'token_count') usage = p.info?.total_token_usage;
    if (usage && (!agent.usageAt || timestamp >= agent.usageAt)) {
      agent.usage = readUsage(usage);
      agent.usageAt = timestamp;
    }
    if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      const name = identity(p.name);
      if (name) agent.tools.add(name);
      if (/(^|[.:/_])update_plan$/.test(name ?? '') && timestamp) {
        this.recordActivity(agent, { role: 'LEAD', summary: 'Plano atualizado' }, timestamp, 'planning');
        return;
      }
    }
    if (normalized?.operational && timestamp) this.recordActivity(agent, normalized, timestamp);
  }

  snapshot(now = Date.now()) {
    const selected = this.resolve(this.selected);
    const connected = new Set(selected ? [selected] : []);
    // Scope totals to the selected real parent/child family, never unrelated workspaces.
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of this.agents.values()) {
        const parent = this.resolve(a.parentId);
        if (parent && (connected.has(a.id) || connected.has(parent))) {
          for (const id of [a.id, parent]) if (!connected.has(id)) { connected.add(id); changed = true; }
        }
      }
      for (const edge of this.communications) {
        const from = this.resolve(edge.from), to = this.resolve(edge.to);
        if (connected.has(from) || connected.has(to)) {
          for (const id of [from, to]) if (!connected.has(id)) { connected.add(id); changed = true; }
        }
      }
    }
    const agents = [...this.agents.values()].filter((a) => connected.has(a.id)).map((a) => {
      const stale = !a.updatedAt || now - Date.parse(a.updatedAt) > this.config.activeWindowMs;
      const state = stale && ACTIVE.has(a.state) ? 'idle' : a.state;
      return { ...a, id: shortId(a.id), parentId: shortId(this.resolve(a.parentId)), tools: [...a.tools], state,
        observedState: a.state, stale, sessionId: shortId(a.id) };
    });
    const edges = this.communications.filter((c) => connected.has(this.resolve(c.from)) && connected.has(this.resolve(c.to)))
      .map((c) => ({ ...c, from: shortId(this.resolve(c.from)), to: shortId(this.resolve(c.to)) }));
    const totals = emptyUsage();
    const knownUsageAgents = agents.filter((a) => a.usage.total !== null).length;
    for (const field of Object.keys(totals)) {
      const values = agents.map((a) => a.usage[field]).filter((v) => v !== null);
      totals[field] = values.length ? values.reduce((a, b) => a + b, 0) : null;
    }
    const activeAgents = agents.filter((a) => ACTIVE.has(a.state)).length;
    return {
      selectedAgentId: shortId(selected), agents, communications: edges,
      usage: { ...totals, knownAgents: knownUsageAgents, observedAgents: agents.length, scope: 'observed family; cumulative snapshots, not summed events' },
      budget: { maxConcurrentAgents: this.config.maxConcurrentAgents, activeAgents, exceeded: activeAgents > this.config.maxConcurrentAgents,
        advisoryOnly: true, policy: 'Small task → Lead · Explore → Explorer · Implement → Worker · Review → Reviewer · Test → QA' },
      duplicatesIgnored: this.duplicates,
    };
  }
}
