// Agent Village — bootstrap: loads local assets, runs the Life Engine and the Canvas renderer.
// Local only: same-origin fetches (static files, the local control plane and the Ops Room SSE); no model calls.
// Real work reaches the avatars only through projector.js (verified runtime data); idle life stays local.
import { Village, ROLE_LABELS, ROLE_ORDER } from './life-engine.js';
import { Camera, Renderer, hitAgent, hitBuilding } from './renderer.js';
import { WEATHERS, WEATHER_LABELS, ambientAt, effectiveHour, parseHourParam, weatherAt, weatherTint } from './ambience.js';
import { SceneFx } from './effects.js';
import { MissionTracker, SOURCE_LABELS, STATE_LABELS, applyAssignments, attentionClaims, claudeClaims, codexClaims, project, queueAtGatehouse } from './projector.js';
import { ControlClient, accountName, mountControlUi, showPairing } from './control-ui.js';
import { WAIT_LABELS, icon, waitPhase } from './overlays.js';
import { Camps, projectsFrom } from './camps.js';
import { mountSkins } from './skins.js';

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
  RAISE: 'Esperando sua resposta (pedido real)', KICK: 'Jogando bola', FISH: 'Pescando',
};
const FRAME_MS = 1000 / 30; // 30 fps cap keeps the old Intel HD GPU comfortable
const params = new URLSearchParams(location.search);
const debug = params.has('debug');

const $ = (id) => document.getElementById(id);
const canvas = $('world');

