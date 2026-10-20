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
const PRIORITY = { 'orchestrator-controlled': 3, 'claude-observed': 2, 'codex-observed': 2 };

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
      missionId: e.missionId, at: ms(e.at), source: 'orchestrator-controlled' });
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
      if (!x.active || !ACTIVE_STATES.has(x.state) || now - ms(x.lastAt) > FRESH_MS) continue;
      const label = x.lastTool ? (x.lastTool.target ? `${x.lastTool.name} · ${x.lastTool.target}` : x.lastTool.name) : null;
      out.push({ role: roleOf(x.role), state: x.state, label, provider: 'claude-code', agentId: x.id, missionId: null, at: ms(x.lastAt), source: 'claude-observed' });
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
    list.sort((a, b) => (PRIORITY[b.source] - PRIORITY[a.source]) || (b.at - a.at));
    const top = list[0];
    out.set(role, { ...top, others: list.length - 1 });
  }
  return out;
}

export function taskLabel(a) {
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
      if (!cur) { village.assignTask(role, { label, state: want.state, source: want.source, provider: want.provider, agentId: want.agentId, missionId: want.missionId }); assigned.push(role); }
      else if (cur.label !== label || cur.state !== want.state) Object.assign(cur, { label, state: want.state, source: want.source, provider: want.provider, agentId: want.agentId, missionId: want.missionId });
    } else if (cur) {
      village.releaseTask(role);
      released.push(role);
    }
  }
  return { assigned, released };
}
