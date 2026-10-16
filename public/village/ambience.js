// Agent Village — ambience (pure): time of day -> light, deterministic local weather, flicker curves.
// No DOM, no network, no model calls. Weather is decorative local simulation, never real data.
// Technique inspired by Habblaud's daylight model (MIT), re-tuned for this map: the art is painted at
// golden hour, so "day" keeps the painting neutral and the cycle mostly adds dusk warmth and night.

export const PHASES = Object.freeze(['madrugada', 'amanhecer', 'dia', 'entardecer', 'noite']);
export const WEATHERS = Object.freeze(['limpo', 'nublado', 'chuva', 'neblina']);
export const WEATHER_LABELS = Object.freeze({ limpo: 'Céu limpo', nublado: 'Nublado', chuva: 'Chuva', neblina: 'Neblina' });
export const FIXED_DAY_HOUR = 13.5;
export const FIXED_NIGHT_HOUR = 22;
const WHITE = [255, 255, 255];

// [hour, night 0..1, warm 0..1, multiply tint]
const KEYS = [
  [0, 1, 0, [64, 76, 138]],
  [4.5, 1, 0, [66, 78, 140]],
  [5.4, 0.8, 0.3, [110, 104, 160]],
  [6.2, 0.4, 0.9, [214, 168, 170]],
  [7.2, 0.05, 0.4, [255, 232, 214]],
  [8, 0, 0, WHITE],
  [16.5, 0, 0, WHITE],
  [17.4, 0.05, 0.6, [255, 226, 196]],
  [18.2, 0.3, 1, [236, 176, 160]],
  [18.9, 0.62, 0.6, [150, 126, 170]],
  [19.6, 0.88, 0.2, [92, 96, 156]],
  [20.3, 1, 0, [70, 82, 146]],
  [24, 1, 0, [64, 76, 138]],
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const wrapHour = (h) => (Number.isFinite(h) ? ((h % 24) + 24) % 24 : 0);
export const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * clamp(t, 0, 1)));

export function phaseOf(hour) {
  const h = wrapHour(hour);
  if (h < 5) return 'madrugada';
  if (h < 7) return 'amanhecer';
  if (h < 17) return 'dia';
  if (h < 19.5) return 'entardecer';
  return 'noite';
}

export function ambientAt(hour) {
  const h = wrapHour(hour);
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] <= h) i++;
  const [h0, n0, w0, c0] = KEYS[i];
  const [h1, n1, w1, c1] = KEYS[i + 1];
  const u = (h - h0) / Math.max(1e-6, h1 - h0);
  return { hour: h, phase: phaseOf(h), night: n0 + (n1 - n0) * u, warm: w0 + (w1 - w0) * u, tint: mix(c0, c1, u) };
}

export function isNeutral(amb) {
  return amb.night < 0.01 && amb.tint.every((c) => c >= 254);
}

// Weather darkens and desaturates the tint a little (rain/fog), proportional to its intensity.
export function weatherTint(amb, weather) {
  const k = weather.intensity;
  if (weather.kind === 'chuva') return { ...amb, tint: mix(amb.tint, mix(amb.tint, [150, 160, 182], 1), 0.55 * k) };
  if (weather.kind === 'neblina') return { ...amb, tint: mix(amb.tint, [214, 218, 228], 0.35 * k) };
  if (weather.kind === 'nublado') return { ...amb, tint: mix(amb.tint, [200, 204, 218], 0.4 * k) };
  return amb;
}

/** Effective hour: forced override (URL ?hora=) > fixed mode > local clock. */
export function effectiveHour(mode, override, date) {
  if (override !== null && override !== undefined && Number.isFinite(override)) return wrapHour(override);
  if (mode === 'dia') return FIXED_DAY_HOUR;
  if (mode === 'noite') return FIXED_NIGHT_HOUR;
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/** Parses ?hora=21:30, 21h30, 21h, 21 -> fractional hour, or null. */
export function parseHourParam(search) {
  if (!search) return null;
  let raw;
  try { raw = new URLSearchParams(search).get('hora'); } catch { return null; }
  if (raw === null) return null;
  const m = /^\s*(\d{1,2})(?:\s*[:h]\s*(\d{2})?)?\s*$/i.exec(raw);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] === undefined ? 0 : Number(m[2]);
  if (hh > 24 || mm > 59 || (hh === 24 && mm > 0)) return null;
  return wrapHour(hh + mm / 60);
}

