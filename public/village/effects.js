// Agent Village — scene effects (Canvas 2D). Lighting layer, glows, water, sky, particles and weather.
// Decorative and local only: no network, no model calls. Real agent activity may *intensify* a building's
// effect (setBuildingActivity, used from M2 on), but nothing here ever implies real work by itself.
// Techniques learned from Habblaud (MIT): cached half-resolution light map multiplied over the scene and
// rebuilt only when its key changes; fixed particle pool in typed arrays (no per-frame allocation).
import { LIGHT_KINDS, flicker, isNeutral, lightKey, lightStrength, mix, pulse } from './ambience.js';

const MAP_SCALE = 2;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- sprites (cached)
const spriteCache = new Map();
function radialSprite(rgb, radius, inner = 0) {
  const key = `${rgb.join(',')}|${radius}|${inner}`;
  let c = spriteCache.get(key);
  if (c) return c;
  const size = Math.max(2, Math.ceil(radius * 2));
  c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
  if (inner) grad.addColorStop(inner, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.55)`);
  grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  spriteCache.set(key, c);
  return c;
}

function makeCanvas(w, h) {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

// ---------------------------------------------------------------- particles
const K = Object.freeze({ SMOKE: 0, SPARK: 1, BUBBLE: 2, FIREFLY: 3, LEAF: 4, RAIN: 5, SPLASH: 6, MIST: 7, DROP: 8, BUTTERFLY: 9 });
const GRAVITY = [-6, 160, -20, 0, 18, 0, 90, -8, 150, 0];
const LEAF_COLORS = ['#7fbf4d', '#a7c957', '#d9b44a', '#5f9e3a'];
const WING_COLORS = ['#ffd166', '#f7a8d8', '#9ad0ff', '#ffffff'];

export class Particles {
  constructor(cap = 800) {
    this.cap = cap;
    this.n = 0;
    for (const f of ['x', 'y', 'vx', 'vy', 'age', 'life', 'ph', 'size', 'tx', 'ty']) this[f] = new Float32Array(cap);
    this.kind = new Uint8Array(cap);
    this.color = new Uint8Array(cap);
  }

  spawn(kind, x, y, vx, vy, life, size = 1, color = 0, tx = 0, ty = 0) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.kind[i] = kind; this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.age[i] = 0; this.life[i] = Math.max(0.05, life); this.size[i] = size; this.color[i] = color;
    this.ph[i] = Math.random() * TAU; this.tx[i] = tx; this.ty[i] = ty;
    return i;
  }

  count(kind) {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.kind[i] === kind) c++;
    return c;
  }

  update(dt, onLand) {
    const d = Math.min(0.1, Math.max(0, dt));
    let i = 0;
    while (i < this.n) {
      this.age[i] += d;
      const k = this.kind[i];
      let dead = this.age[i] >= this.life[i];
      if (!dead) {
        this.vy[i] += GRAVITY[k] * d;
        if (k === K.LEAF) this.vx[i] = Math.sin(this.age[i] * 3 + this.ph[i]) * 10;
        if (k === K.FIREFLY || k === K.BUTTERFLY) {
          // wander around the anchor (tx, ty)
          const a = this.age[i] * (k === K.FIREFLY ? 0.9 : 1.6) + this.ph[i];
          this.vx[i] = Math.cos(a) * (k === K.FIREFLY ? 7 : 16) + (this.tx[i] - this.x[i]) * 0.3;
          this.vy[i] = Math.sin(a * 1.3) * (k === K.FIREFLY ? 5 : 9) + (this.ty[i] - this.y[i]) * 0.3;
        }
        this.x[i] += this.vx[i] * d;
        this.y[i] += this.vy[i] * d;
        if (k === K.RAIN && this.y[i] >= this.ty[i]) { onLand?.(this.x[i], this.ty[i]); dead = true; }
        if (k === K.DROP && this.y[i] >= this.ty[i] && this.vy[i] > 0) dead = true;
      }
      if (dead) { this.#remove(i); continue; }
      i++;
    }
  }

  draw(ctx, v, now) {
    for (let i = 0; i < this.n; i++) {
      const x = this.x[i];
      const y = this.y[i];
      if (x < v.x0 - 8 || x > v.x1 + 8 || y < v.y0 - 8 || y > v.y1 + 8) continue;
      const k = this.kind[i];
      const t = this.age[i] / this.life[i];
      const px = Math.round(x);
      const py = Math.round(y);
      switch (k) {
        case K.SMOKE: {
          const s = Math.round(this.size[i] * (1 + t * 2.2));
          ctx.globalAlpha = 0.42 * (1 - t);
          ctx.fillStyle = t < 0.25 ? '#8d8a92' : '#b9b6bf';
          ctx.fillRect(px - (s >> 1), py - (s >> 1), s, s);
          break;
        }
        case K.MIST: {
          const s = Math.round(this.size[i] * (1 + t * 1.5));
          ctx.globalAlpha = 0.22 * (1 - t);
          ctx.fillStyle = '#e8f6ff';
          ctx.fillRect(px - (s >> 1), py - (s >> 1), s, s);
          break;
        }
        case K.LEAF:
          ctx.globalAlpha = Math.min(1, (1 - t) * 3);
          ctx.fillStyle = LEAF_COLORS[this.color[i] % LEAF_COLORS.length];
          ctx.fillRect(px, py, Math.sin(this.age[i] * 6 + this.ph[i]) > 0 ? 2 : 1, 1);
          break;
        case K.RAIN:
          ctx.globalAlpha = 0.6;
          ctx.fillStyle = '#cfe2ff';
          ctx.fillRect(px, py, 1, 6);
          break;
        case K.SPLASH:
          ctx.globalAlpha = 0.7 * (1 - t);
          ctx.fillStyle = '#d8e8ff';
          ctx.fillRect(px, py, 1, 1);
          break;
        case K.DROP:
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = '#e6f8ff';
          ctx.fillRect(px, py, this.size[i], this.size[i]);
          break;
        case K.BUBBLE: {
          const s = this.size[i];
          ctx.globalAlpha = 0.9 * (1 - t * 0.7);
          ctx.fillStyle = '#d8ffd0';
          ctx.fillRect(px, py, s, s);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(px, py, 1, 1);
          break;
        }
        case K.BUTTERFLY: {
          const open = Math.sin(now / 70 + this.ph[i]) > 0;
          ctx.globalAlpha = Math.min(1, (1 - t) * 4, t * 8);
          ctx.fillStyle = WING_COLORS[this.color[i] % WING_COLORS.length];
          if (open) { ctx.fillRect(px - 1, py, 1, 1); ctx.fillRect(px + 1, py, 1, 1); } else ctx.fillRect(px, py - 1, 1, 1);
          ctx.fillStyle = '#3b2a20';
          ctx.fillRect(px, py, 1, 1);
          break;
        }
        default:
          break; // SPARK and FIREFLY are drawn additively by drawGlowing()
      }
    }
    ctx.globalAlpha = 1;
  }

  drawGlowing(ctx, v, now) {
    for (let i = 0; i < this.n; i++) {
      const k = this.kind[i];
      if (k !== K.SPARK && k !== K.FIREFLY) continue;
      const x = this.x[i];
      const y = this.y[i];
      if (x < v.x0 - 8 || x > v.x1 + 8 || y < v.y0 - 8 || y > v.y1 + 8) continue;
      const t = this.age[i] / this.life[i];
      if (k === K.SPARK) {
        ctx.globalAlpha = (1 - t) * 0.5;
        ctx.drawImage(radialSprite([255, 170, 80], 3), x - 3, y - 3);
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = t < 0.4 ? '#fff6c8' : '#ffa850';
        const s = this.size[i];
        ctx.fillRect(Math.round(x), Math.round(y), s, s);
      } else {
        const blink = 0.5 + 0.5 * Math.sin(now / 260 + this.ph[i] * 3);
        const a = Math.min(1, t * 6, (1 - t) * 4) * blink;
        if (a < 0.05) continue;
        ctx.globalAlpha = a * 0.55;
        ctx.drawImage(radialSprite([210, 255, 120], 5), x - 5, y - 5);
        ctx.globalAlpha = a;
        ctx.fillStyle = '#f4ffb8';
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  clear() { this.n = 0; }

  #remove(i) {
    const j = --this.n;
    if (i === j) return;
    for (const f of ['x', 'y', 'vx', 'vy', 'age', 'life', 'ph', 'size', 'tx', 'ty', 'kind', 'color']) this[f][i] = this[f][j];
  }
}

// ---------------------------------------------------------------- scene effects controller
export class SceneFx {
  constructor(world, fx, { quality = 'alta', reducedMotion = false, map = null, skyMask = null } = {}) {
    this.world = world;
    this.fx = fx;
    this.mapImage = map;
    this.daySky = skyMask ? SceneFx.#buildDaySky(world.size[0], world.size[1], skyMask) : null;
    this.quality = quality;
    this.reduced = reducedMotion;
    this.particles = new Particles(quality === 'baixa' ? 420 : 800);
    this.lights = world.lights.map((l, i) => ({ ...l, seed: i * 2.39 }));
    const [w, h] = world.size;
    this.map = makeCanvas(Math.ceil(w / MAP_SCALE), Math.ceil(h / MAP_SCALE));
    this.mapCtx = this.map.getContext('2d');
    this.lit = null;
    this.litCtx = null;
    this.litKey = '';
    this.tinted = new Map();
    this.timers = new Map();
    this.activity = new Map(); // building id -> 0..1 (M2: verified real activity only)
    // Fonte de Elixir: mirrors REAL provider quota (null = no data). Never invented, never reset locally.
    this.elixir = { level: null, exhausted: false };
    const f0 = fx.fountain;
    for (const l of this.lights) l.fountain = Math.abs(l.x - f0.x) < 30 && Math.abs(l.y - f0.y) < 40;
    this.water = (quality === 'baixa' ? fx.waterPoints.filter((_, i) => i % 2 === 0) : fx.waterPoints)
      .map(([x, y], i) => ({ x, y, ph: (i * 2.17) % TAU, sp: 0.0016 + ((i * 7) % 10) * 0.00012 }));
    this.fog = Array.from({ length: 10 }, (_, i) => ({ x: (i * 173) % w, y: 110 + ((i * 131) % (h - 180)), r: 150 + (i % 3) * 50, v: 4 + (i % 4) * 2 }));
    this.clouds = Array.from({ length: 4 }, (_, i) => ({ x: (i * 397) % w, y: 80 + ((i * 251) % (h - 160)), r: 210 + (i % 2) * 60, v: 6 + i * 1.5 }));
    this.stats = { lightRebuilds: 0 };
  }

  // Blue daytime sky pre-masked to the painted sky/mountains/lakes (the art itself is painted at dusk).
  static #buildDaySky(w, h, mask) {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 260);
    grad.addColorStop(0, '#3f86d8');
    grad.addColorStop(0.55, '#7fb8ec');
    grad.addColorStop(1, '#bfe0f6');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mask, 0, 0);
    return c;
  }

  /** Daylight share used to recolour the painted dusk sky to blue (0 at night/dusk/overcast). */
  static daySkyAmount(amb, weather) {
    const overcast = weather.kind === 'limpo' ? 0 : weather.intensity * 0.6;
    return Math.max(0, Math.min(1, 1 - amb.night * 1.6 - amb.warm * 1.1)) * (1 - overcast);
  }

  #litKey(amb, weather) {
    return `${lightKey(amb)}|${Math.round(SceneFx.daySkyAmount(amb, weather) * 20)}`;
  }

  /**
   * Cached lit background: map + day sky + light map (multiply) + re-lit signs, composed once and rebuilt
   * only when the quantized light key changes. Per frame the whole scene background is a single drawImage,
   * so the old laptop GPU never composites full-screen blend modes every frame.
   */
  #ensureLit(amb, weather) {
    const key = this.#litKey(amb, weather);
    if (key === this.litKey && this.lit) return this.lit;
    this.litKey = key;
    this.stats.lightRebuilds += 1;
    const [w, h] = this.world.size;
    if (!this.lit) { this.lit = makeCanvas(w, h); this.litCtx = this.lit.getContext('2d'); }
    const g = this.litCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.mapImage, 0, 0);
    const day = SceneFx.daySkyAmount(amb, weather);
    if (this.daySky && day >= 0.02) {
      g.globalCompositeOperation = 'color';
      g.globalAlpha = 0.78 * day;
      g.drawImage(this.daySky, 0, 0);
      g.globalAlpha = 1;
    }
    if (!isNeutral(amb)) {
      this.#paintMap(amb);
      g.globalCompositeOperation = 'multiply';
      g.imageSmoothingEnabled = true;
      g.drawImage(this.map, 0, 0, this.map.width, this.map.height, 0, 0, w, h);
      g.imageSmoothingEnabled = false;
      if (amb.night > 0.15) {
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = Math.min(0.85, amb.night);
        for (const [x, y, sw, sh] of this.fx.signs ?? []) g.drawImage(this.mapImage, x, y, sw, sh, x, y, sw, sh);
        g.globalAlpha = 1;
      }
    }
    g.globalCompositeOperation = 'source-over';
    this.tinted.clear(); // avatar atlases and occluders follow the new light
    return this.lit;
  }

  /** Scene background (replaces drawing the raw map). */
  drawBackground(ctx, amb, weather) {
    ctx.drawImage(this.#ensureLit(amb, weather), 0, 0);
  }

  /** Avatar atlas multiplied by the global tint (cached per light key). */
  atlasFor(role, atlas, amb) {
    if (isNeutral(amb)) return atlas;
    const key = `atlas|${role}`;
    let c = this.tinted.get(key);
    if (!c) {
      c = makeCanvas(atlas.width, atlas.height);
      const g = c.getContext('2d');
      g.drawImage(atlas, 0, 0);
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = `rgb(${amb.tint.join(',')})`;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(atlas, 0, 0);
      this.tinted.set(key, c);
    }
    return c;
  }

  /** Foreground occluder cut from the lit background, so it matches the scene light exactly. */
  occluderFor(o, amb, weather) {
    const lit = this.#ensureLit(amb, weather);
    const key = `occ|${o.id}`;
    let c = this.tinted.get(key);
    if (!c) {
      c = makeCanvas(o.img.width, o.img.height);
      const g = c.getContext('2d');
      g.drawImage(o.img, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.drawImage(lit, o.at[0], o.at[1], c.width, c.height, 0, 0, c.width, c.height);
      this.tinted.set(key, c);
    }
    return c;
  }

  /** 0..1 local light at a point from nearby lamps/windows/fire (avatars brighten under lamps at night). */
  localLight(x, y, amb) {
    if (amb.night < 0.1) return 0;
    let best = 0;
    for (const l of this.lights) {
      const spec = LIGHT_KINDS[l.kind];
      if (!spec) continue;
      const r = spec.radius * 1.15;
      const dx = x - l.x;
      const dy = y - l.y;
      if (dx > r || dx < -r || dy > r || dy < -r) continue;
      const d = Math.hypot(dx, dy) / r;
      if (d >= 1) continue;
      best = Math.max(best, lightStrength(l.kind, amb.night) * (1 - d * d));
    }
    return best;
  }

  setBuildingActivity(id, level) {
    this.activity.set(id, Math.max(0, Math.min(1, Number(level) || 0)));
  }

  /** Real quota mirror: level 0..1 (or null when no provider data), exhausted when every plan is out. */
  setElixir({ level = null, exhausted = false } = {}) {
    this.elixir = { level: level === null ? null : Math.max(0, Math.min(1, level)), exhausted: Boolean(exhausted) };
  }

  /** Sparkle burst — called only after the provider itself confirmed a reset (provider.reset_verified). */
  refillBurst() {
    if (this.reduced) return;
    const f = this.fx.fountain;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * TAU;
      this.particles.spawn(K.SPARK, f.x + Math.cos(a) * 10, f.y + Math.sin(a) * 5, Math.cos(a) * 30, -30 - Math.random() * 30, 0.9 + Math.random() * 0.6, Math.random() < 0.5 ? 2 : 1);
    }
  }

  setReducedMotion(on) {
    this.reduced = on;
    if (on) this.particles.clear();
  }

  #every(key, ms, now) {
    const last = this.timers.get(key) ?? -Infinity;
    if (now - last < ms) return false;
    this.timers.set(key, now);
    return true;
  }

  /** Advances particles and emitters. `view` = visible world rect {x0,y0,x1,y1}. */
  update(dt, now, amb, weather, view) {
    if (this.reduced) return;
    const p = this.particles;
    const lowQ = this.quality === 'baixa';
    const raining = weather.kind === 'chuva' ? weather.intensity : 0;
    for (const e of this.fx.emitters) {
      const boost = e.building ? this.activity.get(e.building) ?? 0 : 0;
      if (e.kind === 'smoke' && this.#every('smoke', 420 - boost * 250, now)) {
        p.spawn(K.SMOKE, e.x + (Math.random() * 4 - 2), e.y, 4 + Math.random() * 3 + raining * -2, -9 - Math.random() * 4, 3.2 + Math.random(), 2 + Math.random() * 2);
      }
      if (e.kind === 'sparks' && this.#every(`sparks${e.x}`, 160 - boost * 110, now)) {
        const burst = 2 + Math.round(boost * 4);
        for (let b = 0; b < burst; b++) p.spawn(K.SPARK, e.x + (Math.random() * 14 - 7), e.y + (Math.random() * 6 - 3), Math.random() * 40 - 20, -35 - Math.random() * 35, 0.6 + Math.random() * 0.5, Math.random() < 0.35 ? 2 : 1);
      }
      if (e.kind === 'bubbles' && this.#every(`bub${e.x}`, 260 - boost * 150, now)) {
        p.spawn(K.BUBBLE, e.x + (Math.random() * 12 - 6), e.y + 12, Math.random() * 2 - 1, -10 - Math.random() * 6, 1.6 + Math.random() * 0.8, Math.random() < 0.4 ? 3 : 2);
      }
      if (e.kind === 'mist' && this.#every('mist', 300, now)) {
        p.spawn(K.MIST, e.x + (Math.random() * 20 - 10), e.y, Math.random() * 6 - 3, -4 - Math.random() * 3, 2.4, 3 + Math.random() * 3);
      }
    }
    // fountain droplets
    const f = this.fx.fountain;
    if (this.#every('drop', this.elixir.exhausted ? 650 : 70, now)) {
      const a = Math.random() * TAU;
      p.spawn(K.DROP, f.x + Math.cos(a) * 8, f.y + 4, Math.cos(a) * (14 + Math.random() * 16), -34 - Math.random() * 18, 1.4, Math.random() < 0.4 ? 2 : 1, 0, 0, f.y + 26 + Math.random() * 14);
    }
    // waterfall streaks are drawn procedurally (see drawGround); falling leaves
    if (this.#every('leaf', raining ? 500 : 1500, now)) {
      const [lx, ly] = this.fx.leafPoints[Math.floor(Math.random() * this.fx.leafPoints.length)];
      p.spawn(K.LEAF, lx, ly, 0, 6, 2.2 + Math.random() * 1.5, 1, Math.floor(Math.random() * 4));
    }
    // fireflies at night, butterflies by day (both shelter from rain)
    const fireTarget = Math.round((lowQ ? 10 : 22) * Math.max(0, (amb.night - 0.45) / 0.55) * (1 - raining));
    if (p.count(K.FIREFLY) < fireTarget && this.#every('fly', 180, now)) {
      const pts = this.fx.flowerPoints;
      const [ax, ay] = pts[Math.floor(Math.random() * pts.length)];
      p.spawn(K.FIREFLY, ax, ay - 4, 0, 0, 6 + Math.random() * 6, 1, 0, ax + (Math.random() * 20 - 10), ay - 6 - Math.random() * 8);
    }
    const flyTarget = lowQ ? 0 : Math.round(6 * Math.max(0, 1 - amb.night * 2.5) * (1 - raining) * (weather.kind === 'neblina' ? 0.3 : 1));
    if (p.count(K.BUTTERFLY) < flyTarget && this.#every('bfly', 900, now)) {
      const pts = this.fx.flowerPoints;
      const [ax, ay] = pts[Math.floor(Math.random() * pts.length)];
      p.spawn(K.BUTTERFLY, ax, ay - 6, 0, 0, 9 + Math.random() * 6, 1, Math.floor(Math.random() * 4), ax, ay - 8);
    }
    // rain inside the visible rect
    if (raining > 0) {
      const target = Math.round((lowQ ? 90 : 230) * raining);
      const missing = target - p.count(K.RAIN);
      for (let r = 0; r < Math.min(missing, 24); r++) {
        const x = view.x0 + Math.random() * (view.x1 - view.x0 + 60) - 30;
        const ground = view.y0 + Math.random() * (view.y1 - view.y0);
        p.spawn(K.RAIN, x, view.y0 - Math.random() * 60, -18, 260 + Math.random() * 40, 4, 1, 0, 0, ground);
      }
    }
    p.update(dt / 1000, (x, y) => {
      if (Math.random() < 0.6) for (let s = 0; s < 2; s++) p.spawn(K.SPLASH, x, y, Math.random() * 30 - 15, -20 - Math.random() * 15, 0.3);
    });
    for (const c of this.fog) c.x = (c.x + c.v * dt / 1000) % (this.world.size[0] + 300);
    for (const c of this.clouds) c.x = (c.x + c.v * dt / 1000) % (this.world.size[0] + 400);
  }

  // ---------------------------------------------------------------- drawing (world transform active)

  /** Under the avatars: water shimmer, waterfall streaks. */
  drawGround(ctx, now, amb, view) {
    const vis = (x, y) => x >= view.x0 - 2 && x <= view.x1 + 2 && y >= view.y0 - 2 && y <= view.y1 + 2;
    ctx.fillStyle = '#e9fbff';
    if (!this.reduced) {
      for (const w of this.water) {
        if (!vis(w.x, w.y)) continue;
        // travelling wave along +x gives a sense of flow; only the crest sparkles
        const b = Math.sin(now * w.sp + w.ph - w.x * 0.045);
        if (b < 0.7) continue;
        ctx.globalAlpha = Math.min(1, (b - 0.7) * 3.3) * (0.75 + 0.5 * amb.night);
        ctx.fillRect(w.x, w.y, b > 0.92 ? 3 : b > 0.82 ? 2 : 1, 1);
      }
      const wf = this.fx.waterfall;
      if (vis(wf.x + wf.w / 2, wf.y + wf.h / 2)) {
        ctx.fillStyle = '#ffffff';
        for (let s = 0; s < 18; s++) {
          const col = wf.x + ((s * 13) % wf.w);
          const off = ((now * (0.05 + (s % 4) * 0.012) + s * 37) % (wf.h + 12)) - 12;
          ctx.globalAlpha = 0.35 + (s % 3) * 0.12;
          ctx.fillRect(col, wf.y + off, 1, 6 + (s % 3) * 2);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Over the avatars, before the light map: cloud shadows when cloudy/raining. */
  drawShadows(ctx, weather) {
    const k = weather.kind === 'nublado' || weather.kind === 'chuva' ? weather.intensity : 0;
    if (k < 0.02 || this.quality === 'baixa') return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.28 * k;
    const shadow = radialSprite([70, 76, 96], 160, 0.4);
    for (const c of this.clouds) ctx.drawImage(shadow, c.x - 200 - c.r, c.y - c.r, c.r * 2, c.r * 1.2);
    ctx.restore();
  }

  #paintMap(amb) {
    const m = this.mapCtx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.globalAlpha = 1;
    m.fillStyle = `rgb(${amb.tint.join(',')})`;
    m.fillRect(0, 0, this.map.width, this.map.height);
    m.setTransform(1 / MAP_SCALE, 0, 0, 1 / MAP_SCALE, 0, 0);
    m.globalCompositeOperation = 'lighten';
    for (const l of this.lights) {
      const spec = LIGHT_KINDS[l.kind];
      const s = lightStrength(l.kind, amb.night);
      if (!spec || s < 0.03) continue;
      const c = mix(amb.tint, spec.color, s);
      const r = spec.radius;
      m.globalAlpha = 1;
      m.drawImage(radialSprite(c, r, 0.35), l.x - r, l.y - r, r * 2, r * 2);
    }
    m.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Additive glows: flickering flames, pulsing crystals, sparks, fireflies, stars. */
  drawGlows(ctx, now, amb, view) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const l of this.lights) {
      const spec = LIGHT_KINDS[l.kind];
      if (!spec) continue;
      const strength = lightStrength(l.kind, amb.night);
      if (strength < 0.03) continue;
      if (l.x < view.x0 - 80 || l.x > view.x1 + 80 || l.y < view.y0 - 80 || l.y > view.y1 + 80) continue;
      let a;
      if (l.kind.startsWith('crystal')) a = 0.16 + 0.22 * (this.reduced ? 0.5 : pulse(now, 3_200, l.seed));
      else a = (this.reduced ? 1 : flicker(now, l.seed, spec.flicker)) * (l.kind === 'fire' ? 0.42 : l.kind === 'window' ? 0.12 : 0.22);
      const boost = l.kind === 'fire' ? (this.activity.get('FORGE') ?? 0) * 0.35 : 0;
      const elixir = l.fountain ? (this.elixir.exhausted ? 0.25 : this.elixir.level === null ? 1 : 0.55 + 0.45 * this.elixir.level) : 1;
      ctx.globalAlpha = Math.min(1, (a * strength + boost) * elixir);
      const r = spec.radius * (l.kind === 'fire' ? 0.8 : 0.5);
      ctx.drawImage(radialSprite(spec.color, r), l.x - r, l.y - r, r * 2, r * 2);
    }
    if (amb.night > 0.5) {
      const k = (amb.night - 0.5) * 2;
      ctx.fillStyle = '#fffbe8';
      for (let i = 0; i < this.fx.stars.length; i++) {
        const [x, y] = this.fx.stars[i];
        const tw = this.reduced ? 0.7 : 0.55 + 0.45 * Math.sin(now / 700 + i * 1.7);
        ctx.globalAlpha = k * tw * 0.9;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    this.particles.drawGlowing(ctx, view, now);
    ctx.restore();
  }

  /** Air layer: smoke, leaves, rain, butterflies, then fog. */
  drawAir(ctx, now, weather, view) {
    this.particles.draw(ctx, view, now);
    const fog = weather.kind === 'neblina' ? weather.intensity : weather.kind === 'chuva' ? weather.intensity * 0.35 : 0;
    if (fog > 0.02) {
      ctx.save();
      ctx.globalAlpha = 0.17 * fog; // overall haze
      ctx.fillStyle = 'rgb(222,228,238)';
      ctx.fillRect(view.x0 - 2, view.y0 - 2, view.x1 - view.x0 + 4, view.y1 - view.y0 + 4);
      if (weather.kind !== 'neblina' || this.quality === 'baixa') { ctx.restore(); return; } // banks only in real fog
      ctx.globalAlpha = 0.42 * fog; // drifting banks
      const puff = radialSprite([230, 235, 244], 128, 0.3);
      for (const c of this.fog) ctx.drawImage(puff, c.x - 150 - c.r, c.y - c.r * 0.5, c.r * 2, c.r);
      ctx.restore();
    }
  }
}

export { K as PARTICLE_KINDS };
