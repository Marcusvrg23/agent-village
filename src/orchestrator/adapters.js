// Runtime adapters for Claude Code and Codex. Each adapter reports only capabilities it can prove, verifies
// the billing path before any execution and runs prompts through the provider's own supported CLI using the
// user's local subscription login. Sources: Claude Code CLI reference/headless docs (`claude auth status`
// authMethod, `-p --output-format stream-json`), openai/codex source (`codex login status`, app-server
// `account/read` + `account/rateLimits/read`, `codex exec --json`).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, runOnce, startStream, subscriptionEnv } from './proc.js';
import { parseCodexAppServerLimits } from './quota.js';
import { claudeToolState, commandLabel } from './sources.js';
import { usageFromClaude, usageFromCodex } from './ledger.js';
import { accountEnv } from './accounts.js';

const VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
})();

export const CAPABILITIES = Object.freeze(['discover_sessions', 'create_session', 'resume_session', 'submit_prompt', 'send_message',
  'stream_events', 'request_approval', 'cancel_task', 'read_usage', 'read_quota_windows']);

// Variables that would switch a CLI to pay-per-token billing. They are removed from every child process.
export const CLAUDE_API_VARS = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SIMPLE']);
export const CODEX_API_VARS = Object.freeze(['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY']);
// No agent needs another provider's key either: both children get the union removed.
const ALL_API_VARS = Object.freeze([...CLAUDE_API_VARS, ...CODEX_API_VARS]);

const SUBSCRIPTION_CLAUDE = new Set(['claude.ai', 'oauth_token']);
const API_CLAUDE = new Set(['api_key', 'api_key_helper', 'third_party']);
const versionOf = (text) => /(\d+\.\d+\.\d+)/.exec(text ?? '')?.[1] ?? null;
const caps = (on) => Object.fromEntries(CAPABILITIES.map((c) => [c, on.includes(c)]));

function presentVars(env, list) {
  return list.filter((k) => typeof env[k] === 'string' && env[k].trim() !== '');
}

// ------------------------------------------------------------------------------------------- Claude Code

/** Billing decision from `claude auth status` JSON. Pure (tested). */
export function claudeBillingFrom(status, exitCode) {
  const method = typeof status?.authMethod === 'string' ? status.authMethod : null;
  if (exitCode !== 0 || !method || method === 'none') return { mode: 'none', verified: false, method, reason: 'Claude Code não está logado.' };
  if (SUBSCRIPTION_CLAUDE.has(method)) return { mode: 'subscription', verified: true, method, reason: `Login pela assinatura (authMethod=${method}).` };
  if (API_CLAUDE.has(method)) return { mode: 'api', verified: true, method, reason: `Login por API (authMethod=${method}): cobrança por token, bloqueado.` };
  return { mode: 'unknown', verified: false, method, reason: `authMethod desconhecido (${method}): bloqueado até confirmação.` };
}

export class ClaudeCodeAdapter {
  constructor({ env = process.env, command = 'claude', hasQuotaCapture = () => false, account = null } = {}) {
    this.runtime = 'claude-code';
    this.account = account;
    this.id = account?.key ?? 'claude-code';
    this.label = account && !account.isDefault ? `Claude Code (${account.label})` : 'Claude Code';
    this.baseEnv = env;
    this.command = command;
    this.hasQuotaCapture = hasQuotaCapture;
    // Only CLAUDE_CONFIG_DIR changes per account (never for the default one); API variables are always removed.
    this.env = accountEnv(subscriptionEnv(env, ALL_API_VARS), account);
  }

