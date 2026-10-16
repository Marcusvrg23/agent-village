// Agent Village — Life Engine (M1).
// Deterministic, seeded, local simulation of idle life. Pure module: no DOM, no network, no model calls,
// zero tokens. It never produces technical events: everything here is ambient presence only.
// Real work (M2) enters exclusively through assignTask()/releaseTask(), driven by verified runtime events.
import { buildGraph, pathLength, shortestPath } from './pathfinding.js';

export const ROLE_ORDER = Object.freeze(['LEAD', 'EXPLORER', 'RE_ANALYST', 'SPEC_ARCHITECT', 'WORKER', 'REVIEWER', 'QA', 'RELEASE_GATE']);
export const ROLE_LABELS = Object.freeze({
  LEAD: 'Lead', EXPLORER: 'Explorer', RE_ANALYST: 'RE Analyst', SPEC_ARCHITECT: 'Spec Architect',
  WORKER: 'Worker', REVIEWER: 'Reviewer', QA: 'QA', RELEASE_GATE: 'Release Gate',
});
// Visual personality: affects idle behaviour only, never facts or safety rules.
export const PERSONALITY = Object.freeze({
  LEAD: { curiosity: 0.5, social: 0.85, focus: 0.6, speed: 36 },
  EXPLORER: { curiosity: 0.95, social: 0.6, focus: 0.4, speed: 42 },
  RE_ANALYST: { curiosity: 0.6, social: 0.3, focus: 0.9, speed: 34 },
  SPEC_ARCHITECT: { curiosity: 0.5, social: 0.5, focus: 0.8, speed: 33 },
  WORKER: { curiosity: 0.3, social: 0.4, focus: 0.95, speed: 38 },
  REVIEWER: { curiosity: 0.6, social: 0.5, focus: 0.7, speed: 35 },
  QA: { curiosity: 0.55, social: 0.6, focus: 0.85, speed: 37 },
  RELEASE_GATE: { curiosity: 0.35, social: 0.45, focus: 0.7, speed: 32 },
});
// What each avatar does at its own building while idle (decorative, not a claim of real work).
export const HOME_ACTION = Object.freeze({
  LEAD: 'TYPE', EXPLORER: 'LOOK_AROUND', RE_ANALYST: 'TYPE', SPEC_ARCHITECT: 'READ',
  WORKER: 'TYPE', REVIEWER: 'READ', QA: 'TYPE', RELEASE_GATE: 'LOOK_AROUND',
});
export const ACTIONS = Object.freeze(['IDLE', 'WALK', 'LOOK_AROUND', 'TYPE', 'READ', 'TALK', 'REST', 'CELEBRATE', 'WORK']);
// Local ambient lines. They are deliberately non-technical so they can never be mistaken for agent activity.
export const AMBIENT_PHRASES = Object.freeze([
  'Pronto para a próxima missão', 'Aguardando tasks…', 'Dia tranquilo na vila', 'Bora um café?', 'Que pôr do sol!',
  'Vou dar uma volta', 'Alguém viu meu caderno?', 'Tudo em standby', 'Esticando as pernas', 'A fonte está linda hoje',
  'Olá!', 'Pronto quando você estiver',
]);
export const LIFE = Object.freeze({
  bubbleMs: 4_200,
  maxBubbles: 2,
  talkTurnMs: 2_300,
  meetTimeoutMs: 16_000,
  blinkMs: 140,
  stepPx: 8, // walked distance per walk frame (frames advance with distance, so feet never slide)
});

export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng, lo, hi) => lo + (hi - lo) * rng();
const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

