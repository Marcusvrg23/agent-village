// One-command local start: backend + rollout watcher + web UI (all in server.js), then opens the browser.
// Pass --no-open (or set OPS_ROOM_NO_OPEN=1) to skip the browser. Still bound to 127.0.0.1 only.
import { spawn } from 'node:child_process';
import net from 'node:net';

const port = Number.parseInt(process.env.OPS_ROOM_PORT ?? '4173', 10);
const url = `http://127.0.0.1:${port}/`;
const open = !process.argv.includes('--no-open') && process.env.OPS_ROOM_NO_OPEN !== '1';

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`[ops-room] invalid OPS_ROOM_PORT: ${process.env.OPS_ROOM_PORT}`);
  process.exit(1);
}

async function isOpsRoom() {
  try {
    const health = await (await fetch(`${url}api/health`, { signal: AbortSignal.timeout(1_000) })).json();
    return health.app === 'codex-ops-room';
  } catch {
    return false;
  }
}

function portFree() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function openBrowser() {
  if (!open) return;
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  console.log(`[ops-room] opened ${url}`);
}

// A failed bind would leave server.js alive as a headless duplicate watcher, so check first.
if (await isOpsRoom()) {
  console.log(`[ops-room] already running at ${url}`);
  openBrowser();
  process.exit(0);
}
if (!await portFree()) {
  console.error(`[ops-room] port ${port} is used by another program. Free it or run with another port, e.g. $env:OPS_ROOM_PORT=4174; npm run ops-room`);
  process.exit(1);
}

await import('../server.js');
let up = false;
for (let attempt = 0; attempt < 40 && !(up = await isOpsRoom()); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
if (!up) {
  console.error(`[ops-room] server did not become available at ${url}; not opening the browser.`);
  process.exit(1);
}
openBrowser();
