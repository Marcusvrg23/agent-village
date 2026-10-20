// HTTP control plane for the Agent Village (bound to 127.0.0.1 by server.js).
// Read endpoints are always on; write endpoints exist but real execution only happens when the server was
// started with VILLAGE_CONTROL=1 AND the operator approves each mission in the page.
// Edge protections (pattern learned from Habblaud's guard, MIT): loopback Host only (DNS rebinding),
// POST requires application/json + same-origin Origin + per-process CSRF token, small bodies only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) { reject(Object.assign(new Error('Corpo grande demais.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function createControlPlane(orchestrator, { token = randomBytes(24).toString('hex') } = {}) {
  const clients = new Set();
  const tokenBuf = Buffer.from(token);
  orchestrator.on('village', (event) => {
    for (const c of clients) c.write(`event: village\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const stateTimer = setInterval(() => {
    if (!clients.size) return;
    const data = JSON.stringify(orchestrator.state());
    for (const c of clients) c.write(`event: state\ndata: ${data}\n\n`);
  }, 5_000);
  stateTimer.unref?.();

  function tokenOk(req) {
    const t = Buffer.from(String(req.headers['x-village-token'] ?? ''));
    return t.length === tokenBuf.length && timingSafeEqual(t, tokenBuf);
  }

  /** Returns true when the request was handled. */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/village/') && url.pathname !== '/events/village') return false;
    if (!isLoopbackHost(req.headers.host)) { send(res, 403, { error: 'Somente acesso local (127.0.0.1).' }); return true; }
    if (req.method === 'GET' && url.pathname === '/api/village/state') {
      send(res, 200, { ...orchestrator.state(), token });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/events/village') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: state\ndata: ${JSON.stringify(orchestrator.state())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return true;
    }
    if (req.method !== 'POST') { send(res, 405, { error: 'Método não permitido.' }); return true; }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { send(res, 415, { error: 'Use application/json.' }); return true; }
    if (!sameOrigin(req.headers.origin, req.headers.host ?? '')) { send(res, 403, { error: 'Origem não permitida.' }); return true; }
    if (!tokenOk(req)) { send(res, 403, { error: 'Token da sessão ausente ou inválido.' }); return true; }
    try {
      const body = await readJson(req);
      let m;
      if (url.pathname === '/api/village/quota/refresh') return send(res, 200, await orchestrator.refreshQuota()), true;
      if (url.pathname === '/api/village/probe') { await orchestrator.probeAll(true); return send(res, 200, { adapters: orchestrator.publicProbes(), rea: orchestrator.rea }), true; }
      if (url.pathname === '/api/village/missions') return send(res, 201, await orchestrator.draft(body)), true;
      if ((m = /^\/api\/village\/missions\/(M-[\w-]+)\/approve$/.exec(url.pathname))) return send(res, 200, await orchestrator.approve(m[1], { confirmEdit: body.confirmEdit === true })), true;
      if ((m = /^\/api\/village\/missions\/(M-[\w-]+)\/cancel$/.exec(url.pathname))) return send(res, 200, orchestrator.cancel(m[1])), true;
      send(res, 404, { error: 'Rota desconhecida.' });
    } catch (error) {
      send(res, error.status ?? 500, { error: String(error.message ?? error) });
    }
    return true;
  }

  return { handle, token, close: () => { clearInterval(stateTimer); for (const c of clients) c.end(); } };
}
