import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS, CharacterDirector, DURATIONS, FIRST_WALK_MS, NEUTRAL_POSE, POSE_FPS, ROLE_ORDER, STATIONS, WALK_EVERY_MS,
  blinkClosed, createWakeTimer, destinationBox, needsFrames, poseAt, walkPlan,
} from '../public/character-mode.js';

const t0 = 1_000_000;
const idleVisuals = Object.fromEntries(ROLE_ORDER.map((role) => [role, { visual: 'idle', presence: 'standby' }]));
function run(director, from, to, step = 50, context = () => ({ mode: 'IDLE', visuals: idleVisuals })) {
  const frames = [];
  for (let now = from; now <= to; now += step) frames.push({ now, out: director.tick(now, context(now)) });
  return frames;
}

test('Characters: the state machine covers every required action with bounded steps', () => {
  for (const action of ['IDLE_SIT', 'BLINK', 'LOOK_LEFT', 'LOOK_RIGHT', 'HEAD_NOD', 'TYPE', 'WORK', 'STAND_UP', 'IDLE_STAND', 'WALK_AWAY', 'WALK_RETURN', 'SIT_DOWN', 'CELEBRATE', 'ERROR_REACTION']) {
    assert.ok(ACTIONS.includes(action), action);
  }
  for (const [action, ms] of Object.entries(DURATIONS)) assert.ok(ms > 0 && ms <= 3_000, action);
  const seen = new Set(run(new CharacterDirector(), t0, t0 + 90_000).flatMap((f) => Object.values(f.out).map((d) => d.action)));
  for (const action of ['IDLE_SIT', 'BLINK', 'LOOK_LEFT', 'LOOK_RIGHT', 'HEAD_NOD', 'TYPE', 'WORK', 'STAND_UP', 'IDLE_STAND', 'WALK_AWAY', 'WALK_RETURN', 'SIT_DOWN']) {
    assert.ok(seen.has(action), `idle room never showed ${action}`);
  }
});

test('Characters: a walk stands up, goes out, pauses, returns to the exact seat and sits', () => {
  for (const role of ROLE_ORDER) {
    const steps = walkPlan(role, t0);
    assert.deepEqual(steps.map((s) => s.action).filter((a, i, all) => a !== all[i - 1]),
      ['STAND_UP', 'IDLE_STAND', 'WALK_AWAY', 'IDLE_STAND', 'WALK_RETURN', 'SIT_DOWN']);
    for (let i = 1; i < steps.length; i++) assert.equal(steps[i].start, steps[i - 1].end, 'steps are contiguous');
    assert.deepEqual(steps.find((s) => s.away).to, STATIONS[role].path.at(-1));
    assert.deepEqual(steps.at(-1).to, [0, 0]);
    assert.equal(steps.at(-1).pose, 'sit');
    assert.ok(steps.filter((s) => s.action === 'WALK_AWAY').every((s) => s.end - s.start >= 250));
  }
});

test('Characters: idle scheduling is deterministic, staggered and never has two walkers', () => {
  const a = run(new CharacterDirector(), t0, t0 + 120_000, 100);
  const b = run(new CharacterDirector(), t0, t0 + 120_000, 100);
  assert.deepEqual(a.map((f) => Object.values(f.out).map((d) => d.key)), b.map((f) => Object.values(f.out).map((d) => d.key)));
  let synchronized = 0;
  for (const f of a) {
    const actions = Object.values(f.out).map((d) => d.action);
    if (new Set(actions).size === 1) synchronized++;
    assert.ok(Object.values(f.out).filter((d) => d.pose === 'stand').length <= 1, 'one walker at a time');
  }
  assert.ok(synchronized / a.length < 0.2, 'characters are not moving in lockstep');
  const walkers = new Set(a.flatMap((f) => Object.entries(f.out).filter(([, d]) => d.walking).map(([role]) => role)));
  assert.deepEqual([...walkers].sort(), [...ROLE_ORDER].sort(), 'every station takes a turn walking');
});

test('Characters: any 15 s window of the idle room contains a stand or walk', () => {
  const frames = run(new CharacterDirector(), t0, t0 + 180_000, 100);
  const firstStand = frames.find((f) => Object.values(f.out).some((d) => d.pose === 'stand'));
  assert.ok(firstStand.now - t0 <= FIRST_WALK_MS + 3_500, 'first visible stand-up happens within seconds');
  for (let start = firstStand.now; start + 15_000 <= t0 + 180_000; start += 1_000) {
    assert.ok(frames.some((f) => f.now >= start && f.now < start + 15_000 && Object.values(f.out).some((d) => d.pose === 'stand')), `no movement in window at +${start - t0}`);
  }
  assert.ok(WALK_EVERY_MS <= 15_000);
});