  async probe() {
    const out = { id: this.id, runtime: this.runtime, account: this.account ? { id: this.account.id, label: this.account.label, isDefault: this.account.isDefault } : null, label: this.label, installed: false, version: null, status: 'unavailable', billing: { mode: 'unknown', verified: false },
      capabilities: caps([]), supportedModels: 'unknown', strippedVars: presentVars(this.baseEnv, CLAUDE_API_VARS), reasons: [], probedAt: Date.now() };
    const bin = resolveCommand(this.command, { env: this.baseEnv });
    if (!bin) { out.reasons.push('CLI `claude` não encontrada no PATH.'); return out; }
    out.installed = true;
    const v = await runOnce(bin, ['--version'], { env: this.env, timeoutMs: 15_000 });
    out.version = versionOf(v.stdout || v.stderr);
    const a = await runOnce(bin, ['auth', 'status'], { env: this.env, timeoutMs: 15_000 });
    let status = null;
    try { status = JSON.parse(a.stdout); } catch { /* older versions print text */ }
    out.billing = claudeBillingFrom(status, a.code);
    out.reasons.push(out.billing.reason);
    if (out.strippedVars.length) out.reasons.push(`Variáveis de API ignoradas no processo do agente: ${out.strippedVars.join(', ')}.`);
    out.capabilities = caps(['discover_sessions', 'create_session', 'resume_session', 'submit_prompt', 'stream_events', 'cancel_task', 'read_usage',
      ...(this.hasQuotaCapture() ? ['read_quota_windows'] : [])]);
    out.status = out.billing.mode === 'subscription' ? 'connected' : 'degraded';
    return out;
  }

  /**
   * Runs one prompt. mode 'read' = plan permission mode (no edits); 'edit' = acceptEdits (file edits without
   * shell beyond the read-only set). Unanswerable prompts are denied (--permission-prompts none). Never --bare
   * (bare mode ignores the subscription login and needs an API key).
   */
  run({ prompt, cwd, mode = 'read', resumeSession = null, name = null, onEvent = () => {} }) {
    const bin = resolveCommand(this.command, { env: this.baseEnv });
    if (!bin) throw new Error('CLI `claude` não encontrada.');
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', mode === 'edit' ? 'acceptEdits' : 'plan', '--permission-prompts', 'none'];
    if (resumeSession && /^[\w-]+$/.test(resumeSession)) args.push('--resume', resumeSession);
    if (name && /^[\w.-]+$/.test(name)) args.push('--name', name);
    const result = { ok: false, sessionId: resumeSession, usage: null, perMsg: new Map(), denials: 0, error: null, model: null, isError: false, resultText: null };
    const commands = new Map(); // Bash tool_use_id -> running command (for the waiting animations)
    const handle = startStream(bin, args, {
      cwd, env: this.env, input: prompt,
      onEvent: (e) => {
        if (e.type === 'system' && e.subtype === 'init') {
          result.sessionId = e.session_id ?? result.sessionId;
          result.model = e.model ?? null;
          // Defense in depth: if the CLI reports an API key source, stop before any work continues.
          if (typeof e.apiKeySource === 'string' && /ANTHROPIC_API_KEY|apiKeyHelper|api[_-]?key/i.test(e.apiKeySource)) {
            result.error = `Fonte de chave de API detectada (${e.apiKeySource}): execução interrompida pelo firewall.`;
            handle.stop();
          }
          onEvent({ type: 'session', provider: this.runtime, account: this.account?.id ?? null, sessionId: result.sessionId, model: result.model });
        } else if (e.type === 'assistant' && e.message) {
          const m = e.message;
          if (m.id && m.usage) result.perMsg.set(m.id, usageFromClaude(m.usage));
          // Keep the latest human-readable assistant message as fallback if an older CLI omits result.result.
          const answer = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
          if (answer.trim() && !e.parent_tool_use_id) result.lastAssistantText = answer;
          for (const b of Array.isArray(m.content) ? m.content : []) {
            if (b?.type !== 'tool_use') continue;
            const st = claudeToolState(b.name, b.input ?? {});
            const target = typeof b.input?.file_path === 'string' ? path.basename(b.input.file_path) : null;
            const agentId = e.parent_tool_use_id ? `${result.sessionId}:${e.parent_tool_use_id}` : result.sessionId;
            const command = b.name === 'Bash' && b.input?.run_in_background !== true ? commandLabel(b.input) : null;
            if (command && b.id) commands.set(b.id, { agentId, ...st, label: command });
            onEvent({ type: 'tool', provider: this.runtime, account: this.account?.id ?? null, sessionId: result.sessionId, agentId,
              parentId: e.parent_tool_use_id ? result.sessionId : null, tool: b.name, target, command, ...st });
          }
        } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
          for (const b of e.message.content) {
            if (b?.type !== 'tool_result' || !commands.has(b.tool_use_id)) continue;
            const c = commands.get(b.tool_use_id);
            commands.delete(b.tool_use_id);
            onEvent({ type: 'command_done', provider: this.runtime, account: this.account?.id ?? null, sessionId: result.sessionId, ok: b.is_error !== true, ...c });
          }
        } else if (e.type === 'system' && e.subtype === 'permission_denied') {
          result.denials += 1;
          onEvent({ type: 'permission_denied', provider: this.runtime, account: this.account?.id ?? null, tool: e.tool_name ?? null });
        } else if (e.type === 'result') {
          result.sessionId = e.session_id ?? result.sessionId;
          result.isError = Boolean(e.is_error);
          result.ok = e.subtype === 'success' && !e.is_error;
          result.usage = e.usage ? usageFromClaude(e.usage) : null;
          result.denials = Array.isArray(e.permission_denials) ? e.permission_denials.length : result.denials;
          result.resultText = typeof e.result === 'string' ? e.result : (result.lastAssistantText ?? null);
          onEvent({ type: 'result', provider: this.runtime, account: this.account?.id ?? null, ok: result.ok, sessionId: result.sessionId });
        }
      },
    });
    const done = handle.done.then(({ code, error }) => {
      if (!result.usage && result.perMsg.size) {
        const sum = { input: null, cachedInput: null, cacheWrite: null, output: null, reasoning: null };
        for (const u of result.perMsg.values()) for (const k of Object.keys(sum)) if (u[k] !== null) sum[k] = (sum[k] ?? 0) + u[k];
        result.usage = sum;
      }
      result.exitCode = code;
      if (error && !result.error) result.error = error;
      if (code !== 0 && !result.error) result.error = `Claude Code saiu com código ${code}.`;
      if (result.error) result.ok = false;
      result.resultText ??= result.lastAssistantText ?? null;
      delete result.lastAssistantText;
      delete result.perMsg;
      return result;
    });
    return { stop: () => handle.stop(), done };
  }
}

