// V2.2: portability helpers, "precisa de você" (hooks), multiple accounts, phone pairing, project camps,
// waiting animations, social life and skins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, tmp, unix, waitFor } from '../test-fixtures/sandbox.mjs';
import { accountEnv, discoverAccounts, isCodexHome } from '../src/orchestrator/accounts.js';
import { route } from '../src/orchestrator/router.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { parseClaudeTranscript } from '../src/orchestrator/sources.js';
import { AttentionDesk, summarize, ORPHAN_MS } from '../src/attention.js';
import { LanPairing, MAX_FAILS } from '../src/lan.js';
import { createControlPlane } from '../src/control-http.js';
import { decisionOutput, run as runHook, trim } from '../scripts/village-hook.mjs';
import { planClaudeHooks, planCodexHooks, CODEX_PERMISSION_TIMEOUT_S } from '../scripts/village-setup.mjs';
import { Village, ROLE_ORDER, LIFE } from '../public/village/life-engine.js';
import { attentionClaims, claudeClaims, project, queueAtGatehouse, applyAssignments } from '../public/village/projector.js';
import { Camps, projectsFrom, LINGER_MS, FOLD_MS } from '../public/village/camps.js';
import { waitPhase } from '../public/village/overlays.js';
import { recolor, rgbToHsv, specFor, validateAtlas, zoneOf, hsvToRgb } from '../public/village/skins.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const world = JSON.parse(readFileSync(path.join(root, 'public/village/world.json'), 'utf8'));
const iso = (t) => new Date(t).toISOString();

// ------------------------------------------------------------------ accounts

test('Accounts: ~/.claude* and ~/.codex* folders are discovered by existence only; Codex homes never become Claude accounts', () => {
  const home = tmp('acc-');
  for (const d of ['.claude/projects', '.claude-trabalho/projects', '.codex/sessions/2026', '.codex-pessoal', '.claude-falso/sessions/2026']) mkdirSync(path.join(home, d), { recursive: true });
  writeFileSync(path.join(home, '.codex-pessoal', 'config.toml'), '');
  writeFileSync(path.join(home, '.claude-falso', 'config.toml'), ''); // looks like Codex: must not be a Claude account
  const dataDir = path.join(home, '.agent-village');
  mkdirSync(dataDir);
  writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ 'claude-trabalho': { label: 'Trabalho' } }));
  const a = discoverAccounts({ env: { HOME: home }, home, dataDir });
  assert.deepEqual(a.claude.map((x) => [x.key, x.isDefault, x.label]), [['claude-code', true, 'principal'], ['claude-code@claude-trabalho', false, 'Trabalho']]);
  assert.deepEqual(a.codex.map((x) => x.key), ['codex', 'codex@codex-pessoal']);
  assert.ok(isCodexHome(path.join(home, '.claude-falso')));
  // The default account never gets CLAUDE_CONFIG_DIR set (macOS keychain login lives under the default location).
  assert.equal(accountEnv({ X: 1 }, a.claude[0]).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(accountEnv({}, a.claude[1]).CLAUDE_CONFIG_DIR, path.join(home, '.claude-trabalho'));
  assert.equal(accountEnv({}, a.codex[1]).CODEX_HOME, path.join(home, '.codex-pessoal'));
});

test('Router: picks the account with the most quota left; a manual choice can target one account', () => {
  const sub = (id) => ({ id, runtime: id.split('@')[0], installed: true, billing: { mode: 'subscription', verified: true, reason: 'ok' }, capabilities: { submit_prompt: true, stream_events: true } });
  const probes = { 'claude-code': sub('claude-code'), 'claude-code@trabalho': sub('claude-code@trabalho'), codex: sub('codex') };
  const q = (used) => ({ state: used >= 100 ? 'EXHAUSTED' : 'FRESH', windows: { fiveHour: { usedPercent: used } } });
  const quotas = { 'claude-code': q(100), 'claude-code@trabalho': q(10), codex: q(60) };
  let d = route({ mission: { id: 'm', mode: 'read', runtime: 'auto' }, probes, quotas });
  assert.equal(d.adapter, 'claude-code@trabalho', 'exhausted account skipped, fullest account wins');
  d = route({ mission: { id: 'm', mode: 'read', runtime: 'claude-code' }, probes, quotas });
  assert.equal(d.adapter, 'claude-code@trabalho', 'runtime choice = any account of that runtime');
  d = route({ mission: { id: 'm', mode: 'read', runtime: 'codex' }, probes, quotas });
  assert.equal(d.adapter, 'codex');
});

