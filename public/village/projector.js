// Agent Village — Real Task Projector (M2). Pure: turns REAL runtime data into avatar assignments.
// Inputs are only verified sources: orchestrator events of running missions (orchestrator-controlled),
// Codex agents from the read-only rollout registry (codex-observed) and Claude Code sessions read from
// local transcripts (claude-observed). Nothing here can invent work: no input, no assignment.

export const ACTIVE_STATES = new Set(['planning', 'exploring', 'working', 'reviewing', 'testing', 'integrating']);
export const STATE_LABELS = Object.freeze({
  planning: 'planejando', exploring: 'explorando', working: 'implementando', reviewing: 'revisando',
  testing: 'testando', integrating: 'coordenando', waiting: 'aguardando', done: 'concluído', failed: 'falhou',
});
export const SOURCE_LABELS = Object.freeze({
  'orchestrator-controlled': 'missão da vila', 'codex-observed': 'Codex (observado)', 'claude-observed': 'Claude Code (observado)',
});
const VILLAGE_ROLES = new Set(['LEAD', 'EXPLORER', 'RE_ANALYST', 'SPEC_ARCHITECT', 'WORKER', 'REVIEWER', 'QA', 'RELEASE_GATE']);
export const FRESH_MS = 45_000;
export const OUTCOME_MS = 5_000; // confetti / rain cloud after a real command finishes
const PRIORITY = { 'orchestrator-controlled': 3, 'claude-observed': 2, 'codex-observed': 2 };
// A real request waiting for the operator outranks everything on that role: the hand must be seen.
const priorityOf = (c) => (c.needsYou ? 4 : PRIORITY[c.source] ?? 1);

const roleOf = (r) => (VILLAGE_ROLES.has(r) ? r : 'WORKER'); // unknown/GENERIC roles work at the Forge
const ms = (v) => (typeof v === 'number' ? v : Date.parse(v ?? '') || 0);

// Codex item types arrive as raw labels; show them in plain PT-BR (still no content).
const ITEM_LABELS = Object.freeze({
  reasoning: 'raciocinando', command_execution: 'executando comando', file_change: 'alterando arquivo', web_search: 'buscando na web',
  mcp_tool_call: 'ferramenta MCP', todo_list: 'atualizando o plano', agent_message: 'respondendo', collab_agent_tool_call: 'delegando',
});

/**
 * Remembers the latest orchestrator event per (mission, real agent). One real agent occupies exactly one avatar:
 * when it moves from exploring to editing to testing, the previous role is released (never inflated).
 */
export class MissionTracker {
  constructor() { this.byMission = new Map(); }

  push(e) {
    if (e?.source !== 'orchestrator-controlled' || !e.missionId) return;
    if (e.type === 'mission.completed' || e.type === 'mission.blocked') { this.byMission.delete(e.missionId); return; }
    if (e.type !== 'agent.state' && e.type !== 'agent.spawned') return;
    const m = this.byMission.get(e.missionId) ?? new Map();
    const role = roleOf(e.role);
    m.set(e.agentId ?? `role:${role}`, { role, state: e.type === 'agent.spawned' ? 'planning' : e.state, label: ITEM_LABELS[e.label] ?? e.label ?? null, provider: e.provider, agentId: e.agentId ?? null,
      account: e.account ?? null, missionId: e.missionId, at: ms(e.at), source: 'orchestrator-controlled',
      wait: e.wait ? { since: ms(e.wait.since), label: e.wait.label ?? null } : null, outcome: e.outcome ? { ok: e.outcome.ok, until: ms(e.at) + OUTCOME_MS } : null });
    this.byMission.set(e.missionId, m);
  }

  /** Drops missions the server no longer reports as running (restart, cancel). */
  sync(running = []) {
    const keep = new Set(running);
    for (const id of [...this.byMission.keys()]) if (!keep.has(id)) this.byMission.delete(id);
  }

  claims() {
    const out = [];
    for (const m of this.byMission.values()) for (const c of m.values()) out.push(c);
    return out;
  }
}

/** Codex registry snapshot (Ops Room /events) -> claims. */
export function codexClaims(room, now) {
  const out = [];
  for (const a of room?.agents ?? []) {
    if (!ACTIVE_STATES.has(a.state) || now - ms(a.updatedAt) > FRESH_MS) continue;
    out.push({ role: roleOf(a.role === 'GENERIC' ? 'WORKER' : a.role), state: a.state, label: typeof a.task === 'string' && a.task !== 'N/A' ? a.task : null,
      provider: 'codex', agentId: a.id, missionId: null, at: ms(a.updatedAt), source: 'codex-observed' });
  }
  return out;
}

