import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventNormalizer, ROLES } from './src/event-normalizer.js';
import { SessionWatcher } from './src/session-watcher.js';
import { AgentRegistry, readSessionMetadata } from './src/agent-registry.js';
import { Orchestrator } from './src/orchestrator/orchestrator.js';
import { createControlPlane } from './src/control-http.js';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.OPS_ROOM_PORT ?? '4173', 10);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const ACTIVITY_LIMIT = 24;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function initialRole(role) {
  const labels = {
    EXPLORER: 'Awaiting observable reading activity',
    WORKER: 'Awaiting observable edit activity',
    REVIEWER: 'Awaiting observable review activity',
    QA: 'Awaiting observable test activity',
    LEAD: 'Waiting',
  };
  return { role, state: 'IDLE', summary: labels[role], updatedAt: null };
}

class MonitorState {
  constructor() {
    this.normalizer = new EventNormalizer();
    this.registry = new AgentRegistry();
    this.state = {
      project: 'Unknown',
      session: { status: 'IDLE', id: null, source: null, lastActivity: null },
      mode: 'SINGLE_AGENT',
      modeLabel: 'SINGLE AGENT / ACTIVITY VIEW',
      agents: [],
      progress: null,
      roles: Object.fromEntries(ROLES.map((role) => [role, initialRole(role)])),
      activity: [],
      updatedAt: new Date().toISOString(),
      debug: {
        sessionsRoot: SESSIONS_ROOT,
        rolloutPath: null,
        lastWriteTime: null,
        lastObservedActivity: null,
        offset: 0,
        size: 0,
        linesProcessed: 0,
        recognizedEvents: 0,
        unknownEvents: 0,
        lastRecognized: null,
        recentUnknown: [],
        partialBytesBuffered: 0,
        transport: 'SSE',
        connectedClients: 0,
        watcherStrategy: null,
        readOnly: true,
      },
    };
  }

  switchSession(file) {
    this.normalizer = new EventNormalizer();
    const source = path.basename(file.path);
    const id = source.match(/([0-9a-f]{8}-[0-9a-f-]{27,})/i)?.[1] ?? null;
    this.state.project = 'Unknown';
    this.registry.select(id);
    readSessionMetadata(file.path).then((record) => {
      if (this.state.session.id === id && record) {
        this.registry.metadata(record);
        if (this.state.project === 'Unknown' && typeof record.payload?.cwd === 'string') {
          this.state.project = path.win32.basename(record.payload.cwd.replaceAll('/', '\\')) || 'Unknown';
        }
        scheduleBroadcast();
      }
    }).catch(() => {});
    this.state.session = {
      status: Date.now() - (file.activityMs ?? file.mtimeMs) < 45_000 ? 'ACTIVE' : 'IDLE',
      id,
      source,
      lastActivity: new Date(file.mtimeMs).toISOString(),
    };
    this.state.mode = 'SINGLE_AGENT';
    this.state.modeLabel = 'SINGLE AGENT / ACTIVITY VIEW';
    this.state.agents = [];
    this.state.progress = null;
    this.state.roles = Object.fromEntries(ROLES.map((role) => [role, initialRole(role)]));
    this.state.activity = [];
    this.state.debug.rolloutPath = file.path;
    this.state.debug.recognizedEvents = 0;
    this.state.debug.unknownEvents = 0;
    this.state.debug.lastRecognized = null;
    this.state.debug.recentUnknown = [];
    this.touch();
  }

  ingest(line) {
    const event = this.normalizer.ingestLine(line);
    this.registry.ingest(line, event);
    if (event.recognized) {
      this.state.debug.recognizedEvents += 1;
      if (event.operational) this.state.debug.lastRecognized = `${event.sourceType}:${event.sourceSubtype}`;
    } else {
      this.state.debug.unknownEvents += 1;
      this.state.debug.recentUnknown.push(event.unknown ?? 'unknown');
      this.state.debug.recentUnknown = this.state.debug.recentUnknown.slice(-8);
    }

    if (event.meta) {
      if (event.meta.project) this.state.project = event.meta.project;
      if (event.meta.sessionId) this.state.session.id = event.meta.sessionId;
    }

    if (event.mode === 'MULTI_AGENT') {
      this.state.mode = 'MULTI_AGENT';
      this.state.modeLabel = 'MULTI AGENT';
      this.state.agents = event.agents ?? [];
    }

    if (event.operational) {
      if (ROLES.includes(event.role)) {
        this.state.roles[event.role] = { role: event.role, state: event.state, summary: event.summary, updatedAt: event.timestamp };
      }
      if (event.progress) this.state.progress = event.progress;
      this.state.session.lastActivity = event.timestamp;
      this.state.session.status = event.state === 'ERROR' ? 'ERROR' : event.sourceSubtype === 'task_complete' ? 'IDLE' : 'ACTIVE';
      this.state.activity.unshift({ timestamp: event.timestamp, role: event.role, state: event.state, summary: event.summary });
      this.state.activity = this.state.activity.slice(0, ACTIVITY_LIMIT);
    }
    this.touch();
    return event;
  }

