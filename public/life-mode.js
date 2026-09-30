// V1.1 Life Mode: pure, deterministic presentation logic. No imports, no network, no model calls.
// Everything here derives from the snapshot the existing SSE stream already delivers.

export const ROOM_MODES = Object.freeze({ IDLE: 'IDLE', TASK: 'TASK', COMPLETED: 'COMPLETED' });
export const MODE_LABELS = Object.freeze({ IDLE: 'LIVE IDLE', TASK: 'LIVE TASK', COMPLETED: 'COMPLETED SNAPSHOT' });
export const VISUAL_STATES = ['idle', 'planning', 'exploring', 'working', 'reviewing', 'testing', 'waiting', 'integrating', 'done', 'failed'];
export const STATION_ROLES = ['LEAD', 'EXPLORER', 'WORKER', 'REVIEWER', 'QA'];
export const AMBIENT_PHRASES = Object.freeze([
  'Ready', 'Waiting for tasks', 'Ops Room online', 'Standby', 'Ready when you are', 'Monitoring', 'Waiting for the next task',
]);
// Alternates sides of the room so consecutive ambient lines never come from neighbours.
export const AMBIENT_ORDER = Object.freeze(['LEAD', 'EXPLORER', 'QA', 'WORKER', 'REVIEWER']);
export const LIFE_CONFIG = Object.freeze({
  activeWindowMs: 45_000, // Same freshness window as the V1 registry and watcher.
  completedHoldMs: 12_000,
  settleMs: 15_000,
  eventBubbleMs: 6_000,
  commBubbleMs: 8_000,
  maxTaskBubbles: 3,
  ambientFirstMs: 2_500,
  ambientGapMs: 5_500,
  ambientShowMs: 4_500,
});

const ACTIVE = new Set(['planning', 'exploring', 'working', 'reviewing', 'testing', 'integrating']);
const SETTLED = new Set(['waiting', 'done', 'failed']);
const time = (value) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export function deriveRoomMode(state, now = Date.now(), config = LIFE_CONFIG) {
  const lead = state?.roles?.LEAD;
  const lastEventAt = Math.max(0, time(state?.session?.lastActivity), time(state?.activity?.[0]?.timestamp),
    ...(state?.room?.agents ?? []).map((agent) => time(agent.updatedAt)));
  const growthAt = time(state?.debug?.lastObservedActivity); // Rollout file growth observed by the watcher.
  const lastActivityAt = Math.max(lastEventAt, growthAt) || null;
  const ageMs = lastActivityAt ? Math.max(0, now - lastActivityAt) : null;
  const leadAt = time(lead?.updatedAt);
  // Only turn-level events end a task (V0 normalizer summaries); a failed tool call does not.
  const outcome = lead?.summary === 'Turn complete' ? 'done' : lead?.summary === 'Session reported an error' ? 'failed' : null;
  // A terminal Lead event only ends the task while it is still the newest operational event.
  if (outcome && leadAt && leadAt >= lastEventAt) {
    const mode = now - leadAt < config.completedHoldMs ? ROOM_MODES.COMPLETED : ROOM_MODES.IDLE;
    return { mode, label: MODE_LABELS[mode], outcome, lastActivityAt, ageMs, reason: mode === ROOM_MODES.COMPLETED ? 'task-ended' : 'completed-expired' };
  }
  if (lastEventAt && ageMs !== null && ageMs <= config.activeWindowMs) {
    return { mode: ROOM_MODES.TASK, label: MODE_LABELS.TASK, outcome: null, lastActivityAt, ageMs, reason: 'fresh-activity' };
  }
  return { mode: ROOM_MODES.IDLE, label: MODE_LABELS.IDLE, outcome: null, lastActivityAt, ageMs, reason: lastActivityAt ? 'stale' : 'no-activity' };
}

