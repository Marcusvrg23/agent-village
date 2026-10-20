// Agent Village — avatar looks ("skins"). Every role atlas was made from ONE base sheet by recolouring the hair
// and jacket zones (scripts/village-art/roles.py); this module does the same in the browser, so any avatar can
// take another role's look, a preset, a custom colour mix, or an imported atlas that follows ART-POLICY.md.
// Choices live only in this browser (localStorage). Nothing is uploaded. Animations and frames never change:
// a skin only changes colours (or swaps the whole atlas for one with the exact same frame layout).

/** Same palettes as scripts/village-art/roles.py: [hue°, saturation ×, value ×] per zone (null = keep). */
export const ROLE_LOOKS = Object.freeze({
  LEAD: { hair: [28, 0.62, 0.72], jacket: [226, 0.85, 0.95] },
  EXPLORER: { hair: null, jacket: null },
  RE_ANALYST: { hair: [230, 0.30, 0.42], jacket: [258, 0.70, 0.95] },
  SPEC_ARCHITECT: { hair: [12, 0.62, 0.55], jacket: [352, 0.72, 0.80] },
  WORKER: { hair: [30, 0.92, 1.05], jacket: [22, 0.72, 0.68] },
  REVIEWER: { hair: [276, 0.70, 0.92], jacket: [290, 0.55, 0.80] },
  QA: { hair: [4, 0.85, 0.98], jacket: [132, 0.78, 0.80] },
  RELEASE_GATE: { hair: [220, 0.10, 1.10], jacket: [218, 0.50, 0.62] },
});

export const EXTRA_LOOKS = Object.freeze({
  neve: { label: 'Neve', hair: [210, 0.08, 1.15], jacket: [200, 0.25, 1.05] },
  floresta: { label: 'Floresta', hair: [26, 0.75, 0.55], jacket: [100, 0.70, 0.62] },
  rubi: { label: 'Rubi', hair: [350, 0.80, 0.70], jacket: [345, 0.85, 0.85] },
  noite: { label: 'Noite', hair: [240, 0.35, 0.35], jacket: [235, 0.55, 0.45] },
  ouro: { label: 'Ouro', hair: [45, 0.85, 1.05], jacket: [40, 0.80, 0.90] },
});

export const SKIN_TONES = Object.freeze({
  original: { label: 'Original', spec: null },
  clara: { label: 'Clara', spec: [24, 0.75, 1.06] },
  media: { label: 'Média', spec: [22, 1.15, 0.90] },
  morena: { label: 'Morena', spec: [20, 1.35, 0.72] },
  escura: { label: 'Escura', spec: [18, 1.40, 0.50] },
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max / 255];
}

export function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Which zone a BASE-sheet pixel belongs to (same thresholds as build_sprites.py, plus skin). */
export function zoneOf(h, s, v) {
  if (h >= 199 && h <= 226 && s > 0.55 && v > 0.33) return 'hair';
  if (h >= 155 && h < 199 && s > 0.5 && v > 0.2) return 'jacket';
  if (h >= 5 && h <= 40 && s >= 0.15 && s <= 0.65 && v >= 0.62) return 'skin';
  return null;
}

/** Recolours RGBA pixels of the base (Explorer) atlas in place. spec = {hair, jacket, skin}. Pure (tested). */
export function recolor(data, spec = {}) {
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    const zone = zoneOf(h, s, v);
    const z = zone && spec[zone];
    if (!z) continue;
    const [nh, smul, vmul] = z;
    const [r, g, b] = hsvToRgb(((nh % 360) + 360) % 360, clamp01(s * smul), clamp01(v * vmul));
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  return data;
}

/** Look spec for a stored choice ({look, hairHue, jacketHue, tone}). */
export function specFor(role, choice = {}) {
  let base;
  if (choice.look === 'custom') {
    base = { hair: [Number(choice.hairHue) || 0, 0.8, 0.9], jacket: [Number(choice.jacketHue) || 0, 0.75, 0.85] };
  } else if (choice.look && EXTRA_LOOKS[choice.look]) base = EXTRA_LOOKS[choice.look];
  else base = ROLE_LOOKS[choice.look] ?? ROLE_LOOKS[role] ?? {};
  return { hair: base.hair ?? null, jacket: base.jacket ?? null, skin: SKIN_TONES[choice.tone]?.spec ?? null };
}

