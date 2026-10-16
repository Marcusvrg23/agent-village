// Agent Village — bootstrap: loads local assets, runs the Life Engine and the Canvas renderer.
// Local only: same-origin fetches of static files; no model or external network calls.
import { Village, ROLE_LABELS } from './life-engine.js';
import { Camera, Renderer, hitAgent, hitBuilding } from './renderer.js';
import { WEATHERS, WEATHER_LABELS, ambientAt, effectiveHour, parseHourParam, weatherAt, weatherTint } from './ambience.js';
import { SceneFx } from './effects.js';

const TIME_MODES = ['auto', 'dia', 'noite'];
const TIME_ICONS = { auto: '⟳', dia: '☀', noite: '☾' };
const TIME_TITLES = { auto: 'Ciclo do dia: pela hora local', dia: 'Ciclo do dia: sempre dia', noite: 'Ciclo do dia: sempre noite' };
const WEATHER_MODES = ['auto', ...WEATHERS];
const WEATHER_ICONS = { auto: '⛅', limpo: '☼', nublado: '☁', chuva: '☂', neblina: '≋' };
const PHASE_LABELS = { madrugada: 'madrugada', amanhecer: 'amanhecer', dia: 'dia', entardecer: 'entardecer', noite: 'noite' };

// Smoothly approach the target ambience (mode switches fade instead of jumping).
function approach(cur, target, k) {
  if (!cur || k >= 1) return target;
  const lerp = (a, b) => a + (b - a) * k;
  return { ...target, night: lerp(cur.night, target.night), warm: lerp(cur.warm, target.warm), tint: cur.tint.map((c, i) => Math.round(lerp(c, target.tint[i]))) };
}

const ACTIVITY_LABELS = {
  IDLE: 'Parado', WALK: 'Passeando', LOOK_AROUND: 'Observando a vila', TYPE: 'Mexendo no laptop',
  READ: 'Lendo', TALK: 'Conversando', REST: 'Descansando', CELEBRATE: 'Comemorando à toa', WORK: 'Trabalhando (tarefa real)',
};
const FRAME_MS = 1000 / 30; // 30 fps cap keeps the old Intel HD GPU comfortable
const params = new URLSearchParams(location.search);
const debug = params.has('debug');

const $ = (id) => document.getElementById(id);
const canvas = $('world');

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
    img.src = src;
  });
}