test('E2E: a mission for an extra Claude account runs with that CLAUDE_CONFIG_DIR; the default account runs untouched', async () => {
  const s = sandbox({}, { claudeDirs: ['.claude', '.claude-trabalho'] });
  const orch = new Orchestrator({ env: s.env, dataDir: path.join(s.home, '.agent-village'), control: true });
  assert.deepEqual(orch.keys(), ['claude-code', 'claude-code@claude-trabalho', 'codex']);
  await orch.probeAll(true);
  assert.equal(orch.probes['claude-code@claude-trabalho'].billing.mode, 'subscription');
  const m = await orch.draft({ prompt: 'Revise o README', cwd: s.proj, runtime: 'claude-code@claude-trabalho' });
  assert.equal(m.preflight.adapter, 'claude-code@claude-trabalho');
  await orch.approve(m.id);
  await waitFor(() => ['completed', 'failed'].includes(orch.missions.get(m.id).status));
  const run = s.calls().find((c) => c.args.includes('-p'));
  assert.equal(run.configDir, path.join(s.home, '.claude-trabalho'));
  const probesDefault = s.calls().filter((c) => c.cli === 'claude' && c.args[0] === 'auth' && c.configDir === null);
  assert.ok(probesDefault.length >= 1, 'default account probed without CLAUDE_CONFIG_DIR');
  assert.deepEqual(orch.state().accounts.map((a) => a.key), ['claude-code', 'claude-code@claude-trabalho', 'codex']);
});

// ------------------------------------------------------------------ "precisa de você"

