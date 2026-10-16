import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, distanceToNetwork, pathLength, shortestPath } from '../public/village/pathfinding.js';
import { AMBIENT_PHRASES, LIFE, PERSONALITY, ROLE_ORDER, Village } from '../public/village/life-engine.js';
import { hitAgent, hitBuilding } from '../public/village/renderer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const villageDir = path.join(root, 'public', 'village');
const world = JSON.parse(await readFile(path.join(villageDir, 'world.json'), 'utf8'));
const DT = 33;

function run(village, ms, onStep) {
  for (let t = 0; t < ms; t += DT) {
    village.step(DT);
    onStep?.(village.snapshot(), village.time);
  }
}

async function pngSize(file) {
  const buf = await readFile(file);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('Village world: graph is connected and every building spot, social point and role home is a real node', () => {
  const graph = buildGraph(world);
  const ids = Object.keys(world.nodes);
  for (const id of ids) assert.ok(shortestPath(graph, 'P_N', id), `${id} unreachable`);
  const roles = new Set();
  for (const [id, b] of Object.entries(world.buildings)) {
    assert.ok(world.nodes[b.spot], `${id} spot missing`);
    assert.equal(b.rect.length, 4);
    if (b.role) roles.add(b.role);
  }
  assert.deepEqual([...roles].sort(), [...ROLE_ORDER].sort(), 'each of the 8 roles has exactly one home building');
  for (const pair of world.social) for (const n of pair) assert.ok(world.nodes[n], `social node ${n}`);
  const [w, h] = world.size;
  for (const [x, y] of Object.values(world.nodes)) assert.ok(x > 0 && x < w && y > 0 && y < h);
});

test('Village pathfinding: shortest path follows edges and rejects unknown nodes', () => {
  const graph = buildGraph(world);
  const route = shortestPath(graph, 'OBS_SPOT', 'RE_SPOT');
  assert.equal(route[0], 'OBS_SPOT');
  assert.equal(route.at(-1), 'RE_SPOT');
  for (let i = 1; i < route.length; i++) {
    assert.ok(world.edges.some(([a, b]) => (a === route[i - 1] && b === route[i]) || (b === route[i - 1] && a === route[i])));
  }
  assert.ok(pathLength(graph, route) > 600);
  assert.equal(shortestPath(graph, 'OBS_SPOT', 'NOPE'), null);
});

test('Village assets: map, 8 role atlases with 16 frames each and the fountain occluder exist with the expected sizes', async () => {
  assert.deepEqual(await pngSize(path.join(villageDir, 'assets', 'map.png')), { width: world.size[0], height: world.size[1] });
  const manifest = JSON.parse(await readFile(path.join(villageDir, 'assets', 'sprites', 'manifest.json'), 'utf8'));
  assert.equal(manifest.frames.length, 16);
  assert.deepEqual(Object.keys(manifest.roles).sort(), [...ROLE_ORDER].sort());
  for (const file of Object.values(manifest.roles)) {
    assert.deepEqual(await pngSize(path.join(villageDir, file)), { width: manifest.cell[0] * 16, height: manifest.cell[1] });
  }
  for (const o of world.occluders) assert.ok((await stat(path.join(villageDir, o.image))).size > 0);
});

test('Life Engine is deterministic for a seed and differs across seeds', () => {
  const a = new Village(world, { seed: 7 });
  const b = new Village(world, { seed: 7 });
  const c = new Village(world, { seed: 8 });
  run(a, 20_000); run(b, 20_000); run(c, 20_000);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.notDeepEqual(a.snapshot(), c.snapshot());
});

test('Idle life over 30 s: avatars walk perceptibly, do different things, leave their building and come back, never leave the paths', () => {
  const v = new Village(world);
  const prev = new Map(v.snapshot().map((s) => [s.role, s]));
  const walkFrames = new Set();
  let maxDistinctAtOnce = 0;
  let maxOff = 0;
  let maxStep = 0;
  run(v, 30_000, (snap) => {
    maxDistinctAtOnce = Math.max(maxDistinctAtOnce, new Set(snap.map((s) => s.activity)).size);
    for (const s of snap) {
      assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
      maxOff = Math.max(maxOff, distanceToNetwork(world, [s.x, s.y]));
      const p = prev.get(s.role);
      maxStep = Math.max(maxStep, Math.hypot(s.x - p.x, s.y - p.y) / ((PERSONALITY[s.role].speed * DT) / 1000));
      prev.set(s.role, s);
      if (s.frame.startsWith('walk_')) walkFrames.add(s.frame.at(-1));
    }
  });
  assert.ok(maxDistinctAtOnce >= 3, `only ${maxDistinctAtOnce} distinct activities at once`);
  assert.ok(maxOff < 0.5, `left the path network by ${maxOff}px`);
  assert.ok(maxStep <= 1.0001, 'no teleports: never faster than walking speed');
  assert.deepEqual([...walkFrames].sort(), ['0', '1', '2', '3'], 'full 4-frame walk cycle is used');
  const walkers = v.agents.filter((a) => a.distance >= 60);
  assert.ok(walkers.length >= 3, `${walkers.length} avatars walked >= 60px`);
  assert.ok(v.agents.some((a) => a.returns >= 1), 'someone physically left its building and returned');
});

test('Idle life is not synchronized: avatars start their first walk at different moments', () => {
  const v = new Village(world);
  const firstWalk = new Map();
  run(v, 30_000, (snap, t) => { for (const s of snap) if (s.activity === 'WALK' && !firstWalk.has(s.role)) firstWalk.set(s.role, t); });
  const times = [...firstWalk.values()].sort((x, y) => x - y);
  assert.ok(times.length >= 5);
  assert.ok(new Set(times.map((t) => Math.round(t / 500))).size >= 4, 'first walks are staggered');
});

test('Ambient bubbles: only local phrases, marked ambient, at most two at a time', () => {
  const v = new Village(world);
  const allowed = new Set([...AMBIENT_PHRASES, 'Zzz', '♪']);
  let seen = 0;
  run(v, 90_000, (snap) => {
    const bubbles = snap.filter((s) => s.bubble);
    assert.ok(bubbles.length <= LIFE.maxBubbles, `${bubbles.length} bubbles at once`);
    for (const s of bubbles) {
      assert.equal(s.bubble.kind, 'ambient');
      assert.ok(allowed.has(s.bubble.text), s.bubble.text);
      seen += 1;
    }
  });
  assert.ok(seen > 0);
});

test('Task preempts idle life (M2 hook): walker finishes its segment, goes to its building, works, then returns to idle', () => {
  const v = new Village(world);
  let walking = null;
  for (let t = 0; t < 60_000 && !walking; t += DT) {
    v.step(DT);
    walking = v.snapshot().find((s) => s.activity === 'WALK' && s.role !== 'RELEASE_GATE');
  }
  assert.ok(walking, 'found someone walking');
  const role = walking.role;
  const home = world.nodes[world.buildings[v.agent(role).home].spot];
  assert.equal(v.assignTask(role, { label: 'Fix login timeout', state: 'working' }), true);
  let last = v.snapshot().find((s) => s.role === role);
  let arrived = false;
  run(v, 60_000, (snap) => {
    const s = snap.find((x) => x.role === role);
    assert.ok(Math.hypot(s.x - last.x, s.y - last.y) <= (PERSONALITY[role].speed * DT) / 1000 + 1e-6, 'no jump when re-routed');
    assert.equal(s.bubble, null, 'no ambient line while doing real work');
    last = s;
    if (s.x === home[0] && s.y === home[1] && s.activity === 'WORK') arrived = true;
  });
  assert.ok(arrived, 'reached its own building and is working');
  const s = v.snapshot().find((x) => x.role === role);
  assert.equal(s.presence, 'verified');
  assert.equal(s.task.label, 'Fix login timeout');
  assert.equal(v.releaseTask(role), true);
  run(v, 30_000);
  const after = v.snapshot().find((x) => x.role === role);
  assert.equal(after.presence, 'standby');
  assert.notEqual(after.activity, 'WORK');
});

test('Reduced motion keeps every avatar in place', () => {
  const v = new Village(world, { reducedMotion: true });
  const start = v.snapshot();
  run(v, 30_000, (snap) => { for (const s of snap) assert.notEqual(s.activity, 'WALK'); });
  v.snapshot().forEach((s, i) => assert.deepEqual([s.x, s.y], [start[i].x, start[i].y]));
});

test('Hit testing selects the front-most avatar and the building under the pointer', () => {
  const agents = [{ role: 'A', x: 100, y: 100 }, { role: 'B', x: 104, y: 110 }];
  assert.equal(hitAgent(agents, 102, 90).role, 'B');
  assert.equal(hitAgent(agents, 300, 300), null);
  const [x, y] = world.buildings.FORGE.rect;
  assert.equal(hitBuilding(world.buildings, x + 5, y + 5), 'FORGE');
});

test('Village frontend has no model, external network or extra stream dependency (zero-token idle life)', async () => {
  const files = (await readdir(villageDir)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const src = await readFile(path.join(villageDir, f), 'utf8');
    assert.doesNotMatch(src, /https?:\/\//, `${f} references an absolute URL`);
    assert.doesNotMatch(src, /openai|anthropic|api\.|EventSource|WebSocket|XMLHttpRequest/i, `${f} has a network/model dependency`);
    for (const [, spec] of src.matchAll(/import\s[^'"]*['"]([^'"]+)['"]/g)) assert.ok(spec.startsWith('./'), `${f} imports ${spec}`);
    for (const [, url] of src.matchAll(/fetch\(\s*['"`]([^'"`]+)['"`]/g)) assert.match(url, /^(world\.json|assets\/)/, `${f} fetches ${url}`);
  }
});

test('Server serves the village at /village/ (redirecting /village) while / stays the Ops Room', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'village-home-'));
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, OPS_ROOM_PORT: '0', HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8_000);
    child.stdout.on('data', (chunk) => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const redirect = await fetch(`${base}/village`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/village/');
  const page = await fetch(`${base}/village/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Agent Village/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const ops = await (await fetch(`${base}/`)).text();
  assert.match(ops, /Codex Ops Room/);
  // Encoded traversal out of public/ is still refused by the existing guard.
  assert.equal((await fetch(`${base}/village/%2e%2e%2f%2e%2e%2fpackage.json`)).status, 403);
});
