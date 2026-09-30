// V1.2 character animation director: pure and deterministic (no DOM, no network, no model calls).
// Idle behaviour is ambient visual presence only; task actions come from the real normalized station
// visuals computed by life-mode.js. Coordinates are source-image pixels (1672 x 941).

export const ACTIONS = Object.freeze(['IDLE_SIT', 'BLINK', 'LOOK_LEFT', 'LOOK_RIGHT', 'HEAD_NOD', 'TYPE', 'WORK', 'STAND_UP',
  'IDLE_STAND', 'WALK_AWAY', 'WALK_RETURN', 'SIT_DOWN', 'CELEBRATE', 'ERROR_REACTION']);
export const DURATIONS = Object.freeze({
  IDLE_SIT: 1800, BLINK: 260, LOOK_LEFT: 1500, LOOK_RIGHT: 1500, HEAD_NOD: 1300, TYPE: 2600, WORK: 3000,
  STAND_UP: 650, IDLE_STAND: 900, SIT_DOWN: 650, CELEBRATE: 1600, ERROR_REACTION: 1500,
});
export const WALK_SPEED = 120; // source px per second
export const AWAY_PAUSE_MS = 2800;
// Stations: seated sprite bounds (for layout checks) and a short local walk path relative to the seat.
// Paths were chosen so the destination box stays clear of cards, HUD, panels and other stations.
export const STATIONS = Object.freeze({
  LEAD: { seat: [734, 266, 172, 150], rise: 16, path: [[-78, 0]], altPath: [[70, 0]], legs: false },
  EXPLORER: { seat: [352, 262, 130, 178], rise: 20, path: [[48, -4], [150, 50]], legs: true },
  WORKER: { seat: [1254, 309, 110, 182], rise: 20, path: [[-40, 8], [-175, 40]], legs: true },
  REVIEWER: { seat: [356, 554, 158, 176], rise: 20, path: [[70, 6], [230, 30]], legs: true },
  QA: { seat: [1078, 612, 154, 160], rise: 20, path: [[-60, -8], [-200, -20]], legs: true },
});
export const ROLE_ORDER = Object.freeze(['LEAD', 'EXPLORER', 'REVIEWER', 'WORKER', 'QA']);
// First walks are staggered so a 15 s window always contains one, then one walker every WALK_EVERY_MS.
export const FIRST_WALK_MS = 2_500;
export const WALK_EVERY_MS = 11_000;

const TASK_LOOPS = Object.freeze({
  planning: ['WORK', 'LOOK_LEFT', 'WORK', 'LOOK_RIGHT'],
  integrating: ['LOOK_LEFT', 'WORK', 'LOOK_RIGHT', 'WORK'],
  exploring: ['LOOK_LEFT', 'TYPE', 'LOOK_RIGHT', 'TYPE'],
  working: ['TYPE', 'TYPE', 'HEAD_NOD', 'TYPE'],
  reviewing: ['HEAD_NOD', 'LOOK_RIGHT', 'HEAD_NOD', 'LOOK_LEFT'],
  testing: ['TYPE', 'WORK', 'TYPE', 'HEAD_NOD'],
  waiting: ['IDLE_SIT', 'BLINK', 'IDLE_SIT', 'LOOK_LEFT'],
});
// Deterministic idle micro-routines; each role starts at a different offset so the room is never in sync.
const IDLE_ROUTINE = Object.freeze(['IDLE_SIT', 'BLINK', 'LOOK_LEFT', 'IDLE_SIT', 'TYPE', 'LOOK_RIGHT', 'BLINK', 'HEAD_NOD', 'IDLE_SIT', 'WORK', 'BLINK']);
const IDLE_OFFSET = Object.freeze({ LEAD: 0, EXPLORER: 3, REVIEWER: 6, WORKER: 8, QA: 4 });

const dist = ([ax, ay], [bx, by]) => Math.hypot(bx - ax, by - ay);
const walkMs = (a, b) => Math.max(250, Math.round((dist(a, b) / WALK_SPEED) * 1000));
const lerp = ([ax, ay], [bx, by], t) => [ax + (bx - ax) * t, ay + (by - ay) * t];

