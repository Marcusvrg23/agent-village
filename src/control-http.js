// HTTP control plane for the Agent Village (main port bound to 127.0.0.1 by server.js).
// Read endpoints are always on; write endpoints exist but real execution only happens when the server was
// was not started with VILLAGE_CONTROL=0 (nor in Docker) AND the operator approves each mission in the page.
// Edge protections (pattern learned from Habblaud's guard, MIT): loopback Host only (DNS rebinding),
// POST requires application/json + same-origin Origin + per-process CSRF token, small bodies only.
// Hooks (Claude Code / Codex PermissionRequest and Notification) authenticate with a separate secret kept in
// ~/.agent-village/hook.json (mode 600). Requests from the optional LAN port (phone) need a paired cookie and
// can only read the village and answer "precisa de você" requests.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { COOKIE, SESSION_TTL_MS, lanAddresses } from './lan.js';

const BODY_MAX = 64 * 1024;

export function hostnameOf(value) {
  if (!value) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end > 0 ? v.slice(1, end) : undefined;
  }
  const m = /^([a-z0-9._-]+)(?::\d{1,5})?$/.exec(v);
  return m ? m[1].replace(/\.$/, '') : undefined;
}

export function isLoopbackHost(host) {
  const name = hostnameOf(host);
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return true;
  return isIP(name) === 4 && name.startsWith('127.');
}

