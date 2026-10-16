import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIGHT_KINDS, WEATHERS, WEATHER_FADE_MS, WEATHER_SEGMENT_MS, ambientAt, effectiveHour, flicker, isNeutral,
  lightKey, lightStrength, parseHourParam, phaseOf, weatherAt, weatherTint,
} from '../public/village/ambience.js';
import { PARTICLE_KINDS, Particles } from '../public/village/effects.js';
import { Village } from '../public/village/life-engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const villageDir = path.join(root, 'public', 'village');
const world = JSON.parse(await readFile(path.join(villageDir, 'world.json'), 'utf8'));
const fx = JSON.parse(await readFile(path.join(villageDir, 'fx.json'), 'utf8'));

test('Ambience: midday is neutral (painting untouched), night is dark and blue, dusk is warm', () => {
  assert.ok(isNeutral(ambientAt(13)));
  const night = ambientAt(23);
  assert.equal(night.phase, 'noite');
  assert.ok(night.night > 0.95);
  assert.ok(night.tint[2] > night.tint[0], 'night tint is bluish');
  const dusk = ambientAt(18.2);
  assert.equal(dusk.phase, 'entardecer');
  assert.ok(dusk.warm > 0.8);
  assert.deepEqual(ambientAt(0).tint, ambientAt(24).tint, 'midnight wraps continuously');
  for (let h = 0; h < 24; h += 0.25) {
    const a = ambientAt(h);
    assert.ok(a.night >= 0 && a.night <= 1 && a.tint.every((c) => c >= 0 && c <= 255), `hour ${h}`);
  }
  assert.equal(phaseOf(5.5), 'amanhecer');
});

test('Ambience: ?hora= parsing and effective hour (URL override > fixed mode > clock)', () => {
  assert.equal(parseHourParam('?hora=21:30'), 21.5);
  assert.equal(parseHourParam('?hora=6h'), 6);
  assert.equal(parseHourParam('?hora=7h15'), 7.25);
  assert.equal(parseHourParam('?hora=25'), null);
  assert.equal(parseHourParam('?x=1'), null);
  const d = new Date(2026, 9, 16, 9, 30, 0);
  assert.equal(effectiveHour('auto', null, d), 9.5);
  assert.equal(effectiveHour('noite', null, d), 22);
  assert.equal(effectiveHour('dia', 3, d), 3);
});

test('Weather: deterministic seeded schedule, every kind occurs, cross-fades are bounded, forced mode wins', () => {
  const kinds = new Set();
  for (let seg = 0; seg < 400; seg++) kinds.add(weatherAt(seg * WEATHER_SEGMENT_MS + WEATHER_SEGMENT_MS / 2).kind);
  assert.deepEqual([...kinds].sort(), [...WEATHERS].sort());
  const t = 123_456_789;
  assert.deepEqual(weatherAt(t), weatherAt(t));
  assert.notDeepEqual(
    Array.from({ length: 50 }, (_, i) => weatherAt(i * WEATHER_SEGMENT_MS, { seed: 1 }).kind),
    Array.from({ length: 50 }, (_, i) => weatherAt(i * WEATHER_SEGMENT_MS, { seed: 2 }).kind),
  );
  for (let ms = 0; ms < 60 * WEATHER_SEGMENT_MS; ms += WEATHER_FADE_MS / 5) {
    const w = weatherAt(ms);
    assert.ok(w.intensity >= 0 && w.intensity <= 1);
  }
  assert.deepEqual(weatherAt(t, { forced: 'chuva' }), { kind: 'chuva', intensity: 1, forced: true });
  const rainy = weatherTint(ambientAt(13), { kind: 'chuva', intensity: 1 });
  assert.ok(rainy.tint.every((c, i) => c <= ambientAt(13).tint[i]), 'rain darkens the scene');
});

