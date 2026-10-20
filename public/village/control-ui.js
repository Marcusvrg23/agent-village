// Agent Village — control UI: Fountain of Elixir (real quota per account), "precisa de você" cards, mission
// composer, mission list and phone pairing. Talks only to the village server (same origin). Writes carry the
// per-process token. The fountain never resets provider credits: clicking it only re-reads the sources.

const PROVIDER_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex' };
const STATE_TEXT = {
  UNKNOWN: 'sem dado', FRESH: 'disponível', LOW: 'baixa', EXHAUSTED: 'esgotada', AWAITING_PROVIDER_RESET: 'aguardando dados novos', STALE: 'desatualizada',
};
const MISSION_STATUS = {
  draft: 'rascunho', running: 'executando', completed: 'concluída', failed: 'falhou', blocked: 'bloqueada', waiting_for_quota: 'aguardando cota',
  queued: 'na fila', interrupted: 'interrompida',
};
const fmtInt = (n) => (n === null || n === undefined ? 'N/D' : new Intl.NumberFormat('pt-BR').format(n));
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const ago = (ms) => {
  if (!ms) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `há ${s}s` : s < 3600 ? `há ${Math.round(s / 60)} min` : `há ${Math.round(s / 3600)} h`;
};
const runtimeOf = (key) => String(key ?? '').split('@')[0];
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v; // CSSOM: allowed by the page CSP (style attributes are not)
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}

export class ControlClient extends EventTarget {
  constructor() {
    super();
    this.state = null;
    this.token = null;
    this.available = false;
    this.lan = false;
  }

  async start() {
    let r;
    try {
      r = await fetch('/api/village/state', { cache: 'no-store' });
    } catch {
      this.dispatchEvent(new CustomEvent('unavailable'));
      return;
    }
    if (r.status === 401) { this.dispatchEvent(new CustomEvent('pair')); return; } // phone not paired yet
    if (!r.ok) { this.dispatchEvent(new CustomEvent('unavailable')); return; }
    const data = await r.json();
    this.token = data.token;
    this.lan = Boolean(data.lan);
    this.#setState(data);
    this.available = true;
    const es = new EventSource('/events/village');
    es.addEventListener('state', (e) => this.#setState(JSON.parse(e.data)));
    es.addEventListener('village', (e) => this.dispatchEvent(new CustomEvent('village', { detail: JSON.parse(e.data) })));
    es.onerror = () => this.dispatchEvent(new CustomEvent('connection', { detail: 'reconnecting' }));
    es.onopen = () => this.dispatchEvent(new CustomEvent('connection', { detail: 'live' }));
  }

  #setState(data) {
    const { token, ...rest } = data;
    this.state = rest;
    this.dispatchEvent(new CustomEvent('state', { detail: rest }));
  }

  async post(path, body = {}) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-village-token': this.token ?? '' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `Erro ${r.status}`);
    return data;
  }
}

/** Tightest window decides the reservoir level (remaining = 100 - used). Null when no data. */
export function reservoirLevel(q) {
  const w = Object.values(q?.windows ?? {});
  if (!w.length) return q?.noQuota ? 0 : null;
  return Math.max(0, 100 - Math.max(...w.map((x) => x.usedPercent)));
}

/** "Claude Code", "Codex · trabalho"… from the account list of the state. */
export function accountName(state, key) {
  const acc = (state?.accounts ?? []).find((a) => a.key === key);
  const base = PROVIDER_LABELS[runtimeOf(key)] ?? key;
  const many = (state?.accounts ?? []).filter((a) => a.runtime === runtimeOf(key)).length > 1;
  return acc && (many || !acc.isDefault) ? `${base} · ${acc.label}` : base;
}

const keysOf = (state) => (state?.accounts?.length ? state.accounts.map((a) => a.key) : ['claude-code', 'codex']);

