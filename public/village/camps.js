// Agent Village — one camp (tent) per project with real activity. A camp is pitched when a project gets its
// first real session (Claude Code / Codex / mission), lights up while agents work there, goes dark when they are
// idle and is folded away a while after the last session ends; its plot is then free for the next project.
// Projects come only from verified sources (session cwd, mission folder). Drawing is procedural pixel art.

export const PITCH_MS = 1_400;
export const FOLD_MS = 1_400;
export const LINGER_MS = 2 * 60_000; // a closed project keeps its tent this long (lights off), then it folds

/** Projects with real activity -> {name: {active, agents, sources}}. Pure (tested). */
export function projectsFrom({ claudeSessions = [], missions = [], room = null } = {}, now = Date.now()) {
  const out = new Map();
  const add = (name, active, source) => {
    if (!name) return;
    const p = out.get(name) ?? { name, active: false, agents: 0, sources: new Set() };
    p.active ||= active;
    if (active) p.agents += 1;
    p.sources.add(source);
    out.set(name, p);
  };
  for (const s of claudeSessions) {
    const recent = now - (Date.parse(s.lastAt ?? 0) || Number(s.lastAt) || 0) < 30 * 60_000;
    if (s.project && (s.active || recent || s.wait)) add(s.project, Boolean(s.active || s.wait), 'claude');
  }
  for (const m of missions) {
    const name = typeof m.cwd === 'string' ? m.cwd.replaceAll('\\', '/').split('/').filter(Boolean).pop() : null;
    if (m.status === 'running') add(name, true, 'missão');
  }
  if (room?.project && room.project !== 'Unknown' && (room.agents ?? []).some((a) => a.state && !['idle', 'done'].includes(a.state))) add(room.project, true, 'codex');
  return out;
}

const hashHue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };

/** Tent sprite (cached per hue): 44×34 world pixels, crisp edges. */
const sprites = new Map();
function tentSprite(hue) {
  const key = hue;
  if (sprites.has(key)) return sprites.get(key);
  const w = 44;
  const h = 34;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d');
  const cloth = `hsl(${hue} 55% 52%)`;
  const clothDark = `hsl(${hue} 50% 34%)`;
  const cream = '#efe3c2';
  const creamDark = '#c9b98f';
  const ink = '#1b1f33';
  // ground shadow
  g.fillStyle = 'rgba(8,10,20,0.35)';
  g.beginPath(); g.ellipse(22, 31, 20, 3.2, 0, 0, Math.PI * 2); g.fill();
  // back panel (right side, darker), front panel (left side) — simple isometric A-frame
  g.fillStyle = clothDark;
  g.beginPath(); g.moveTo(22, 4); g.lineTo(41, 30); g.lineTo(22, 30); g.closePath(); g.fill();
  g.fillStyle = cloth;
  g.beginPath(); g.moveTo(22, 4); g.lineTo(3, 30); g.lineTo(22, 30); g.closePath(); g.fill();
  // cream stripes on the front panel
  g.fillStyle = cream;
  for (const t of [0.34, 0.68]) {
    g.beginPath(); g.moveTo(22, 4); g.lineTo(22 - 19 * t - 1.5, 30); g.lineTo(22 - 19 * t + 1.5, 30); g.closePath(); g.fill();
  }
  g.fillStyle = creamDark;
  for (const t of [0.34, 0.68]) {
    g.beginPath(); g.moveTo(22, 4); g.lineTo(22 + 19 * t - 1.2, 30); g.lineTo(22 + 19 * t + 1.2, 30); g.closePath(); g.fill();
  }
  // door opening
  g.fillStyle = '#2a1f2e';
  g.beginPath(); g.moveTo(22, 15); g.lineTo(16, 30); g.lineTo(28, 30); g.closePath(); g.fill();
  // pole + flag
  g.fillStyle = '#6b4a2b'; g.fillRect(21, 0, 2, 6);
  g.fillStyle = `hsl(${(hue + 40) % 360} 80% 60%)`; g.fillRect(23, 0, 5, 3);
  // crisp pixel look: hard alpha
  const img = g.getImageData(0, 0, w, h);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] >= 110 ? (img.data[i] > 200 ? 255 : img.data[i]) : 0;
  g.putImageData(img, 0, 0);
  // outline
  g.strokeStyle = ink; g.lineWidth = 1;
  g.beginPath(); g.moveTo(22.5, 3.5); g.lineTo(2.5, 30.5); g.lineTo(41.5, 30.5); g.closePath(); g.stroke();
  sprites.set(key, c);
  return c;
}

export class Camps {
  constructor(world) {
    this.plots = world.camps?.plots ?? [];
    this.camps = new Map(); // name -> {name, plot, hue, state, since, lastActive, agents, foldAt}
  }

  /** Syncs camps with the projects that have real activity. `projects` from projectsFrom(). */
  update(projects, now = Date.now()) {
    for (const [name, p] of projects) {
      let c = this.camps.get(name);
      if (!c) {
        const used = new Set([...this.camps.values()].map((x) => x.plot));
        const free = this.plots.findIndex((_, i) => !used.has(i));
        if (free < 0) continue; // no plot left: the project still shows on its avatars and in the panel
        c = { name, plot: free, hue: hashHue(name), born: now, lastActive: now, agents: 0, foldAt: null };
        this.camps.set(name, c);
      }
      c.foldAt = null;
      c.agents = p.agents;
      c.sources = [...p.sources];
      if (p.active) c.lastActive = now;
      c.lit = p.active;
    }
    for (const c of this.camps.values()) {
      if (projects.has(c.name)) continue;
      c.lit = false;
      c.agents = 0;
      if (!c.foldAt && now - c.lastActive > LINGER_MS) c.foldAt = now;
    }
    for (const [name, c] of [...this.camps]) if (c.foldAt && now - c.foldAt > FOLD_MS) this.camps.delete(name);
  }

  list() { return [...this.camps.values()]; }

  /** Drawables for the renderer (depth-sorted with avatars). */
  drawables(now, night = 0) {
    return this.list().map((c) => {
      const [x, y] = this.plots[c.plot];
      const grow = Math.min(1, (now - c.born) / PITCH_MS);
      const fold = c.foldAt ? Math.max(0, 1 - (now - c.foldAt) / FOLD_MS) : 1;
      const k = Math.max(0.05, Math.min(grow, fold));
      return {
        y, camp: c, x,
        draw: (ctx) => {
          const img = tentSprite(c.hue);
          const S = 1.4; // a bit larger than an avatar
          const h = Math.round(img.height * k);
          ctx.save();
          if (!c.lit) ctx.globalAlpha = 0.9;
          ctx.drawImage(img, 0, img.height - h, img.width, h, x - 22 * S, y - h * S, img.width * S, h * S);
          ctx.restore();
          if (c.lit && k > 0.95) {
            // warm lantern inside the door (stronger at night)
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = `rgba(255, 200, 110, ${0.35 + 0.45 * night})`;
            ctx.fillRect(x - 4, y - 17, 8, 13);
            ctx.restore();
          } else if (k > 0.95) {
            ctx.fillStyle = 'rgba(10, 14, 30, 0.35)'; // lights off
            ctx.fillRect(x - 7, y - 21, 14, 17);
          }
        },
      };
    });
  }

  /** World-space hit test for clicks: returns the camp under (wx, wy). */
  hit(wx, wy) {
    for (const c of this.camps.values()) {
      const [x, y] = this.plots[c.plot];
      if (wx >= x - 31 && wx <= x + 31 && wy >= y - 48 && wy <= y + 2) return c;
    }
    return null;
  }
}