// ------------------------------------------------------------------------------------------------ Codex

/** Billing decision from `codex login status` output + optional app-server account/read. Pure (tested). */
export function codexBillingFrom({ loginText = '', loginCode = 1, account = undefined, rolloutPlan = null } = {}) {
  const text = String(loginText);
  const evidence = [];
  if (loginCode !== 0 || /Not logged in/i.test(text)) return { mode: 'none', verified: false, reason: 'Codex não está logado.', evidence };
  if (/API key configured|Bedrock|access token|personal access token|workload identity/i.test(text) && !/ChatGPT/.test(text)) {
    return { mode: 'api', verified: true, reason: 'Login do Codex por chave/token de API: cobrança por uso, bloqueado.', evidence: [text.trim()] };
  }
  if (!/Logged in using ChatGPT/.test(text)) return { mode: 'unknown', verified: false, reason: 'Modo de login do Codex não reconhecido: bloqueado.', evidence };
  evidence.push('codex login status: "Logged in using ChatGPT"');
  if (account?.type === 'apiKey') return { mode: 'api', verified: true, reason: 'app-server informa conta por chave de API: bloqueado.', evidence };
  if (account?.type === 'chatgpt') {
    evidence.push(`app-server account/read: chatgpt (${account.planType ?? 'plano ?'})`);
    return { mode: 'subscription', verified: true, plan: account.planType ?? null, reason: `Assinatura ChatGPT verificada (${account.planType ?? 'plano não informado'}).`, evidence };
  }
  if (rolloutPlan) {
    evidence.push(`rollouts locais: rate_limits.plan_type=${rolloutPlan}`);
    return { mode: 'subscription', verified: true, plan: rolloutPlan, reason: `Assinatura ChatGPT verificada pelo login e pelos rollouts (${rolloutPlan}).`, evidence };
  }
  return { mode: 'unknown', verified: false, reason: 'Login ChatGPT sem segunda confirmação (app-server/rollouts): bloqueado até confirmar.', evidence };
}