test('Lights: map lights are valid kinds inside the world; strength rises with night; flicker stays in range', () => {
  const [w, h] = world.size;
  assert.ok(world.lights.length >= 50);
  for (const l of world.lights) {
    assert.ok(LIGHT_KINDS[l.kind], l.kind);
    assert.ok(l.x > 0 && l.x < w && l.y > 0 && l.y < h);
  }
  assert.equal(lightStrength('lamp', 0), 0, 'street lamps are off by day');
  assert.ok(lightStrength('lamp', 1) > 0.99);
  assert.ok(lightStrength('fire', 0) > 0, 'the forge glows by day too');
  for (let t = 0; t < 20_000; t += 37) {
    const f = flicker(t, 3.1, 0.22);
    assert.ok(f >= 0.78 - 1e-9 && f <= 1 + 1e-9);
  }
  // the cached light map key only changes in coarse steps (rebuilds are rare)
  const keys = new Set();
  for (let m = 0; m < 60; m++) keys.add(lightKey(ambientAt(13 + m / 60)));
  assert.equal(keys.size, 1, 'an hour of daylight never rebuilds the map');
});

test('Scene data: water, stars, leaves, flowers, signs and emitters are inside the map', () => {
  const [w, h] = world.size;
  const inside = ([x, y]) => x >= 0 && x < w && y >= 0 && y < h;
  assert.ok(fx.waterPoints.length >= 1000 && fx.waterPoints.every(inside));
  assert.ok(fx.stars.length >= 40 && fx.stars.every(([, y]) => y < 160), 'stars only in the sky band');
  assert.ok(fx.leafPoints.every(inside) && fx.flowerPoints.every(inside));
  assert.equal(fx.signs.length, Object.keys(world.buildings).length, 'one sign per building');
  const kinds = new Set(fx.emitters.map((e) => e.kind));
  for (const k of ['smoke', 'sparks', 'bubbles', 'mist']) assert.ok(kinds.has(k), k);
  for (const e of fx.emitters) if (e.building) assert.ok(world.buildings[e.building], e.building);
});

test('Particles: fixed pool never exceeds capacity and expires everything; rain lands', () => {
  const p = new Particles(50);
  for (let i = 0; i < 200; i++) p.spawn(PARTICLE_KINDS.SMOKE, 10, 10, 0, -5, 1);
  assert.equal(p.n, 50);
  let landed = 0;
  p.clear();
  for (let i = 0; i < 10; i++) p.spawn(PARTICLE_KINDS.RAIN, i, 0, 0, 200, 5, 1, 0, 0, 50);
  for (let s = 0; s < 40; s++) p.update(0.05, () => { landed += 1; });
  assert.equal(landed, 10);
  for (let i = 0; i < 20; i++) p.spawn(PARTICLE_KINDS.SPARK, 0, 0, 1, -1, 0.5);
  for (let s = 0; s < 20; s++) p.update(0.05);
  assert.equal(p.n, 0, 'every particle expires');
});

test('Life Engine + ambience: night and rain keep avatars home more, without touching animations or truth', () => {
  const walked = (env) => {
    const v = new Village(world, { seed: 99 });
    v.setEnvironment(env);
    let walk = 0;
    for (let t = 0; t < 120_000; t += 33) { v.step(33); walk += v.snapshot().filter((s) => s.activity === 'WALK').length; }
    return { walk, presence: new Set(v.snapshot().map((s) => s.presence)) };
  };
  const day = walked({ night: 0, rain: 0 });
  const night = walked({ night: 1, rain: 0 });
  const storm = walked({ night: 1, rain: 1 });
  assert.ok(night.walk < day.walk, `night ${night.walk} < day ${day.walk}`);
  assert.ok(storm.walk < night.walk, `storm ${storm.walk} < night ${night.walk}`);
  assert.ok(storm.walk > 0, 'still alive in a storm');
  for (const r of [day, night, storm]) assert.deepEqual([...r.presence], ['standby'], 'ambience never marks anyone active');
});

test('Ambience and effects modules stay local: no network, no model, no absolute URLs', async () => {
  for (const f of ['ambience.js', 'effects.js']) {
    const src = await readFile(path.join(villageDir, f), 'utf8');
    assert.doesNotMatch(src, /https?:\/\//);
    assert.doesNotMatch(src, /fetch\(|openai|anthropic|EventSource|WebSocket|XMLHttpRequest/i);
  }
  const files = await readdir(villageDir);
  assert.ok(files.includes('fx.json'));
});
