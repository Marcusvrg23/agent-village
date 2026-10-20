#!/usr/bin/env node
// Agent Village hook for Claude Code and Codex ("precisa de você"). Installed by
// `npm run village:setup -- hooks install`; never edit the CLI settings by hand to add it.
//
//   village-hook.mjs permission claude   → Claude Code PermissionRequest
//   village-hook.mjs permission codex    → Codex PermissionRequest (<CODEX_HOME>/hooks.json, trusted by you in /hooks)
//   village-hook.mjs notify claude <idle_prompt|permission_prompt>  → Claude Code Notification
//
// What it does: reads the event JSON from stdin, sends a trimmed copy to the local village
// (127.0.0.1, port and secret from ~/.agent-village/hook.json) and, for permissions, waits for your click.
// Allowed → prints {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}};
// denied → behavior "deny" with your reason. Anything else (village closed, no page open, "answer in the
// terminal", timeout, any error) → exits 0 printing nothing, and the CLI asks you in the terminal as usual.
// Formats: Claude Code hooks reference (PermissionRequest decision, exec form, onFailure) and openai/codex
// hooks schema permission-request.command.output (allow/deny + message; updatedInput/updatedPermissions/
// interrupt are not supported there and are never printed).
// Rules: Node only (node:* modules), never exits non-zero, never talks to anything but 127.0.0.1.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_STDIN = 4 * 1024 * 1024;
const MAX_STRING = 4_000;
const REGISTER_MS = 2_000;
const POLL_MS = 25_000;
export const WAIT_S = { claude: 300, codex: 25 };

export function dataDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return env.AGENT_VILLAGE_HOME ? path.resolve(env.AGENT_VILLAGE_HOME) : path.join(home, '.agent-village');
}

export function readHookConfig(env = process.env) {
  try {
    const j = JSON.parse(readFileSync(path.join(dataDir(env), 'hook.json'), 'utf8'));
    if (Number.isInteger(j.port) && j.port > 0 && j.port < 65_536 && typeof j.token === 'string' && j.token.length >= 16) return { port: j.port, token: j.token };
  } catch { /* village not running */ }
  return null;
}

export function trim(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => trim(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 60)) out[k] = trim(x, max, depth + 1);
  return out;
}

/** Account = config folder name, like the village names it (".claude-trabalho" → "claude-trabalho"). */
export function accountOf(provider, env = process.env) {
  const raw = provider === 'codex' ? env.CODEX_HOME : (env.CLAUDE_CONFIG_DIR ?? '').split(',')[0];
  return raw && raw.trim() ? path.basename(path.resolve(raw.trim())).replace(/^\./, '') : null;
}

/** Hook stdout for a village decision (undefined = print nothing). Pure (tested). */
export function decisionOutput(result) {
  if (!result || result.status !== 'decided') return undefined;
  if (result.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  if (result.behavior === 'deny') {
    const why = typeof result.message === 'string' && result.message.trim() ? `: ${result.message.trim().slice(0, 500)}` : '.';
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: `Recusado pelo operador na Agent Village${why}` } } };
  }
  return undefined;
}

async function call(cfg, method, route, body, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
      method,
      headers: { 'x-village-hook': cfg.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => resolve(''), 5_000);
    process.stdin.on('data', (c) => { size += c.length; if (size <= MAX_STDIN) chunks.push(c); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

export async function run(argv = process.argv.slice(2), env = process.env, stdinText = null) {
  const [event, providerArg, kind] = argv;
  const provider = providerArg === 'codex' ? 'codex' : 'claude';
  const cfg = readHookConfig(env);
  if (!cfg) return undefined;
  let input;
  try { input = JSON.parse(stdinText ?? await readStdin()); } catch { return undefined; }
  if (!input || typeof input !== 'object') return undefined;
  const common = { provider: provider === 'codex' ? 'codex' : 'claude-code', account: accountOf(provider, env), session_id: input.session_id, cwd: input.cwd };
  if (event === 'notify') {
    await call(cfg, 'POST', '/api/village/hooks/notify', { ...common, kind: kind ?? input.notification_type ?? 'idle_prompt', message: typeof input.message === 'string' ? input.message.slice(0, 200) : null }, 1_500);
    return undefined;
  }
  if (event !== 'permission') return undefined;
  const waitS = Number(env.VILLAGE_PERMISSION_WAIT) > 0 ? Math.min(86_400, Math.max(5, Number(env.VILLAGE_PERMISSION_WAIT))) : WAIT_S[provider];
  const reg = await call(cfg, 'POST', '/api/village/hooks/permission', {
    ...common, agent_id: input.agent_id, tool_name: input.tool_name, tool_input: trim(input.tool_input ?? {}), timeout_ms: waitS * 1_000,
  }, REGISTER_MS);
  if (!reg || reg.status !== 200 || !reg.json?.id) return undefined;
  const id = reg.json.id;
  const deadline = Date.now() + waitS * 1_000;
  while (Date.now() < deadline) {
    const left = Math.min(POLL_MS, deadline - Date.now());
    const r = await call(cfg, 'GET', `/api/village/hooks/permission/${id}/wait?ms=${Math.max(1_000, left)}`, undefined, left + 5_000);
    if (!r || r.status !== 200) return undefined;
    if (r.json?.status === 'decided' || r.json?.status === 'gone') return decisionOutput(r.json);
  }
  await call(cfg, 'POST', `/api/village/hooks/permission/${id}/cancel`, {}, 1_000);
  return undefined;
}

const isMain = (() => { try { return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const out = await run().catch(() => undefined);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