export class Village {
  constructor(world, { seed = 20261016, reducedMotion = false } = {}) {
    this.world = world;
    this.graph = buildGraph(world);
    this.reducedMotion = reducedMotion;
    this.time = 0;
    this.meetSeq = 0;
    this.reserved = new Set(); // social nodes in use
    this.homes = {};
    for (const [id, building] of Object.entries(world.buildings)) if (building.role) this.homes[building.role] = { id, node: building.spot };
    this.strollNodes = Object.keys(world.nodes).filter((id) => !id.endsWith('_SPOT'));
    this.spotNodes = Object.values(world.buildings).map((b) => b.spot);
    this.agents = ROLE_ORDER.filter((role) => this.homes[role]).map((role, index) => {
      const rng = mulberry32(seed + index * 7919);
      const home = this.homes[role];
      const [x, y] = world.nodes[home.node];
      const agent = {
        role, label: ROLE_LABELS[role], home: home.id, homeNode: home.node, rng, x, y, node: home.node,
        plan: [], step: null, path: [], walked: 0, facing: index % 2 ? 'right' : 'left', heading: 'down',
        activity: 'IDLE', bubble: null, nextBlinkAt: between(rng, 600, 3_000), blinkUntil: 0,
        presence: 'standby', task: null, trips: 0, returns: 0, distance: 0,
      };
      // Stagger the first decisions so the village never moves in sync.
      agent.plan.push({ type: 'act', action: HOME_ACTION[role], ms: between(rng, 1_500, 11_000) });
      return agent;
    });
    this.byRole = new Map(this.agents.map((a) => [a.role, a]));
    this.env = { night: 0, rain: 0 };
  }

  /** Local ambience only (time of day, decorative weather): changes idle preferences, never facts. */
  setEnvironment({ night = 0, rain = 0 } = {}) {
    const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    this.env = { night: clamp01(night), rain: clamp01(rain) };
  }

  agent(role) { return this.byRole.get(role); }

  distance(from, to) {
    const route = shortestPath(this.graph, from, to);
    return route ? pathLength(this.graph, route) : Infinity;
  }