export function stationVisual({ mode, displayState, updatedAt } = {}, now = Date.now(), config = LIFE_CONFIG) {
  const state = VISUAL_STATES.includes(displayState) ? displayState : 'idle';
  const standby = { visual: 'idle', presence: 'standby' };
  if (mode === ROOM_MODES.TASK) {
    if (ACTIVE.has(state)) return { visual: state, presence: 'active' };
    if (SETTLED.has(state) && updatedAt && now - time(updatedAt) <= config.settleMs) return { visual: state, presence: 'settled' };
    return standby;
  }
  if (mode === ROOM_MODES.COMPLETED) {
    // Only the station whose own real state ended shows it; the observed turn may belong to a child agent,
    // and an outcome from an earlier turn is too old to belong to this completion.
    if ((state === 'done' || state === 'failed') && updatedAt && now - time(updatedAt) <= config.settleMs) return { visual: state, presence: 'settled' };
    return standby;
  }
  return standby; // IDLE: visual presence only; nothing is shown as running.
}

export function formatAge(ageMs) {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return '—';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

// Deterministic local rotation. Only one ambient line exists at a time and only in IDLE.
export class AmbientDirector {
  constructor({ phrases = AMBIENT_PHRASES, order = AMBIENT_ORDER, config = LIFE_CONFIG } = {}) {
    this.phrases = phrases;
    this.order = order;
    this.config = config;
    this.phraseIndex = 0;
    this.roleIndex = 0;
    this.current = null;
    this.nextAt = null;
  }

  tick(now, mode) {
    if (mode !== ROOM_MODES.IDLE) {
      this.current = null;
      this.nextAt = null; // Resume only after a fresh pause once the room is idle again.
      return null;
    }
    this.nextAt ??= now + this.config.ambientFirstMs;
    if (this.current && now >= this.current.until) {
      this.current = null;
      this.nextAt = now + this.config.ambientGapMs;
    }
    if (!this.current && now >= this.nextAt) {
      const role = this.order[this.roleIndex++ % this.order.length];
      const text = this.phrases[this.phraseIndex++ % this.phrases.length];
      this.current = { role, text, kind: 'ambient', since: now, until: now + this.config.ambientShowMs };
    }
    return this.current;
  }
}

// Task bubbles only restate real normalized events or verified communication endpoints.
export function taskBubbles({ mode, stations = [], room = null, now = Date.now(), config = LIFE_CONFIG } = {}) {
  if (mode !== ROOM_MODES.TASK && mode !== ROOM_MODES.COMPLETED) return [];
  const byRole = new Map();
  const agents = room?.agents ?? [];
  const stationRoles = new Set(stations.map((station) => station.role));
  const offer = (bubble) => {
    const existing = byRole.get(bubble.role);
    if (!existing || (bubble.kind === 'comm' && existing.kind !== 'comm') || (bubble.kind === existing.kind && bubble.at > existing.at)) byRole.set(bubble.role, bubble);
  };
  for (const edge of room?.communications ?? []) {
    const at = time(edge.timestamp);
    if (!at || now - at > config.commBubbleMs || now < at - 2_000) continue;
    const from = agents.find((agent) => agent.id === edge.from);
    const to = agents.find((agent) => agent.id === edge.to);
    if (!from || !to || from.id === to.id) continue;
    if (stationRoles.has(from.role)) offer({ role: from.role, kind: 'comm', text: `→ ${to.label}: ${edge.label}`, at });
    else if (stationRoles.has(to.role)) offer({ role: to.role, kind: 'comm', text: `← ${from.label}: ${edge.label}`, at });
  }
  for (const station of stations) {
    const at = time(station.updatedAt);
    if (!station.task || !at || now - at > config.eventBubbleMs || now < at - 2_000) continue;
    const { presence } = stationVisual({ ...station, mode }, now, config);
    if (presence === 'standby') continue;
    offer({ role: station.role, kind: 'event', text: station.task, at });
  }
  return [...byRole.values()].sort((a, b) => b.at - a.at).slice(0, config.maxTaskBubbles);
}