/** Minimal client for `codex app-server` over stdio JSONL (only read-only account requests are used). */
export async function codexAppServerRead(bin, env, requests, { timeoutMs = 20_000 } = {}) {
  const pending = new Map();
  let nextId = 1;
  const results = {};
  const handle = startStream(bin, ['app-server'], {
    env,
    input: null,
    onEvent: (msg) => {
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    },
  });
  const send = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    handle.child.stdin.write(`${JSON.stringify(params === undefined ? { method, id } : { method, id, params })}\n`);
  });
  const timer = new Promise((resolve) => setTimeout(() => resolve({ error: { message: 'timeout' } }), timeoutMs).unref());
  try {
    const init = await Promise.race([send('initialize', { clientInfo: { name: 'agent_village', title: 'Agent Village', version: VERSION } }), timer]);
    if (init.error) return { error: init.error.message ?? 'initialize falhou' };
    handle.child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    for (const [key, method, params] of requests) {
      const r = await Promise.race([send(method, params), timer]);
      results[key] = r.error ? { error: r.error.message ?? String(r.error) } : r.result;
    }
    return results;
  } finally {
    try { handle.child.stdin.end(); } catch { /* closed */ }
    handle.stop();
  }
}

const CODEX_TEST = /\b(test|tests|pytest|jest|vitest|mocha|node --test|npm (run )?test|go test|cargo test)\b/i;

/** `codex exec --json` item -> village state. Pure (tested). */
export function codexItemState(item = {}) {
  switch (item.type) {
    case 'command_execution': {
      const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
      return CODEX_TEST.test(cmd) ? { state: 'testing', role: 'QA' } : /\b(rg|grep|cat|ls|find|sed -n|head|tail)\b/.test(cmd) ? { state: 'exploring', role: 'EXPLORER' } : { state: 'working', role: 'WORKER' };
    }
    case 'file_change': return { state: 'working', role: 'WORKER' };
    case 'reasoning': case 'todo_list': return { state: 'planning', role: 'LEAD' };
    case 'web_search': return { state: 'exploring', role: 'EXPLORER' };
    case 'mcp_tool_call': return String(item.server ?? '').toLowerCase().includes('rea') ? { state: 'exploring', role: 'RE_ANALYST' } : { state: 'exploring', role: 'EXPLORER' };
    case 'agent_message': return { state: 'integrating', role: 'LEAD' };
    default: return null;
  }
}

export class CodexAdapter {
  constructor({ env = process.env, command = 'codex', rolloutPlan = () => null, account = null } = {}) {
    this.runtime = 'codex';
    this.account = account;
    this.id = account?.key ?? 'codex';
    this.label = account && !account.isDefault ? `Codex (${account.label})` : 'Codex';
    this.baseEnv = env;
    this.command = command;
    this.rolloutPlan = rolloutPlan;
    this.env = accountEnv(subscriptionEnv(env, ALL_API_VARS), account);
  }

  async probe() {
    const out = { id: this.id, runtime: this.runtime, account: this.account ? { id: this.account.id, label: this.account.label, isDefault: this.account.isDefault } : null, label: this.label, installed: false, version: null, status: 'unavailable', billing: { mode: 'unknown', verified: false },
      capabilities: caps([]), supportedModels: 'unknown', strippedVars: presentVars(this.baseEnv, CODEX_API_VARS), reasons: [], probedAt: Date.now() };
    const bin = resolveCommand(this.command, { env: this.baseEnv });
    if (!bin) { out.reasons.push('CLI `codex` não encontrada no PATH.'); return out; }
    out.installed = true;
    const v = await runOnce(bin, ['--version'], { env: this.env, timeoutMs: 15_000 });
    out.version = versionOf(v.stdout || v.stderr);
    const login = await runOnce(bin, ['login', 'status'], { env: this.env, timeoutMs: 15_000 });
    let account;
    let appServer = false;
    if (/Logged in using ChatGPT/.test(`${login.stdout}${login.stderr}`)) {
      const r = await codexAppServerRead(bin, this.env, [['account', 'account/read', { refreshToken: false }]], { timeoutMs: 20_000 });
      if (!r.error && r.account && !r.account.error) { account = r.account.account ?? null; appServer = true; }
    }
    out.billing = codexBillingFrom({ loginText: `${login.stdout}\n${login.stderr}`, loginCode: login.code, account, rolloutPlan: this.rolloutPlan() });
    out.plan = out.billing.plan ?? null;
    out.reasons.push(out.billing.reason);
    if (out.strippedVars.length) out.reasons.push(`Variáveis de API ignoradas no processo do agente: ${out.strippedVars.join(', ')}.`);
    out.capabilities = caps(['discover_sessions', 'create_session', 'resume_session', 'submit_prompt', 'stream_events', 'cancel_task', 'read_usage',
      ...(appServer || this.rolloutPlan() ? ['read_quota_windows'] : [])]);
    out.appServer = appServer;
    out.status = out.billing.mode === 'subscription' ? 'connected' : 'degraded';
    return out;
  }

