// Browser smoke test of the actual Agent Village served by its Node backend.
// This uses the fake local CLI fixture: no paid API call and no synthetic screenshot overlay.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(path.join(os.tmpdir(), 'agent-village-smoke-'));
const bin = path.join(home, 'bin');
const project = path.join(home, 'projeto-teste');
const artifacts = path.join(root, 'artifacts', 'mission-smoke');
for (const dir of [bin, project, artifacts, path.join(home, '.claude', 'projects'), path.join(home, '.codex', 'sessions')]) mkdirSync(dir, { recursive: true });
for (const name of ['claude', 'codex']) {
  const executable = path.join(bin, name);
  const fixture = path.join(root, 'test-fixtures', 'fake-cli.mjs');
  writeFileSync(executable, `#!/bin/sh\nFAKE_CLI_NAME=${name} exec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(executable, 0o755);
}

const port = 4187;
const responseText = [
  '# Resultado completo da missão — demonstração do smoke test',
  '',
  'Agente: Codex (CLI simulada; interface real).',
  'Objetivo: conferir captura, persistência, Release Gate e exibição.',
  '',
  '## Evidências',
  '- Comando de testes observado pela vila',
  '- Resposta completa recuperada pelo endpoint local',
  '- Histórico da missão consultável depois da execução',
  '',
  '## Conteúdo longo',
  'Este bloco comprova que textos extensos não são interrompidos na interface.',
  'Verificação detalhada. '.repeat(600),
  '',
  '## Encerramento',
  'FIM DO RELATÓRIO — conteúdo íntegro.',
].join('\n');

const env = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CODEX_HOME: path.join(home, '.codex'),
  AGENT_VILLAGE_HOME: path.join(home, '.agent-village'),
  VILLAGE_PROJECT_ROOTS: home,
  FAKE_RUN: 'ok',
  FAKE_RESULT_TEXT: responseText,
  OPS_ROOM_PORT: String(port),
  VILLAGE_CONTROL: '1',
};
const srv = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
srv.stdout.on('data', (d) => { serverLog += d; });
srv.stderr.on('data', (d) => { serverLog += d; });
let browser;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (srv.exitCode !== null) throw new Error('Servidor encerrou: '+serverLog);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) { ready = true; break; }
    } catch {}
    await sleep(200);
  }
  assert.ok(ready, `Servidor não iniciou. ${serverLog}`);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/village/', { waitUntil: 'domcontentloaded' });
  await page.locator('#world').waitFor();
  await page.locator('#open-missions').click();
  const mission = await page.evaluate(async ({ project }) => {
    const state = await (await fetch('/api/village/state')).json();
    const post = async (path, body) => {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-village-token': state.token },
        body: JSON.stringify(body)
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    };
    const m = await post('/api/village/missions', {
      prompt: 'Corrija o bug do login e rode os testes',
      cwd: project, runtime: 'codex', mode: 'read'
    });
    await post('/api/village/missions/' + m.id + '/approve', {});
    return m;
  }, { project });

  let completed;
  for (let i = 0; i < 120; i++) {
    const state = await (await fetch(base + '/api/village/state')).json();
    completed = state.missions.find((m) => m.id === mission.id);
    if (completed?.status === 'completed') break;
    await sleep(250);
  }
  assert.equal(completed?.status, 'completed', 'missão precisa completar');
  assert.equal(completed?.result?.hasOutput, true, 'resposta capturada');
  assert.equal(completed?.gate?.status, 'READY', 'gate precisa validar entrega');

  const outputResp = await fetch(base + '/api/village/missions/' + mission.id + '/output');
  assert.equal(outputResp.status, 200);
  const output = await outputResp.text();
  assert.equal(output, responseText, 'resultado não pode ser truncado');

  const screenshotDetail = path.join(artifacts, 'agent-village-resultado-completo.png');
  const screenshotWorld = path.join(artifacts, 'agent-village-panorama.png');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#open-missions').click();
  await page.locator('#mission-list .mission').first().locator('summary').click();
  await page.waitForFunction(() => document.querySelector('#mission-list .mission-output')?.textContent?.includes('FIM DO RELATÓRIO'), { timeout: 15000 });
  await page.screenshot({ path: screenshotDetail, fullPage: true });
  await page.locator('#missions-close').click();
  await page.screenshot({ path: screenshotWorld, fullPage: true });
  // Genuine two-session mission: complete both independent processes, perform two durable handoffs,
  // and exercise the team chat UI with the browser (fixture does not generate invented avatar dialogue).
  const teamMission = await page.evaluate(async ({ project }) => {
    const state = await (await fetch('/api/village/state')).json();
    const post = async (url, body) => {
      const res = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-village-token': state.token },
        body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    };
    const m = await post('/api/village/missions', {
      prompt: 'Implemente uma nova tela de relatórios e rode os testes',
      cwd: project, runtime: 'codex', mode: 'read', team: true,
    });
    await post('/api/village/missions/' + m.id + '/approve', {});
    return m;
  }, { project });
  let teamState;
  for (let i = 0; i < 160; i++) {
    const state = await (await fetch(base + '/api/village/state')).json();
    teamState = state.missions.find((m) => m.id === teamMission.id);
    if (teamState?.status === 'completed') break;
    if (teamState?.status === 'failed') throw new Error('A equipe falhou: ' + JSON.stringify(teamState.result));
    await sleep(250);
  }
  assert.equal(teamState?.status, 'completed', 'real team must complete');
  assert.notEqual(teamState.teamAgents?.LEAD?.sessionId, teamState.teamAgents?.WORKER?.sessionId);
  assert.equal(teamState.teamAgents?.LEAD?.turns, 2);
  assert.equal(teamState.teamAgents?.WORKER?.turns, 2);
  assert.equal(teamState.gate.checks.find(x => x.id === 'review').status, 'PASS');
  const teamPayload = await (await fetch(base + '/api/village/missions/' + teamMission.id + '/team')).json();
  assert.equal(teamPayload.messages.filter(m => m.kind === 'reply').length, 4);
  assert.equal(teamPayload.messages.filter(m => m.kind === 'handoff').length, 2);
  const screenshotTeam = path.join(artifacts, 'agent-village-equipe-real.png');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#open-missions').click();
  await page.locator('#mission-list .mission').first().getByText('Conversas e sessões da equipe').click();
  await page.locator('#team-body .team-message').first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: screenshotTeam, fullPage: true });
  await page.getByRole('button', { name: 'LEAD', exact: true }).last().click();
  await page.locator('#team-body .team-message').first().waitFor();
  assert.equal(await page.locator('#team-body .team-agent').count(), 2);
  await page.locator('#team-close').click();
  assert.equal(errors.length, 0, 'sem erros JS: ' + errors.join('; '));
  const report = { ok: true, branch: 'feat/real-agent-team-v1', teamMissionId: teamMission.id, teamSessions: teamState.teamAgents, teamMessages: teamPayload.messages.length, teamScreenshot: path.basename(screenshotTeam), missionId: mission.id,
    status: completed.status, gate: completed.gate.status,
    outputBytes: Buffer.byteLength(output), truncated: output !== responseText,
    screenshotDetail: path.basename(screenshotDetail),
    screenshotWorld: path.basename(screenshotWorld), browserErrors: errors };
  writeFileSync(path.join(artifacts, 'smoke-report.json'), JSON.stringify(report, null, 2));
  console.log('SMOKE_OK ' + JSON.stringify(report));
} finally {
  await browser?.close();
  srv.kill('SIGTERM');
}