function sameOrigin(origin, host) {
  if (!origin) return true; // same-origin fetches may omit it; the token still protects
  try {
    const u = new URL(origin);
    return isLoopbackHost(u.host) && hostnameOf(u.host) === hostnameOf(host) && (u.port || '80') === ((host.split(':')[1]) || '80');
  } catch {
    return false;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readJson(req, max = BODY_MAX) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('Corpo grande demais.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function createControlPlane(orchestrator, { token = randomBytes(24).toString('hex'), desk = null, hookToken = null, lan = null, lanPort = null } = {}) {
  const clients = new Set(); // {res, lan}
  const tokenBuf = Buffer.from(token);
  const hookBuf = hookToken ? Buffer.from(hookToken) : null;
  const broadcast = (event, data) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.res.write(line);
  };
  const fullState = () => ({ ...orchestrator.state(), attention: desk ? desk.list() : [] });
  /** What a paired phone may see: the village, quotas and the requests waiting for an answer. */
  const lanState = () => {
    const s = fullState();
    return { control: s.control, policy: s.policy, accounts: s.accounts, quotas: s.quotas, adapters: s.adapters, running: s.running, observed: s.observed,
      attention: s.attention, missions: s.missions.map((m) => ({ id: m.id, goal: m.goal, status: m.status, level: m.level, levelLabel: m.levelLabel, adapter: m.adapter, gate: m.gate, usage: m.usage })),
      lan: true };
  };
  orchestrator.on('village', (event) => broadcast('village', event));
  desk?.on('change', (event) => broadcast('village', { ...event, source: 'hook', at: new Date().toISOString() }));
  const stateTimer = setInterval(() => {
    if (!clients.size) return;
    const full = `event: state\ndata: ${JSON.stringify(fullState())}\n\n`;
    const phone = [...clients].some((c) => c.lan) ? `event: state\ndata: ${JSON.stringify(lanState())}\n\n` : '';
    for (const c of clients) c.res.write(c.lan ? phone : full);
  }, 5_000);
  stateTimer.unref?.();
  const syncViewers = () => { if (desk) desk.viewers = clients.size; };

  function tokenOk(req) {
    const t = Buffer.from(String(req.headers['x-village-token'] ?? ''));
    return t.length === tokenBuf.length && timingSafeEqual(t, tokenBuf);
  }
  function hookOk(req) {
    if (!hookBuf) return false;
    const t = Buffer.from(String(req.headers['x-village-hook'] ?? ''));
    return t.length === hookBuf.length && timingSafeEqual(t, hookBuf);
  }

  function openStream(req, res, isLan) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: state\ndata: ${JSON.stringify(isLan ? lanState() : fullState())}\n\n`);
    const c = { res, lan: isLan };
    clients.add(c);
    syncViewers();
    const ka = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => { clearInterval(ka); clients.delete(c); syncViewers(); });
  }

  async function handleHook(req, res, url) {
    if (!desk) return send(res, 404, { error: 'Recurso desligado.' });
    if (!hookOk(req)) return send(res, 403, { error: 'Segredo do hook ausente ou inválido.' });
    let m;
    if (req.method === 'GET' && (m = /^\/api\/village\/hooks\/permission\/(A-[0-9a-f]+)\/wait$/.exec(url.pathname))) {
      const ms = Math.max(1_000, Math.min(25_000, Number(url.searchParams.get('ms')) || 25_000));
      return send(res, 200, await desk.wait(m[1], ms));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido.' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'Use application/json.' });
    const b = await readJson(req, 256 * 1024);
    if (url.pathname === '/api/village/hooks/permission') {
      // Account label only for extra accounts (the default one needs no name on the card).
      const acc = (orchestrator.accountList?.() ?? []).find((a) => a.id === b.account && a.runtime === (b.provider === 'codex' ? 'codex' : 'claude-code'));
      const account = acc ? (acc.isDefault ? null : acc.label) : b.account ?? null;
      const item = desk.request({ provider: b.provider, account, sessionId: b.session_id, agentId: b.agent_id, toolName: b.tool_name, toolInput: b.tool_input, cwd: b.cwd, timeoutMs: b.timeout_ms });
      if (!item) { res.writeHead(204); res.end(); return; }
      return send(res, 200, { id: item.id, expiresAt: item.expiresAt });
    }
    if ((m = /^\/api\/village\/hooks\/permission\/(A-[0-9a-f]+)\/cancel$/.exec(url.pathname))) { desk.cancel(m[1]); res.writeHead(204); res.end(); return; }
    if (url.pathname === '/api/village/hooks/notify') {
      const acc = (orchestrator.accountList?.() ?? []).find((a) => a.id === b.account && a.runtime === (b.provider === 'codex' ? 'codex' : 'claude-code'));
      desk.notice({ provider: b.provider, account: acc ? (acc.isDefault ? null : acc.label) : b.account ?? null, sessionId: b.session_id, kind: b.kind, message: b.message, cwd: b.cwd });
      res.writeHead(204); res.end(); return;
    }
    return send(res, 404, { error: 'Rota desconhecida.' });
  }

  async function handleLan(req, res, url) {
    if (url.pathname === '/api/village/lan/pair') {
      if (req.method !== 'POST' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 405, { error: 'Use POST com JSON.' });
      const b = await readJson(req, 4 * 1024);
      const s = lan.pair(b.code, b.label);
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(s.key)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
      return send(res, 200, { ok: true });
    }
    const session = lan.session(req);
    if (!session) return send(res, 401, { error: 'Celular não pareado.', pair: true });
    if (req.method === 'GET' && url.pathname === '/api/village/state') return send(res, 200, { ...lanState(), token: session.csrf });
    if (req.method === 'GET' && url.pathname === '/events/village') return openStream(req, res, true);
    let m;
    if (req.method === 'POST' && (m = /^\/api\/village\/attention\/([AN]-[0-9a-f]+)$/.exec(url.pathname))) {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'Use application/json.' });
      if (String(req.headers['x-village-token'] ?? '') !== session.csrf) return send(res, 403, { error: 'Token da sessão ausente ou inválido.' });
      const b = await readJson(req);
      return send(res, 200, desk.decide(m[1], { behavior: b.behavior, message: b.message }));
    }
    return send(res, 403, { error: 'Pelo celular só é possível acompanhar a vila e responder pedidos de permissão.' });
  }

  /** Returns true when the request was handled. `ctx.lan` = arrived on the LAN port. */
  async function handle(req, res, url, ctx = {}) {
    if (!url.pathname.startsWith('/api/village/') && url.pathname !== '/events/village') return false;
    try {
      if (ctx.lan) {
        if (!lan) { send(res, 404, { error: 'Acesso pela rede desligado.' }); return true; }
        await handleLan(req, res, url);
        return true;
      }
      if (!isLoopbackHost(req.headers.host)) { send(res, 403, { error: 'Somente acesso local (127.0.0.1).' }); return true; }
      if (url.pathname.startsWith('/api/village/hooks/')) { await handleHook(req, res, url); return true; }
      if (req.method === 'GET' && url.pathname === '/api/village/state') { send(res, 200, { ...fullState(), token }); return true; }
      if (req.method === 'GET' && url.pathname === '/events/village') { openStream(req, res, false); return true; }
      if (req.method === 'GET' && url.pathname === '/api/village/lan') {
        send(res, 200, lan ? { enabled: true, urls: lanAddresses(typeof lanPort === 'function' ? lanPort() : lanPort), ...lan.current(), devices: lan.devices() } : { enabled: false });
        return true;
      }
      if (req.method !== 'POST') { send(res, 405, { error: 'Método não permitido.' }); return true; }
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { send(res, 415, { error: 'Use application/json.' }); return true; }
      if (!sameOrigin(req.headers.origin, req.headers.host ?? '')) { send(res, 403, { error: 'Origem não permitida.' }); return true; }
      if (!tokenOk(req)) { send(res, 403, { error: 'Token da sessão ausente ou inválido.' }); return true; }
      const body = await readJson(req);
      let m;
      if (url.pathname === '/api/village/quota/refresh') return send(res, 200, await orchestrator.refreshQuota()), true;
      if (url.pathname === '/api/village/probe') { await orchestrator.probeAll(true); return send(res, 200, { adapters: orchestrator.publicProbes(), rea: orchestrator.rea }), true; }
      if (url.pathname === '/api/village/missions') return send(res, 201, await orchestrator.draft(body)), true;
      if ((m = /^\/api\/village\/missions\/(M-[\w-]+)\/approve$/.exec(url.pathname))) return send(res, 200, await orchestrator.approve(m[1], { confirmEdit: body.confirmEdit === true })), true;
      if ((m = /^\/api\/village\/missions\/(M-[\w-]+)\/cancel$/.exec(url.pathname))) return send(res, 200, orchestrator.cancel(m[1])), true;
      if ((m = /^\/api\/village\/attention\/([AN]-[0-9a-f]+)$/.exec(url.pathname)) && desk) return send(res, 200, desk.decide(m[1], { behavior: body.behavior, message: body.message })), true;
      if (url.pathname === '/api/village/lan/revoke' && lan) { lan.revokeAll(); return send(res, 200, { ok: true, ...lan.current() }), true; }
      if (url.pathname === '/api/village/lan/rotate' && lan) { lan.rotate(); return send(res, 200, { ok: true, ...lan.current() }), true; }
      send(res, 404, { error: 'Rota desconhecida.' });
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, { error: String(error.message ?? error) });
    }
    return true;
  }

  return { handle, token, close: () => { clearInterval(stateTimer); for (const c of clients) c.res.end(); } };
}