  watcherDebug(info) {
    this.state.debug.rolloutPath = info.path;
    this.state.debug.lastWriteTime = info.lastWriteTime;
    this.state.debug.lastObservedActivity = info.lastObservedActivity;
    this.state.debug.offset = info.offset;
    this.state.debug.size = info.size;
    this.state.debug.linesProcessed = info.linesProcessed;
    this.state.debug.partialBytesBuffered = info.partialBytesBuffered;
    this.state.debug.watcherStrategy = info.strategy;
    if (info.lastWriteTime) {
      const newestObservedTime = Math.max(
        Date.parse(info.lastObservedActivity ?? info.lastWriteTime) || 0,
        Date.parse(this.state.session.lastActivity) || 0,
      );
      const age = Date.now() - newestObservedTime;
      if (age > 45_000 && this.state.session.status === 'ACTIVE') this.state.session.status = 'IDLE';
    }
    this.touch();
  }

  error(error) {
    this.state.session.status = 'ERROR';
    this.state.roles.LEAD = { role: 'LEAD', state: 'ERROR', summary: 'Watcher error', updatedAt: new Date().toISOString() };
    this.state.debug.recentUnknown.push(`watcher:${error.code ?? error.name ?? 'error'}`);
    this.state.debug.recentUnknown = this.state.debug.recentUnknown.slice(-8);
    this.touch();
  }

  touch() {
    this.state.updatedAt = new Date().toISOString();
  }
}

const monitor = new MonitorState();
const clients = new Set();

function publicState() {
  const room = monitor.registry.snapshot();
  const multi = room.agents.some((a) => a.parentId) || room.agents.length > 1;
  return { ...monitor.state, room, mode: multi ? 'MULTI_AGENT' : 'SINGLE_AGENT',
    modeLabel: multi ? 'MULTI AGENT' : 'SINGLE AGENT / ACTIVITY VIEW' };
}

function sendSse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast() {
  const snapshot = publicState();
  for (const client of clients) sendSse(client, 'snapshot', snapshot);
}

function scheduleBroadcast() {
  clearTimeout(scheduleBroadcast.timer);
  scheduleBroadcast.timer = setTimeout(broadcast, 40);
}

const watcher = new SessionWatcher({
  root: SESSIONS_ROOT,
  onSwitch(file) {
    monitor.switchSession(file);
    scheduleBroadcast();
  },
  onLine(line) {
    monitor.ingest(line);
    scheduleBroadcast();
  },
  onDebug(info) {
    monitor.watcherDebug(info);
    scheduleBroadcast();
  },
  onError(error) {
    monitor.error(error);
    scheduleBroadcast();
  },
});

async function serveStatic(requestPath, response) {
  // Directory URLs serve their index.html (/ -> Ops Room, /village/ -> Agent Village).
  const normalizedPath = requestPath.endsWith('/') ? `${requestPath}index.html` : requestPath;
  let decoded;
  try {
    decoded = decodeURIComponent(normalizedPath);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  const filePath = path.resolve(PUBLIC_ROOT, `.${decoded}`);
  if (!filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': path.extname(filePath) === '.webp' ? 'public, max-age=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

// Agent Village control plane: quotas, ledger, adapters, missions (see src/control-http.js).
const orchestrator = new Orchestrator();
const control = createControlPlane(orchestrator);
const pollTimer = setInterval(() => { try { orchestrator.poll(); } catch (error) { console.error(`[village] poll: ${error.message}`); } }, 10_000);
pollTimer.unref();
setTimeout(() => {
  try { orchestrator.poll(); } catch { /* sources may not exist yet */ }
  orchestrator.probeAll().catch(() => {});
}, 1_500).unref();

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
  if (await control.handle(request, response, requestUrl)) return;
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end('Method not allowed');
    return;
  }
  if (requestUrl.pathname === '/api/state') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(publicState()));
    return;
  }
  if (requestUrl.pathname === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ ok: true, app: 'codex-ops-room', version: '1.0.0', host: HOST, watcher: Boolean(monitor.state.debug.rolloutPath) }));
    return;
  }
  if (requestUrl.pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clients.add(response);
    monitor.state.debug.connectedClients = clients.size;
    sendSse(response, 'snapshot', publicState());
    const keepAlive = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    request.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(response);
      monitor.state.debug.connectedClients = clients.size;
    });
    return;
  }
  if (requestUrl.pathname === '/village') {
    response.writeHead(301, { Location: '/village/' }).end();
    return;
  }
  await serveStatic(requestUrl.pathname, response);
});

server.on('error', (error) => {
  console.error(`[ops-room] server error: ${error.message}`);
  process.exitCode = 1;
});

async function shutdown() {
  watcher.stop();
  control.close();
  for (const id of orchestrator.running.keys()) { try { orchestrator.cancel(id); } catch { /* already stopped */ } }
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await watcher.start().catch((error) => monitor.error(error));
server.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  process.parentPort?.postMessage({ type: 'ready', port: actualPort });
  console.log(`[ops-room] http://${HOST}:${actualPort}`);
  console.log(`[ops-room] watching read-only: ${SESSIONS_ROOT}`);
  console.log(`[village] execução real: ${orchestrator.control ? 'LIGADA (VILLAGE_CONTROL=1, cada missão exige aprovação)' : 'desligada (modo só rascunho)'}`);
});