export function destinationBox(role, path = STATIONS[role].path) {
  const { seat: [x, y, w, h], rise, legs } = STATIONS[role];
  const [dx, dy] = path.at(-1);
  return [x + dx, y + dy - rise, w, h + (legs ? 24 : 0)];
}

// Build the timed steps of one walk: stand, pause, walk out, stay, walk back, sit.
export function walkPlan(role, start, useAlt = false) {
  const station = STATIONS[role];
  const path = useAlt && station.altPath ? station.altPath : station.path;
  const steps = [];
  let t = start;
  const push = (action, ms, extra = {}) => { steps.push({ action, start: t, end: t + ms, ...extra }); t += ms; };
  push('STAND_UP', DURATIONS.STAND_UP, { from: [0, 0], to: [0, 0], pose: 'stand' });
  push('IDLE_STAND', DURATIONS.IDLE_STAND, { from: [0, 0], to: [0, 0], pose: 'stand' });
  let at = [0, 0];
  for (const point of path) { push('WALK_AWAY', walkMs(at, point), { from: at, to: point, pose: 'stand' }); at = point; }
  push('IDLE_STAND', AWAY_PAUSE_MS, { from: at, to: at, pose: 'stand', away: true, speak: true });
  for (const point of [...path.slice(0, -1)].reverse().concat([[0, 0]])) { push('WALK_RETURN', walkMs(at, point), { from: at, to: point, pose: 'stand' }); at = point; }
  push('SIT_DOWN', DURATIONS.SIT_DOWN, { from: [0, 0], to: [0, 0], pose: 'sit' });
  return steps;
}

function facing(from, to, previous = 'right') {
  if (to[0] < from[0] - 0.5) return 'left';
  if (to[0] > from[0] + 0.5) return 'right';
  return previous;
}

export class CharacterDirector {
  constructor({ roles = ROLE_ORDER } = {}) {
    this.roles = roles;
    this.startedAt = null;
    this.state = Object.fromEntries(roles.map((role) => [role, { steps: [], idleIndex: IDLE_OFFSET[role] ?? 0, taskIndex: 0, taskVisual: null, facing: 'right', last: null, walks: 0 }]));
    this.walker = null; // at most one idle walker in the room
    this.nextWalkAt = null;
    this.walkTurn = 0;
  }

  // Current step for a role (queue-driven). Returns a stable object while the step lasts.
  tick(now, { mode = 'IDLE', visuals = {}, reducedMotion = false } = {}) {
    this.startedAt ??= now;
    this.nextWalkAt ??= now + FIRST_WALK_MS;
    const out = {};
    for (const role of this.roles) {
      const s = this.state[role];
      const v = visuals[role] ?? { visual: 'idle', presence: 'standby' };
      const task = mode !== 'IDLE' && v.presence !== 'standby' ? v.visual : null;
      if (reducedMotion) { s.steps = [this.still(role, now)]; if (this.walker === role) this.walker = null; out[role] = this.describe(role, s.steps[0], now); continue; }
      // Real task activity interrupts casual idle behaviour and brings the character home first;
      // outside IDLE nobody keeps strolling, involved or not.
      if (task && s.taskVisual !== task) this.interrupt(role, now, task);
      else if (!task && s.taskVisual) {
        s.taskVisual = null;
        // Still walking home from an interrupted stroll: finish the return instead of snapping to the chair.
        if (s.steps.some((step) => step.pose === 'stand' && step.end > now)) this.interrupt(role, now, null);
        else s.steps = [];
      }
      else if (mode !== 'IDLE' && s.steps.some((step) => step.walk && step.pose === 'stand')) this.interrupt(role, now, null);
      while (s.steps.length && s.steps[0].end <= now) s.steps.shift();
      if (!s.steps.length) s.steps.push(...this.plan(role, now, mode, task));
      out[role] = this.describe(role, s.steps[0], now);
    }
    return out;
  }

  still(role, now) { return { action: 'IDLE_SIT', start: now, end: now + DURATIONS.IDLE_SIT, from: [0, 0], to: [0, 0], pose: 'sit' }; }

