import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuotaStore, parseClaudeRateLimits, parseCodexAppServerLimits, parseCodexRateLimits, rollover } from '../src/orchestrator/quota.js';
import { UsageLedger, usageFromClaude, usageFromCodex } from '../src/orchestrator/ledger.js';
import { parseClaudeTranscript, scanClaudeSessions, scanCodex, readClaudeStatusline } from '../src/orchestrator/sources.js';
import { claudeBillingFrom, codexBillingFrom, codexItemState } from '../src/orchestrator/adapters.js';
import { route, checkAdapter, fallbackAfterFailure, POLICY } from '../src/orchestrator/router.js';
import { classify, compileCapsule, specTemplate } from '../src/orchestrator/sdd.js';
import { evaluateGate } from '../src/orchestrator/gates.js';
import { reaAuthorization } from '../src/orchestrator/rea.js';
import { redact, newMissionId } from '../src/orchestrator/vault.js';
import { checkProjectDir, Orchestrator } from '../src/orchestrator/orchestrator.js';
import { captureRecord, writeCapture } from '../scripts/claude-statusline-tap.mjs';
import { planStatusline } from '../scripts/village-setup.mjs';
import { createControlPlane, isLoopbackHost } from '../src/control-http.js';
import http from 'node:http';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, '..', 'test-fixtures', 'fake-cli.mjs');
const H = 3600_000;
const unix = process.platform !== 'win32';