test('Characters: real task activity interrupts an idle walk and returns home without teleporting', () => {
  const director = new CharacterDirector();
  let now = t0;
  let described;
  for (; now < t0 + 60_000; now += 50) {
    described = director.tick(now, { mode: 'IDLE', visuals: idleVisuals });
    if (described.EXPLORER.action === 'WALK_AWAY' && now > described.EXPLORER.start + 300) break;
  }
  assert.equal(described.EXPLORER.action, 'WALK_AWAY');
  const visuals = { ...idleVisuals, EXPLORER: { visual: 'exploring', presence: 'active' } };
  const back = director.tick(now, { mode: 'TASK', visuals });
  assert.equal(back.EXPLORER.action, 'WALK_RETURN');
  assert.deepEqual(back.EXPLORER.target, [0, 0]);
  assert.ok(Math.hypot(...back.EXPLORER.at) > 1, 'return starts from the current position');
  // A second state flip mid-return must not snap the character to the chair.
  const flip = director.tick(now + 100, { mode: 'TASK', visuals: { ...visuals, EXPLORER: { visual: 'waiting', presence: 'settled' } } });
  assert.equal(flip.EXPLORER.action, 'WALK_RETURN');
  const seq = [];
  for (let t = now + 150; t < now + 12_000; t += 50) seq.push(director.tick(t, { mode: 'TASK', visuals }).EXPLORER.action);
  const order = seq.filter((a, i) => a !== seq[i - 1]);
  assert.equal(order[order.indexOf('SIT_DOWN') + 1] !== undefined, true);
  assert.ok(order.indexOf('SIT_DOWN') >= 0 && order.slice(order.indexOf('SIT_DOWN') + 1).every((a) => ['LOOK_LEFT', 'TYPE', 'LOOK_RIGHT'].includes(a)));
  assert.ok(!seq.includes('WALK_AWAY') && !seq.includes('STAND_UP'), 'no new strolls during a task');
});

test('Characters: uninvolved walkers go home when a task starts; nobody starts walking outside IDLE', () => {
  const director = new CharacterDirector();
  let now = t0; let out;
  for (; now < t0 + 60_000; now += 50) { out = director.tick(now, { mode: 'IDLE', visuals: idleVisuals }); if (Object.values(out).some((d) => d.action === 'IDLE_STAND' && d.away)) break; }
  const walker = Object.entries(out).find(([, d]) => d.away)[0];
  const home = director.tick(now + 50, { mode: 'TASK', visuals: idleVisuals });
  assert.equal(home[walker].action, 'WALK_RETURN');
  for (let t = now + 100; t < now + 90_000; t += 100) {
    const frame = director.tick(t, { mode: 'TASK', visuals: idleVisuals });
    assert.ok(!Object.values(frame).some((d) => d.action === 'WALK_AWAY' || d.action === 'STAND_UP'));
  }
});

test('Characters: done and failed react once, then settle', () => {
  const director = new CharacterDirector();
  const visuals = { ...idleVisuals, WORKER: { visual: 'done', presence: 'settled' }, QA: { visual: 'failed', presence: 'settled' } };
  const seq = { WORKER: [], QA: [] };
  for (let t = t0; t < t0 + 20_000; t += 50) { const out = director.tick(t, { mode: 'COMPLETED', visuals }); seq.WORKER.push(out.WORKER.key); seq.QA.push(out.QA.key); }
  const count = (keys, action) => new Set(keys.filter((k) => k.includes(`:${action}:`))).size;
  assert.equal(count(seq.WORKER, 'CELEBRATE'), 1);
  assert.equal(count(seq.QA, 'ERROR_REACTION'), 1);
});

test('Characters: reduced motion keeps everyone seated and still', () => {
  const frames = run(new CharacterDirector(), t0, t0 + 90_000, 200, () => ({ mode: 'IDLE', visuals: idleVisuals, reducedMotion: true }));
  for (const f of frames) for (const d of Object.values(f.out)) { assert.equal(d.action, 'IDLE_SIT'); assert.equal(d.pose, 'sit'); assert.equal(d.walking, false); }
});

test('Characters: walk destinations stay inside the room and clear of UI panels', () => {
  // Measured V1 overlay rectangles in source pixels (role cards, HUD, progress, activity panel, buttons).
  const ui = { cardExplorer: [164, 325, 334, 60], cardWorker: [1207, 353, 334, 60], cardReviewer: [170, 560, 334, 60], cardQa: [1197, 585, 334, 60],
    cardLead: [659, 361, 359, 60], hud: [604, 11, 472, 176], progress: [1088, 40, 221, 115], activity: [597, 776, 488, 165] };
  const bubbles = { LEAD: [855, 253, 174, 50], EXPLORER: [444, 229, 118, 64], WORKER: [1373, 308, 159, 48], REVIEWER: [433, 508, 150, 46], QA: [1018, 565, 136, 46] };
  const hit = ([ax, ay, aw, ah], [bx, by, bw, bh]) => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
  for (const role of ROLE_ORDER) {
    for (const path of [STATIONS[role].path, STATIONS[role].altPath].filter(Boolean)) {
      const box = destinationBox(role, path);
      assert.ok(box[0] >= 0 && box[1] >= 0 && box[0] + box[2] <= 1672 && box[1] + box[3] <= 941, `${role} stays in the room`);
      if (role === 'LEAD') continue; // the Lead only steps sideways behind its own desk, under its own card
      for (const [name, rect] of Object.entries(ui)) assert.ok(!hit(box, rect), `${role} destination overlaps ${name}`);
      for (const [other, rect] of Object.entries(bubbles)) if (other !== role) assert.ok(!hit(box, rect), `${role} destination overlaps ${other} bubble`);
    }
  }
});