/** Validates an imported atlas against the base layout. Returns a list of problems (empty = ok). Pure. */
export function validateAtlas({ width, height, transparentCorners, bytes }, base, meta = {}) {
  const errors = [];
  if (width !== base.width || height !== base.height) errors.push(`O atlas precisa ter exatamente ${base.width}×${base.height} px (16 quadros de ${base.width / 16}×${base.height}).`);
  if (!transparentCorners) errors.push('O fundo precisa ser transparente.');
  if (bytes > 512 * 1024) errors.push('Arquivo grande demais (máximo 512 KB).');
  if (!meta.accepted) errors.push('Confirme que a arte segue a política de arte (ART-POLICY.md).');
  if (!String(meta.author ?? '').trim()) errors.push('Informe o autor ou a origem da arte.');
  if (!String(meta.license ?? '').trim()) errors.push('Informe a licença ou a permissão de uso.');
  return errors;
}

const KEY = 'village.skins';
export function loadChoices() {
  try { const j = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
export function saveChoices(c) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); return true; } catch { return false; }
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Builds the atlas for a role from the base image and a choice (or the imported image). */
export async function atlasFor(role, choice, baseImg) {
  if (choice?.look === 'imported' && choice.dataUrl) {
    const img = new Image();
    img.src = choice.dataUrl;
    await img.decode();
    return img;
  }
  const c = canvasOf(baseImg.width, baseImg.height);
  const g = c.getContext('2d');
  g.drawImage(baseImg, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  recolor(d.data, specFor(role, choice ?? {}));
  g.putImageData(d, 0, 0);
  return c;
}

const ROLE_NAMES = {
  LEAD: 'Lead', EXPLORER: 'Explorer', RE_ANALYST: 'RE Analyst', SPEC_ARCHITECT: 'Spec Architect', WORKER: 'Worker', REVIEWER: 'Reviewer', QA: 'QA', RELEASE_GATE: 'Release Gate',
};

/**
 * Mounts the 🎨 panel. `apply(role, atlas)` swaps the atlas used by the renderer. `cell` = [w, h] of a frame.
 */
export function mountSkins({ baseImg, roles, cell, apply }) {
  const panel = document.getElementById('skins');
  const body = document.getElementById('skins-body');
  let choices = loadChoices();
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  };

  async function applyRole(role) {
    const atlas = await atlasFor(role, choices[role], baseImg).catch(() => null);
    if (atlas) apply(role, atlas);
    return atlas;
  }

  function preview(atlas) {
    const c = el('canvas', { width: String(cell[0]), height: String(cell[1]), 'aria-hidden': 'true' });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(atlas, 8 * cell[0], 0, cell[0], cell[1], 0, 0, cell[0], cell[1]); // idle frame
    return c;
  }

  async function card(role) {
    const ch = choices[role] ?? {};
    const atlas = await atlasFor(role, ch, baseImg).catch(() => baseImg);
    const look = el('select', { 'aria-label': `Visual do ${ROLE_NAMES[role]}` },
      el('option', { value: '' }, 'Padrão do papel'),
      ...roles.filter((r) => r !== role).map((r) => el('option', { value: r }, `Visual do ${ROLE_NAMES[r]}`)),
      ...Object.entries(EXTRA_LOOKS).map(([k, v]) => el('option', { value: k }, v.label)),
      el('option', { value: 'custom' }, 'Personalizado'),
      ch.look === 'imported' ? el('option', { value: 'imported' }, `Importado (${ch.author ?? 'arte própria'})`) : null);
    look.value = ch.look ?? '';
    const tone = el('select', { 'aria-label': 'Tom de pele' }, ...Object.entries(SKIN_TONES).map(([k, v]) => el('option', { value: k }, `Pele: ${v.label}`)));
    tone.value = ch.tone ?? 'original';
    const hair = el('input', { type: 'range', min: '0', max: '359', value: String(ch.hairHue ?? 30), 'aria-label': 'Cor do cabelo' });
    const jacket = el('input', { type: 'range', min: '0', max: '359', value: String(ch.jacketHue ?? 210), 'aria-label': 'Cor da roupa' });
    const custom = el('div', { class: 'custom' }, el('label', {}, 'Cabelo', hair), el('label', {}, 'Roupa', jacket));
    custom.hidden = look.value !== 'custom';
    const update = async () => {
      const next = { ...(choices[role] ?? {}), look: look.value || undefined, tone: tone.value === 'original' ? undefined : tone.value, hairHue: Number(hair.value), jacketHue: Number(jacket.value) };
      if (next.look !== 'imported') { delete next.dataUrl; delete next.author; delete next.license; }
      choices[role] = next;
      saveChoices(choices);
      custom.hidden = look.value !== 'custom';
      const a = await applyRole(role);
      if (a) wrap.querySelector('canvas').replaceWith(preview(a));
    };
    for (const n of [look, tone]) n.addEventListener('change', update);
    for (const n of [hair, jacket]) n.addEventListener('input', update);
    const wrap = el('div', { class: 'skin-card' }, preview(atlas), el('b', {}, ROLE_NAMES[role]), look, tone, custom,
      el('button', { type: 'button', onclick: () => importFor(role) }, 'Importar atlas…'));
    return wrap;
  }

  function importFor(role) {
    const box = el('form', { class: 'import' });
    const file = el('input', { type: 'file', accept: 'image/png', required: true });
    const author = el('input', { type: 'text', placeholder: 'Autor ou origem da arte', maxlength: '80', required: true });
    const license = el('input', { type: 'text', placeholder: 'Licença ou permissão (ex.: arte própria, CC BY 4.0)', maxlength: '80', required: true });
    const accept = el('input', { type: 'checkbox' });
    const out = el('p', { class: 'error' });
    box.append(el('p', {}, `Importar visual para ${ROLE_NAMES[role]}`),
      el('p', { class: 'small' }, `PNG com fundo transparente, ${baseImg.width}×${baseImg.height} px: os mesmos 16 quadros, na mesma ordem, do atlas original (veja ART-POLICY.md). Fica só neste navegador.`),
      file, author, license,
      el('label', { class: 'check' }, accept, ' A arte é minha ou tenho permissão; não usa personagens, marcas ou pessoas reais de terceiros; segue a política de arte.'),
      el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'primary' }, 'Usar este visual'), el('button', { type: 'button', onclick: () => render() }, 'Cancelar')), out);
    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = file.files?.[0];
      if (!f) return;
      const dataUrl = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
      const img = new Image();
      img.src = dataUrl;
      try { await img.decode(); } catch { out.textContent = 'Não foi possível ler a imagem.'; return; }
      const c = canvasOf(img.width, img.height);
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const corner = (x, y) => g.getImageData(x, y, 1, 1).data[3] === 0;
      const errors = validateAtlas({ width: img.width, height: img.height, bytes: f.size, transparentCorners: corner(0, 0) && corner(img.width - 1, 0) && corner(0, img.height - 1) },
        baseImg, { accepted: accept.checked, author: author.value, license: license.value });
      if (errors.length) { out.textContent = errors.join(' '); return; }
      choices[role] = { look: 'imported', dataUrl, author: author.value.trim(), license: license.value.trim(), importedAt: new Date().toISOString() };
      if (!saveChoices(choices)) { out.textContent = 'O navegador não deixou guardar a imagem (espaço cheio ou modo privado).'; return; }
      await applyRole(role);
      render();
    });
    body.replaceChildren(box);
  }

  async function render() {
    const cards = await Promise.all(roles.map(card));
    body.replaceChildren(
      el('p', { class: 'small' }, 'Troque só a aparência: animações, papéis e o que cada avatar representa continuam iguais. As escolhas ficam neste navegador.'),
      el('div', { class: 'skin-grid' }, cards),
      el('div', { class: 'actions' }, el('button', { type: 'button', onclick: async () => { choices = {}; saveChoices(choices); for (const r of roles) await applyRole(r); render(); } }, 'Voltar ao visual original')),
      el('p', { class: 'small' }, 'Arte importada precisa seguir a política de arte: original ou licenciada, sem personagens, marcas ou pessoas reais de terceiros, sem conteúdo sexual, de ódio ou violento.'));
  }

  document.getElementById('open-skins').addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) render(); });
  document.getElementById('skins-close').addEventListener('click', () => { panel.hidden = true; });
  // Apply saved looks at start (only roles that have a choice).
  return Promise.all(roles.filter((r) => choices[r]).map(applyRole));
}