function tmp(prefix = 'av-') { return mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** Temp HOME with fake `claude`/`codex` on PATH and empty provider folders. */
function sandbox(extraEnv = {}) {
  const home = tmp('av-home-');
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    const f = path.join(bin, name);
    writeFileSync(f, `#!/bin/sh\nFAKE_CLI_NAME=${name} exec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(f, 0o755);
  }
  mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  mkdirSync(path.join(home, 'proj'));
  const log = path.join(home, 'calls.jsonl');
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    AGENT_VILLAGE_HOME: path.join(home, '.agent-village'), VILLAGE_PROJECT_ROOTS: home, FAKE_LOG: log, ...extraEnv };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { home, env, calls, proj: path.join(home, 'proj') };
}

const waitFor = async (fn, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout');
};

// ------------------------------------------------------------------ quotas

test('Quota: Codex rollout and app-server formats parse to the same windows; other buckets are ignored', () => {
  const now = Date.now();
  const r = parseCodexRateLimits({ limit_id: 'codex', plan_type: 'plus', primary: { used_percent: 98, window_minutes: 300, resets_at: (now + H) / 1000 },
    secondary: { used_percent: 15, window_minutes: 10080, resets_at: (now + 48 * H) / 1000 } }, now);
  assert.equal(r.plan, 'plus');
  assert.equal(r.windows.fiveHour.usedPercent, 98);
  assert.equal(r.windows.weekly.usedPercent, 15);
  assert.equal(parseCodexRateLimits({ limit_id: 'premium', primary: null }, now), undefined);
  const a = parseCodexAppServerLimits({ rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: (now + H) / 1000 }, planType: 'plus' } }, now);
  assert.equal(a.windows.fiveHour.usedPercent, 12);
  assert.equal(a.source, 'codex-app-server');
  const c = parseClaudeRateLimits({ five_hour: { used_percentage: 23.5, resets_at: (now + H) / 1000 }, seven_day: { used_percentage: 41.2 } }, now);
  assert.equal(c.windows.fiveHour.usedPercent, 23.5);
  assert.equal(c.windows.weekly.usedPercent, 41.2);
});

test('Quota: expired windows become NO DATA (never 0%), exhaustion and refill need provider data', () => {
  const t0 = Date.parse('2026-10-03T18:53:09Z');
  const store = new QuotaStore();
  store.set(parseCodexRateLimits({ limit_id: 'codex', primary: { used_percent: 100, window_minutes: 300, resets_at: (t0 + H) / 1000 } }, t0), t0);
  assert.equal(store.view('codex', t0 + 60_000).state, 'EXHAUSTED');
  const later = t0 + 2 * H;
  const v = store.view('codex', later);
  assert.equal(v.state, 'AWAITING_PROVIDER_RESET', 'the reset passed but no new data arrived');
  assert.deepEqual(v.snapshot.windows, {});
  assert.equal(v.refilledAt, null, 'no visual refill without provider confirmation');
  store.set(parseCodexRateLimits({ limit_id: 'codex', primary: { used_percent: 3, window_minutes: 300, resets_at: (later + 5 * H) / 1000 } }, later), later);
  const after = store.view('codex', later);
  assert.equal(after.state, 'FRESH');
  assert.equal(after.refilledAt, later, 'refill verified by fresh provider data');
  assert.equal(rollover({ windows: { a: { usedPercent: 1, resetsAt: 5 } } }, 10).expired[0], 'a');
  assert.equal(new QuotaStore().view('claude-code').state, 'UNKNOWN');
});

// ------------------------------------------------------------------ ledger

test('Ledger: cumulative session snapshots dedupe across restarts; totals never reset; nulls stay null', () => {
  const dir = tmp();
  const l1 = new UsageLedger(dir);
  assert.equal(l1.record({ provider: 'codex', sessionId: 's1', usage: usageFromCodex({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }), source: 't' }), true);
  assert.equal(l1.record({ provider: 'codex', sessionId: 's1', usage: usageFromCodex({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }), source: 't' }), false);
  l1.record({ provider: 'codex', sessionId: 's1', usage: usageFromCodex({ input_tokens: 150, cached_input_tokens: 80, output_tokens: 12 }), source: 't' });
  l1.record({ provider: 'claude-code', sessionId: 'c1', missionId: 'M-1', usage: usageFromClaude({ input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }), source: 't' });
  const l2 = new UsageLedger(dir);
  const t = l2.totals();
  assert.equal(t.byProvider.codex.input, 150, 'latest cumulative, not a sum of snapshots');
  assert.equal(t.byProvider.codex.reasoning, null);
  assert.equal(t.byProvider['claude-code'].input, 100);
  assert.equal(t.byMission['M-1'].output, 5);
  assert.equal(l2.record({ provider: 'codex', sessionId: 's1', usage: usageFromCodex({ input_tokens: 150, cached_input_tokens: 80, output_tokens: 12 }), source: 't' }), false);
});

// ------------------------------------------------------------------ sources

test('Claude transcript: usage per message is the max of repeated lines; tools map to states; no content leaks', () => {
  const lines = [
    { type: 'user', sessionId: 'abc', cwd: '/home/u/proj', timestamp: '2026-10-19T10:00:00Z', message: { role: 'user', content: 'SEGREDO do prompt' } },
    { type: 'assistant', sessionId: 'abc', timestamp: '2026-10-19T10:00:05Z', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 }, content: [{ type: 'text', text: 'resposta privada' }] } },
    { type: 'assistant', sessionId: 'abc', timestamp: '2026-10-19T10:00:06Z', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 5, cache_read_input_tokens: 50, output_tokens: 9 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npx vitest run' } }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const p = parseClaudeTranscript(lines);
  assert.equal(p.sessionId, 'abc');
  assert.equal(p.usage.input, 55);
  assert.equal(p.usage.output, 9);
  assert.equal(p.lastTool.state, 'testing');
  assert.doesNotMatch(JSON.stringify(p), /SEGREDO|resposta privada/);
});

test('Sources: Codex rollouts and Claude projects are scanned read-only from their folders', () => {
  const s = sandbox();
  const now = Date.now();
  const day = path.join(s.home, '.codex', 'sessions', '2026', '10', '19');
  mkdirSync(day, { recursive: true });
  const ts = new Date(now - 60_000).toISOString();
  writeFileSync(path.join(day, 'rollout-2026-10-19T10-00-00-01a1aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), [
    { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
      rate_limits: { limit_id: 'codex', plan_type: 'plus', primary: { used_percent: 30, window_minutes: 300, resets_at: (now + H) / 1000 } } } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const codex = scanCodex({ home: path.join(s.home, '.codex'), now });
  assert.equal(codex.quota.windows.fiveHour.usedPercent, 30);
  assert.equal(codex.sessions[0].usage.input, 1000);
  const proj = path.join(s.home, '.claude', 'projects', '-home-u-proj');
  mkdirSync(path.join(proj, 'sess1', 'subagents'), { recursive: true });
  writeFileSync(path.join(proj, 'sess1.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'sess1', cwd: '/home/u/proj', timestamp: new Date(now - 5_000).toISOString(),
    message: { id: 'a', model: 'm', usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/home/u/proj/x.js' } }] } }));
  writeFileSync(path.join(proj, 'sess1', 'subagents', 'agent-q1.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'sess1', timestamp: new Date(now - 4_000).toISOString(),
    message: { id: 'b', usage: { input_tokens: 2, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Grep', input: {} }] } }));
  const sessions = scanClaudeSessions({ configDir: path.join(s.home, '.claude'), now });
  assert.equal(sessions[0].id, 'sess1');
  assert.equal(sessions[0].active, true);
  assert.equal(sessions[0].state, 'working');
  assert.equal(sessions[0].lastTool.target, 'x.js', 'only the basename is exposed');
  assert.equal(sessions[0].subagents[0].id, 'sess1:q1');
  assert.equal(sessions[0].subagents[0].state, 'exploring');
});

test('Status line tap: stores only the quota windows; setup plans install/uninstall with the original command preserved', () => {
  const rec = captureRecord({ transcript_path: '/home/u/.claude/projects/p/s.jsonl', session_id: 'x', cost: { total_cost_usd: 3 }, prompt: 'secreto',
    rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } }, 1000);
  assert.deepEqual(Object.keys(rec).sort(), ['accountId', 'fetchedAt', 'five_hour', 'seven_day']);
  assert.equal(captureRecord({ session_id: 'x' }), undefined, 'API users: no rate_limits, nothing stored');
  const dir = tmp();
  writeCapture({ ...rec, fetchedAt: Date.now() }, dir);
  assert.equal(readClaudeStatusline(dir).windows.fiveHour.usedPercent, 23.5);
  const before = { theme: 'dark', statusLine: { type: 'command', command: 'bash ~/.claude/sl.sh' } };
  const inst = planStatusline(before, 'install', '/usr/bin/node', '/opt/av/scripts/claude-statusline-tap.mjs');
  assert.match(inst.after.statusLine.command, /claude-statusline-tap\.mjs -- bash ~\/\.claude\/sl\.sh$/);
  assert.equal(inst.after.theme, 'dark');
  const un = planStatusline(inst.after, 'uninstall');
  assert.equal(un.after.statusLine.command, 'bash ~/.claude/sl.sh');
  assert.equal(planStatusline(inst.after, 'install').changed, false);
});

// ------------------------------------------------------------------ firewall + router

test('Firewall: only verified subscription logins pass; API and unknown billing are blocked', () => {
  assert.equal(claudeBillingFrom({ authMethod: 'claude.ai' }, 0).mode, 'subscription');
  assert.equal(claudeBillingFrom({ authMethod: 'oauth_token' }, 0).mode, 'subscription');
  assert.equal(claudeBillingFrom({ authMethod: 'api_key' }, 0).mode, 'api');
  assert.equal(claudeBillingFrom({ authMethod: 'api_key_helper' }, 0).mode, 'api');
  assert.equal(claudeBillingFrom({ authMethod: 'weird' }, 0).verified, false);
  assert.equal(claudeBillingFrom(null, 1).mode, 'none');
  assert.equal(codexBillingFrom({ loginText: 'Logged in using ChatGPT', loginCode: 0, account: { type: 'chatgpt', planType: 'plus' } }).mode, 'subscription');
  assert.equal(codexBillingFrom({ loginText: 'Logged in using ChatGPT', loginCode: 0, account: { type: 'apiKey' } }).mode, 'api');
  assert.equal(codexBillingFrom({ loginText: 'API key configured - sk-***', loginCode: 0 }).mode, 'api');
  assert.equal(codexBillingFrom({ loginText: 'Logged in using ChatGPT', loginCode: 0 }).verified, false, 'one signal is not enough');
  assert.equal(codexBillingFrom({ loginText: 'Logged in using ChatGPT', loginCode: 0, rolloutPlan: 'plus' }).mode, 'subscription');
  assert.equal(codexItemState({ type: 'command_execution', command: ['bash', '-lc', 'npm test'] }).state, 'testing');
});

const sub = (id, extra = {}) => ({ id, installed: true, billing: { mode: 'subscription', verified: true, reason: 'ok' }, capabilities: { submit_prompt: true, stream_events: true }, ...extra });

test('Router: automatic choice by real quota, WAITING_FOR_QUOTA, cap of 3 total, no duplicate run, manual override', () => {
  const mission = { id: 'M-x', mode: 'read', runtime: 'auto' };
  const q = (used) => ({ state: used >= 100 ? 'EXHAUSTED' : used >= 80 ? 'LOW' : 'FRESH', windows: { fiveHour: { usedPercent: used } } });
  let d = route({ mission, probes: { 'claude-code': sub('claude-code'), codex: sub('codex') }, quotas: { 'claude-code': q(70), codex: q(20) } });
  assert.equal(d.adapter, 'codex');
  assert.equal(d.fallback, 'claude-code');
  assert.equal(d.policy.allowedApiSpendUsd, 0);
  d = route({ mission, probes: { 'claude-code': sub('claude-code'), codex: sub('codex', { billing: { mode: 'api', verified: true } }) }, quotas: {} });
  assert.equal(d.adapter, 'claude-code', 'API-billed runtime never selected');
  d = route({ mission, probes: { 'claude-code': sub('claude-code', { billing: { mode: 'unknown', verified: false } }), codex: sub('codex', { billing: { mode: 'api', verified: true } }) } });
  assert.equal(d.status, 'blocked');
  d = route({ mission, probes: { 'claude-code': sub('claude-code'), codex: sub('codex') }, quotas: { 'claude-code': q(100), codex: q(100) } });
  assert.equal(d.status, 'waiting_for_quota');
  d = route({ mission, probes: { codex: sub('codex') }, running: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  assert.equal(d.status, 'queued');
  assert.equal(POLICY.maxParallelAgents, 3);
  d = route({ mission, probes: { codex: sub('codex') }, running: [{ id: 'M-x' }] });
  assert.match(d.reasons[0], /duplicada/);
  d = route({ mission: { ...mission, runtime: 'claude-code' }, probes: { 'claude-code': sub('claude-code'), codex: sub('codex') }, quotas: { 'claude-code': q(70), codex: q(10) } });
  assert.equal(d.adapter, 'claude-code', 'manual override respected (still inside the firewall)');
  assert.equal(fallbackAfterFailure({ mission, failed: 'codex', settled: false, probes: {}, quotas: {}, running: [] }).status, 'blocked');
  assert.equal(checkAdapter(sub('codex'), q(50), { needsEdit: true }).reasons.some((r) => /aprovação/.test(r)), true);
});

// ------------------------------------------------------------------ SDD, gates, vault

test('Adaptive SDD: S0 stays light, binaries go S3 with REA, risky work goes S4; capsule is bounded', () => {
  assert.equal(classify({ prompt: 'Corrija um typo no texto de login' }).level, 'S0');
  assert.equal(classify({ prompt: 'Investigue e corrija bug de autenticação com testes' }).level, 'S1');
  assert.equal(classify({ prompt: 'Implemente uma nova tela de relatórios com filtros e exportação' }).level, 'S2');
  const s3 = classify({ prompt: 'Descubra o fluxo de importação e crie uma solução original', target: 'C:\\apps\\app.exe' });
  assert.equal(s3.level, 'S3');
  assert.equal(s3.needsRea, true);
  assert.equal(classify({ prompt: 'Preparar o deploy em produção com migração do banco' }).level, 'S4');
  const m = { id: 'M-1', goal: 'typo', mode: 'read' };
  assert.equal(specTemplate(m, classify({ prompt: 'typo no botão' })), null, 'no spec bureaucracy for S0');
  const cap = compileCapsule(m, classify({ prompt: 'typo no botão' }));
  assert.ok(cap.length < 1200, 'minimal context capsule');
  assert.match(cap, /somente leitura/);
  assert.equal(reaAuthorization({ target: 'x.exe', authorized: false }).ok, false);
});

test('Release Gate: READY only with everything verified; unverified tests/review make it PARTIAL; failures BLOCK', () => {
  const base = { level: 'S1', mode: 'edit', adapter: 'codex', billingVerified: true };
  assert.equal(evaluateGate(base, { ok: true, states: ['testing'] }).status, 'READY');
  assert.equal(evaluateGate(base, { ok: true, states: ['working'] }).status, 'PARTIAL');
  assert.equal(evaluateGate({ ...base, level: 'S2' }, { ok: true, states: ['testing'] }).status, 'PARTIAL', 'S2 needs an independent review');
  assert.equal(evaluateGate(base, { ok: false, error: 'x' }).status, 'BLOCKED');
  assert.equal(evaluateGate({ ...base, billingVerified: false }, { ok: true, states: ['testing'] }).status, 'BLOCKED');
  assert.match(redact('token sk-ant-abcdefghijklmnop1234 aqui'), /\[segredo removido\]/);
  assert.match(newMissionId(new Date(2026, 9, 20, 3, 4, 5), () => 0), /^M-20261020-030405-aaaa$/);
  const s = sandbox();
  assert.equal(checkProjectDir(s.proj, [s.home]).ok, true);
  assert.equal(checkProjectDir('/etc', [s.home]).ok, false);
  assert.equal(checkProjectDir('relativo', [s.home]).ok, false);
});

// ------------------------------------------------------------------ end to end with fake CLIs

test('E2E: draft is free; execution needs VILLAGE_CONTROL + approval; prompt goes via stdin; API vars never reach the CLI', { skip: !unix }, async () => {
  const s = sandbox({ OPENAI_API_KEY: 'sk-should-not-leak-000000', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak-0000' });
  const off = new Orchestrator({ env: s.env, dataDir: path.join(s.home, '.agent-village'), control: false });
  const draft = await off.draft({ prompt: 'Corrija o bug do login e rode os testes', cwd: s.proj });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.preflight.canRun, false);
  assert.equal(draft.preflight.paidApiSpendAllowedUsd, 0);
  await assert.rejects(off.approve(draft.id), /VILLAGE_CONTROL=1/);
  assert.equal(s.calls().filter((c) => c.args.includes('-p') || c.args[0] === 'exec').length, 0, 'nothing executed in draft-only mode');
  const probes = s.calls();
  assert.ok(probes.every((c) => c.apiVars.length === 0), 'API keys stripped from every child process');

  const on = new Orchestrator({ env: s.env, dataDir: path.join(s.home, '.agent-village2'), control: true });
  const events = [];
  on.on('village', (e) => events.push(e));
  const m = await on.draft({ prompt: 'Corrija o bug do login e rode os testes', cwd: s.proj });
  assert.equal(m.preflight.canRun, true);
  const started = await on.approve(m.id);
  assert.equal(started.status, 'running');
  await assert.rejects(on.approve(m.id), /duplicada/);
  const done = await waitFor(() => (['completed', 'failed'].includes(on.missions.get(m.id).status) ? on.missions.get(m.id) : null));
  assert.equal(done.status, 'completed');
  const runs = s.calls().filter((c) => c.args.includes('-p') || c.args[0] === 'exec');
  assert.equal(runs.length, 1, 'exactly one execution');
  assert.match(runs[0].stdin, /Corrija o bug do login/);
  assert.ok(!runs[0].args.join(' ').includes('Corrija'), 'user text never on the command line');
  assert.ok(runs[0].apiVars.length === 0);
  assert.ok(!runs[0].args.includes('--bare'), 'bare mode would bypass the subscription');
  const states = events.filter((e) => e.type === 'agent.state');
  assert.ok(states.length >= 1 && states.every((e) => e.source === 'orchestrator-controlled'));
  assert.ok(states.some((e) => e.role === 'QA' && e.state === 'testing'));
  assert.ok(events.some((e) => e.type === 'mission.completed'));
  assert.equal(done.gate.status, 'READY');
  assert.ok(on.ledger.totals().byMission[m.id], 'mission usage recorded in the ledger');
  const vaultDir = path.join(s.home, '.agent-village2', 'orchestrator', 'missions', m.id);
  for (const f of ['mission.json', 'events.jsonl', 'release.md']) assert.ok(existsSync(path.join(vaultDir, f)), f);
  assert.match(readFileSync(path.join(s.home, '.agent-village2', 'orchestrator', 'audit.jsonl'), 'utf8'), /"action":"approve"/);
});

test('E2E: API-billed logins are never executed; quota exhaustion falls back once to the other subscription', { skip: !unix }, async () => {
  const api = sandbox({ FAKE_CLAUDE_AUTH: 'api_key', FAKE_CODEX_LOGIN: 'apikey' });
  const o = new Orchestrator({ env: api.env, dataDir: path.join(api.home, '.av'), control: true });
  const m = await o.draft({ prompt: 'Implemente a tela nova', cwd: api.proj });
  assert.equal(m.preflight.status, 'blocked');
  const r = await o.approve(m.id);
  assert.equal(r.status, 'blocked');
  assert.equal(api.calls().filter((c) => c.args.includes('-p') || c.args[0] === 'exec').length, 0, 'no paid execution attempted');

  const q = sandbox({ FAKE_RUN: 'quota', FAKE_CODEX_ACCOUNT: 'chatgpt' });
  const o2 = new Orchestrator({ env: q.env, dataDir: path.join(q.home, '.av'), control: true });
  const m2 = await o2.draft({ prompt: 'Corrija o bug', cwd: q.proj, runtime: 'codex' });
  await o2.approve(m2.id);
  const final = await waitFor(() => {
    const x = o2.missions.get(m2.id);
    return x.fallbackUsed && ['completed', 'failed', 'waiting_for_quota'].includes(x.status) && !o2.running.has(m2.id) ? x : null;
  });
  const runs = q.calls().filter((c) => c.args.includes('-p') || c.args[0] === 'exec');
  assert.equal(runs[0].cli, 'codex');
  assert.equal(runs.length, 2, 'one fallback, never a parallel duplicate');
  assert.equal(runs[1].cli, 'claude');
  assert.ok(['completed', 'failed'].includes(final.status));
});

test('E2E: Fountain refresh reads Codex quota through app-server without any model turn', { skip: !unix }, async () => {
  const s = sandbox();
  const o = new Orchestrator({ env: s.env, dataDir: path.join(s.home, '.av'), control: false });
  await o.probeAll(true);
  const r = await o.refreshQuota();
  assert.equal(r.quotas.codex.windows.fiveHour.usedPercent, 12);
  assert.equal(r.quotas.codex.source, 'codex-app-server');
  assert.equal(r.quotas['claude-code'].state, 'UNKNOWN', 'no capture -> unknown, never invented');
  assert.equal(s.calls().filter((c) => c.args.includes('-p') || c.args[0] === 'exec').length, 0);
});

test('Control plane: loopback host only, JSON + same origin + CSRF token required for writes', { skip: !unix }, async (t) => {
  const s = sandbox();
  const o = new Orchestrator({ env: s.env, dataDir: path.join(s.home, '.av'), control: false });
  const cp = createControlPlane(o, { token: 'tok123' });
  const server = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://x'); if (!(await cp.handle(req, res, url))) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { cp.close(); server.close(); });
  const port = server.address().port;
  const req = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    if (body) r.end(body); else r.end();
  });
  assert.equal((await req('/api/village/state', { headers: { Host: 'evil.example:80' } })).status, 403, 'DNS rebinding blocked');
  const st = await req('/api/village/state', { headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(st.status, 200);
  assert.equal(JSON.parse(st.body).token, 'tok123');
  const body = JSON.stringify({ prompt: 'typo no botão', cwd: s.proj });
  const h = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' };
  assert.equal((await req('/api/village/missions', { method: 'POST', headers: h, body })).status, 403, 'no token');
  assert.equal((await req('/api/village/missions', { method: 'POST', headers: { ...h, 'x-village-token': 'tok123', 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await req('/api/village/missions', { method: 'POST', headers: { ...h, 'x-village-token': 'tok123', Origin: 'https://evil.example' }, body })).status, 403);
  const ok = await req('/api/village/missions', { method: 'POST', headers: { ...h, 'x-village-token': 'tok123', Origin: `http://127.0.0.1:${port}` }, body });
  assert.equal(ok.status, 201);
  assert.equal(JSON.parse(ok.body).level, 'S0');
  assert.equal(isLoopbackHost('localhost:4173'), true);
  assert.equal(isLoopbackHost('192.168.0.10:4173'), false);
});