test('Attention: requests need an open page; decisions resolve the long-poll; orphaned requests disappear', async () => {
  let now = 1_000_000;
  const desk = new AttentionDesk({ now: () => now });
  assert.equal(desk.request({ provider: 'claude-code', sessionId: 's', toolName: 'Bash', toolInput: { command: 'ls' } }), null, 'no page open: hook exits at once');
  desk.viewers = 1;
  const item = desk.request({ provider: 'claude-code', sessionId: 's', toolName: 'Bash', toolInput: { command: 'npm install x', description: 'Instalar' }, cwd: '/home/u/loja' });
  assert.equal(item.summary.kind, 'command');
  assert.equal(item.project, 'loja');
  const waiting = desk.wait(item.id, 5_000);
  desk.decide(item.id, { behavior: 'allow' });
  assert.deepEqual(await waiting, { status: 'decided', behavior: 'allow', message: '' });
  assert.throws(() => desk.decide(item.id, { behavior: 'allow' }), /já respondido/);
  const q = desk.request({ provider: 'claude-code', sessionId: 's', toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Qual?', options: [{ label: 'A' }] }] } });
  assert.equal(q.canAnswer, false, 'questions are answered in the terminal');
  assert.throws(() => desk.decide(q.id, { behavior: 'allow' }), /terminal/);
  const lost = desk.request({ provider: 'codex', sessionId: 'c', toolName: 'Bash', toolInput: {} });
  now += ORPHAN_MS + 1_000; // the CLI killed the hook (answered in the terminal): no more polls
  assert.ok(!desk.list().some((x) => x.id === lost.id));
  assert.equal(summarize('Write', { file_path: '/a/b/.env' }).file, '.env');
});

test('Hook: prints allow/deny only for real decisions; never for timeouts, terminal answers or a closed village', async () => {
  assert.deepEqual(decisionOutput({ status: 'decided', behavior: 'allow' }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const deny = decisionOutput({ status: 'decided', behavior: 'deny', message: 'não' });
  assert.equal(deny.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(deny.hookSpecificOutput.decision.message, /não/);
  // Codex rejects these fields: never printed.
  for (const k of ['updatedInput', 'updatedPermissions', 'interrupt']) assert.ok(!(k in deny.hookSpecificOutput.decision));
  for (const b of ['terminal', 'timeout', 'terminal-answered', 'gone']) assert.equal(decisionOutput({ status: 'decided', behavior: b }), undefined);
  assert.equal(await runHook(['permission', 'claude'], { HOME: tmp('nohook-') }, '{"tool_name":"Bash"}'), undefined, 'village closed: silent');
  assert.equal(trim('x'.repeat(10_000)).length, 4_000);
});

test('E2E hook <-> village: the page approves, the hook prints allow; hooks need the secret; the phone needs pairing', async (t) => {
  const s = sandbox();
  const orch = new Orchestrator({ env: s.env, dataDir: path.join(s.home, '.agent-village'), control: false });
  const desk = new AttentionDesk();
  const lan = new LanPairing();
  const hookToken = 'h'.repeat(32);
  const control = createControlPlane(orch, { desk, hookToken, lan, lanPort: 0 });
  const mk = (isLan) => http.createServer(async (req, res) => { if (!(await control.handle(req, res, new URL(req.url, 'http://x'), { lan: isLan }))) { res.writeHead(404); res.end(); } });
  const main = mk(false);
  const phone = mk(true);
  await new Promise((r) => main.listen(0, '127.0.0.1', r));
  await new Promise((r) => phone.listen(0, '127.0.0.1', r));
  t.after(() => { control.close(); main.close(); phone.close(); });
  const port = main.address().port;
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(path.join(s.home, '.agent-village', 'hook.json'), JSON.stringify({ port, token: hookToken }));
  // no secret -> refused
  const bad = await fetch(`${base}/api/village/hooks/permission`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 403);
  // a page is open (SSE)
  const ac = new AbortController();
  const sse = await fetch(`${base}/events/village`, { signal: ac.signal });
  t.after(() => ac.abort());
  assert.equal(sse.status, 200);
  const { token } = await (await fetch(`${base}/api/village/state`)).json();
  const hook = runHook(['permission', 'claude'], { HOME: s.home, AGENT_VILLAGE_HOME: path.join(s.home, '.agent-village') },
    JSON.stringify({ session_id: 'sess', cwd: '/x/app', tool_name: 'Bash', tool_input: { command: 'npm publish' } }));
  const item = await waitFor(() => desk.list()[0]);
  assert.equal(item.summary.detail, 'npm publish');
  const ok = await fetch(`${base}/api/village/attention/${item.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-village-token': token }, body: JSON.stringify({ behavior: 'allow' }) });
  assert.equal(ok.status, 200);
  assert.equal((await hook).hookSpecificOutput.decision.behavior, 'allow');
  // phone: not paired -> 401; wrong code -> 403; right code -> cookie; can answer, cannot draft missions
  const pbase = `http://127.0.0.1:${phone.address().port}`;
  assert.equal((await fetch(`${pbase}/api/village/state`)).status, 401);
  assert.equal((await fetch(`${pbase}/api/village/lan/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"XXXXXXXX"}' })).status, 403);
  const paired = await fetch(`${pbase}/api/village/lan/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: lan.current().code }) });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  assert.match(paired.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const pstate = await (await fetch(`${pbase}/api/village/state`, { headers: { cookie } })).json();
  assert.equal(pstate.lan, true);
  assert.equal(pstate.dataDir, undefined, 'phone does not see local paths');
  const draft = await fetch(`${pbase}/api/village/missions`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'x-village-token': pstate.token }, body: '{}' });
  assert.equal(draft.status, 403, 'no missions from the phone');
  const hook2 = runHook(['permission', 'codex'], { HOME: s.home, AGENT_VILLAGE_HOME: path.join(s.home, '.agent-village') }, JSON.stringify({ session_id: 'c', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }));
  const item2 = await waitFor(() => desk.list()[0]);
  const denied = await fetch(`${pbase}/api/village/attention/${item2.id}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'x-village-token': pstate.token }, body: JSON.stringify({ behavior: 'deny', message: 'nao' }) });
  assert.equal(denied.status, 200);
  assert.equal((await hook2).hookSpecificOutput.decision.behavior, 'deny');
  // the main port still refuses a non-loopback Host (DNS rebinding)
  const reb = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/village/state', headers: { Host: 'evil.example' } }, (r) => resolve(r.statusCode)));
  assert.equal(reb, 403);
});

test('Phone pairing: codes rotate after use and lock after repeated wrong tries', () => {
  let now = 0;
  const lan = new LanPairing({ now: () => now });
  const first = lan.current().code;
  assert.match(first, /^[A-HJ-NP-Z2-9]{8}$/);
  lan.pair(first);
  assert.notEqual(lan.current().code, first, 'one code, one phone');
  for (let i = 0; i < MAX_FAILS; i++) assert.throws(() => lan.pair('WRONG123'));
  assert.throws(() => lan.pair(lan.current().code), /Muitas tentativas/);
  now += 11 * 60_000;
  assert.ok(lan.pair(lan.current().code).key);
  lan.revokeAll();
  assert.equal(lan.devices().length, 0);
});

test('Setup: the status line uses bare node on Windows and a reinstall updates an old tap command in place', async () => {
  const { planStatusline, shellNode } = await import('../scripts/village-setup.mjs');
  assert.equal(shellNode('win32'), 'node');
  const old = { statusLine: { type: 'command', command: '"C:\\Program Files\\nodejs\\node.exe" C:\\av\\scripts\\claude-statusline-tap.mjs -- bash ~/sl.sh' } };
  const re = planStatusline(old, 'install', 'node', 'C:\\av\\scripts\\claude-statusline-tap.mjs');
  assert.equal(re.changed, true);
  assert.equal(re.after.statusLine.command, 'node C:\\av\\scripts\\claude-statusline-tap.mjs -- bash ~/sl.sh');
  assert.equal(planStatusline(re.after, 'install', 'node', 'C:\\av\\scripts\\claude-statusline-tap.mjs').changed, false);
});

test('Setup: hooks are added in exec form with onFailure continue, never duplicated, and removed cleanly', () => {
  const before = { hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-app' }] }] }, theme: 'dark' };
  const inst = planClaudeHooks(before, 'install', '/usr/bin/node', '/opt/av/scripts/village-hook.mjs');
  const ours = inst.after.hooks.PermissionRequest.at(-1).hooks[0];
  assert.deepEqual([ours.command, ours.args, ours.onFailure], ['/usr/bin/node', ['/opt/av/scripts/village-hook.mjs', 'permission', 'claude'], 'continue']);
  assert.equal(inst.after.hooks.PermissionRequest[0].hooks[0].command, 'other-app', "other apps' hooks untouched");
  assert.equal(inst.after.hooks.Notification[0].matcher, 'idle_prompt');
  const again = planClaudeHooks(inst.after, 'install', '/usr/bin/node', '/opt/av/scripts/village-hook.mjs');
  assert.equal(again.after.hooks.PermissionRequest.length, 2, 'no duplicates');
  const un = planClaudeHooks(inst.after, 'uninstall');
  assert.deepEqual(un.after, before);
  const cx = planCodexHooks({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'orca' }] }] } }, 'install', '/usr/bin/node', '/opt/av/scripts/village-hook.mjs');
  assert.equal(cx.after.hooks.PermissionRequest[0].hooks[0].command, 'orca', 'appended at the end: other trust entries keep their position');
  assert.equal(cx.after.hooks.PermissionRequest[1].hooks[0].timeout, CODEX_PERMISSION_TIMEOUT_S);
  assert.equal(planCodexHooks(cx.after, 'install', '/usr/bin/node', '/opt/av/scripts/village-hook.mjs').changed, false);
});

test('Projector: the avatar of the waiting session raises its hand at the Gatehouse; otherwise the Release Gate keeper does', () => {
  const sessions = [{ id: 's1', role: 'QA', subagents: [] }];
  const claims = attentionClaims([{ id: 'A-1', type: 'permission', provider: 'claude-code', sessionId: 's1', summary: { title: 'executar um comando' }, createdAt: 1 },
    { id: 'A-2', type: 'permission', provider: 'codex', sessionId: 'cx', summary: { title: 'editar um arquivo' }, createdAt: 2 }], sessions);
  assert.deepEqual(claims.map((c) => [c.role, c.needsYou]), [['QA', true], ['RELEASE_GATE', true]]);
  const working = { role: 'QA', state: 'testing', source: 'orchestrator-controlled', at: 99, provider: 'codex' };
  const out = queueAtGatehouse(project([working, ...claims]), { keeper: 'RELEASE_GATE', queue: world.attention.queue });
  assert.equal(out.get('QA').needsYou, true, 'the hand outranks normal work');
  assert.equal(out.get('QA').spot, world.attention.queue[0]);
  assert.equal(out.get('RELEASE_GATE').spot, null, 'keeper waits at home');
  const v = new Village(world, { seed: 3 });
  applyAssignments(v, out, ROLE_ORDER);
  assert.equal(v.agent('QA').task.needsYou, true);
  assert.equal(v.agent('QA').task.at, world.attention.queue[0]);
  for (let i = 0; i < 400; i++) v.step(100);
  const qa = v.agent('QA');
  assert.equal(qa.node, world.attention.queue[0], 'walked to the Gatehouse queue');
  assert.equal(qa.activity, 'RAISE');
});

// ------------------------------------------------------------------ waiting animations, camps

test('Waiting: a Bash call without result keeps the session active with an hourglass; the result decides confetti or rain', () => {
  const t0 = Date.parse('2026-10-20T10:00:00Z');
  const lines = [
    { type: 'assistant', sessionId: 's', cwd: '/u/app', timestamp: iso(t0), message: { id: 'm1', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test', description: 'Rodar testes' } }] } },
  ];
  let p = parseClaudeTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(p.pendingCommand.label, 'Rodar testes');
  assert.equal(p.pendingCommand.role, 'QA');
  lines.push({ type: 'user', sessionId: 's', timestamp: iso(t0 + 600_000), message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true }] } });
  p = parseClaudeTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(p.pendingCommand, null);
  assert.equal(p.lastCommand.ok, false);
  assert.equal(waitPhase(0, 60_000), 'popcorn');
  assert.equal(waitPhase(0, 4 * 60_000), 'arms');
  assert.equal(waitPhase(0, 12 * 60_000), 'cobweb');
  assert.equal(waitPhase(0, 30 * 60_000), 'sleep');
  // an old silent session with a running command still claims its avatar (no 45 s freshness cut)
  const c = claudeClaims([{ id: 's', active: true, state: 'testing', role: 'QA', lastAt: iso(t0), wait: { since: iso(t0), label: 'Rodar testes' }, subagents: [] }], t0 + 15 * 60_000);
  assert.equal(c.length, 1);
  assert.equal(c[0].wait.label, 'Rodar testes');
});

test('Camps: a tent per project with real activity; lights follow activity; folds after the last session and frees its plot', () => {
  const camps = new Camps(world);
  let now = 0;
  const sess = (project, active) => ({ project, active, lastAt: iso(now), subagents: [] });
  camps.update(projectsFrom({ claudeSessions: [sess('loja', true), sess('app', false)] }, now), now);
  assert.deepEqual(camps.list().map((c) => [c.name, c.lit]), [['loja', true], ['app', false]]);
  now += 60_000;
  camps.update(projectsFrom({ claudeSessions: [] }, now), now);
  assert.equal(camps.list().length, 2, 'lingers with lights off');
  now += LINGER_MS + 1;
  camps.update(new Map(), now);
  now += FOLD_MS + 1;
  camps.update(new Map(), now);
  assert.equal(camps.list().length, 0, 'folded away');
  const many = new Map(Array.from({ length: 12 }, (_, i) => [`p${i}`, { name: `p${i}`, active: true, agents: 1, sources: new Set(['claude']) }]));
  camps.update(many, now);
  assert.equal(camps.list().length, world.camps.plots.length, 'never more tents than plots');
  assert.equal(projectsFrom({ missions: [{ status: 'running', cwd: 'C:\\Users\\Dell\\meu-app' }] }).has('meu-app'), true);
});

// ------------------------------------------------------------------ social life

test('Social life: avatars play rock-paper-scissors (coins conserved), football with a ball, and go fishing — all local and seeded', () => {
  const v = new Village(world, { seed: 20261020 });
  const seen = { rps: false, ball: false, fish: false };
  let maxBalls = 0;
  for (let t = 0; t < 30 * 60_000; t += 100) {
    v.step(100);
    for (const a of v.agents) {
      if (a.step?.type === 'meet' && a.step.game === 'rps' && a.social?.icon) seen.rps = true;
      if (a.activity === 'FISH') seen.fish = true;
    }
    if (v.props().length) seen.ball = true;
    maxBalls = Math.max(maxBalls, v.props().length);
  }
  assert.deepEqual(seen, { rps: true, ball: true, fish: true });
  const coins = v.agents.reduce((s, a) => s + a.coins, 0);
  const games = v.agents.reduce((s, a) => s + a.games, 0);
  assert.ok(games >= 2, `${games} games`);
  assert.ok(coins >= 0 && coins <= games, 'coins only move between players (plus floor at 0)');
  assert.ok(maxBalls <= 4);
  // a real task interrupts any game at once; reduced motion has no games
  const w = new Village(world, { seed: 20261020 });
  for (let t = 0; t < 10 * 60_000; t += 100) w.step(100);
  w.assignTask('QA', { label: 'real', state: 'testing' });
  assert.equal(w.agent('QA').social, null);
  const still = new Village(world, { seed: 1, reducedMotion: true });
  for (let t = 0; t < 5 * 60_000; t += 100) still.step(100);
  assert.equal(still.props().length, 0);
  assert.ok(still.agents.every((a) => a.games === 0 && a.fish === 0));
  assert.ok(LIFE.rpsRounds === 3);
});

// ------------------------------------------------------------------ skins

test('Skins: colour zones match the art pipeline; presets recolour only hair/jacket/skin; imports are validated against the policy', () => {
  assert.equal(zoneOf(...rgbToHsv(...hsvToRgb(212, 0.9, 0.7))), 'hair');
  assert.equal(zoneOf(...rgbToHsv(...hsvToRgb(180, 0.9, 0.7))), 'jacket');
  assert.equal(zoneOf(...rgbToHsv(...hsvToRgb(24, 0.4, 0.9))), 'skin');
  assert.equal(zoneOf(...rgbToHsv(20, 20, 40)), null, 'outline and pants untouched');
  const px = new Uint8ClampedArray([...hsvToRgb(212, 0.9, 0.7), 255, 20, 20, 40, 255, 0, 0, 0, 0]);
  recolor(px, specFor('QA', {}));
  const [h] = rgbToHsv(px[0], px[1], px[2]);
  assert.ok(Math.abs(h - 4) < 3 || Math.abs(h - 364) < 3, 'QA hair hue');
  assert.deepEqual([...px.slice(4)], [20, 20, 40, 255, 0, 0, 0, 0]);
  const base = { width: 640, height: 50 };
  assert.deepEqual(validateAtlas({ width: 640, height: 50, transparentCorners: true, bytes: 1000 }, base, { accepted: true, author: 'eu', license: 'arte própria' }), []);
  const errs = validateAtlas({ width: 600, height: 50, transparentCorners: false, bytes: 900_000 }, base, {});
  assert.equal(errs.length, 6);
  assert.ok(statSync(path.join(root, 'ART-POLICY.md')).size > 500);
});

test('Portability: Docker and CI files exist; the server image never enables execution', () => {
  const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(docker, /VILLAGE_IN_DOCKER=1/);
  const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /127\.0\.0\.1:\$\{VILLAGE_PORT:-4173\}:4173/);
  assert.match(compose, /projects:\/claude\/projects:ro/);
  assert.match(compose, /sessions:\/codex\/sessions:ro/);
  assert.doesNotMatch(compose, /auth\.json|\.credentials/);
  const ci = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.ok(ci.includes(os));
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /flag\('VILLAGE_CONTROL'\) && !IN_DOCKER/);
  assert.match(server, /\.trim\(\) === '1'/, 'cmd.exe `set X=1 && ...` keeps a trailing space');
  assert.ok(unix || !unix);
});

test('Status line tap: heartbeat says whether Claude Code sent quota; visible text when there is no other status line; BOM tolerated', async () => {
  const { writeTapStatus, statusText } = await import('../scripts/claude-statusline-tap.mjs');
  const { readTapStatus } = await import('../src/orchestrator/sources.js');
  const dir = tmp('tap-');
  const input = { transcript_path: '/home/u/.claude/projects/p/s.jsonl' };
  writeTapStatus(input, dir, 1_000);
  assert.deepEqual(readTapStatus(dir, '.claude'), { seenAt: 1_000, rateLimits: false });
  assert.match(statusText(input), /aguardando a cota/);
  const withQuota = { ...input, rate_limits: { five_hour: { used_percentage: 34, resets_at: 1 }, seven_day: { used_percentage: 61, resets_at: 2 } } };
  writeTapStatus(withQuota, dir, 2_000);
  assert.equal(readTapStatus(dir, '.claude').rateLimits, true);
  assert.equal(statusText(withQuota), '⛲ Agent Village · 5 h 34% · semana 61%');
  // the real script, fed through a pipe with a UTF-8 BOM (as Windows PowerShell can send)
  const { spawnSync } = await import('node:child_process');
  const home = tmp('taphome-');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/claude-statusline-tap.mjs')], {
    input: `﻿${JSON.stringify(withQuota)}`, env: { ...process.env, AGENT_VILLAGE_HOME: home }, encoding: 'utf8',
  });
  assert.match(r.stdout, /5 h 34%/);
  assert.ok(readFileSync(path.join(home, 'usage', '.claude.json'), 'utf8').includes('"five_hour"'));
});

test('Windows .cmd shims run through a single checked command line (no DEP0190 args array with shell: true)', async () => {
  const { commandLine, spawnResolved } = await import('../src/orchestrator/proc.js');
  assert.equal(commandLine('C:\\Program Files\\nodejs\\claude.cmd', ['-p', '--verbose']), '"C:\\Program Files\\nodejs\\claude.cmd" -p --verbose');
  assert.throws(() => spawnResolved({ file: 'x.cmd', shell: true }, ['ok', 'rm -rf /'], {}), /inseguro/);
});