// ---- deterministic weather schedule ----
function hash32(n) {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
export const WEATHER_SEGMENT_MS = 4 * 60_000;
export const WEATHER_FADE_MS = 25_000;
const WEIGHTS = [['limpo', 0.5], ['nublado', 0.22], ['chuva', 0.14], ['neblina', 0.14]];

export function weatherKindForSegment(segment, seed = 0) {
  let r = hash32(segment * 7919 + seed * 104729);
  for (const [kind, w] of WEIGHTS) { if ((r -= w) < 0) return kind; }
  return 'limpo';
}

/**
 * Weather at wall-clock `ms`. `forced` (a WEATHERS value) fixes it; otherwise a seeded schedule of
 * 4-minute segments with 25 s cross-fades. Returns {kind, intensity 0..1, next}.
 */
export function weatherAt(ms, { seed = 0, forced = null } = {}) {
  if (forced && WEATHERS.includes(forced)) return { kind: forced, intensity: 1, forced: true };
  const seg = Math.floor(ms / WEATHER_SEGMENT_MS);
  const into = ms - seg * WEATHER_SEGMENT_MS;
  const kind = weatherKindForSegment(seg, seed);
  const prev = weatherKindForSegment(seg - 1, seed);
  const next = weatherKindForSegment(seg + 1, seed);
  let intensity = 1;
  if (prev !== kind && into < WEATHER_FADE_MS) intensity = into / WEATHER_FADE_MS;
  const left = WEATHER_SEGMENT_MS - into;
  if (next !== kind && left < WEATHER_FADE_MS) intensity = Math.min(intensity, left / WEATHER_FADE_MS);
  return { kind, intensity: kind === 'limpo' ? 1 : clamp(intensity, 0, 1), forced: false };
}

// ---- lights ----
// Colour, halo radius (world px) and whether the light also glows a little in daylight.
export const LIGHT_KINDS = Object.freeze({
  lamp: { color: [255, 214, 150], radius: 34, day: 0, flicker: 0.06 },
  window: { color: [255, 226, 176], radius: 22, day: 0, flicker: 0.02 },
  fire: { color: [255, 150, 70], radius: 62, day: 0.35, flicker: 0.22 },
  'crystal-blue': { color: [120, 190, 255], radius: 70, day: 0.35, flicker: 0 },
  'crystal-violet': { color: [190, 150, 255], radius: 58, day: 0.3, flicker: 0 },
  'crystal-purple': { color: [200, 130, 255], radius: 52, day: 0.3, flicker: 0 },
  'flask-green': { color: [140, 255, 150], radius: 34, day: 0.25, flicker: 0.05 },
  'screen-cyan': { color: [140, 230, 255], radius: 22, day: 0.15, flicker: 0.04 },
});

/** Deterministic flicker in [1-amount, 1] (sum of incommensurate sines; seed per light). */
export function flicker(t, seed, amount) {
  if (!amount) return 1;
  const s = seed * 1.618;
  const n = Math.sin(t / 97 + s) * 0.5 + Math.sin(t / 211 + s * 2.3) * 0.3 + Math.sin(t / 53 + s * 0.7) * 0.2;
  return 1 - amount * (0.5 + 0.5 * n);
}

/** Slow pulse 0..1 for crystals (period ms). */
export function pulse(t, period, seed = 0) {
  return 0.5 + 0.5 * Math.sin((t / period) * Math.PI * 2 + seed);
}

/** How strongly a light shows: full at night, `day` share in daylight. */
export function lightStrength(kind, night) {
  const spec = LIGHT_KINDS[kind];
  if (!spec) return 0;
  const k = clamp((night - 0.08) / 0.55, 0, 1);
  return clamp(spec.day + (1 - spec.day) * k, 0, 1);
}

/** Cache key for the light map: rebuilt only when this changes (quantized). */
export function lightKey(amb) {
  return `${Math.round(amb.night * 60)}|${amb.tint.join(',')}`;
}