  #nearby(node, list, count) {
    return list.filter((n) => n !== node).map((n) => [n, this.distance(node, n)]).sort((x, y) => x[1] - y[1]).slice(0, count).map(([n]) => n);
  }

  // ---- M2 entry points: only verified runtime events may call these. ----
  assignTask(role, task) {
    const a = this.byRole.get(role);
    if (!a) return false;
    a.task = { label: String(task?.label ?? 'N/A'), state: String(task?.state ?? 'working'), since: this.time };
    a.presence = 'verified';
    a.bubble = null; // ambient lines never overlap real work
    this.#abortSocial(a);
    const target = this.homes[role].node;
    a.plan = [{ type: 'act', action: 'WORK', ms: Infinity }];
    a.step = this.reducedMotion ? null : { type: 'walk', to: target, started: this.time, resume: true };
    if (a.step) this.#startWalk(a, target, true);
    return true;
  }

  releaseTask(role) {
    const a = this.byRole.get(role);
    if (!a || !a.task) return false;
    a.task = null;
    a.presence = 'standby';
    a.plan = [];
    a.step = null;
    return true;
  }

  step(dtMs) {
    const dt = Math.max(0, Math.min(dtMs, 250)); // large gaps (tab hidden) never teleport anyone
    this.time += dt;
    for (const a of this.agents) this.#update(a, dt);
  }

  snapshot() {
    return this.agents.map((a) => ({
      role: a.role, label: a.label, x: a.x, y: a.y, activity: a.activity, presence: a.presence, task: a.task,
      building: a.home, bubble: a.bubble && a.bubble.until > this.time ? { text: a.bubble.text, kind: a.bubble.kind } : null,
      ...frameFor(a, this.time, this.byRole),
    }));
  }

  // ---------------------------------------------------------------------------------------------
  #update(a, dt) {
    if (a.bubble && a.bubble.until <= this.time) a.bubble = null;
    if (!a.step) {
      if (!a.plan.length) a.plan = this.#choosePlan(a);
      this.#begin(a, a.plan.shift());
    }
    const s = a.step;
    if (s.type === 'walk') this.#walk(a, dt);
    else if (s.type === 'act') {
      a.activity = s.action;
      if (this.time - s.started >= s.ms) this.#finish(a);
    } else if (s.type === 'meet') this.#meet(a);
    if (this.time >= a.nextBlinkAt) {
      a.blinkUntil = this.time + LIFE.blinkMs;
      a.nextBlinkAt = this.time + between(a.rng, 2_200, 5_600);
    }
  }

  #begin(a, step) {
    a.step = { ...step, started: this.time };
    if (step.type === 'walk') this.#startWalk(a, step.to, false);
    if (step.type === 'act' && step.bubble) this.#say(a, step.bubble);
    if (step.type === 'act') a.activity = step.action;
  }

  #finish(a) {
    if (a.step?.type === 'meet') this.reserved.delete(a.step.node);
    a.step = null;
  }

  #startWalk(a, to, resume) {
    // When re-routed mid-edge, finish the current segment first (no jumps, no duplicated sprite).
    const next = resume && a.path.length ? a.path[0] : a.node;
    const route = shortestPath(this.graph, next, to) ?? [next];
    a.path = resume && a.path.length ? route : route.slice(1);
    if (a.node === a.homeNode && to !== a.homeNode) a.trips += 1;
    a.activity = 'WALK';
  }

  #walk(a, dt) {
    let budget = (PERSONALITY[a.role].speed * dt) / 1000;
    a.activity = 'WALK';
    while (budget > 0 && a.path.length) {
      const [tx, ty] = this.world.nodes[a.path[0]];
      const dx = tx - a.x;
      const dy = ty - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.01) {
        if (Math.abs(dx) > 0.2) a.facing = dx < 0 ? 'left' : 'right';
        a.heading = dy < -0.15 * d ? 'up' : 'down';
      }
      const move = Math.min(budget, d);
      if (d > 0) { a.x += (dx / d) * move; a.y += (dy / d) * move; }
      a.walked += move;
      a.distance += move;
      budget -= move;
      if (move >= d) {
        a.x = tx; a.y = ty;
        a.node = a.path.shift();
        if (a.node === a.homeNode && !a.path.length && a.trips > a.returns) a.returns += 1;
      }
    }
    if (!a.path.length) this.#finish(a);
  }

  #meet(a) {
    const s = a.step;
    const partner = this.byRole.get(s.with);
    const ps = partner?.step;
    const together = ps?.type === 'meet' && ps.id === s.id;
    if (!together) {
      a.activity = 'IDLE';
      // Partner left (task, timeout): end politely instead of waiting forever.
      if (s.joined || this.time - s.started > LIFE.meetTimeoutMs) this.#finish(a);
      return;
    }
    s.joined = true;
    a.facing = partner.x < a.x ? 'left' : 'right';
    const since = this.time - Math.max(s.started, ps.started);
    const turn = Math.floor(since / LIFE.talkTurnMs);
    const speaking = (turn % 2 === 0) === s.leader;
    a.activity = speaking ? 'TALK' : 'IDLE';
    if (speaking && s.lastTurn !== turn) {
      s.lastTurn = turn;
      this.#say(a, pick(a.rng, AMBIENT_PHRASES), LIFE.talkTurnMs - 200);
    }
    if (since >= s.ms) this.#finish(a);
  }

  #say(a, text, ms = LIFE.bubbleMs) {
    const visible = this.agents.filter((o) => o !== a && o.bubble && o.bubble.until > this.time).length;
    if (visible >= LIFE.maxBubbles) return;
    a.bubble = { text, kind: 'ambient', until: this.time + ms };
  }

  #abortSocial(a) {
    if (a.step?.type === 'meet') this.reserved.delete(a.step.node);
  }

  #free(o) {
    return !o.task && o.step?.type === 'act' && !['REST', 'CELEBRATE'].includes(o.step.action) && !o.plan.some((p) => p.type === 'meet');
  }

  #choosePlan(a) {
    const r = a.rng;
    const p = PERSONALITY[a.role];
    const home = HOME_ACTION[a.role];
    if (a.task) return [{ type: 'act', action: 'WORK', ms: Infinity }];
    if (this.reducedMotion) return [{ type: 'act', action: home, ms: between(r, 9_000, 15_000) }];
    const away = a.node !== a.homeNode;
    // Ambience (local, decorative): at night and in the rain avatars stay home and rest more.
    const { night, rain } = this.env;
    const outdoors = (1 - 0.6 * night) * (1 - 0.7 * rain);
    const options = [
      ['home', 1 + p.focus * 2 + (away ? 2.5 : 0) + night * 1.5 + rain * 2.5],
      ['stroll', p.curiosity * 1.3 * outdoors],
      ['visit', p.curiosity * 0.8 * outdoors],
      ['social', p.social * 1.5 * (1 - 0.5 * rain)],
      ['rest', 0.35 + night * 1.2],
      ['celebrate', 0.12 * (1 - rain)],
    ].filter(([kind]) => !(kind === 'home' && !away && a.activity === home));
    const total = options.reduce((sum, [, w]) => sum + w, 0);
    let roll = r() * total;
    let kind = options[0][0];
    for (const [k, w] of options) { if ((roll -= w) <= 0) { kind = k; break; } }
    const chatty = r() < 0.3 ? pick(r, AMBIENT_PHRASES) : null;
    switch (kind) {
      case 'stroll':
        return [{ type: 'walk', to: pick(r, this.#nearby(a.node, this.strollNodes, 6)) }, { type: 'act', action: 'LOOK_AROUND', ms: between(r, 3_000, 6_000), bubble: chatty }];
      case 'visit': {
        const spot = pick(r, this.#nearby(a.node, this.spotNodes.filter((n) => n !== a.homeNode), 3));
        return [{ type: 'walk', to: spot }, { type: 'act', action: r() < 0.5 ? 'READ' : 'LOOK_AROUND', ms: between(r, 5_000, 9_000) }];
      }
      case 'social': {
        const plan = this.#planSocial(a);
        if (plan) return plan;
        return [{ type: 'walk', to: pick(r, this.#nearby(a.node, this.strollNodes, 5)) }, { type: 'act', action: 'LOOK_AROUND', ms: between(r, 3_000, 5_000) }];
      }
      case 'rest':
        return [{ type: 'act', action: 'REST', ms: between(r, 4_500, 7_500), bubble: 'Zzz' }];
      case 'celebrate':
        return [{ type: 'act', action: 'CELEBRATE', ms: 1_700, bubble: '♪' }];
      default:
        return [{ type: 'walk', to: a.homeNode }, { type: 'act', action: home, ms: between(r, 9_000, 16_000), bubble: chatty }];
    }
  }

  #planSocial(a) {
    const r = a.rng;
    const spots = this.world.social.filter(([n1, n2]) => !this.reserved.has(n1) && !this.reserved.has(n2));
    const partners = this.agents.filter((o) => o !== a && this.#free(o))
      .map((o) => [o, this.distance(a.node, o.node)]).filter(([, d]) => d < 520).sort((x, y) => x[1] - y[1]);
    if (!spots.length || !partners.length) return null;
    const partner = partners[Math.floor(r() * Math.min(2, partners.length))][0];
    const cost = ([x, y]) => Math.max(this.distance(a.node, x), this.distance(partner.node, y));
    const [n1, n2] = spots.map((pair) => [pair, cost(pair)]).sort((x, y) => x[1] - y[1])[0][0];
    const id = ++this.meetSeq;
    const ms = between(r, 6_500, 9_500);
    this.reserved.add(n1);
    this.reserved.add(n2);
    // The partner politely finishes nothing mid-air: it is standing (act step), so it can leave at once.
    partner.plan = [{ type: 'walk', to: n2 }, { type: 'meet', id, with: a.role, ms, node: n2, leader: false }];
    partner.step = null;
    return [{ type: 'walk', to: n1 }, { type: 'meet', id, with: partner.role, ms, node: n1, leader: true }];
  }
}

// Sprite selection. Base frames face down-left (walk_dl / idle) or up-right (walk_ur); `flip` mirrors them.
export function frameFor(a, t, byRole) {
  const idleish = a.activity === 'IDLE' || a.activity === 'REST' || a.activity === 'LOOK_AROUND';
  let frame = 'idle_0';
  let flip = a.facing === 'right';
  let bob = 0;
  switch (a.activity) {
    case 'WALK': {
      const i = Math.floor(a.walked / LIFE.stepPx) % 4;
      if (a.heading === 'up') { frame = `walk_ur_${i}`; flip = a.facing === 'left'; } else { frame = `walk_dl_${i}`; }
      bob = i % 2 ? -1 : 0;
      break;
    }
    case 'LOOK_AROUND':
      frame = Math.floor((t - (a.step?.started ?? 0)) / 1_100) % 3 === 1 ? 'look_back' : 'idle_0';
      break;
    case 'TYPE':
    case 'WORK':
      frame = 'type';
      bob = Math.floor(t / 280) % 2 ? -1 : 0;
      break;
    case 'READ':
      frame = 'read';
      bob = Math.floor(t / 1_400) % 2 ? -1 : 0;
      break;
    case 'TALK':
      frame = Math.floor(t / 450) % 2 ? 'talk' : 'idle_0';
      break;
    case 'CELEBRATE':
      frame = 'celebrate';
      bob = -Math.round(3 * Math.abs(Math.sin(t / 170)));
      break;
    default:
      frame = 'idle_0';
  }
  if (idleish && a.blinkUntil > t && frame === 'idle_0') frame = 'blink';
  return { frame, flip, bob };
}
