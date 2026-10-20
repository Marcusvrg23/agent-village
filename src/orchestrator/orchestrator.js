// Local Orchestrator / Mission Controller. One controller, one shared policy, interchangeable adapters.
// Lifecycle: draft (classify + route preview, nothing spent) -> approve (explicit operator action) -> run
// (adapter, real events) -> gate -> completed/blocked. Idle village life never reaches this module.
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter, CodexAdapter } from './adapters.js';
import { discoverAccounts } from './accounts.js';
import { evaluateGate } from './gates.js';
import { UsageLedger } from './ledger.js';
import { QuotaStore } from './quota.js';
import { probeRea, reaAuthorization } from './rea.js';
import { POLICY, fallbackAfterFailure, route, runtimeOf } from './router.js';
import { classify, compileCapsule, isBinaryTarget, specTemplate } from './sdd.js';
import { readClaudeStatusline, readTapStatus, scanClaudeSessions, scanCodex, statuslineDir, villageDataDir } from './sources.js';
import { ContextVault, newMissionId, redact } from './vault.js';

const PROBE_TTL_MS = 5 * 60_000;
const PROMPT_MAX = 12_000;

export function allowedRoots(env = process.env, home = os.homedir()) {
  const raw = (env.VILLAGE_PROJECT_ROOTS ?? '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  return (raw.length ? raw : [home]).map((p) => path.resolve(p));
}

/** Project folder must exist, be a directory and live under an allowed root. Pure-ish (tested). */
export function checkProjectDir(cwd, roots) {
  if (typeof cwd !== 'string' || !cwd.trim() || !path.isAbsolute(cwd)) return { ok: false, reason: 'Informe o caminho absoluto da pasta do projeto.' };
  const resolved = path.resolve(cwd);
  let st;
  try { st = statSync(resolved); } catch { return { ok: false, reason: 'A pasta do projeto não existe.' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'O caminho do projeto não é uma pasta.' };
  const inside = roots.some((r) => resolved === r || resolved.startsWith(`${r}${path.sep}`));
  if (!inside) return { ok: false, reason: `Pasta fora das raízes permitidas (${roots.join(', ')}). Ajuste VILLAGE_PROJECT_ROOTS.` };
  if (resolved === path.parse(resolved).root) return { ok: false, reason: 'A raiz do disco não é aceita como projeto.' };
  return { ok: true, path: resolved };
}

export class Orchestrator extends EventEmitter {
  constructor({ env = process.env, dataDir = villageDataDir(env), adapters = null, control = String(env.VILLAGE_CONTROL ?? '').trim() !== '0', now = () => Date.now() } = {}) {
    super();
    this.env = env;
    this.now = now;
    this.control = control;
    this.dataDir = dataDir;
    this.vault = new ContextVault(path.join(dataDir, 'orchestrator'));
    this.ledger = new UsageLedger(path.join(dataDir, 'ledger'));
    this.quotas = new QuotaStore();
    this.claudeCache = new Map();
    this.claudeSessions = [];
    this.codexSessions = [];
    this.probes = {};
    this.probedAt = 0;
    this.rea = { status: 'UNKNOWN' };
    this.running = new Map(); // missionId -> {handle, adapter, startedAt}
    this.missions = new Map(this.vault.list(50).map((m) => [m.id, m]));
    for (const m of this.missions.values()) if (m.status === 'running') { m.status = 'interrupted'; this.vault.save(m); }
    // One adapter per account: "claude-code" / "codex" for the default accounts, "<runtime>@<id>" for the others.
    this.accounts = discoverAccounts({ env, dataDir });
    if (adapters) this.adapters = adapters;
    else {
      this.adapters = {};
      for (const account of this.accounts.claude) {
        this.adapters[account.key] = new ClaudeCodeAdapter({ env, account, hasQuotaCapture: () => Boolean(this.#claudeQuota(account, this.now())) });
      }
      for (const account of this.accounts.codex) {
        this.adapters[account.key] = new CodexAdapter({ env, account, rolloutPlan: () => this.quotas.view(account.key, this.now()).snapshot?.plan ?? null });
      }
    }
  }

  /** Adapter ids, in a stable order (also the quota keys). */
  keys() { return Object.keys(this.adapters); }

  accountList() {
    return this.keys().map((key) => {
      const acc = this.adapters[key].account;
      return { key, runtime: runtimeOf({ id: key, runtime: this.adapters[key].runtime }), id: acc?.id ?? null, label: acc?.label ?? 'principal', isDefault: acc ? acc.isDefault : true };
    });
  }

  #claudeQuota(account, now) {
    const dir = statuslineDir(this.env);
    return readClaudeStatusline(dir, now, account.captureId) ?? (this.accounts.claude.length === 1 ? readClaudeStatusline(dir, now) : undefined);
  }

  /** Diagnostics for the Fountain: did the status line tap run, and did Claude Code send quota data? */
  #tapStatus() {
    const out = {};
    for (const acc of this.accounts.claude) out[acc.key] = readTapStatus(statuslineDir(this.env), acc.captureId);
    return out;
  }

  #quotaViews(now) {
    return Object.fromEntries(this.keys().map((k) => [k, this.quotas.view(k, now)]));
  }

  emitVillage(event) {
    this.emit('village', { ...event, at: event.at ?? new Date(this.now()).toISOString() });
  }

  // ------------------------------------------------------------------ read-only data

  /** Scans local sources (cheap, read-only). Called on an interval by the server. */
  poll() {
    const now = this.now();
    const before = JSON.stringify(this.quotas.publicView(now, this.keys()));
    const claudeAccounts = this.accounts.claude.length ? this.accounts.claude : [{ key: 'claude-code', id: null, dir: this.env.CLAUDE_CONFIG_DIR ? path.resolve(this.env.CLAUDE_CONFIG_DIR.split(',')[0].trim()) : path.join(os.homedir(), '.claude'), captureId: '.claude' }];
    const codexAccounts = this.accounts.codex.length ? this.accounts.codex : [{ key: 'codex', id: null, dir: this.env.CODEX_HOME ? path.resolve(this.env.CODEX_HOME) : path.join(os.homedir(), '.codex') }];
    this.codexSessions = [];
    for (const acc of codexAccounts) {
      const codex = scanCodex({ home: acc.dir, now });
      if (codex.quota) this.quotas.set({ ...codex.quota, provider: acc.key }, now);
      for (const s of codex.sessions) {
        this.codexSessions.push({ ...s, account: acc.id });
        this.ledger.record({ provider: acc.key, sessionId: s.id, usage: s.usage, at: s.at, source: 'codex-rollout' });
      }
    }
    this.claudeSessions = [];
    for (const acc of claudeAccounts) {
      const q = this.#claudeQuota(acc, now);
      if (q) this.quotas.set({ ...q, provider: acc.key }, now);
      for (const s of scanClaudeSessions({ configDir: acc.dir, now, cache: this.claudeCache })) {
        this.claudeSessions.push({ ...s, account: acc.id });
        for (const x of [s, ...s.subagents]) {
          if (Object.values(x.usage).some((v) => v !== null)) this.ledger.record({ provider: acc.key, sessionId: x.id, model: x.model, usage: x.usage, at: x.lastAt, source: 'claude-transcript' });
        }
      }
    }
    this.claudeSessions.sort((a, b) => (Date.parse(b.lastAt ?? 0) || 0) - (Date.parse(a.lastAt ?? 0) || 0));
    const after = JSON.stringify(this.quotas.publicView(now, this.keys()));
    if (before !== after) this.emitVillage({ type: 'provider.quota', source: 'provider', quotas: this.quotas.publicView(now, this.keys()) });
    return { changed: before !== after };
  }

  async probeAll(force = false) {
    if (!force && this.now() - this.probedAt < PROBE_TTL_MS && Object.keys(this.probes).length) return this.probes;
    const entries = await Promise.all(Object.entries(this.adapters).map(async ([id, a]) => {
      try { return [id, await a.probe()]; } catch (error) { return [id, { id, installed: false, status: 'unavailable', billing: { mode: 'unknown', verified: false }, capabilities: {}, reasons: [String(error.message)] }]; }
    }));
    this.probes = Object.fromEntries(entries);
    this.probedAt = this.now();
    this.rea = await probeRea({ env: this.env }).catch((e) => ({ status: 'UNAVAILABLE', reason: String(e.message) }));
    return this.probes;
  }

  /** Fountain click: re-read the authorized sources (and ask Codex app-server for its quota). Never resets. */
  async refreshQuota() {
    const now = this.now();
    const keys = this.keys();
    const refilledBefore = Object.fromEntries(keys.map((p) => [p, this.quotas.view(p, now).refilledAt]));
    this.poll();
    const notes = [];
    for (const key of keys) {
      const a = this.adapters[key];
      if (runtimeOf({ id: key, runtime: a.runtime }) !== 'codex') continue;
      const name = a.label ?? key;
      if (a.readQuota && this.probes[key]?.billing?.mode === 'subscription') {
        const r = await a.readQuota().catch((e) => ({ error: String(e.message) }));
        if (r.snapshot) { this.quotas.set({ ...r.snapshot, provider: key }, this.now()); notes.push(`${name}: cota lida no app-server (sem turno de modelo).`); } else notes.push(`${name}: ${r.error}`);
      } else notes.push(`${name}: usando os rollouts locais (app-server não verificado).`);
    }
    for (const key of keys.filter((k) => runtimeOf({ id: k, runtime: this.adapters[k].runtime }) === 'claude-code')) {
      const name = this.adapters[key].label ?? key;
      const acc = this.accounts.claude.find((a) => a.key === key);
      const tap = acc ? readTapStatus(statuslineDir(this.env), acc.captureId) : null;
      notes.push(this.quotas.view(key, now).snapshot ? `${name}: captura do statusline lida.`
        : tap && !tap.rateLimits ? `${name}: o status line está rodando, mas o Claude Code ainda não enviou a cota (só vem em contas Pro/Max, depois de uma resposta).`
          : tap ? `${name}: o status line recebeu a cota, mas a vila não conseguiu ler o arquivo.`
            : `${name}: o coletor do status line nunca rodou (instale com \`npm run village:setup -- statusline install --yes\` e abra o Claude Code no terminal).`);
    }
    const view = this.quotas.publicView(this.now(), keys);
    for (const p of keys) {
      if (view[p].refilledAt && view[p].refilledAt !== refilledBefore[p]) this.emitVillage({ type: 'provider.reset_verified', source: 'provider', provider: p });
    }
    this.emitVillage({ type: 'provider.quota', source: 'provider', quotas: view });
    return { quotas: view, notes, refreshedAt: new Date(this.now()).toISOString() };
  }

  // ------------------------------------------------------------------ missions

  async draft({ prompt, cwd, runtime = 'auto', mode = 'read', target = null, authorized = false }) {
    const text = redact(String(prompt ?? '').trim()).slice(0, PROMPT_MAX);
    if (!text) throw Object.assign(new Error('Escreva o pedido da missão.'), { status: 400 });
    if (!['auto', ...POLICY.allowedRuntimeTypes, ...this.keys()].includes(runtime)) throw Object.assign(new Error('Runtime inválido.'), { status: 400 });
    if (!['read', 'edit'].includes(mode)) throw Object.assign(new Error('Modo inválido.'), { status: 400 });
    const dir = checkProjectDir(cwd, allowedRoots(this.env));
    const cls = classify({ prompt: text, target, mode });
    const auth = reaAuthorization({ target: isBinaryTarget(target) ? target : null, authorized: Boolean(authorized) });
    await this.probeAll();
    const mission = {
      id: newMissionId(new Date(this.now())), goal: text.split('\n')[0].slice(0, 160), prompt: text, cwd: dir.ok ? dir.path : cwd ?? null,
      runtime, mode, target: target || null, authorized: Boolean(authorized), level: cls.level, levelLabel: cls.label, pipeline: cls.pipeline,
      classification: cls.reasons, status: 'draft', createdAt: new Date(this.now()).toISOString(), blockers: [],
    };
    if (!dir.ok) mission.blockers.push(dir.reason);
    if (!auth.ok) mission.blockers.push(auth.reason);
    if (cls.needsRea && this.rea.status !== 'AVAILABLE') mission.notes = ['REA indisponível: a missão seguirá apenas com análise de fonte; evidência binária ficará como desconhecida.'];
    mission.capsule = compileCapsule(mission, cls, { rea: this.rea });
    mission.route = this.#route(mission);
    mission.preflight = this.#preflight(mission);
    this.missions.set(mission.id, mission);
    this.vault.save(mission);
    const spec = specTemplate(mission, cls);
    if (spec) this.vault.writeArtifact(mission.id, 'spec.md', spec);
    this.vault.appendEvent(mission.id, { type: 'mission.created' });
    this.emitVillage({ type: 'mission.created', source: 'orchestrator-controlled', missionId: mission.id, level: mission.level });
    this.emitVillage({ type: 'mission.classified', source: 'orchestrator-controlled', missionId: mission.id, level: mission.level, pipeline: mission.pipeline });
    return this.publicMission(mission);
  }

  #route(mission) {
    const now = this.now();
    const quotas = this.#quotaViews(now);
    return route({ mission, probes: this.probes, quotas, running: [...this.running.keys()].map((id) => ({ id })), history: this.vault.history() });
  }

  #preflight(mission) {
    const r = mission.route;
    const probe = r.adapter ? this.probes[r.adapter] : null;
    return {
      adapter: r.adapter, model: probe?.supportedModels === 'unknown' ? 'definido pelo próprio runtime (não verificável aqui)' : probe?.supportedModels ?? null,
      why: r.reasons, status: r.status, risk: mission.level === 'S4' ? 'alto' : mission.level === 'S3' ? 'médio-alto' : mission.mode === 'edit' ? 'médio' : 'baixo',
      paidApiSpendAllowedUsd: POLICY.allowedApiSpendUsd, approval: this.control ? 'aguardando sua aprovação' : 'controle desligado (modo só rascunho)',
      canRun: this.control && r.status === 'ready' && !mission.blockers.length,
    };
  }

  async approve(id, { confirmEdit = false } = {}) {
    const mission = this.missions.get(id);
    if (!mission) throw Object.assign(new Error('Missão não encontrada.'), { status: 404 });
    if (!this.control) throw Object.assign(new Error('Execução desligada (a vila foi iniciada com VILLAGE_CONTROL=0 ou no Docker): abra a vila sem essa variável para permitir execução real.'), { status: 403 });
    if (this.running.has(id)) throw Object.assign(new Error('Missão já em execução: execução duplicada negada.'), { status: 409 });
    if (!['draft', 'waiting_for_quota', 'queued', 'interrupted', 'failed'].includes(mission.status)) throw Object.assign(new Error(`Missão em estado ${mission.status}.`), { status: 409 });
    if (mission.blockers.length) throw Object.assign(new Error(mission.blockers.join(' ')), { status: 400 });
    if (mission.mode === 'edit' && !confirmEdit) throw Object.assign(new Error('Missão com edição exige confirmação explícita.'), { status: 400 });
    await this.probeAll(true); // fresh billing verification right before spending anything
    mission.route = this.#route(mission);
    mission.preflight = this.#preflight(mission);
    if (mission.route.status !== 'ready') {
      mission.status = mission.route.status === 'waiting_for_quota' ? 'waiting_for_quota' : mission.route.status === 'queued' ? 'queued' : 'blocked';
      this.vault.save(mission);
      this.emitVillage({ type: 'mission.blocked', source: 'orchestrator-controlled', missionId: id, status: mission.status, reasons: mission.route.reasons });
      return this.publicMission(mission);
    }
    this.vault.audit({ action: 'approve', missionId: id, adapter: mission.route.adapter, mode: mission.mode, level: mission.level });
    this.#start(mission, mission.route.adapter);
    return this.publicMission(mission);
  }

  #start(mission, adapterId) {
    const adapter = this.adapters[adapterId];
    mission.adapter = adapterId;
    mission.billingVerified = this.probes[adapterId]?.billing?.mode === 'subscription' && this.probes[adapterId]?.billing?.verified === true;
    mission.status = 'running';
    mission.startedAt = new Date(this.now()).toISOString();
    mission.observed = { states: [], tools: 0, denials: 0, reaUsed: false };
    this.vault.save(mission);
    this.vault.audit({ action: 'run', missionId: mission.id, adapter: adapterId });
    this.emitVillage({ type: 'agent.spawned', source: 'orchestrator-controlled', missionId: mission.id, provider: adapter.runtime ?? runtimeOf({ id: adapterId }), account: adapter.account?.id ?? null, role: 'LEAD', agentId: `${mission.id}:lead`, label: mission.goal });
    const handle = adapter.run({
      prompt: `${mission.capsule}\n\nPedido do operador:\n${mission.prompt}`, cwd: mission.cwd, mode: mission.mode, name: `village-${mission.id}`,
      onEvent: (e) => this.#onAdapterEvent(mission, e),
    });
    this.running.set(mission.id, { handle, adapter: adapterId, startedAt: this.now() });
    handle.done.then((result) => this.#finish(mission, adapterId, result)).catch((error) => this.#finish(mission, adapterId, { ok: false, error: String(error.message) }));
  }

  #onAdapterEvent(mission, e) {
    if (e.type === 'session') {
      mission.sessionId = e.sessionId;
      this.vault.appendEvent(mission.id, { type: 'session', provider: e.provider, sessionId: e.sessionId });
    } else if (e.type === 'tool') {
      mission.observed.tools += 1;
      if (!mission.observed.states.includes(e.state)) mission.observed.states.push(e.state);
      if (e.role === 'RE_ANALYST') mission.observed.reaUsed = true;
      const ev = { type: 'agent.state', source: 'orchestrator-controlled', missionId: mission.id, provider: e.provider, account: e.account ?? null, agentId: e.agentId ?? mission.sessionId,
        parentAgentId: e.parentId ?? null, role: e.role, state: e.state, label: e.command ?? (e.target ? `${e.tool} · ${e.target}` : e.tool),
        wait: e.command ? { since: new Date(this.now()).toISOString(), label: e.command } : null };
      this.vault.appendEvent(mission.id, ev);
      this.emitVillage(ev);
    } else if (e.type === 'command_done') {
      // A real command finished: the avatar celebrates (ok) or gets a rain cloud (failed) for a moment.
      const ev = { type: 'agent.state', source: 'orchestrator-controlled', missionId: mission.id, provider: e.provider, account: e.account ?? null, agentId: e.agentId ?? mission.sessionId,
        role: e.role, state: e.state, label: e.label, wait: null, outcome: { ok: e.ok } };
      this.vault.appendEvent(mission.id, ev);
      this.emitVillage(ev);
    } else if (e.type === 'permission_denied') {
      mission.observed.denials += 1;
    }
  }

  #finish(mission, adapterId, result) {
    this.running.delete(mission.id);
    mission.result = { ok: result.ok, error: result.error ?? null, exitCode: result.exitCode ?? null, sessionId: result.sessionId ?? mission.sessionId ?? null, summary: result.resultText ? redact(result.resultText) : null };
    if (result.usage && mission.result.sessionId) this.ledger.record({ provider: adapterId, sessionId: mission.result.sessionId, missionId: mission.id, usage: result.usage, source: `${adapterId}-run` });
    mission.observed.denials = Math.max(mission.observed.denials, result.denials ?? 0);
    mission.finishedAt = new Date(this.now()).toISOString();
    mission.gate = evaluateGate(mission, { ...mission.observed, ok: result.ok, error: result.error });
    mission.status = result.ok ? 'completed' : 'failed';
    this.vault.save(mission);
    this.vault.writeArtifact(mission.id, 'release.md', [`# Release Gate — ${mission.id}`, '', `**Status:** ${mission.gate.status}`, '',
      ...mission.gate.checks.map((c) => `- **${c.label}:** ${c.status} — ${c.detail}`), '', mission.result.summary ? `## Resumo do runtime\n\n${mission.result.summary}` : ''].join('\n'));
    this.vault.audit({ action: 'finish', missionId: mission.id, adapter: adapterId, ok: result.ok, gate: mission.gate.status });
    this.emitVillage({ type: mission.gate.status === 'READY' ? 'gate.pass' : 'gate.fail', source: 'orchestrator-controlled', missionId: mission.id, status: mission.gate.status });
    this.emitVillage({ type: 'mission.completed', source: 'orchestrator-controlled', missionId: mission.id, ok: result.ok, gate: mission.gate.status });
    // Safe fallback only for quota exhaustion, only to another verified subscription runtime, and only once.
    if (!result.ok && result.quotaExhausted && !mission.fallbackUsed) {
      const now = this.now();
      const d = fallbackAfterFailure({ mission, failed: adapterId, settled: true, probes: this.probes, running: [...this.running.keys()].map((id) => ({ id })),
        quotas: this.#quotaViews(now) });
      mission.fallbackUsed = true;
      if (d.status === 'ready' && d.adapter) {
        this.vault.audit({ action: 'fallback', missionId: mission.id, from: adapterId, to: d.adapter });
        this.#start(mission, d.adapter);
      } else {
        mission.status = 'waiting_for_quota';
        this.vault.save(mission);
      }
    }
  }

  cancel(id) {
    const r = this.running.get(id);
    if (!r) throw Object.assign(new Error('Missão não está em execução.'), { status: 409 });
    r.handle.stop();
    this.vault.audit({ action: 'cancel', missionId: id });
    return { ok: true };
  }

  publicMission(m) {
    if (!m) return null;
    return {
      id: m.id, goal: m.goal, status: m.status, level: m.level, levelLabel: m.levelLabel, pipeline: m.pipeline, classification: m.classification,
      runtime: m.runtime, mode: m.mode, cwd: m.cwd, target: m.target, adapter: m.adapter ?? null, preflight: m.preflight, blockers: m.blockers, notes: m.notes ?? [],
      createdAt: m.createdAt, startedAt: m.startedAt ?? null, finishedAt: m.finishedAt ?? null, gate: m.gate ?? null,
      result: m.result ? { ok: m.result.ok, error: m.result.error, summary: m.result.summary } : null,
      usage: this.ledger.totals().byMission[m.id] ?? null, observed: m.observed ?? null,
    };
  }

  publicProbes() {
    return Object.fromEntries(Object.entries(this.probes).map(([id, p]) => [id, {
      id, runtime: p.runtime ?? runtimeOf(p), account: p.account ?? null, label: p.label, installed: p.installed, version: p.version, status: p.status, billing: { mode: p.billing?.mode, verified: p.billing?.verified, reason: p.billing?.reason },
      plan: p.plan ?? null, capabilities: p.capabilities, strippedVars: p.strippedVars ?? [], reasons: p.reasons ?? [], probedAt: p.probedAt ?? null,
    }]));
  }

  state() {
    const now = this.now();
    return {
      control: this.control, policy: POLICY, accounts: this.accountList(), claudeTap: this.#tapStatus(), quotas: this.quotas.publicView(now, this.keys()), ledger: this.ledger.totals(), adapters: this.publicProbes(), rea: this.rea,
      missions: [...this.missions.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 15).map((m) => this.publicMission(m)),
      running: [...this.running.keys()],
      observed: {
        claude: this.claudeSessions.slice(0, 8).map((s) => ({ ...s, subagents: s.subagents.slice(0, 6) })),
        codex: this.codexSessions.slice(0, 8).map(({ provider, id, usage, at, account }) => ({ provider, id, usage, at, account })),
      },
      dataDir: this.dataDir,
    };
  }
}

export { existsSync };
