import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { EventNormalizer } from '../src/event-normalizer.js';
import {
  AMBIENT_ORDER, AMBIENT_PHRASES, AmbientDirector, LIFE_CONFIG, ROOM_MODES, deriveRoomMode, formatAge, stationVisual, taskBubbles,
} from '../public/life-mode.js';

const t0 = Date.parse('2026-09-30T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const role = (state, summary, at) => ({ state, summary, updatedAt: at == null ? null : iso(at) });
function snapshot({ lastEventAt = null, growthAt = null, lead = role('IDLE', 'Waiting', null), agents = [], communications = [] } = {}) {
  return {
    session: { lastActivity: lastEventAt == null ? null : iso(lastEventAt) },
    activity: lastEventAt == null ? [] : [{ timestamp: iso(lastEventAt) }],
    roles: { LEAD: lead },
    debug: { lastObservedActivity: growthAt == null ? null : iso(growthAt) },
    room: { agents, communications },
  };
}

test('Life: no observed task is LIVE IDLE; a fresh real event switches IDLE -> TASK', () => {
  const empty = deriveRoomMode(snapshot(), t0);
  assert.equal(empty.mode, ROOM_MODES.IDLE);
  assert.equal(empty.label, 'LIVE IDLE');
  assert.equal(empty.ageMs, null);
  const live = deriveRoomMode(snapshot({ lastEventAt: t0 - 2_000, lead: role('ACTIVE', 'Working', t0 - 2_000) }), t0);
  assert.equal(live.mode, ROOM_MODES.TASK);
  assert.equal(live.label, 'LIVE TASK');
  assert.equal(formatAge(live.ageMs), '2s ago');
});

test('Life: TASK -> IDLE after the stale timeout without a completion event', () => {
  const state = snapshot({ lastEventAt: t0, lead: role('ACTIVE', 'Running a local command', t0) });
  assert.equal(deriveRoomMode(state, t0 + LIFE_CONFIG.activeWindowMs).mode, ROOM_MODES.TASK);
  const stale = deriveRoomMode(state, t0 + LIFE_CONFIG.activeWindowMs + 1);
  assert.equal(stale.mode, ROOM_MODES.IDLE);
  assert.equal(stale.reason, 'stale');
  assert.equal(formatAge(stale.ageMs), '45s ago');
});

test('Life: rollout growth keeps a running task live but cannot revive a completed one', () => {
  const running = snapshot({ lastEventAt: t0 - 40_000, growthAt: t0 - 1_000, lead: role('ACTIVE', 'Working', t0 - 40_000) });
  assert.equal(deriveRoomMode(running, t0 + 10_000).mode, ROOM_MODES.TASK);
  const completed = snapshot({ lastEventAt: t0 - 60_000, growthAt: t0 - 500, lead: role('DONE', 'Turn complete', t0 - 60_000) });
  assert.equal(deriveRoomMode(completed, t0).mode, ROOM_MODES.IDLE);
  assert.equal(formatAge(deriveRoomMode(completed, t0).ageMs), '0s ago');
});

test('Life: completion shows a short COMPLETED SNAPSHOT, then returns to IDLE automatically', () => {
  // Contract with the untouched V0 normalizer: task_complete is the Lead's "Turn complete".
  const normalized = new EventNormalizer().ingestLine(JSON.stringify({ type: 'event_msg', timestamp: iso(t0), payload: { type: 'task_complete' } }));
  assert.equal(normalized.role, 'LEAD');
  assert.equal(normalized.summary, 'Turn complete');
  const state = snapshot({ lastEventAt: t0, lead: role(normalized.state, normalized.summary, t0) });
  const done = deriveRoomMode(state, t0 + 1_000);
  assert.equal(done.mode, ROOM_MODES.COMPLETED);
  assert.equal(done.label, 'COMPLETED SNAPSHOT');
  assert.equal(done.outcome, 'done');
  const after = deriveRoomMode(state, t0 + LIFE_CONFIG.completedHoldMs);
  assert.equal(after.mode, ROOM_MODES.IDLE);
  assert.equal(after.reason, 'completed-expired');
  // A new turn after completion is newer than the terminal event, so the room goes live again.
  const next = snapshot({ lastEventAt: t0 + 20_000, lead: role('DONE', 'Turn complete', t0) });
  assert.equal(deriveRoomMode(next, t0 + 21_000).mode, ROOM_MODES.TASK);
  const aborted = new EventNormalizer().ingestLine(JSON.stringify({ type: 'event_msg', timestamp: iso(t0), payload: { type: 'turn_aborted' } }));
  const failed = deriveRoomMode(snapshot({ lastEventAt: t0, lead: role(aborted.state, aborted.summary, t0) }), t0 + 500);
  assert.equal(failed.mode, ROOM_MODES.COMPLETED);
  assert.equal(failed.outcome, 'failed');
  // A failed tool call classified to the Lead is task progress, not the end of the turn.
  const toolFailure = deriveRoomMode(snapshot({ lastEventAt: t0, lead: role('ERROR', 'Running a local command failed', t0) }), t0 + 500);
  assert.equal(toolFailure.mode, ROOM_MODES.TASK);
});

test('Life: ambient dialogue rotates deterministically through local phrases and stations', () => {
  const director = new AmbientDirector();
  const seen = [];
  for (let now = t0; now < t0 + 200_000; now += 250) {
    const bubble = director.tick(now, ROOM_MODES.IDLE);
    if (bubble && seen.at(-1)?.since !== bubble.since) seen.push(bubble);
  }
  assert.ok(seen.length >= AMBIENT_PHRASES.length);
  seen.forEach((bubble, index) => {
    assert.equal(bubble.kind, 'ambient');
    assert.equal(bubble.text, AMBIENT_PHRASES[index % AMBIENT_PHRASES.length]);
    assert.equal(bubble.role, AMBIENT_ORDER[index % AMBIENT_ORDER.length]);
  });
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i].role, seen[i - 1].role);
  const replay = new AmbientDirector();
  let first = null;
  for (let now = t0; !first; now += 250) first = replay.tick(now, ROOM_MODES.IDLE);
  assert.deepEqual({ role: first.role, text: first.text }, { role: seen[0].role, text: seen[0].text });
});