  plan(role, now, mode, task) {
    const s = this.state[role];
    if (this.walker === role) this.walker = null; // previous walk finished
    if (task) {
      const loop = task === 'done' ? ['CELEBRATE'] : task === 'failed' ? ['ERROR_REACTION'] : TASK_LOOPS[task] ?? ['WORK'];
      if ((task === 'done' || task === 'failed') && s.taskIndex > 0) return [this.still(role, now)]; // react once
      const action = loop[s.taskIndex++ % loop.length];
      return [{ action, start: now, end: now + DURATIONS[action], from: [0, 0], to: [0, 0], pose: 'sit' }];
    }
    if (mode === 'IDLE' && this.walker === null && now >= this.nextWalkAt && this.roles[this.walkTurn % this.roles.length] === role) {
      this.walker = role;
      this.walkTurn++;
      this.nextWalkAt = now + WALK_EVERY_MS;
      return walkPlan(role, now, s.walks++ % 2 === 1).map((step) => ({ ...step, walk: true }));
    }
    const action = IDLE_ROUTINE[s.idleIndex++ % IDLE_ROUTINE.length];
    return [{ action, start: now, end: now + DURATIONS[action], from: [0, 0], to: [0, 0], pose: 'sit' }];
  }

  // Cancel an idle sequence safely: walk straight home from the current position, sit, then work.
  interrupt(role, now, task) {
    const s = this.state[role];
    if (task) { s.taskVisual = task; s.taskIndex = 0; }
    const current = s.steps.find((step) => step.start <= now && step.end > now) ?? s.steps[0];
    const steps = [];
    if (current?.pose === 'stand') { // includes an earlier interrupted return: never teleport home
      const t = Math.min(1, Math.max(0, (now - current.start) / Math.max(1, current.end - current.start)));
      const at = current.action === 'STAND_UP' || current.action === 'IDLE_STAND' ? current.from : lerp(current.from, current.to, t);
      let start = now;
      if (Math.hypot(at[0], at[1]) > 0.5) { const ms = walkMs(at, [0, 0]); steps.push({ action: 'WALK_RETURN', start, end: start + ms, from: at, to: [0, 0], pose: 'stand', interrupted: true }); start += ms; }
      steps.push({ action: 'SIT_DOWN', start, end: start + DURATIONS.SIT_DOWN, from: [0, 0], to: [0, 0], pose: 'sit', interrupted: true });
    }
    if (this.walker === role) this.walker = null;
    s.steps = steps;
  }

  describe(role, step, now) {
    const s = this.state[role];
    s.facing = facing(step.from, step.to, s.facing);
    s.last = step;
    const walking = step.action === 'WALK_AWAY' || step.action === 'WALK_RETURN';
    return {
      action: step.action, pose: step.pose, walking, away: Boolean(step.away), speak: Boolean(step.speak),
      at: walking ? step.from : step.to, target: step.to, moveMs: walking ? step.end - step.start : 0,
      facing: s.facing, start: step.start, end: step.end, key: `${role}:${step.action}:${step.start}`,
    };
  }

  nextWake(now) {
    let next = Infinity;
    for (const role of this.roles) for (const step of this.state[role].steps) if (step.end > now) { next = Math.min(next, step.end); break; }
    return Number.isFinite(next) ? next : now + 1_000;
  }
}

// ---- Poses: sprite-style frames at a low, fixed rate (like classic isometric games). ----
// Each pose change costs one composited frame; between changes the page stays static, which keeps
// integrated GPUs cool. When every character is still, no pose frames are produced at all.
export const POSE_FPS = 10;
const TAU = Math.PI * 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const ease = (p) => p * p * (3 - 2 * p);
// 0 → 1 → 0 envelope with a plateau (turn the head, hold, turn back).
const plateau = (p, edge = 0.22) => (p < edge ? ease(p / edge) : p > 1 - edge ? ease((1 - p) / edge) : 1);
const round = (v) => Math.round(v * 10) / 10;
export const NEUTRAL_POSE = Object.freeze({ x: 0, y: 0, lift: 0, flip: 1, bodyY: 0, bodyRot: 0, headRot: 0, headX: 0, headY: 0, leg1: 0, leg2: 0, lids: 0 });

// Periodic blink for characters facing the room: closed for ~150 ms every few seconds, staggered.
export function blinkClosed(role, now) {
  const period = { LEAD: 4300, EXPLORER: 5100, WORKER: 4700, REVIEWER: 5500, QA: 4900 }[role] ?? 5000;
  const offset = { LEAD: 900, EXPLORER: 2300, WORKER: 3100, REVIEWER: 1700, QA: 400 }[role] ?? 0;
  return (now + offset) % period < 150;
}

