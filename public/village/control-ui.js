// Agent Village — control UI: Fountain of Elixir (real quota), mission composer and mission list.
// Talks only to the local control plane (same origin, 127.0.0.1). Writes carry the per-process token.
// The fountain never resets provider credits: clicking it only asks the server to re-read the sources.

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
function el(tag, attrs = {}, ...children) {
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
  }

  async start() {
    try {
      const r = await fetch('/api/village/state', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      this.token = data.token;
      this.#setState(data);
      this.available = true;
    } catch {
      this.available = false;
      this.dispatchEvent(new CustomEvent('unavailable'));
      return;
    }
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

export function mountControlUi({ client, onFountainState, onRefill }) {
  const $ = (id) => document.getElementById(id);
  const fountainPanel = $('fountain');
  const drawer = $('missions');
  let lastRefill = {};

  // ---------------------------------------------------------------- Fountain of Elixir
  function renderFountain(state) {
    const body = $('fountain-body');
    const res = [];
    for (const p of ['claude-code', 'codex']) {
      const q = state.quotas?.[p] ?? {};
      const level = reservoirLevel(q);
      const plan = q.plan ? ` ${q.plan[0].toUpperCase()}${q.plan.slice(1)}` : '';
      const windows = Object.entries(q.windows ?? {}).map(([k, w]) => el('li', {},
        `${k === 'fiveHour' ? 'Janela de 5 h' : 'Semanal'}: ${Math.round(w.usedPercent)}% usada · reinicia ${fmtTime(w.resetsAt)}`));
      if (!windows.length && q.expired?.length) windows.push(el('li', {}, 'A janela reiniciou; aguardando o provedor informar o novo consumo.'));
      if (!windows.length && !q.expired?.length) windows.push(el('li', {}, p === 'claude-code' ? 'Sem captura do statusline. Rode: npm run village:setup -- statusline install' : 'Sem leitura ainda: use o Codex ou atualize.'));
      const tokens = state.ledger?.byProvider?.[p];
      res.push(el('section', { class: `reservoir state-${(q.state ?? 'UNKNOWN').toLowerCase()}` },
        el('div', { class: 'vial', 'aria-hidden': 'true' }, el('i', { style: `height:${level === null ? 0 : level}%` }), level === null ? el('b', {}, '?') : null),
        el('div', { class: 'meta' },
          el('h3', {}, `${PROVIDER_LABELS[p]}${plan}`),
          el('p', { class: 'big' }, level === null ? 'N/D' : `${Math.round(level)}% livre`, el('span', { class: 'chip' }, STATE_TEXT[q.state] ?? q.state)),
          el('ul', {}, windows),
          el('p', { class: 'small' }, `Fonte: ${q.source ?? '—'} · lida ${ago(q.fetchedAt)}${q.stale ? ' (desatualizada)' : ''}`),
          el('p', { class: 'small' }, `Tokens medidos (histórico): entrada ${fmtInt(tokens?.input)} · saída ${fmtInt(tokens?.output)}`))));
    }
    body.replaceChildren(...res);
    // world: fountain glow follows the remaining quota of the providers that have data
    const levels = ['claude-code', 'codex'].map((p) => reservoirLevel(state.quotas?.[p])).filter((v) => v !== null);
    onFountainState?.({ level: levels.length ? Math.min(...levels) / 100 : null, exhausted: ['claude-code', 'codex'].every((p) => state.quotas?.[p]?.state === 'EXHAUSTED') });
    for (const p of ['claude-code', 'codex']) {
      const r = state.quotas?.[p]?.refilledAt;
      if (r && lastRefill[p] && r !== lastRefill[p]) onRefill?.(p);
      lastRefill[p] = r ?? lastRefill[p] ?? null;
    }
  }

  async function refreshFountain() {
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

  // ---------------------------------------------------------------- composer
  const form = $('composer');
  const cwdInput = $('m-cwd');
  try { cwdInput.value = localStorage.getItem('village.cwd') ?? ''; } catch { /* storage unavailable */ }
  $('open-missions').addEventListener('click', () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden) $('m-prompt').focus(); });
  $('missions-close').addEventListener('click', () => { drawer.hidden = true; });
  let currentDraft = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('preflight');
    out.replaceChildren(el('p', { class: 'small' }, 'Classificando e verificando runtimes (nada é gasto nesta etapa)…'));
    try { localStorage.setItem('village.cwd', cwdInput.value.trim()); } catch { /* ignore */ }
    try {
      currentDraft = await client.post('/api/village/missions', {
        prompt: $('m-prompt').value, cwd: cwdInput.value.trim(), runtime: $('m-runtime').value, mode: form.querySelector('input[name="m-mode"]:checked').value,
        target: $('m-target').value.trim() || null, authorized: $('m-authorized').checked,
      });
      renderPreflight(currentDraft);
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
      ['Runtime escolhido', p.adapter ? `${PROVIDER_LABELS[p.adapter]} (automático)` : 'nenhum elegível'],
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
        : 'Modo só rascunho: a vila não executa nada. Para permitir execução real, feche a vila e inicie no Prompt de Comando com: set VILLAGE_CONTROL=1 && npm run village'));
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

  // ---------------------------------------------------------------- mission list + adapters
  function renderMissions(state) {
    const list = $('mission-list');
    const items = (state.missions ?? []).map((m) => el('li', { class: `mission st-${m.status}` },
      el('div', { class: 'row' }, el('b', {}, m.levelLabel?.split(' —')[0] ?? m.level), el('span', { class: 'chip' }, MISSION_STATUS[m.status] ?? m.status),
        m.gate ? el('span', { class: `chip gate-${m.gate.status.toLowerCase()}` }, `Gate: ${m.gate.status}`) : null,
        m.adapter ? el('span', { class: 'small' }, PROVIDER_LABELS[m.adapter]) : null),
      el('p', {}, m.goal),
      m.usage ? el('p', { class: 'small' }, `Tokens: entrada ${fmtInt(m.usage.input)} · saída ${fmtInt(m.usage.output)}`) : null,
      m.result?.error ? el('p', { class: 'error' }, m.result.error) : null,
      m.status === 'running' ? el('button', { type: 'button', onclick: () => client.post(`/api/village/missions/${m.id}/cancel`).catch(() => {}) }, 'Cancelar') : null));
    list.replaceChildren(...(items.length ? items : [el('li', { class: 'small' }, 'Nenhuma missão ainda.')]));
    const ad = $('adapters');
    ad.replaceChildren(...['claude-code', 'codex'].map((id) => {
      const a = state.adapters?.[id];
      const ok = a?.status === 'connected';
      return el('li', { class: ok ? 'ok' : 'bad' }, el('b', {}, PROVIDER_LABELS[id]), ' ', a ? `${a.version ?? 'versão ?'} · ${a.billing?.reason ?? ''}` : 'verificando…');
    }), el('li', { class: state.rea?.status === 'AVAILABLE' ? 'ok' : 'bad' }, el('b', {}, 'REA'), ' ', state.rea?.status === 'AVAILABLE' ? `disponível ${state.rea.version ?? ''}` : `indisponível — ${state.rea?.reason ?? '…'}`));
    $('control-mode').textContent = state.control ? 'Execução real LIGADA (cada missão exige sua aprovação)' : 'Modo só rascunho (execução desligada)';
  }

  client.addEventListener('state', (e) => {
    renderMissions(e.detail);
    renderFountain(e.detail); // also keeps the world fountain in sync while the panel is closed
  });
  client.addEventListener('unavailable', () => {
    $('open-missions').disabled = true;
    $('open-fountain').title = 'Plano de controle indisponível';
  });

  return { openFountain };
}