export function mountControlUi({ client, onFountainState, onRefill, onAttention }) {
  const $ = (id) => document.getElementById(id);
  const fountainPanel = $('fountain');
  const drawer = $('missions');
  const lastRefill = {};

  // ---------------------------------------------------------------- Fountain of Elixir
  function renderFountain(state) {
    const body = $('fountain-body');
    const res = [];
    const keys = keysOf(state);
    for (const p of keys) {
      const q = state.quotas?.[p] ?? {};
      const level = reservoirLevel(q);
      const plan = q.plan ? ` ${q.plan[0].toUpperCase()}${q.plan.slice(1)}` : '';
      const windows = Object.entries(q.windows ?? {}).map(([k, w]) => el('li', {},
        `${k === 'fiveHour' ? 'Janela de 5 h' : 'Semanal'}: ${Math.round(w.usedPercent)}% usada · reinicia ${fmtTime(w.resetsAt)}`));
      if (!windows.length && q.expired?.length) windows.push(el('li', {}, 'A janela reiniciou; aguardando o provedor informar o novo consumo.'));
      if (!windows.length && !q.expired?.length) {
        const tap = state.claudeTap?.[p];
        const msg = runtimeOf(p) !== 'claude-code' ? 'Sem leitura ainda: use o Codex ou atualize.'
          : !tap ? 'O coletor do status line nunca rodou. Rode npm run village:setup -- statusline install --yes e abra o Claude Code no terminal.'
            : !tap.rateLimits ? `O status line está rodando (${ago(tap.seenAt)}), mas o Claude Code ainda não enviou a cota. Ela só vem em contas Pro/Max, depois de uma resposta.`
              : `O status line recebeu a cota ${ago(tap.seenAt)}; clique em Atualizar leitura.`;
        windows.push(el('li', {}, msg));
      }
      const tokens = state.ledger?.byProvider?.[p];
      res.push(el('section', { class: `reservoir state-${(q.state ?? 'UNKNOWN').toLowerCase()}` },
        el('div', { class: 'vial', 'aria-hidden': 'true' }, el('i', { style: `height:${level === null ? 0 : level}%` }), level === null ? el('b', {}, '?') : null),
        el('div', { class: 'meta' },
          el('h3', {}, `${accountName(state, p)}${plan}`),
          el('p', { class: 'big' }, level === null ? 'N/D' : `${Math.round(level)}% livre`, el('span', { class: 'chip' }, STATE_TEXT[q.state] ?? q.state ?? 'sem dado')),
          el('ul', {}, windows),
          el('p', { class: 'small' }, `Fonte: ${q.source ?? '—'} · lida ${ago(q.fetchedAt)}${q.stale ? ' (desatualizada)' : ''}`),
          el('p', { class: 'small' }, `Tokens medidos (histórico): entrada ${fmtInt(tokens?.input)} · saída ${fmtInt(tokens?.output)}`))));
    }
    body.replaceChildren(...res);
    const levels = keys.map((p) => reservoirLevel(state.quotas?.[p])).filter((v) => v !== null);
    onFountainState?.({ level: levels.length ? Math.min(...levels) / 100 : null, exhausted: keys.every((p) => state.quotas?.[p]?.state === 'EXHAUSTED') });
    for (const p of keys) {
      const r = state.quotas?.[p]?.refilledAt;
      if (r && lastRefill[p] && r !== lastRefill[p]) onRefill?.(p);
      lastRefill[p] = r ?? lastRefill[p] ?? null;
    }
  }

  async function refreshFountain() {
    if (client.lan) { $('fountain-note').textContent = 'Pelo celular a fonte só mostra a última leitura do computador.'; return; }
    const btn = $('fountain-refresh');
    btn.disabled = true;
    $('fountain-note').textContent = 'Lendo as fontes locais…';
    try {
      const r = await client.post('/api/village/quota/refresh');
      $('fountain-note').textContent = `${r.notes.join(' ')} Nenhum crédito foi alterado.`;
    } catch (error) {
      $('fountain-note').textContent = `Falha ao atualizar: ${error.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  function openFountain() {
    fountainPanel.hidden = false;
    if (client.state) renderFountain(client.state);
    refreshFountain();
  }
  $('fountain-close').addEventListener('click', () => { fountainPanel.hidden = true; });
  $('fountain-refresh').addEventListener('click', refreshFountain);
  $('open-fountain').addEventListener('click', () => (fountainPanel.hidden ? openFountain() : (fountainPanel.hidden = true)));

  // ---------------------------------------------------------------- "precisa de você"
  const stack = $('attention');
  let attention = [];
  const notifyOn = () => storage.get('village.notify') === '1';
  const bell = $('notify');
  function paintBell() {
    const on = notifyOn();
    bell.setAttribute('aria-pressed', String(on));
    bell.title = on ? 'Avisos ligados (som e notificação quando alguém precisar de você)' : 'Ligar avisos quando alguém precisar de você';
  }
  bell.addEventListener('click', async () => {
    if (notifyOn()) { storage.set('village.notify', '0'); paintBell(); return; }
    try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch { /* not supported */ }
    storage.set('village.notify', '1');
    paintBell();
    chime();
  });
  paintBell();

  let audio = null;
  function chime() {
    try {
      audio ??= new AudioContext();
      const t = audio.currentTime;
      for (const [i, f] of [660, 880].entries()) {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.16);
        g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.16 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.22);
        o.connect(g).connect(audio.destination);
        o.start(t + i * 0.16);
        o.stop(t + i * 0.16 + 0.25);
      }
    } catch { /* audio unavailable */ }
  }

  function announce(item) {
    if (!notifyOn()) return;
    chime();
    try {
      if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        new Notification(`${PROVIDER_LABELS[item.provider] ?? 'Agente'} precisa de você`, { body: item.summary?.title ?? 'Esperando no terminal', tag: item.id });
      }
    } catch { /* notifications unavailable */ }
  }

  async function answer(item, behavior, message = '') {
    try {
      await client.post(`/api/village/attention/${item.id}`, { behavior, message });
      attention = attention.filter((x) => x.id !== item.id);
      renderAttention();
      onAttention?.(attention);
    } catch (error) {
      const card = stack.querySelector(`[data-id="${item.id}"] .error`);
      if (card) card.textContent = error.message;
    }
  }

  function card(item) {
    const who = `${PROVIDER_LABELS[item.provider] ?? 'Agente'}${item.account ? ` · ${item.account}` : ''}`;
    const s = item.summary ?? {};
    const reason = el('input', { type: 'text', placeholder: 'Motivo (opcional)', maxlength: '300', class: 'reason' });
    const actions = el('div', { class: 'actions' });
    if (item.type === 'notice') {
      actions.append(el('button', { type: 'button', onclick: () => answer(item, 'seen') }, 'Ok, vou ao terminal'));
    } else {
      if (item.canAnswer) actions.append(el('button', { type: 'button', class: 'primary', onclick: () => answer(item, 'allow') }, 'Aprovar'));
      actions.append(el('button', { type: 'button', class: 'danger', onclick: () => answer(item, 'deny', reason.value) }, 'Recusar'));
      actions.append(el('button', { type: 'button', onclick: () => answer(item, 'terminal') }, 'Responder no terminal'));
    }
    const left = Math.max(0, Math.round((item.expiresAt - Date.now()) / 1000));
    return el('article', { class: `attention-card kind-${item.type}`, 'data-id': item.id, role: 'alertdialog', 'aria-label': `${who} precisa de você` },
      el('p', { class: 'kicker' }, `✋ ${who} precisa de você${item.project ? ` · ${item.project}` : ''}`),
      el('h3', {}, item.type === 'notice' ? (item.kind === 'permission_prompt' ? 'Pedido de permissão no terminal' : 'Esperando sua próxima instrução no terminal') : `Quer ${s.title ?? 'usar uma ferramenta'}`),
      s.description ? el('p', { class: 'small' }, s.description) : null,
      s.detail ? el('code', { class: 'detail' }, s.detail) : null,
      s.kind === 'question' ? el('ul', { class: 'small' }, (s.questions ?? []).map((q) => el('li', {}, `${q.question} — ${q.options.join(' · ')}`))) : null,
      s.kind === 'question' ? el('p', { class: 'small' }, 'Perguntas são respondidas no terminal; aqui você vê o que está sendo perguntado.') : null,
      item.type === 'permission' ? reason : null,
      actions,
      el('p', { class: 'small' }, item.type === 'permission' ? `Vale o que você responder primeiro (aqui ou no terminal). Expira em ${Math.ceil(left / 60)} min.` : (item.message ?? '')),
      el('p', { class: 'error' }));
  }

  function renderAttention() {
    stack.replaceChildren(...attention.slice(0, 4).map(card), attention.length > 4 ? el('p', { class: 'small more' }, `e mais ${attention.length - 4}`) : '');
    stack.hidden = !attention.length;
    $('open-attention').textContent = attention.length ? `✋ ${attention.length}` : '✋';
    $('open-attention').classList.toggle('alert', attention.length > 0);
  }
  $('open-attention').addEventListener('click', () => { if (attention.length) stack.hidden = !stack.hidden; });

  client.addEventListener('village', (e) => {
    const ev = e.detail;
    if (ev?.type === 'attention.new' && ev.item) {
      if (!attention.some((x) => x.id === ev.item.id)) attention.push(ev.item);
      renderAttention();
      onAttention?.(attention);
      announce(ev.item);
    } else if (ev?.type === 'attention.resolved') {
      attention = attention.filter((x) => x.id !== ev.id);
      renderAttention();
      onAttention?.(attention);
    }
  });

  // ---------------------------------------------------------------- composer
  const form = $('composer');
  const cwdInput = $('m-cwd');
  cwdInput.value = storage.get('village.cwd') ?? '';
  $('open-missions').addEventListener('click', () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden) $('m-prompt').focus(); });
  $('missions-close').addEventListener('click', () => { drawer.hidden = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('preflight');
    out.replaceChildren(el('p', { class: 'small' }, 'Classificando e verificando runtimes (nada é gasto nesta etapa)…'));
    storage.set('village.cwd', cwdInput.value.trim());
    try {
      const m = await client.post('/api/village/missions', {
        prompt: $('m-prompt').value, cwd: cwdInput.value.trim(), runtime: $('m-runtime').value, mode: form.querySelector('input[name="m-mode"]:checked').value,
        target: $('m-target').value.trim() || null, authorized: $('m-authorized').checked,
      });
      renderPreflight(m);
    } catch (error) {
      out.replaceChildren(el('p', { class: 'error' }, error.message));
    }
  });

  function renderPreflight(m) {
    const p = m.preflight ?? {};
    const out = $('preflight');
    const rows = [
      ['Nível SDD', `${m.levelLabel} — ${m.classification.join('; ')}`],
      ['Pipeline', m.pipeline.join(' → ')],
      ['Runtime escolhido', p.adapter ? `${accountName(client.state, p.adapter)} (${m.runtime === 'auto' ? 'automático' : 'escolha manual'})` : 'nenhum elegível'],
      ['Por quê', (p.why ?? []).join(' ')],
      ['Modelo', p.model ?? '—'],
      ['Risco', p.risk],
      ['Gasto de API permitido', `US$ ${Number(p.paidApiSpendAllowedUsd ?? 0).toFixed(2)}`],
      ['Aprovação', p.approval],
    ];
    const dl = el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    const blockers = m.blockers.length ? el('p', { class: 'error' }, m.blockers.join(' ')) : null;
    const notes = m.notes.length ? el('p', { class: 'small' }, m.notes.join(' ')) : null;
    const actions = el('div', { class: 'actions' });
    if (p.canRun) {
      const confirm = m.mode === 'edit' ? el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'm-confirm-edit' }), ' Autorizo editar arquivos nesta pasta') : null;
      actions.append(confirm ?? '', el('button', { type: 'button', class: 'primary', onclick: () => approve(m) }, 'Aprovar e executar'));
    } else {
      actions.append(el('button', { type: 'button', onclick: () => copyPrompt(m) }, 'Copiar prompt para o Claude Code/Codex'));
      actions.append(el('p', { class: 'small' }, client.state?.control
        ? 'Execução indisponível para esta missão (veja os motivos acima).'
        : 'Modo só rascunho: a vila não executa nada. Para permitir execução real, feche a vila e inicie com VILLAGE_CONTROL=1 (veja o README).'));
    }
    out.replaceChildren(dl, blockers ?? '', notes ?? '', actions);
  }

  async function approve(m) {
    const confirmEdit = Boolean(document.getElementById('m-confirm-edit')?.checked);
    try {
      const r = await client.post(`/api/village/missions/${m.id}/approve`, { confirmEdit });
      $('preflight').replaceChildren(el('p', {}, `Missão ${r.id} ${r.status === 'running' ? 'iniciada' : MISSION_STATUS[r.status] ?? r.status}. Acompanhe os avatares na vila; o resultado e o gate aparecem em Missões recentes.`));
    } catch (error) {
      $('preflight').append(el('p', { class: 'error' }, error.message));
    }
  }

  async function copyPrompt(m) {
    const text = m.prompt ?? $('m-prompt').value;
    try { await navigator.clipboard.writeText(text); $('preflight').append(el('p', { class: 'small' }, 'Prompt copiado. Cole no Claude Code ou no Codex; a vila mostra a sessão quando ela aparecer.')); } catch {
      $('preflight').append(el('p', { class: 'small' }, 'Copie manualmente o texto do campo acima.'));
    }
  }

  // ---------------------------------------------------------------- mission list + adapters + runtime choices
  let runtimeOptionsKey = '';
  function renderRuntimeOptions(state) {
    const keys = keysOf(state);
    const sig = keys.join('|');
    if (sig === runtimeOptionsKey) return;
    runtimeOptionsKey = sig;
    const sel = $('m-runtime');
    const cur = sel.value;
    const opts = [el('option', { value: 'auto' }, 'Automático (melhor cota)'), el('option', { value: 'claude-code' }, 'Claude Code (qualquer conta)'), el('option', { value: 'codex' }, 'Codex (qualquer conta)')];
    if (keys.length > 2) for (const k of keys) opts.push(el('option', { value: k }, `Só ${accountName(state, k)}`));
    sel.replaceChildren(...opts);
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  function renderMissions(state) {
    const list = $('mission-list');
    const items = (state.missions ?? []).map((m) => el('li', { class: `mission st-${m.status}` },
      el('div', { class: 'row' }, el('b', {}, m.levelLabel?.split(' —')[0] ?? m.level), el('span', { class: 'chip' }, MISSION_STATUS[m.status] ?? m.status),
        m.gate ? el('span', { class: `chip gate-${m.gate.status.toLowerCase()}` }, `Gate: ${m.gate.status}`) : null,
        m.adapter ? el('span', { class: 'small' }, accountName(state, m.adapter)) : null),
      el('p', {}, m.goal),
      m.usage ? el('p', { class: 'small' }, `Tokens: entrada ${fmtInt(m.usage.input)} · saída ${fmtInt(m.usage.output)}`) : null,
      m.result?.error ? el('p', { class: 'error' }, m.result.error) : null,
      m.status === 'running' && !client.lan ? el('button', { type: 'button', onclick: () => client.post(`/api/village/missions/${m.id}/cancel`).catch(() => {}) }, 'Cancelar') : null));
    list.replaceChildren(...(items.length ? items : [el('li', { class: 'small' }, 'Nenhuma missão ainda.')]));
    const ad = $('adapters');
    ad.replaceChildren(...keysOf(state).map((id) => {
      const a = state.adapters?.[id];
      const ok = a?.status === 'connected';
      return el('li', { class: ok ? 'ok' : 'bad' }, el('b', {}, accountName(state, id)), ' ', a ? `${a.version ?? 'versão ?'} · ${a.billing?.reason ?? a.reasons?.[0] ?? ''}` : 'verificando…');
    }), state.rea ? el('li', { class: state.rea.status === 'AVAILABLE' ? 'ok' : 'bad' }, el('b', {}, 'REA'), ' ', state.rea.status === 'AVAILABLE' ? `disponível ${state.rea.version ?? ''}` : `indisponível — ${state.rea.reason ?? '…'}`) : '');
    $('control-mode').textContent = client.lan ? 'Pelo celular: acompanhar e responder pedidos. Missões só pelo computador.'
      : state.control ? 'Execução real LIGADA (cada missão exige sua aprovação)' : 'Modo só rascunho (execução desligada)';
    renderRuntimeOptions(state);
  }

  client.addEventListener('state', (e) => {
    renderMissions(e.detail);
    renderFountain(e.detail); // also keeps the world fountain in sync while the panel is closed
    attention = e.detail.attention ?? attention;
    renderAttention();
    onAttention?.(attention);
    if (client.lan) document.body.classList.add('phone');
  });
  client.addEventListener('unavailable', () => {
    $('open-missions').disabled = true;
    $('open-fountain').title = 'Plano de controle indisponível';
  });

  // ---------------------------------------------------------------- phone on the local network
  const phonePanel = $('phone');
  async function renderPhone() {
    const body = $('phone-body');
    try {
      const r = await fetch('/api/village/lan', { cache: 'no-store' });
      const d = await r.json();
      if (!d.enabled) {
        body.replaceChildren(
          el('p', {}, 'O acesso pelo celular está desligado.'),
          el('p', { class: 'small' }, 'Para ligar, feche a vila e abra de novo com VILLAGE_LAN=1 (Prompt de Comando: set VILLAGE_LAN=1 && npm run village · macOS/Linux: VILLAGE_LAN=1 npm run village).'),
          el('p', { class: 'small' }, 'O celular só vê a vila e responde pedidos de permissão. Use apenas em rede de confiança (a conexão na rede local não é criptografada).'));
        return;
      }
      body.replaceChildren(
        el('p', {}, 'No celular (mesmo Wi-Fi), abra:'),
        el('ul', { class: 'urls' }, d.urls.length ? d.urls.map((u) => el('li', {}, el('code', {}, u))) : [el('li', { class: 'small' }, 'Nenhum endereço de rede local encontrado.')]),
        el('p', {}, 'e digite o código:'),
        el('p', { class: 'pair-code' }, d.code.replace(/(.{4})/, '$1 ')),
        el('p', { class: 'small' }, `O código muda em ${Math.max(1, Math.round((d.expiresAt - Date.now()) / 60_000))} min e depois de cada pareamento.`),
        el('p', { class: 'small' }, `Celulares conectados: ${d.devices.length}`),
        el('div', { class: 'actions' },
          el('button', { type: 'button', onclick: async () => { await client.post('/api/village/lan/rotate').catch(() => {}); renderPhone(); } }, 'Gerar novo código'),
          el('button', { type: 'button', class: 'danger', onclick: async () => { await client.post('/api/village/lan/revoke').catch(() => {}); renderPhone(); } }, 'Desconectar celulares')),
        el('p', { class: 'small' }, 'Use apenas em rede de confiança: na rede local a conexão não é criptografada.'));
    } catch (error) {
      body.replaceChildren(el('p', { class: 'error' }, error.message));
    }
  }
  $('open-phone').addEventListener('click', () => { phonePanel.hidden = !phonePanel.hidden; if (!phonePanel.hidden) renderPhone(); });
  $('phone-close').addEventListener('click', () => { phonePanel.hidden = true; });

  return { openFountain, attention: () => attention };
}

/** Pairing screen shown on a phone that is not paired yet. */
export function showPairing() {
  const box = document.getElementById('pairing');
  box.hidden = false;
  const form = document.getElementById('pair-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('pair-error');
    out.textContent = '';
    try {
      const r = await fetch('/api/village/lan/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('pair-code').value, label: navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('Android') ? 'Android' : 'celular' }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `Erro ${r.status}`);
      location.reload();
    } catch (error) {
      out.textContent = error.message;
    }
  });
}