async function boot() {
  const [world, manifest, fxData] = await Promise.all([
    fetch('world.json').then((r) => r.json()),
    fetch('assets/sprites/manifest.json').then((r) => r.json()),
    fetch('fx.json').then((r) => r.json()),
  ]);
  const map = await loadImage('assets/map.png');
  const atlases = Object.fromEntries(await Promise.all(Object.entries(manifest.roles).map(async ([role, src]) => [role, await loadImage(src)])));
  const occluders = await Promise.all(world.occluders.map(async (o) => ({ ...o, img: await loadImage(o.image) })));
  const skyMask = await loadImage('assets/sky-mask.png');

  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let village = new Village(world, { seed: Number(params.get('seed')) || 20261016, reducedMotion: reduceQuery.matches });
  const camera = new Camera(world.size[0], world.size[1]);
  const renderer = new Renderer(canvas, { map, atlases, manifest, occluders });
  const ui = { selected: null, selectedBuilding: null, hovered: null, hoveredBuilding: null };
  // ---- ambience: time of day + decorative local weather ----
  const hourOverride = parseHourParam(location.search);
  let quality = params.get('qualidade') === 'baixa' ? 'baixa' : 'alta';
  const effectsOff = params.get('efeitos') === 'off';
  let fx = new SceneFx(world, fxData, { quality, reducedMotion: reduceQuery.matches, map, skyMask });
  const forcedWeather = params.get('clima');
  const env = {
    timeMode: 'auto',
    weatherMode: WEATHERS.includes(forcedWeather) ? forcedWeather : 'auto',
    amb: null,
    weather: { kind: 'limpo', intensity: 1 },
  };
  const timeBtn = $('time');
  const weatherBtn = $('weather');
  function paintEnvButtons() {
    timeBtn.textContent = hourOverride !== null ? '⏲' : TIME_ICONS[env.timeMode];
    timeBtn.title = hourOverride !== null ? 'Hora fixada pela URL (?hora=)' : TIME_TITLES[env.timeMode];
    weatherBtn.textContent = WEATHER_ICONS[env.weatherMode];
    weatherBtn.title = env.weatherMode === 'auto' ? 'Clima: automático (simulação local)' : `Clima: ${WEATHER_LABELS[env.weatherMode]} (fixo)`;
  }
  timeBtn.addEventListener('click', () => { env.timeMode = TIME_MODES[(TIME_MODES.indexOf(env.timeMode) + 1) % TIME_MODES.length]; paintEnvButtons(); });
  weatherBtn.addEventListener('click', () => { env.weatherMode = WEATHER_MODES[(WEATHER_MODES.indexOf(env.weatherMode) + 1) % WEATHER_MODES.length]; paintEnvButtons(); });
  paintEnvButtons();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);
    camera.fit(canvas.clientWidth, canvas.clientHeight);
  }
  resize();
  window.addEventListener('resize', resize);

  // ---- input: pan (drag), zoom (wheel / buttons / keys), select (click) ----
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4) {
        canvas.classList.add('dragging');
        camera.pan(dx, dy, renderer.viewW, renderer.viewH);
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    const [wx, wy] = camera.toWorld(e.offsetX, e.offsetY);
    const agent = hitAgent(village.snapshot(), wx, wy);
    ui.hovered = agent?.role ?? null;
    ui.hoveredBuilding = agent ? null : hitBuilding(world.buildings, wx, wy);
    canvas.classList.toggle('pointer', Boolean(ui.hovered || ui.hoveredBuilding));
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging');
    if (drag && drag.moved <= 4) {
      const [wx, wy] = camera.toWorld(e.offsetX, e.offsetY);
      const agent = hitAgent(village.snapshot(), wx, wy);
      if (agent) select({ role: agent.role });
      else {
        const b = hitBuilding(world.buildings, wx, wy);
        select(b ? { building: b } : {});
      }
    }
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.offsetX, e.offsetY, renderer.viewW, renderer.viewH);
  }, { passive: false });
  const zoomCenter = (f) => camera.zoomAt(f, renderer.viewW / 2, renderer.viewH / 2, renderer.viewW, renderer.viewH);
  $('zoom-in').addEventListener('click', () => zoomCenter(1.25));
  $('zoom-out').addEventListener('click', () => zoomCenter(1 / 1.25));
  $('zoom-fit').addEventListener('click', () => camera.fit(renderer.viewW, renderer.viewH));
  window.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') zoomCenter(1.25);
    else if (e.key === '-') zoomCenter(1 / 1.25);
    else if (e.key === '0') camera.fit(renderer.viewW, renderer.viewH);
    else if (e.key === 'Escape') select({});
  });

  const motionBtn = $('motion');
  const setReduced = (on) => {
    motionBtn.setAttribute('aria-pressed', String(on));
    village = new Village(world, { seed: 20261016, reducedMotion: on });
    fx.setReducedMotion(on);
  };
  motionBtn.addEventListener('click', () => setReduced(motionBtn.getAttribute('aria-pressed') !== 'true'));
  if (reduceQuery.matches) motionBtn.setAttribute('aria-pressed', 'true');
  reduceQuery.addEventListener?.('change', (e) => setReduced(e.matches));

  // ---- side panel ----
  const panel = $('panel');
  $('panel-close').addEventListener('click', () => select({}));
  function select({ role = null, building = null }) {
    ui.selected = role;
    ui.selectedBuilding = building;
    panel.hidden = !role && !building;
    renderPanel();
  }
  function row(dt, dd) {
    const t = document.createElement('dt'); t.textContent = dt;
    const d = document.createElement('dd'); d.textContent = dd;
    return [t, d];
  }
  function renderPanel() {
    const body = $('panel-body');
    if (ui.selected) {
      const a = village.snapshot().find((s) => s.role === ui.selected);
      if (!a) return;
      $('panel-kicker').textContent = 'Avatar';
      $('panel-title').textContent = ROLE_LABELS[a.role];
      body.replaceChildren(
        ...row('Prédio', world.buildings[a.building].label),
        ...row('Presença', a.presence === 'verified' ? 'ACTIVE (agente real verificado)' : 'STANDBY'),
        ...row('Atividade', ACTIVITY_LABELS[a.activity] ?? a.activity),
        ...row('Agente real', a.task ? a.task.label : 'nenhum'),
      );
      $('panel-note').textContent = a.task
        ? 'Estado derivado de evento real do runtime.'
        : 'Vida ociosa simulada localmente. Não representa trabalho do Codex; eventos reais entram no M2.';
    } else if (ui.selectedBuilding) {
      const b = world.buildings[ui.selectedBuilding];
      $('panel-kicker').textContent = 'Prédio';
      $('panel-title').textContent = b.label;
      body.replaceChildren(
        ...row('Papel', b.role ? ROLE_LABELS[b.role] : 'Serviço local (sem avatar)'),
        ...row('Função', b.about),
      );
      $('panel-note').textContent = 'Fases, specs e evidências aparecem aqui quando o Orchestrator estiver ligado (M3).';
    }
  }

  // ---- loop: fixed 30 fps cap; paused while the tab is hidden ----
  const perf = $('perf');
  if (debug) perf.hidden = false;
  const stats = { frames: 0, renderMs: 0, fps: 0, since: performance.now() };
  let last = performance.now();
  let lastFrame = 0;
  let panelTick = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - lastFrame < FRAME_MS - 1) return;
    lastFrame = now;
    const dt = Math.min(250, now - last);
    village.step(now - last);
    last = now;
    // ambience (cheap pure math every frame; the light map itself is cached by key)
    const hour = effectiveHour(env.timeMode, hourOverride, new Date());
    env.weather = weatherAt(Date.now(), { forced: env.weatherMode === 'auto' ? null : env.weatherMode });
    env.amb = approach(env.amb, weatherTint(ambientAt(hour), env.weather), (dt / 1200) * 3);
    if (panelTick % 30 === 0) village.setEnvironment({ night: env.amb.night, rain: env.weather.kind === 'chuva' ? env.weather.intensity : 0 });
    const view = { x0: camera.x, y0: camera.y, x1: camera.x + renderer.viewW / camera.scale, y1: camera.y + renderer.viewH / camera.scale };
    const t0 = performance.now();
    if (!effectsOff) fx.update(dt, now, env.amb, env.weather, view);
    renderer.draw(camera, village.snapshot(), {
      selected: ui.selected, hovered: ui.hovered, hoveredBuilding: ui.hoveredBuilding, buildings: world.buildings,
      fx: effectsOff ? null : fx, ambient: env.amb, weather: env.weather, now,
    });
    stats.renderMs += performance.now() - t0;
    stats.frames += 1;
    if (now - stats.since >= 1000) {
      stats.fps = Math.round((stats.frames * 1000) / (now - stats.since));
      stats.avgMs = stats.renderMs / stats.frames;
      // Auto-degrade on slow machines: three seconds in a row under 24 fps (tab visible) switch the effects
      // to low quality (fewer particles and water glints). The village itself and its animations are unchanged.
      stats.slow = stats.fps < 24 && document.visibilityState === 'visible' ? (stats.slow ?? 0) + 1 : 0;
      if (stats.slow >= 3 && quality === 'alta') {
        quality = 'baixa';
        fx = new SceneFx(world, fxData, { quality, reducedMotion: motionBtn.getAttribute('aria-pressed') === 'true', map, skyMask });
      }
      const totalMin = Math.round(env.amb.hour * 60) % 1440;
      const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
      const mm = String(totalMin % 60).padStart(2, '0');
      $('mode').textContent = `IDLE · ${hh}:${mm} ${PHASE_LABELS[env.amb.phase]} · ${WEATHER_LABELS[env.weather.kind]}`;
      if (debug) perf.textContent = `${stats.fps} fps · render ${stats.avgMs.toFixed(2)} ms/quadro · efeitos ${quality} · partículas ${fx.particles.n}`;
      stats.frames = 0; stats.renderMs = 0; stats.since = now;
    }
    if (++panelTick % 10 === 0 && ui.selected) renderPanel();
  }
  document.addEventListener('visibilitychange', () => { last = performance.now(); });
  $('loading').hidden = true;
  requestAnimationFrame(frame);
  if (debug) window.__village = { get village() { return village; }, get fx() { return fx; }, camera, stats, world, env };
}

boot().catch((error) => {
  const el = $('loading');
  el.textContent = `Não foi possível abrir a vila: ${error.message}`;
  el.classList.add('error');
});