  /** Reads the plan quota through app-server `account/rateLimits/read` (no model turn, no tokens). */
  async readQuota() {
    const bin = resolveCommand(this.command, { env: this.baseEnv });
    if (!bin) return { error: 'CLI `codex` não encontrada.' };
    const r = await codexAppServerRead(bin, this.env, [['limits', 'account/rateLimits/read']], { timeoutMs: 20_000 });
    if (r.error || r.limits?.error) return { error: r.error ?? r.limits.error };
    const snap = parseCodexAppServerLimits(r.limits, Date.now());
    return snap ? { snapshot: snap } : { error: 'Resposta sem janelas de cota.' };
  }

  /** mode 'read' = read-only sandbox; 'edit' = workspace-write sandbox. Prompt via stdin (`codex exec -`). */
  run({ prompt, cwd, mode = 'read', onEvent = () => {} }) {
    const bin = resolveCommand(this.command, { env: this.baseEnv });
    if (!bin) throw new Error('CLI `codex` não encontrada.');
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', mode === 'edit' ? 'workspace-write' : 'read-only', '-'];
    const result = { ok: false, sessionId: null, usage: null, error: null, turns: 0, resultText: null };
    const handle = startStream(bin, args, {
      cwd, env: this.env, input: prompt,
      onEvent: (e) => {
        if (e.type === 'thread.started') {
          result.sessionId = e.thread_id ?? null;
          onEvent({ type: 'session', provider: this.runtime, account: this.account?.id ?? null, sessionId: result.sessionId });
        } else if (e.type === 'item.started' || e.type === 'item.completed') {
          // Codex emits its final answer as a completed agent_message item, not in turn.completed.
          if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string' && e.item.text.trim()) {
            result.resultText = result.resultText ? `${result.resultText}\n\n${e.item.text}` : e.item.text;
          }
          const st = codexItemState(e.item);
          const isCmd = e.item?.type === 'command_execution';
          if (st && e.type === 'item.started') {
            onEvent({ type: 'tool', provider: this.runtime, account: this.account?.id ?? null, sessionId: result.sessionId, agentId: result.sessionId, tool: e.item.type, target: null,
              command: isCmd ? commandLabel({ command: e.item.command }) : null, ...st });
          } else if (st && isCmd && e.type === 'item.completed') {
            const ok = typeof e.item.exit_code === 'number' ? e.item.exit_code === 0 : e.item.status !== 'failed';
            onEvent({ type: 'command_done', provider: this.runtime, account: this.account?.id ?? null, sessionId: result.sessionId, agentId: result.sessionId, ok,
              label: commandLabel({ command: e.item.command }), ...st });
          }
        } else if (e.type === 'turn.completed') {
          result.turns += 1;
          result.usage = e.usage ? usageFromCodex(e.usage) : result.usage;
          result.ok = true;
        } else if (e.type === 'turn.failed' || e.type === 'error') {
          result.ok = false;
          result.error = String(e.error?.message ?? e.message ?? 'Falha no turno do Codex.').slice(0, 500);
          result.quotaExhausted = /usage limit|rate limit|quota/i.test(result.error);
        }
      },
    });
    const done = handle.done.then(({ code, error }) => {
      result.exitCode = code;
      if (error && !result.error) result.error = error;
      if (code !== 0 && !result.error) result.error = `Codex saiu com código ${code}.`;
      if (result.error) result.ok = false;
      onEvent({ type: 'result', provider: this.runtime, account: this.account?.id ?? null, ok: result.ok, sessionId: result.sessionId });
      return result;
    });
    return { stop: () => handle.stop(), done };
  }
}
