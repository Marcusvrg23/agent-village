// Agent Village — Canvas 2D renderer. Draws the cleaned map, depth-sorted independent sprites,
// foreground occluders and ambient bubbles. No network, no model calls.
import { drawOverlay } from './overlays.js';

export class Camera {
  constructor(worldW, worldH) {
    this.worldW = worldW;
    this.worldH = worldH;
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.minScale = 0.5;
    this.maxScale = 4;
  }

  fit(viewW, viewH) {
    const contain = Math.min(viewW / this.worldW, viewH / this.worldH);
    // Portrait screens (phones): zoom in around the plaza instead of a thin strip; drag to see the rest.
    this.scale = viewH > viewW * 1.15 ? Math.min((viewW / this.worldW) * 2.2, viewH / this.worldH) : contain;
    this.minScale = contain * 0.9;
    this.maxScale = Math.max(this.scale * 4, 3);
    this.x = (this.worldW - viewW / this.scale) / 2;
    this.y = (this.worldH - viewH / this.scale) / 2;
  }

  toWorld(sx, sy) { return [sx / this.scale + this.x, sy / this.scale + this.y]; }
  toScreen(wx, wy) { return [(wx - this.x) * this.scale, (wy - this.y) * this.scale]; }

  zoomAt(factor, sx, sy, viewW, viewH) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    this.x = wx - sx / this.scale;
    this.y = wy - sy / this.scale;
    this.clamp(viewW, viewH);
  }

  pan(dx, dy, viewW, viewH) {
    this.x -= dx / this.scale;
    this.y -= dy / this.scale;
    this.clamp(viewW, viewH);
  }

  clamp(viewW, viewH) {
    const vw = viewW / this.scale;
    const vh = viewH / this.scale;
    const clampAxis = (pos, view, world) => (view >= world ? (world - view) / 2 : Math.min(Math.max(pos, 0), world - view));
    this.x = clampAxis(this.x, vw, this.worldW);
    this.y = clampAxis(this.y, vh, this.worldH);
  }
}

export class Renderer {
  constructor(canvas, { map, atlases, manifest, occluders }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.map = map;
    this.atlases = atlases;
    this.manifest = manifest;
    this.frameIndex = new Map(manifest.frames.map((name, i) => [name, i]));
    this.occluders = occluders;
    this.dpr = 1;
    this.viewW = 0;
    this.viewH = 0;
  }