test('Characters: the wake timer never keeps more than one pending timeout', () => {
  const pending = new Set(); let id = 0;
  const timer = createWakeTimer({ setTimeout: (fn) => { const h = ++id; pending.add(h); fn.h = h; return h; }, clearTimeout: (h) => pending.delete(h) });
  for (let i = 0; i < 25; i++) timer.schedule(100 + i, () => {});
  assert.equal(pending.size, 1);
  assert.equal(timer.pending, true);
  timer.cancel();
  assert.equal(pending.size, 0);
  assert.equal(timer.pending, false);
});

test('Characters: poses are deterministic sprite frames with clearly visible magnitudes', () => {
  assert.ok(POSE_FPS >= 8 && POSE_FPS <= 15, 'classic low sprite frame rate');
  const steps = walkPlan('EXPLORER', t0).map((s) => ({ ...s, walk: true }));
  const director = new CharacterDirector();
  const describe = (step) => director.describe('EXPLORER', step, step.start);
  const walkOut = steps.find((s) => s.action === 'WALK_AWAY' && s.to[0] > 100);
  const mid = poseAt('EXPLORER', describe(walkOut), (walkOut.start + walkOut.end) / 2);
  assert.deepEqual(mid, poseAt('EXPLORER', describe(walkOut), (walkOut.start + walkOut.end) / 2));
  assert.ok(mid.x > walkOut.from[0] + 20 && mid.x < walkOut.to[0] - 20, 'walks through intermediate positions');
  assert.equal(mid.lift, STATIONS.EXPLORER.rise, 'standing lifts the whole figure');
  const legSwing = Math.max(...Array.from({ length: 12 }, (_, i) => Math.abs(poseAt('EXPLORER', describe(walkOut), walkOut.start + i * 83).leg1)));
  assert.ok(legSwing >= 15, 'legs visibly swing while walking');
  const away = steps.find((s) => s.away);
  assert.deepEqual([poseAt('EXPLORER', describe(away), away.start + 100).x, poseAt('EXPLORER', describe(away), away.start + 100).y], STATIONS.EXPLORER.path.at(-1));
  const look = { action: 'LOOK_LEFT', pose: 'sit', walking: false, at: [0, 0], target: [0, 0], facing: 'right', start: t0, end: t0 + DURATIONS.LOOK_LEFT };
  assert.ok(poseAt('WORKER', look, t0 + DURATIONS.LOOK_LEFT / 2).headRot <= -10, 'head turns are large enough to notice');
});

test('Characters: a still room needs no frames; reduced motion is neutral', () => {
  const still = Object.fromEntries(ROLE_ORDER.map((role) => [role, { action: 'IDLE_SIT', pose: 'sit', walking: false, at: [0, 0], target: [0, 0], facing: 'right', start: t0, end: t0 + 1800 }]));
  let quiet = 0;
  for (let now = t0; now < t0 + 20_000; now += 50) if (!needsFrames(still, now)) quiet++;
  assert.ok(quiet / 400 > 0.75, 'most of a still period renders nothing');
  assert.equal(needsFrames({ ...still, QA: { ...still.QA, action: 'TYPE' } }, t0), true);
  const typing = { ...still.QA, action: 'TYPE' };
  assert.deepEqual(poseAt('QA', typing, t0 + 500, { reducedMotion: true }), { ...NEUTRAL_POSE });
  assert.deepEqual(poseAt('QA', still.QA, t0 + 5), { ...NEUTRAL_POSE, lids: blinkClosed('QA', t0 + 5) ? 1 : 0 });
  const blinks = ROLE_ORDER.map((role) => Array.from({ length: 200 }, (_, i) => blinkClosed(role, t0 + i * 50)).join(''));
  assert.equal(new Set(blinks).size, ROLE_ORDER.length, 'blinks are staggered, not simultaneous');
});

test('Characters: a task ending mid-return finishes the walk home instead of teleporting', () => {
  const director = new CharacterDirector();
  let now = t0; let out;
  for (; now < t0 + 60_000; now += 50) { out = director.tick(now, { mode: 'IDLE', visuals: idleVisuals }); if (out.EXPLORER.away) break; }
  const task = { ...idleVisuals, EXPLORER: { visual: 'exploring', presence: 'active' } };
  assert.equal(director.tick(now + 50, { mode: 'TASK', visuals: task }).EXPLORER.action, 'WALK_RETURN');
  const after = director.tick(now + 300, { mode: 'IDLE', visuals: idleVisuals }).EXPLORER;
  assert.equal(after.action, 'WALK_RETURN');
  assert.ok(Math.hypot(...after.at) > 1, 'resumes from where it is, not from the chair');
});