test('Life: ambient bubbles time out, never overlap, and leave quiet gaps', () => {
  const director = new AmbientDirector();
  let first = null;
  let now = t0;
  for (; !first; now += 100) first = director.tick(now, ROOM_MODES.IDLE);
  assert.equal(first.until - first.since, LIFE_CONFIG.ambientShowMs);
  assert.equal(director.tick(first.until - 1, ROOM_MODES.IDLE), first);
  assert.equal(director.tick(first.until, ROOM_MODES.IDLE), null);
  assert.equal(director.tick(first.until + LIFE_CONFIG.ambientGapMs - 1, ROOM_MODES.IDLE), null);
  const second = director.tick(first.until + LIFE_CONFIG.ambientGapMs, ROOM_MODES.IDLE);
  assert.ok(second && second !== first);
});

test('Life: ambient dialogue is suspended during real task activity and completion', () => {
  const director = new AmbientDirector();
  let bubble = null;
  let now = t0;
  for (; !bubble; now += 100) bubble = director.tick(now, ROOM_MODES.IDLE);
  assert.equal(director.tick(now, ROOM_MODES.TASK), null);
  for (let later = now; later < now + 60_000; later += 500) {
    assert.equal(director.tick(later, ROOM_MODES.TASK), null);
    assert.equal(director.tick(later, ROOM_MODES.COMPLETED), null);
  }
  // Back in IDLE, the room waits before speaking again instead of resuming mid-thought.
  assert.equal(director.tick(now + 60_000, ROOM_MODES.IDLE), null);
  assert.equal(taskBubbles({ mode: ROOM_MODES.IDLE, stations: [{ role: 'LEAD', displayState: 'working', task: 'Working', updatedAt: iso(t0) }], now: t0 }).length, 0);
});