  resize(cssW, cssH, dpr) {
    this.dpr = dpr;
    this.viewW = cssW;
    this.viewH = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  draw(camera, agents, { selected = null, hovered = null, hoveredBuilding = null, buildings = {}, fx = null, ambient = null, weather = null, now = 0, extras = [], reduced = false, wall = Date.now() } = {}) {
    const { ctx, dpr } = this;
    const [cw, ch] = this.manifest.cell;
    const [ax, ay] = this.manifest.anchor;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1230';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const k = camera.scale * dpr;
    ctx.setTransform(k, 0, 0, k, -camera.x * k, -camera.y * k);
    ctx.imageSmoothingEnabled = false;
    if (fx && ambient && weather) fx.drawBackground(ctx, ambient, weather);
    else ctx.drawImage(this.map, 0, 0);
    const view = { x0: camera.x, y0: camera.y, x1: camera.x + this.viewW / camera.scale, y1: camera.y + this.viewH / camera.scale };
    if (fx && ambient) fx.drawGround(ctx, now, ambient, view);

    if (hoveredBuilding && buildings[hoveredBuilding]) {
      const [x, y, w, h] = buildings[hoveredBuilding].rect;
      ctx.strokeStyle = 'rgba(255, 226, 140, 0.85)';
      ctx.lineWidth = 2 / camera.scale;
      ctx.setLineDash([6 / camera.scale, 4 / camera.scale]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }

    // Depth sort: avatars by feet, occluders by their baseline.
    const drawables = [
      ...agents.map((a) => ({ y: a.y, kind: 'agent', a })),
      ...this.occluders.map((o) => ({ y: o.baseline, kind: 'occluder', o })),
      ...extras.map((e) => ({ y: e.y, kind: 'extra', e })), // project camps (tents), social props
    ].sort((p, q) => p.y - q.y);

    for (const d of drawables) {
      if (d.kind === 'extra') { d.e.draw(ctx, camera); continue; }
      if (d.kind === 'occluder') {
        ctx.drawImage(fx && ambient && weather ? fx.occluderFor(d.o, ambient, weather) : d.o.img, d.o.at[0], d.o.at[1]);
        continue;
      }
      const a = d.a;
      const px = Math.round(a.x);
      const py = Math.round(a.y);
      // soft contact shadow
      ctx.fillStyle = 'rgba(8, 10, 20, 0.35)';
      ctx.beginPath();
      ctx.ellipse(px, py - 1, 9, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      if (a.role === selected || a.role === hovered) {
        ctx.strokeStyle = a.role === selected ? '#ffe28c' : 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1.5 / camera.scale;
        ctx.beginPath();
        ctx.ellipse(px, py - 1, 13, 5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (a.presence === 'verified') {
        ctx.strokeStyle = '#5dffb0';
        ctx.lineWidth = 2 / camera.scale;
        ctx.beginPath();
        ctx.ellipse(px, py - 1, 15, 6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      const base = this.atlases[a.role];
      const fi = this.frameIndex.get(a.frame) ?? 0;
      const top = py - ay + a.bob;
      // Same sprites and frames as M1; at night the atlas is pre-tinted and nearby lamps add local light.
      const tinted = fx && ambient ? fx.atlasFor(a.role, base, ambient) : base;
      const lamp = fx && ambient && tinted !== base ? fx.localLight(a.x, a.y - 20, ambient) : 0;
      const blit = (img) => {
        if (a.flip) {
          ctx.save();
          ctx.translate(px, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(img, fi * cw, 0, cw, ch, -ax, top, cw, ch);
          ctx.restore();
        } else {
          ctx.drawImage(img, fi * cw, 0, cw, ch, px - ax, top, cw, ch);
        }
      };
      blit(tinted);
      if (lamp > 0.04) {
        ctx.globalAlpha = Math.min(0.9, lamp);
        blit(base);
        ctx.globalAlpha = 1;
      }
      drawOverlay(ctx, a, top, wall, reduced); // raised hand, hourglass, popcorn, cobwebs, rain cloud (real states only)
    }

    // Scene lighting and weather over the world (avatars included), under the UI.
    if (fx && ambient && weather) {
      fx.drawShadows(ctx, weather);
      fx.drawGlows(ctx, now, ambient, view);
      fx.drawAir(ctx, now, weather, view);
    }

    // Screen-space UI: name tags and bubbles stay crisp at any zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const font = Math.round(Math.min(15, Math.max(11, 11 * camera.scale)));
    for (const e of extras) {
      if (!e.label) continue;
      const [sx, sy] = camera.toScreen(e.x, e.y + 4);
      this.#sign(sx, sy, e.label, Math.max(10, font - 2), e.lit);
    }
    for (const a of agents) {
      const [sx, sy] = camera.toScreen(a.x, a.y - ay + 2 + a.bob);
      if (a.role === selected || a.role === hovered) this.#tag(sx, sy - 4, a.label, font, a.presence);
      const lift = a.role === selected || a.role === hovered ? 24 : 6;
      // Real-state bubbles (solid edge): what the agent is waiting on. Ambient ones stay dashed.
      if (a.task?.needsYou) this.#bubble(sx, sy - lift - 10, 'Preciso de você!', font, true);
      else if (a.task?.wait && a.task.waitText) this.#bubble(sx, sy - lift - 10, `⏳ ${a.task.waitText}`, font, true);
      else if (a.bubble) this.#bubble(sx, sy - lift, a.bubble.text, font);
    }
  }

  // Small wooden sign under a project camp.
  #sign(x, y, text, font, lit) {
    const { ctx } = this;
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    const label = text.length > 22 ? `${text.slice(0, 21)}…` : text;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = lit ? 'rgba(92, 58, 26, 0.92)' : 'rgba(44, 34, 28, 0.85)';
    roundRect(ctx, x - w / 2, y, w, font + 6, 3);
    ctx.fill();
    ctx.fillStyle = lit ? '#ffe9b8' : '#b9ad9a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + (font + 6) / 2);
  }

  #tag(x, y, text, font, presence) {
    const { ctx } = this;
    ctx.font = `600 ${font - 1}px system-ui, sans-serif`;
    const label = `${text} · ${presence === 'verified' ? 'ACTIVE' : 'STANDBY'}`;
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = presence === 'verified' ? 'rgba(18, 92, 60, 0.92)' : 'rgba(14, 20, 44, 0.88)';
    roundRect(ctx, x - w / 2, y - font - 6, w, font + 6, 5);
    ctx.fill();
    ctx.fillStyle = '#f4f1e8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y - font / 2 - 3);
  }

  // Ambient bubbles are dark with a dashed edge: visibly different from (future) real-event bubbles.
  #bubble(x, y, text, font, real = false) {
    const { ctx } = this;
    ctx.font = `500 ${font}px system-ui, sans-serif`;
    const w = Math.min(220, ctx.measureText(text).width + 16);
    const h = font + 10;
    // Keep bubbles on screen (and clear of the top HUD row) when an avatar is near the viewport edge.
    const bx = Math.round(Math.min(Math.max(x - w / 2, 6), this.viewW - w - 6));
    const by = Math.round(Math.max(y - h - 8, 56));
    x = Math.min(Math.max(x, bx + 10), bx + w - 10);
    ctx.fillStyle = real ? 'rgba(48, 34, 6, 0.94)' : 'rgba(16, 22, 48, 0.9)';
    roundRect(ctx, bx, by, w, h, 7);
    ctx.fill();
    if (!real) ctx.setLineDash([3, 3]);
    ctx.strokeStyle = real ? '#ffd84d' : 'rgba(190, 205, 255, 0.55)';
    ctx.lineWidth = real ? 1.5 : 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x - 5, by + h);
    ctx.lineTo(x, by + h + 6);
    ctx.lineTo(x + 5, by + h);
    ctx.closePath();
    ctx.fillStyle = real ? 'rgba(48, 34, 6, 0.94)' : 'rgba(16, 22, 48, 0.9)';
    ctx.fill();
    ctx.fillStyle = real ? '#fff3c4' : '#e8ecff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, by + h / 2 + 0.5, w - 10);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Hit testing in world coordinates (pure, testable).
export function hitAgent(agents, wx, wy) {
  let best = null;
  for (const a of agents) {
    if (wx >= a.x - 12 && wx <= a.x + 12 && wy >= a.y - 44 && wy <= a.y + 2) {
      if (!best || a.y > best.y) best = a; // front-most wins
    }
  }
  return best;
}

export function hitBuilding(buildings, wx, wy) {
  for (const [id, b] of Object.entries(buildings)) {
    const [x, y, w, h] = b.rect;
    if (wx >= x && wx <= x + w && wy >= y && wy <= y + h) return id;
  }
  return null;
}
