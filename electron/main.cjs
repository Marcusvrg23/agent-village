const { app, BrowserWindow, utilityProcess, dialog } = require('electron');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const os = require('node:os');

const smoke = process.argv.includes('--smoke-test');
// The desktop app opens the Agent Village; `--ops-room` opens the original Ops Room screen instead.
const startPath = process.argv.includes('--ops-room') ? '/' : '/village/';
const smokeDir = process.env.OPS_ROOM_SMOKE_DIR || path.join(os.tmpdir(), 'codex-ops-room-smoke');
let backend;
let window;
let quitting = false;
const consoleErrors = [];
app.setName('Codex Ops Room'); // kept: the name decides the profile folder (saved preferences stay put)
app.commandLine.appendSwitch('disable-background-networking');
if (smoke) {
  // Test profile is isolated from the user's normal desktop app profile.
  app.setPath('userData', path.join(smokeDir, 'profile'));
}

async function launch() {
  await app.whenReady();
  backend = utilityProcess.fork(path.join(app.getAppPath(), 'server.js'), [], {
    env: { ...process.env, OPS_ROOM_PORT: '0' },
    stdio: 'pipe', serviceName: 'Codex Ops Room read-only monitor',
  });
  backend.stdout.on('data', (chunk) => process.stdout.write(chunk));
  backend.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local backend did not start within 30 seconds')), 30_000);
    backend.on('message', (message) => {
      if (message.type === 'ready' && Number.isInteger(message.port)) {
        clearTimeout(timer);
        resolve(message.port);
      }
    });
    backend.once('exit', (code) => {
      clearTimeout(timer);
      if (!quitting) reject(new Error(`Backend exited (${code})`));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  window = new BrowserWindow({
    width: 1440, height: 880, minWidth: 880, minHeight: 570,
    title: 'Agent Village', backgroundColor: '#0b1230', show: !smoke,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'ops-room' },
  });
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => {
    const permitted = details.url.startsWith(`${origin}/`);
    callback({ cancel: !permitted });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${origin}/`)) event.preventDefault();
  });
  // Electron 44 puts level/message on the first argument; the positional level is deprecated.
  window.webContents.on('console-message', (details, legacyLevel, legacyMessage) => {
    if (details?.level === 'error' || legacyLevel === 3) consoleErrors.push(details?.message ?? legacyMessage);
  });
  backend.on('exit', (code) => {
    if (!quitting && !smoke) dialog.showErrorBox('Codex Ops Room', `O backend local foi encerrado (${code}). Reabra o aplicativo.`);
  });
  if (smoke) {
    await window.loadURL(`${origin}/`);
    await smokeTest(origin);
    return;
  }
  await window.loadURL(`${origin}${startPath}`);
  window.setTitle(`${startPath === '/' ? 'Codex Ops Room' : 'Agent Village'} — ${origin}`);
}

async function smokeTest(origin) {
  const readUi = () => window.webContents.executeJavaScript(`({
    title: document.title,
    connection: document.querySelector('#connection')?.textContent,
    imageLoaded: Boolean(document.querySelector('.room-art')?.naturalWidth),
    project: document.querySelector('#project')?.textContent,
    source: document.querySelector('#source')?.textContent,
    agentButtons: document.querySelectorAll('.role-card[role="button"]').length,
    hasNode: typeof window.require !== 'undefined'
  })`);
  let ui;
  const deadline = Date.now() + 20_000;
  do {
    ui = await readUi();
    if (ui.connection === 'LIVE' && ui.imageLoaded && ui.project !== 'Unknown') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  const health = await (await fetch(`${origin}/api/health`)).json();
  const state = await (await fetch(`${origin}/api/state`)).json();
  // Agent Village: canvas world renders, control plane answers, nothing reaches Node.
  await window.loadURL(`${origin}/village/`);
  const readVillage = () => window.webContents.executeJavaScript(`({
    loaded: document.querySelector('#loading')?.hidden === true,
    canvas: Boolean(document.querySelector('#world')?.width),
    runtime: document.querySelector('#runtime')?.textContent,
    hasNode: typeof window.require !== 'undefined'
  })`);
  let village;
  const villageDeadline = Date.now() + 20_000;
  do {
    village = await readVillage();
    if (village.loaded && village.runtime && !/verificando/.test(village.runtime)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < villageDeadline);
  const villageState = await (await fetch(`${origin}/api/village/state`)).json();
  const villagePass = village.loaded && village.canvas && !village.hasNode && villageState.policy?.allowedApiSpendUsd === 0;
  const pass = ui.connection === 'LIVE' && ui.imageLoaded && ui.agentButtons === 5 && !ui.hasNode &&
    health.watcher && health.host === '127.0.0.1' && state.room.agents.length > 0 && consoleErrors.length === 0 && villagePass;
  const report = { pass, packaged: app.isPackaged, executable: process.execPath, origin, ui,
    village: { ...village, control: villageState.control, adapters: Object.fromEntries(Object.entries(villageState.adapters ?? {}).map(([k, v]) => [k, v.status])) },
    health, agentCount: state.room.agents.length, recognizedEvents: state.debug.recognizedEvents,
    readOnly: state.debug.readOnly, consoleErrors, metrics: app.getAppMetrics().map(({ type, memory }) => ({ type, memory })) };
  await mkdir(smokeDir, { recursive: true });
  await writeFile(path.join(smokeDir, 'electron-smoke.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(smokeDir, 'electron-smoke.png'), (await window.webContents.capturePage()).toPNG());
  console.log(JSON.stringify(report));
  quitting = true;
  backend.kill();
  app.exit(pass ? 0 : 1);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; backend?.kill(); });
launch().catch(async (error) => {
  quitting = true;
  backend?.kill();
  if (smoke) {
    await mkdir(smokeDir, { recursive: true });
    await writeFile(path.join(smokeDir, 'electron-smoke.json'), JSON.stringify({ pass: false, error: error.message }));
  } else dialog.showErrorBox('Codex Ops Room', error.message);
  app.exit(1);
});