const inRect = (r, x, y) => Boolean(r) && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
const shortId = (id) => (String(id).length > 14 ? `${String(id).slice(0, 8)}…${String(id).slice(-4)}` : String(id));

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
  const renderer = new Renderer(canvas, { map, atlases: { ...atlases }, manifest, occluders });
  // Looks (🎨): recoloured copies of the base sheet or an imported atlas with the same frames; this browser only.
  const applySkin = (role, atlas) => { renderer.atlases[role] = atlas; fx?.forgetAtlas?.(role); };
  queueMicrotask(() => mountSkins({ baseImg: atlases.EXPLORER, roles: ROLE_ORDER, cell: manifest.cell, apply: applySkin }).catch((e) => console.warn('[village] skins', e)));
  const ui = { selected: null, selectedBuilding: null, selectedCamp: null, hovered: null, hoveredBuilding: null };
  const camps = new Camps(world);
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
    canvas.classList.toggle('pointer', Boolean(ui.hovered || ui.hoveredBuilding || camps.hit(wx, wy) || inRect(world.fountain?.rect, wx, wy)));
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging');
    if (drag && drag.moved <= 4) {
      const [wx, wy] = camera.toWorld(e.offsetX, e.offsetY);
      const agent = hitAgent(village.snapshot(), wx, wy);
      const camp = agent ? null : camps.hit(wx, wy);
      if (agent) select({ role: agent.role });
      else if (camp) select({ camp: camp.name });
      else if (inRect(world.fountain?.rect, wx, wy) && control) { select({}); control.openFountain(); }
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
  function select({ role = null, building = null, camp = null }) {
    if (role || building || camp) $('fountain').hidden = true;
    ui.selected = role;
    ui.selectedBuilding = building;
    ui.selectedCamp = camp;
    panel.hidden = !role && !building && !camp;
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
        ...(a.fun && (a.fun.games || a.fun.fish) ? row('Diversão (local)', `${a.fun.coins} moedas · ${a.fun.games} partidas · ${a.fun.fish} peixes`) : []),
        ...(a.task ? [
          ...row('Fonte', SOURCE_LABELS[a.task.source] ?? a.task.source ?? '—'),
          ...row('Estado real', STATE_LABELS[a.task.state] ?? a.task.state),
          ...row('Agente', a.task.agentId ? shortId(a.task.agentId) : '—'),
          ...(a.task.account ? row('Conta', a.task.account) : []),
          ...(a.task.needsYou ? row('Precisa de você', 'sim — responda no cartão ✋ ou no terminal') : []),
          ...(a.task.wait ? row('Esperando', `${a.task.waitText ?? a.task.wait.label} (${WAIT_LABELS[a.task.waitPhase] ?? 'aguardando'})`) : []),
          ...row('Missão', a.task.missionId ?? '—'),
          ...row('Tarefa', a.task.label),
        ] : row('Agente real', 'nenhum')),
      );
      $('panel-note').textContent = a.task
        ? 'Estado derivado de evento real (rollout do Codex, transcrição do Claude Code ou missão aprovada). Nenhum conteúdo de prompt é exibido.'
        : 'Vida ociosa simulada localmente. Não representa trabalho real; o avatar fica ACTIVE só quando um agente real ocupa este papel.';
    } else if (ui.selectedCamp) {
      const c = camps.list().find((x) => x.name === ui.selectedCamp);
      if (!c) { select({}); return; }
      $('panel-kicker').textContent = 'Acampamento do projeto';
      $('panel-title').textContent = c.name;
      body.replaceChildren(
        ...row('Situação', c.foldAt ? 'desmontando' : c.lit ? 'luzes acesas (agentes trabalhando)' : 'luzes apagadas (sem atividade agora)'),
        ...row('Agentes ativos', String(c.agents)),
        ...row('Fontes', (c.sources ?? []).join(', ') || '—'),
      );
      $('panel-note').textContent = 'Uma barraca por projeto com sessão real (pasta da sessão). Some sozinha alguns minutos depois que a última sessão termina.';
    } else if (ui.selectedBuilding) {
      const b = world.buildings[ui.selectedBuilding];
      $('panel-kicker').textContent = 'Prédio';
      $('panel-title').textContent = b.label;
      body.replaceChildren(
        ...row('Papel', b.role ? ROLE_LABELS[b.role] : 'Serviço local (sem avatar)'),
        ...row('Função', b.about),
      );
      const active = b.role && village.agent(b.role)?.task;
      if (active) body.append(...row('Agora', active.label));
      $('panel-note').textContent = b.role ? 'O prédio brilha mais quando o papel tem um agente real ativo.' : 'Missões, specs e evidências ficam no Context Vault (~/.agent-village/orchestrator).';
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
      extras: [
        ...camps.drawables(Date.now(), env.amb.night).map((d) => ({ ...d, label: d.camp.name, lit: d.camp.lit })),
        // futebol: the ball (depth-sorted by the ground point under it, with a small shadow)
        ...village.props().map((b) => ({ y: b.ground ?? b.y, draw: (ctx) => {
          ctx.fillStyle = 'rgba(8,10,20,0.35)';
          ctx.fillRect(Math.round(b.x) - 4, Math.round(b.ground ?? b.y) - 1, 9, 3);
          const img = icon('ball');
          if (img) ctx.drawImage(img, Math.round(b.x) - 6, Math.round(b.y) - 12, img.width * 2, img.height * 2);
        } })),
      ],
      reduced: motionBtn.getAttribute('aria-pressed') === 'true', wall: Date.now(),
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
        fx.setElixir(elixir);
      }
      const totalMin = Math.round(env.amb.hour * 60) % 1440;
      const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
      const mm = String(totalMin % 60).padStart(2, '0');
      const live = ROLE_ORDER.filter((r) => village.agent(r)?.task).length;
      $('mode').textContent = `${live ? `ACTIVE · ${live} real` : 'IDLE'} · ${hh}:${mm} ${PHASE_LABELS[env.amb.phase]} · ${WEATHER_LABELS[env.weather.kind]}`;
      if (debug) perf.textContent = `${stats.fps} fps · render ${stats.avgMs.toFixed(2)} ms/quadro · efeitos ${quality} · partículas ${fx.particles.n}`;
      stats.frames = 0; stats.renderMs = 0; stats.since = now;
    }
    if (++panelTick % 10 === 0 && (ui.selected || ui.selectedCamp)) renderPanel();
  }
  document.addEventListener('visibilitychange', () => { last = performance.now(); });

  // ---- real runtime projection (M2) + control plane (Fonte de Elixir, missions) ----
  let elixir = { level: null, exhausted: false };
  const tracker = new MissionTracker();
  const client = new ControlClient();
  let control = null;
  let room = null;
  let claudeSessions = [];
  let attention = [];
  let lastState = null;
  try {
    control = mountControlUi({ client, onFountainState: (st) => { elixir = st; fx.setElixir(st); }, onAttention: (items) => { attention = items; projectTick(); } });
  } catch (error) {
    console.warn('[village] painel de controle indisponível', error);
  }
  client.addEventListener('pair', () => { $('loading').hidden = true; showPairing(); });
  client.addEventListener('village', (e) => {
    tracker.push(e.detail);
    if (e.detail?.type === 'provider.reset_verified') fx.refillBurst();
  });
  let opsRoomStarted = false;
  client.addEventListener('state', (e) => {
    lastState = e.detail;
    tracker.sync(e.detail.running);
    claudeSessions = e.detail.observed?.claude ?? [];
    paintRuntime(e.detail);
    // Codex agents keep coming from the original Ops Room watcher (read-only rollouts; computer only).
    if (!opsRoomStarted && !client.lan) {
      opsRoomStarted = true;
      try {
        const opsRoom = new EventSource('/events');
        opsRoom.addEventListener('snapshot', (ev) => { try { room = JSON.parse(ev.data).room ?? null; } catch { /* ignore malformed */ } });
      } catch { /* EventSource unavailable */ }
    }
  });
  client.addEventListener('unavailable', () => { $('runtime').textContent = 'Runtime: plano de controle indisponível'; });
  client.start();
  function paintRuntime(state) {
    const badge = $('runtime');
    const keys = state.accounts?.length ? state.accounts.map((a) => a.key) : ['claude-code', 'codex'];
    const names = keys.filter((id) => state.adapters?.[id]?.status === 'connected').map((id) => accountName(state, id));
    badge.textContent = `Runtime: ${names.length ? names.join(' + ') : 'nenhum verificado'}${client.lan ? ' · celular' : state.control ? ' · execução ligada' : ' · só rascunho'}`;
    badge.title = keys.map((id) => `${accountName(state, id)}: ${state.adapters?.[id]?.billing?.reason ?? 'verificando'}`).join('\n');
  }
  const BUILDING_OF = Object.fromEntries(Object.entries(world.buildings).filter(([, b]) => b.role).map(([id, b]) => [b.role, id]));
  const celebrated = new Map(); // role -> outcome.until already celebrated (confetti once per real result)
  function projectTick() {
    const now = Date.now();
    const claims = [...tracker.claims(), ...codexClaims(room, now), ...claudeClaims(claudeSessions, now), ...attentionClaims(attention, claudeSessions)];
    const assignments = queueAtGatehouse(project(claims), { keeper: world.attention?.keeper ?? 'RELEASE_GATE', queue: world.attention?.queue ?? [] });
    applyAssignments(village, assignments, ROLE_ORDER);
    camps.update(projectsFrom({ claudeSessions, missions: lastState?.missions ?? [], room }, now), now);
    for (const role of ROLE_ORDER) {
      if (BUILDING_OF[role]) fx.setBuildingActivity(BUILDING_OF[role], assignments.has(role) && !assignments.get(role).needsYou ? 1 : 0);
      const a = village.agent(role);
      const t = a?.task;
      if (!t) continue;
      // Pose from REAL timing: celebrate / rain cloud right after a command, popcorn → arms → cobwebs → nap while it runs.
      if (t.outcome && t.outcome.until > now) {
        t.pose = t.outcome.ok ? 'celebrate' : 'sad';
        if (t.outcome.ok && celebrated.get(role) !== t.outcome.until) { celebrated.set(role, t.outcome.until); fx.confetti(a.x, a.y - 44); }
      } else if (t.wait) {
        const phase = waitPhase(t.wait.since, now);
        t.pose = phase === 'sleep' ? 'sleep' : 'watch';
        const min = Math.floor((now - t.wait.since) / 60_000);
        t.waitText = `${t.wait.label || 'comando'} · ${min < 1 ? 'agora' : `${min} min`}`;
        t.waitPhase = phase;
      } else t.pose = null;
    }
  }
  setInterval(projectTick, 1000);
  $('loading').hidden = true;
  requestAnimationFrame(frame);
  if (debug) window.__village = { camps, get village() { return village; }, get fx() { return fx; }, camera, stats, world, env, tracker, client, projectTick, get attention() { return attention; }, get state() { return lastState; } };
}

boot().catch((error) => {
  const el = $('loading');
  el.textContent = `Não foi possível abrir a vila: ${error.message}`;
  el.classList.add('error');
});
