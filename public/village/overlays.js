// Agent Village — tiny pixel-art icons drawn over avatars (raised hand, hourglass, popcorn, cobwebs, rain cloud).
// Drawn from text grids into cached canvases at load time: no extra image files, crisp at any zoom.
// Only real states show icons: a raised hand = a real request waiting for you; an hourglass = a real command
// still running. Idle life never shows them.

const PALETTE = {
  k: '#1b1f33', w: '#fff7e6', s: '#f2c79b', S: '#d99a6c', y: '#ffd84d', Y: '#f0a830', o: '#e8742c', r: '#d8443c',
  b: '#6fb7ff', B: '#2f6fd8', g: '#c9d1e6', G: '#8a93b8', c: '#e9eef9', d: '#5a6178', p: '#ff9fd0',
};

const GRIDS = {
  hand: [
    '...kk.kk....',
    '..kssksskk..',
    '..ksskssksk.',
    '..ksskssksk.',
    '.kksssssssk.',
    'kssksssssssk',
    'ksssssssssk.',
    '.kssssssssk.',
    '..kssssssk..',
    '...kSSSSk...',
    '....kkkk....',
  ],
  hourglassA: [
    'kkkkkkkk',
    'kwwwwwwk',
    '.kyyyyk.',
    '..kyyk..',
    '...kk...',
    '..k..k..',
    '.k....k.',
    'kwwwwwwk',
    'kkkkkkkk',
  ],
  hourglassB: [
    'kkkkkkkk',
    'kwwwwwwk',
    '.k....k.',
    '..k..k..',
    '...kk...',
    '..kyyk..',
    '.kyyyyk.',
    'kwyyyywk',
    'kkkkkkkk',
  ],
  popcorn: [
    '..w.ww.w..',
    '.wwywwwyw.',
    '.wwwwywww.',
    'krwrwrwrwk',
    '.krwrwrwk.',
    '.krwrwrwk.',
    '..krwrwk..',
    '..kkkkkk..',
  ],
  cobweb: [
    'g...g...g',
    '.g..g..g.',
    '..ggggg..',
    'ggg.g.ggg',
    '..ggggg..',
    '.g..g..g.',
    'g...g...g',
  ],
  cloud: [
    '...gggg.....',
    '..gccccg.gg.',
    '.gccccccgccg',
    'gccccccccccg',
    'gccccccccccg',
    '.gggggggggg.',
    '..b..b..b...',
    '.b..b..b..b.',
  ],
  coin: [
    '.kkkk.',
    'kyYYyk',
    'kYyyYk',
    'kYyyYk',
    'kyYYyk',
    '.kkkk.',
  ],
  ball: [
    '.kkkk.',
    'kwwkwk',
    'kwkkwk',
    'kkwwkk',
    'kwwwwk',
    '.kkkk.',
  ],
  fish: [
    '.....kk..',
    'k..kkbbk.',
    'kkkbbbwbk',
    'kkkbbbbbk',
    'k..kkbbk.',
    '.....kk..',
  ],
  rock: [
    '.kkkk.',
    'kSssSk',
    'ksSSsk',
    'kSssSk',
    '.kkkk.',
  ],
  paper: [
    'kkkkkk',
    'kwwwwk',
    'kwkkwk',
    'kwwwwk',
    'kwkkwk',
    'kkkkkk',
  ],
  scissors: [
    'k...k.',
    '.k.k..',
    '..k...',
    '.krk..',
    'kr.rk.',
    'kk.kk.',
  ],
};

const cache = new Map();

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Cached icon canvas (1 grid cell = 1 world pixel). */
export function icon(name) {
  if (cache.has(name)) return cache.get(name);
  const grid = GRIDS[name];
  if (!grid) return null;
  const h = grid.length;
  const w = Math.max(...grid.map((r) => r.length));
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const col = PALETTE[grid[y][x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  }
  cache.set(name, c);
  return c;
}

export const ICONS = Object.freeze(Object.keys(GRIDS));

/** Wait phases for a real command still running (minutes since it started). Pure (tested). */
export function waitPhase(sinceMs, now) {
  const min = Math.max(0, now - sinceMs) / 60_000;
  if (min >= 25) return 'sleep';
  if (min >= 10) return 'cobweb';
  if (min >= 3) return 'arms';
  return 'popcorn';
}

export const WAIT_LABELS = Object.freeze({ popcorn: 'comendo pipoca', arms: 'de braços cruzados', cobweb: 'juntando teias', sleep: 'cochilando' });

/**
 * Draws the overlay of one avatar in WORLD space (call after its sprite). `top` = y of the sprite's top edge.
 * Returns nothing; purely visual.
 */
export function drawOverlay(ctx, a, top, now, reduced) {
  const t = a.task;
  const x = Math.round(a.x);
  if (a.activity === 'FISH') {
    // fishing rod and line toward the water (decorative idle life)
    const dir = a.flip ? 1 : -1;
    ctx.strokeStyle = '#6b4a2b';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + dir * 6, top + 30); ctx.lineTo(x + dir * 20, top + 14); ctx.stroke();
    ctx.strokeStyle = 'rgba(230, 240, 255, 0.8)';
    const sway = reduced ? 0 : Math.sin(now / 500) * 1.5;
    ctx.beginPath(); ctx.moveTo(x + dir * 20, top + 14); ctx.lineTo(x + dir * 26 + sway, top + 44); ctx.stroke();
  }
  if (a.social?.icon) {
    const img = icon(a.social.icon);
    const hop = a.social.shake && !reduced ? -Math.abs(Math.round(Math.sin(now / 90) * 3)) : 0;
    // game props are drawn at 2× so they read at the default zoom
    if (img) ctx.drawImage(img, x + (a.flip ? -26 : 12), top + 10 + hop, img.width * 2, img.height * 2);
  }
  if (!t) return;
  if (t.needsYou) {
    const img = icon('hand');
    const blink = reduced || Math.floor(now / 450) % 2 === 0;
    const lift = reduced ? 0 : Math.round(Math.sin(now / 160) * 1.5);
    if (img) {
      ctx.globalAlpha = blink ? 1 : 0.55;
      ctx.drawImage(img, x - 6, top - 12 + lift);
      ctx.globalAlpha = 1;
    }
    // small "!" badge
    ctx.fillStyle = '#ffd84d';
    ctx.fillRect(x + 7, top - 13 + lift, 3, 6);
    ctx.fillRect(x + 7, top - 5 + lift, 3, 2);
    return;
  }
  if (t.outcome && t.outcome.until > now) {
    if (t.outcome.ok === false) {
      const img = icon('cloud');
      if (img) ctx.drawImage(img, x - 6, top - 12 + (reduced ? 0 : Math.round(Math.sin(now / 300))));
    }
    return;
  }
  if (t.wait) {
    const phase = waitPhase(t.wait.since, now);
    const flip = reduced ? 0 : Math.floor(now / 900) % 2;
    const glass = icon(flip ? 'hourglassB' : 'hourglassA');
    if (glass) ctx.drawImage(glass, x - 4, top - 11);
    if (phase === 'popcorn') {
      const img = icon('popcorn');
      if (img) ctx.drawImage(img, x + (a.flip ? -14 : 6), top + 24 + (reduced ? 0 : Math.floor(now / 400) % 2));
    } else if (phase === 'cobweb' || phase === 'sleep') {
      const img = icon('cobweb');
      if (img) { ctx.drawImage(img, x - 14, top + 2); ctx.drawImage(img, x + 6, top + 8); }
    }
  }
}
