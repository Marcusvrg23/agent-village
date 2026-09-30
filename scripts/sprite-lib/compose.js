// Runs inside the (offscreen) build page. Composes one station from the official art with Canvas 2D:
// plate = art with the character's region replaced by an authored reconstruction recipe,
// sprites = antialiased clips of the art (plus painted fills for body parts the art never showed),
// occluders = clips of the final room in front of the character. Coordinates are source-image pixels.
/* global window, document */
(() => {
  function bounds(polys, pad) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const poly of polys) for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x: Math.floor(x0) - pad, y: Math.floor(y0) - pad, w: Math.ceil(x1) - Math.floor(x0) + 2 * pad, h: Math.ceil(y1) - Math.floor(y0) + 2 * pad };
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function path(g, poly) { g.beginPath(); poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); }

  let artData = null;
  // 'at:x,y' = 5x5 average of the official art around (x, y); anything else is a CSS color.
  function color(value) {
    if (!value.startsWith('at:')) return value;
    const [x, y] = value.slice(3).split(',').map(Number);
    let r = 0; let g = 0; let b = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const i = ((y + dy) * artData.width + x + dx) * 4; r += artData.data[i]; g += artData.data[i + 1]; b += artData.data[i + 2]; }
    return `rgb(${Math.round(r / 25)}, ${Math.round(g / 25)}, ${Math.round(b / 25)})`;
  }
  function paint(g, fill) {
    if (typeof fill === 'string') return color(fill);
    const [kind, x0, y0, x1, y1, ...stops] = fill;
    if (kind !== 'lin') throw new Error('fill ' + kind);
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), color(c)));
    return grad;
  }

  // Harmonic ("membrane") fill: solve Laplace's equation inside the hole with the real surrounding
  // pixels as boundary, so the fill meets its neighbours seamlessly. Successive over-relaxation.
  function membrane(g, holeMask) {
    const { width: w, height: h } = g.canvas;
    const img = g.getImageData(0, 0, w, h); const d = img.data; const m = holeMask.getContext('2d').getImageData(0, 0, w, h).data;
    const unknown = []; const isUnknown = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (m[i * 4 + 3] > 0) { isUnknown[i] = 1; unknown.push(i); }
    const px = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) px[i * 3 + c] = d[i * 4 + c];
    // Start from the mean of the boundary so convergence is quick.
    const mean = [0, 0, 0]; let n = 0;
    for (const i of unknown) for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < w * h && !isUnknown[j]) { for (let c = 0; c < 3; c++) mean[c] += px[j * 3 + c]; n++; }
    for (const i of unknown) for (let c = 0; c < 3; c++) px[i * 3 + c] = n ? mean[c] / n : 0;
    for (let it = 0; it < 900; it++) {
      for (const i of unknown) {
        const x = i % w;
        for (let c = 0; c < 3; c++) {
          let sum = 0; let k = 0;
          if (x > 0) { sum += px[(i - 1) * 3 + c]; k++; }
          if (x < w - 1) { sum += px[(i + 1) * 3 + c]; k++; }
          if (i >= w) { sum += px[(i - w) * 3 + c]; k++; }
          if (i < w * (h - 1)) { sum += px[(i + w) * 3 + c]; k++; }
          px[i * 3 + c] += 1.9 * (sum / k - px[i * 3 + c]);
        }
      }
    }
    for (const i of unknown) { for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.max(0, Math.min(255, Math.round(px[i * 3 + c]))); d[i * 4 + 3] = 255; }
    g.putImageData(img, 0, 0);
  }

  function runRecipe(g, art, ops, holeMask) {
    for (const op of ops) {
      const [kind, ...a] = op;
      g.save();
      if (kind === 'membrane') { // []: smooth fill of the whole hole from its real surroundings
        membrane(g, holeMask);
      } else if (kind === 'clone') { // [sx, sy, w, h, dx, dy, clipPoly?]
        const [sx, sy, w, h, dx, dy, clip] = a;
        if (clip) { path(g, clip); g.clip(); }
        g.drawImage(art, sx, sy, w, h, dx, dy, w, h);
      } else if (kind === 'poly') { // [points, fill, alpha?]
        const [points, fill, alpha] = a;
        g.globalAlpha = alpha ?? 1; path(g, points); g.fillStyle = paint(g, fill); g.fill();
      } else if (kind === 'line') { // [points, color, width]
        const [points, c, width] = a;
        g.beginPath(); points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.strokeStyle = color(c); g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke();
      } else if (kind === 'tile') { // [sx, sy, w, h, clipPoly]: repeat a clean texture patch over a region
        const [sx, sy, w, h, clip] = a;
        const patch = canvas(w, h); patch.getContext('2d').drawImage(art, sx, sy, w, h, 0, 0, w, h);
        const pattern = g.createPattern(patch, 'repeat');
        pattern.setTransform(new DOMMatrix().translate(sx, sy)); // keep the texture phase aligned with the source
        path(g, clip); g.fillStyle = pattern; g.fill();
      } else if (kind === 'round') { // [x, y, w, h, radius, fill, stroke?, strokeWidth?]
        const [x, y, w, h, r, fill, stroke, width] = a;
        g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = paint(g, fill); g.fill();
        if (stroke) { g.strokeStyle = color(stroke); g.lineWidth = width ?? 1.5; g.stroke(); }
      } else if (kind === 'blur') { // [clipPoly, px]: soften painted edges inside a region
        const [clip, px] = a;
        const copy = canvas(g.canvas.width, g.canvas.height); copy.getContext('2d').drawImage(g.canvas, 0, 0);
        path(g, clip); g.clip();
        g.setTransform(1, 0, 0, 1, 0, 0); g.filter = `blur(${px}px)`; g.drawImage(copy, 0, 0);
      } else throw new Error('op ' + kind);
      g.restore();
    }
  }

  // A retouch may only copy real background: no clone/tile source may touch any painted character.
  function assertCleanSources(role, ops, allSilhouettes) {
    const hit = (x, y, w, h) => {
      const [x0, y0, x1, y1] = [x - 3, y - 3, x + w + 3, y + h + 3];
      return allSilhouettes.some((poly) => poly.some(([px, py]) => px >= x0 && px <= x1 && py >= y0 && py <= y1)
        || Array.from({ length: Math.ceil((y1 - y0) / 2) + 1 }, (_, iy) => y0 + iy * 2)
          .some((yy) => Array.from({ length: Math.ceil((x1 - x0) / 2) + 1 }, (_, ix) => x0 + ix * 2).some((xx) => pointIn(poly, xx, yy))));
    };
    for (const op of ops) {
      if (op[0] !== 'clone' && op[0] !== 'tile') continue;
      const [, sx, sy, w, h] = op;
      if (hit(sx, sy, w, h)) throw new Error(`${role}: ${op[0]} source ${sx},${sy} ${w}x${h} overlaps a character`);
    }
  }
  function pointIn(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  window.silhouettesOf = (stations) => Object.values(stations).flatMap((d) => [d.body, d.head, d.seatLegs].filter(Boolean));

  window.composeStation = (art, def, role = '?', allSilhouettes = []) => {
    assertCleanSources(role, def.plate ?? [], allSilhouettes);
    if (!artData) {
      const c = canvas(art.naturalWidth, art.naturalHeight); const g = c.getContext('2d'); g.drawImage(art, 0, 0);
      artData = g.getImageData(0, 0, c.width, c.height);
    }
    const silhouette = [def.body, ...(def.head ? [def.head] : []), ...(def.seatLegs ? [def.seatLegs] : [])];
    const dil = def.dilate ?? 2;
    const pb = bounds(silhouette, dil + 2);
    // Recipe canvas starts as the art itself so clones and paint land on real context.
    // Hole mask = silhouette grown by `dil` px; only this region of the plate differs from the art.
    const mask = canvas(pb.w, pb.h); const mg = mask.getContext('2d'); mg.translate(-pb.x, -pb.y);
    mg.fillStyle = '#fff'; mg.strokeStyle = '#fff'; mg.lineWidth = dil * 2; mg.lineJoin = 'round';
    for (const poly of silhouette) { path(mg, poly); mg.fill(); mg.stroke(); }
    const recipe = canvas(pb.w, pb.h); const rg = recipe.getContext('2d', { willReadFrequently: true });
    rg.translate(-pb.x, -pb.y); rg.drawImage(art, 0, 0);
    runRecipe(rg, art, def.plate ?? [], mask);
    const plate = canvas(pb.w, pb.h); const pg = plate.getContext('2d');
    pg.drawImage(recipe, 0, 0); pg.globalCompositeOperation = 'destination-in'; pg.drawImage(mask, 0, 0);
    pg.globalCompositeOperation = 'destination-over'; pg.translate(-pb.x, -pb.y); pg.drawImage(art, 0, 0);
    // The empty room as displayed (art + plate), source for occluders.
    const room = canvas(art.naturalWidth, art.naturalHeight); const roomG = room.getContext('2d');
    roomG.drawImage(art, 0, 0); roomG.drawImage(plate, pb.x, pb.y);

    const clipOf = (source, poly, { minus = [], fill = [] } = {}) => {
      const extent = (op) => (op[0] === 'round' ? [[op[1], op[2]], [op[1] + op[3], op[2] + op[4]]] : op[1]);
      const b = bounds([poly, ...fill.map(extent)], 2); const c = canvas(b.w, b.h); const g = c.getContext('2d');
      g.translate(-b.x, -b.y);
      if (fill.length) runRecipe(g, art, fill); // painted parts the artwork never showed (hidden behind a chair)
      g.save(); path(g, poly); g.clip(); g.drawImage(source, 0, 0); g.restore();
      g.globalCompositeOperation = 'destination-out';
      for (const m of minus) { path(g, m); g.fill(); }
      return { rect: b, url: c.toDataURL('image/png') };
    };
    const out = { plate: { rect: pb, url: plate.toDataURL('image/png') } };
    out.body = clipOf(art, def.body, { minus: [def.head, def.seatLegs].filter(Boolean), fill: def.bodyFill ?? [] });
    if (def.head) out.head = clipOf(art, def.head);
    if (def.seatLegs) out.seatlegs = clipOf(art, def.seatLegs);
    for (const [name, poly] of Object.entries(def.occluders ?? {})) out[name] = clipOf(room, poly);
    return out;
  };
})();