/** Claude sessions (orchestrator state.observed.claude) -> claims, subagents included. */
export function claudeClaims(sessions, now) {
  const out = [];
  for (const s of sessions ?? []) {
    for (const x of [s, ...(s.subagents ?? [])]) {
      // A real command still running keeps its avatar busy (hourglass) however long it takes.
      if (!x.active || !ACTIVE_STATES.has(x.state) || (!x.wait && now - ms(x.lastAt) > FRESH_MS)) continue;
      const label = x.wait ? x.wait.label : x.lastTool ? (x.lastTool.target ? `${x.lastTool.name} · ${x.lastTool.target}` : x.lastTool.name) : null;
      const done = x.lastCommand && now - ms(x.lastCommand.at) < OUTCOME_MS ? { ok: x.lastCommand.ok, until: ms(x.lastCommand.at) + OUTCOME_MS } : null;
      out.push({ role: roleOf(x.role), state: x.state, label, provider: 'claude-code', account: s.account ?? null, project: s.project ?? null, agentId: x.id, missionId: null,
        at: Math.max(ms(x.lastAt), x.wait ? ms(x.wait.since) : 0), source: 'claude-observed', wait: x.wait ? { since: ms(x.wait.since), label: x.wait.label } : null, outcome: x.wait ? null : done });
    }
  }
  return out;
}

/**
 * Resolves claims to at most one assignment per avatar role: highest source priority, then most recent.
 * The number of other real agents on the same role is reported (never hidden, never inflated).
 */
export function project(claims) {
  const byRole = new Map();
  for (const c of claims) {
    const list = byRole.get(c.role) ?? [];
    list.push(c);
    byRole.set(c.role, list);
  }
  const out = new Map();
  for (const [role, list] of byRole) {
    list.sort((a, b) => (priorityOf(b) - priorityOf(a)) || (b.at - a.at));
    const top = list[0];
    out.set(role, { ...top, others: list.length - 1 });
  }
  return out;
}

/**
 * Requests waiting for the operator (hooks) -> claims. The avatar that is working for that session raises its
 * hand; when the session is not on screen, the Release Gate keeper does. Pure (tested).
 */
export function attentionClaims(items, claudeSessions = [], { keeper = 'RELEASE_GATE' } = {}) {
  const roleOfSession = new Map();
  for (const s of claudeSessions ?? []) {
    roleOfSession.set(s.id, roleOf(s.role));
    for (const x of s.subagents ?? []) roleOfSession.set(x.id, roleOf(x.role));
  }
  const out = [];
  for (const it of items ?? []) {
    if (it.status && it.status !== 'pending') continue;
    const role = (it.agentId && roleOfSession.get(`${it.sessionId}:${it.agentId}`)) || roleOfSession.get(it.sessionId) || keeper;
    const label = it.type === 'notice' ? 'esperando você no terminal' : it.summary?.title ?? 'pedido de permissão';
    out.push({ role, state: 'waiting', needsYou: true, attentionId: it.id, label: it.project ? `${label} · ${it.project}` : label,
      provider: it.provider, account: it.account ?? null, agentId: it.sessionId, missionId: null, at: it.createdAt ?? 0,
      source: it.provider === 'codex' ? 'codex-observed' : 'claude-observed' });
  }
  return out;
}

/** Gatehouse queue: the keeper waits at home, the others at the queue spots (in arrival order). Mutates. */
export function queueAtGatehouse(assignments, { keeper = 'RELEASE_GATE', queue = [] } = {}) {
  let i = 0;
  const waiting = [...assignments.values()].filter((a) => a.needsYou).sort((a, b) => a.at - b.at);
  for (const a of waiting) a.spot = a.role === keeper ? null : queue[Math.min(i++, queue.length - 1)] ?? null;
  return assignments;
}

export function taskLabel(a) {
  if (a.needsYou) return `✋ precisa de você · ${a.label ?? 'pedido'}${a.others ? ` (+${a.others})` : ''}`;
  const st = STATE_LABELS[a.state] ?? a.state;
  const more = a.others ? ` (+${a.others})` : '';
  return `${SOURCE_LABELS[a.source]} · ${st}${a.label ? ` · ${a.label}` : ''}${more}`;
}

/**
 * Applies assignments to the village with minimal changes (no re-walk when nothing changed).
 * Returns {assigned, released} role lists. `village` must expose agent(role), assignTask, releaseTask.
 */
export function applyAssignments(village, assignments, roles) {
  const assigned = [];
  const released = [];
  for (const role of roles) {
    const want = assignments.get(role);
    const cur = village.agent(role)?.task ?? null;
    if (want) {
      const label = taskLabel(want);
      const task = { label, state: want.state, source: want.source, provider: want.provider, agentId: want.agentId, missionId: want.missionId,
        account: want.account ?? null, project: want.project ?? null, needsYou: Boolean(want.needsYou), attentionId: want.attentionId ?? null,
        at: want.spot ?? null, wait: want.wait ?? null, outcome: want.outcome ?? null };
      // New task, or the avatar must move (raise its hand at the Gatehouse / go back to work): re-plan.
      if (!cur || cur.needsYou !== task.needsYou || (cur.at ?? null) !== task.at) { village.assignTask(role, task); assigned.push(role); }
      else if (cur.label !== label || cur.state !== want.state || cur.wait?.since !== task.wait?.since || cur.outcome?.until !== task.outcome?.until) Object.assign(cur, task);
    } else if (cur) {
      village.releaseTask(role);
      released.push(role);
    }
  }
  return { assigned, released };
}