export function poseAt(role, d, now, { reducedMotion = false } = {}) {
  if (!d || reducedMotion) return { ...NEUTRAL_POSE };
  const rise = STATIONS[role]?.rise ?? 20;
  const span = Math.max(1, d.end - d.start);
  const p = clamp01((now - d.start) / span);
  const t = (now - d.start) / 1000;
  const pose = { ...NEUTRAL_POSE, flip: d.facing === 'left' ? -1 : 1 };
  const [fx, fy] = d.walking ? d.at : d.target;
  const [tx, ty] = d.target;
  [pose.x, pose.y] = d.walking ? [fx + (tx - fx) * p, fy + (ty - fy) * p] : [tx, ty];
  pose.lift = d.pose === 'stand' ? rise : 0;
  switch (d.action) {
    case 'STAND_UP': pose.lift = rise * ease(p); pose.bodyRot = -4 * Math.sin(Math.PI * p); break;
    case 'SIT_DOWN': pose.lift = rise * (1 - ease(p)); pose.bodyRot = 3 * Math.sin(Math.PI * p); break;
    case 'IDLE_STAND': pose.bodyRot = 2.5 * Math.sin(TAU * t / 1.8); pose.headRot = -9 * Math.sin(TAU * t / 2.8); break;
    case 'WALK_AWAY':
    case 'WALK_RETURN': {
      const phase = Math.sin(TAU * t / 0.5);
      pose.bodyY = -3.5 * Math.abs(phase); pose.leg1 = 24 * phase; pose.leg2 = -24 * phase; pose.headRot = 2 * phase;
      break;
    }
    case 'LOOK_LEFT': pose.headRot = -13 * plateau(p); pose.headX = -4 * plateau(p); break;
    case 'LOOK_RIGHT': pose.headRot = 13 * plateau(p); pose.headX = 4 * plateau(p); break;
    case 'HEAD_NOD': { const n = Math.abs(Math.sin(TAU * p)); pose.headRot = 9 * n; pose.headY = 2 * n; break; }
    case 'TYPE': pose.bodyY = Math.floor(t * 6) % 2 ? 1.5 : 0; pose.headRot = 3 * Math.sin(TAU * t / 1.3); break;
    case 'WORK': pose.bodyY = Math.floor(t * 5) % 2 ? 1.2 : 0; pose.headRot = -10 * plateau(clamp01(p * 2)) + 9 * plateau(clamp01(p * 2 - 1)); break;
    case 'BLINK': pose.headY = 2 * Math.sin(Math.PI * p); pose.lids = 1; break;
    case 'CELEBRATE': pose.bodyY = -16 * Math.abs(Math.sin(TAU * t / 0.8)) * (p < 1 ? 1 : 0); pose.headRot = 9 * Math.sin(TAU * t / 0.8); break;
    case 'ERROR_REACTION': pose.headRot = 10 * Math.sin(TAU * t / 0.5) * (1 - p); pose.bodyY = p < 0.15 ? 3 : 0; break;
    default: break; // IDLE_SIT: still, so a quiet room costs no frames
  }
  if (d.action !== 'BLINK' && blinkClosed(role, now)) pose.lids = 1;
  for (const key of Object.keys(pose)) pose[key] = round(pose[key]);
  return pose;
}

// True while any character needs fresh pose frames (moving, or a blink is due soon).
export function needsFrames(frame, now) {
  return Object.entries(frame).some(([role, d]) => d.action !== 'IDLE_SIT' || blinkClosed(role, now) || blinkClosed(role, now + 1000 / POSE_FPS));
}

// Exactly one pending timer at a time, whatever the call pattern (prevents duplicate loops).
export function createWakeTimer({ setTimeout: set = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout } = {}) {
  let handle = null;
  return {
    schedule(delayMs, fn) {
      if (handle !== null) clear(handle);
      handle = set(() => { handle = null; fn(); }, Math.max(16, delayMs));
    },
    cancel() { if (handle !== null) clear(handle); handle = null; },
    get pending() { return handle !== null; },
  };
}