test('Life: unverified and stale stations stay standby in every mode', () => {
  for (const mode of Object.values(ROOM_MODES)) {
    for (const role of ['EXPLORER', 'WORKER', 'REVIEWER', 'QA']) {
      assert.deepEqual(stationVisual({ mode, role, displayState: 'idle' }, t0), { visual: 'idle', presence: 'standby' });
      assert.deepEqual(stationVisual({ mode, role, displayState: undefined }, t0), { visual: 'idle', presence: 'standby' });
    }
  }
  // In IDLE a lingering stored state is only presence, never shown as running.
  assert.deepEqual(stationVisual({ mode: ROOM_MODES.IDLE, role: 'WORKER', displayState: 'working', updatedAt: iso(t0) }, t0), { visual: 'idle', presence: 'standby' });
  assert.deepEqual(stationVisual({ mode: ROOM_MODES.TASK, role: 'QA', displayState: 'waiting', updatedAt: iso(t0 - LIFE_CONFIG.settleMs - 1) }, t0), { visual: 'idle', presence: 'standby' });
  assert.deepEqual(stationVisual({ mode: ROOM_MODES.COMPLETED, role: 'WORKER', displayState: 'waiting', updatedAt: iso(t0) }, t0), { visual: 'idle', presence: 'standby' });
  const bubbles = taskBubbles({ mode: ROOM_MODES.TASK, now: t0, stations: [{ role: 'EXPLORER', displayState: 'idle', task: 'Reading x.js', updatedAt: iso(t0) }] });
  assert.equal(bubbles.length, 0);
});

test('Life: real normalized agent states override idle visuals during a task', () => {
  const expected = { EXPLORER: 'exploring', WORKER: 'working', REVIEWER: 'reviewing', QA: 'testing' };
  for (const [role, displayState] of Object.entries(expected)) {
    assert.deepEqual(stationVisual({ mode: ROOM_MODES.TASK, role, displayState, updatedAt: iso(t0) }, t0), { visual: displayState, presence: 'active' });
  }
  for (const displayState of ['planning', 'integrating']) {
    assert.equal(stationVisual({ mode: ROOM_MODES.TASK, role: 'LEAD', displayState }, t0).presence, 'active');
  }
  assert.deepEqual(stationVisual({ mode: ROOM_MODES.TASK, role: 'QA', displayState: 'failed', updatedAt: iso(t0) }, t0), { visual: 'failed', presence: 'settled' });
  assert.deepEqual(stationVisual({ mode: ROOM_MODES.COMPLETED, role: 'WORKER', displayState: 'done', updatedAt: iso(t0) }, t0 + LIFE_CONFIG.completedHoldMs - 1), { visual: 'done', presence: 'settled' });
  assert.equal(stationVisual({ mode: ROOM_MODES.COMPLETED, role: 'LEAD', displayState: 'failed', updatedAt: iso(t0) }, t0).visual, 'failed');
  // An outcome from an earlier turn must not reappear as part of this completion.
  assert.deepEqual(stationVisual({ mode: ROOM_MODES.COMPLETED, role: 'WORKER', displayState: 'failed', updatedAt: iso(t0 - 20 * 60_000) }, t0), { visual: 'idle', presence: 'standby' });
  // A child's completed turn must not make the unobserved parent Lead look done.
  assert.deepEqual(stationVisual({ mode: ROOM_MODES.COMPLETED, role: 'LEAD', displayState: 'idle', outcome: 'done' }, t0), { visual: 'idle', presence: 'standby' });
});

test('Life: task bubbles restate only real events and verified communication endpoints', () => {
  const lead = { id: 'agent-lead', role: 'LEAD', label: 'Lead' };
  const explorer = { id: 'agent-explorer', role: 'EXPLORER', label: 'explorer' };
  const helper = { id: 'agent-helper', role: 'GENERIC', label: 'heart' };
  const room = {
    agents: [lead, explorer, helper],
    communications: [
      { from: lead.id, to: explorer.id, label: 'Delegação iniciada', timestamp: iso(t0 - 1_000) },
      { from: helper.id, to: lead.id, label: 'Mensagem recebida', timestamp: iso(t0 - 500) },
      { from: 'agent-missing', to: lead.id, label: 'Invented', timestamp: iso(t0) },
      { from: explorer.id, to: lead.id, label: 'Old', timestamp: iso(t0 - LIFE_CONFIG.commBubbleMs - 1) },
    ],
  };
  const stations = [
    { role: 'LEAD', displayState: 'working', task: 'Working', updatedAt: iso(t0 - 2_000) },
    { role: 'EXPLORER', displayState: 'exploring', task: 'Searching project files', updatedAt: iso(t0 - 300) },
    { role: 'WORKER', displayState: 'working', task: 'Editing a.js', updatedAt: iso(t0 - LIFE_CONFIG.eventBubbleMs - 1) },
    { role: 'QA', displayState: 'idle', task: null, updatedAt: null },
  ];
  const bubbles = taskBubbles({ mode: ROOM_MODES.TASK, stations, room, now: t0 });
  const byRole = Object.fromEntries(bubbles.map((bubble) => [bubble.role, bubble]));
  assert.deepEqual(Object.keys(byRole).sort(), ['EXPLORER', 'LEAD']);
  assert.equal(byRole.LEAD.kind, 'comm');
  assert.equal(byRole.LEAD.text, '← heart: Mensagem recebida');
  assert.equal(byRole.EXPLORER.kind, 'event');
  assert.equal(byRole.EXPLORER.text, 'Searching project files');
  assert.ok(!JSON.stringify(bubbles).includes('Invented'));
  assert.ok(!JSON.stringify(bubbles).includes('Old'));
  assert.ok(bubbles.length <= LIFE_CONFIG.maxTaskBubbles);
});

test('Life: stale activity is detected from any signal and reported as elapsed time', () => {
  assert.equal(formatAge(null), '—');
  assert.equal(formatAge(8_400), '8s ago');
  assert.equal(formatAge(125_000), '2m ago');
  assert.equal(formatAge(3 * 3_600_000), '3h ago');
  assert.equal(formatAge(49 * 3_600_000), '2d ago');
  const oldAgent = snapshot({ agents: [{ id: 'a', updatedAt: iso(t0 - 5 * 60_000) }] });
  const room = deriveRoomMode(oldAgent, t0);
  assert.equal(room.mode, ROOM_MODES.IDLE);
  assert.equal(formatAge(room.ageMs), '5m ago');
  const freshAgent = snapshot({ agents: [{ id: 'a', updatedAt: iso(t0 - 3_000) }] });
  assert.equal(deriveRoomMode(freshAgent, t0).mode, ROOM_MODES.TASK);
  const growthOnly = deriveRoomMode(snapshot({ growthAt: t0 - 1_000 }), t0);
  assert.equal(growthOnly.mode, ROOM_MODES.IDLE); // File growth alone, with no task event, is not a task.
});

test('Life Mode has no LLM, network, or extra SSE dependency', async () => {
  for (const name of ['life-mode.js', 'character-mode.js']) {
    const pure = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(pure, /^\s*import\s/m, `${name} must not import anything`);
  }
  const files = ['life-mode.js', 'life-view.js', 'life.css', 'character-mode.js', 'sprites/sprites.css'];
  for (const name of files) {
    const source = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?:\/\//, name);
    assert.doesNotMatch(source, /openai|anthropic|claude|gpt-|chat\/completions|\/v1\/responses|\bllm\b/i, name);
  }
  let streams = 0;
  for (const name of (await readdir(new URL('../public/', import.meta.url))).filter((file) => file.endsWith('.js'))) {
    streams += ((await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')).match(/new EventSource\(/g) ?? []).length;
  }
  assert.equal(streams, 1, 'the page keeps exactly one SSE connection');
});
