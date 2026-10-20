#!/usr/bin/env node
// Agent Village setup helper. Optional changes to the CLIs' own settings, always previewed first, applied only
// with --yes and always after a timestamped backup. Every Claude Code / Codex account found on this machine is
// included (use --conta <id> to pick one).
//
//   npm run village:setup -- contas                         (lists the accounts the village sees)
//   npm run village:setup -- statusline status|install|uninstall [--yes] [--conta <id>]
//       Claude Code status line tap: lets the village read the Pro/Max quota (5 h and weekly windows).
//   npm run village:setup -- hooks status|install|uninstall [--yes] [--conta <id>]
//       "Precisa de você": Claude Code PermissionRequest + Notification(idle_prompt) hooks in settings.json and
//       the Codex PermissionRequest hook in <CODEX_HOME>/hooks.json (Codex asks you to trust it once in /hooks).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAccounts } from '../src/orchestrator/accounts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAP = path.join(ROOT, 'scripts', 'claude-statusline-tap.mjs');
const HOOK = path.join(ROOT, 'scripts', 'village-hook.mjs');
const MARK = 'claude-statusline-tap.mjs';
const HOOK_MARK = 'village-hook.mjs';
const STATUS_MESSAGE = 'Aguardando sua resposta na Agent Village';
export const CLAUDE_PERMISSION_TIMEOUT_S = 330; // hook waits up to 300 s, plus margin
export const CODEX_PERMISSION_TIMEOUT_S = 35; // Codex shows its own prompt only after the hook ends: keep it short

export function settingsPath(env = process.env, home = os.homedir()) {
  const dir = (env.CLAUDE_CONFIG_DIR ?? '').split(',')[0].trim() || path.join(home, '.claude');
  return path.join(dir, 'settings.json');
}

const quote = (p) => (/[\s"'&()]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

/** Pure planner (tested): returns {action, before, after} for a settings object. */
export function planStatusline(settings, action, nodeBin = process.execPath, tap = TAP) {
  const s = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  const cur = s.statusLine && typeof s.statusLine === 'object' ? s.statusLine : null;
  const installed = Boolean(cur?.command?.includes(MARK));
  if (action === 'status') return { action, installed, current: cur };
  if (action === 'install') {
    if (installed) return { action, changed: false, reason: 'já instalado', before: s, after: s };
    const original = cur?.type === 'command' && typeof cur.command === 'string' ? cur.command : '';
    const command = `${quote(nodeBin)} ${quote(tap)}${original ? ` -- ${original}` : ''}`;
    const after = { ...s, statusLine: { ...(cur ?? {}), type: 'command', command } };
    return { action, changed: true, before: s, after };
  }
  if (action === 'uninstall') {
    if (!installed) return { action, changed: false, reason: 'não instalado', before: s, after: s };
    const i = cur.command.indexOf(' -- ');
    const after = { ...s };
    if (i >= 0) after.statusLine = { ...cur, command: cur.command.slice(i + 4) };
    else delete after.statusLine;
    return { action, changed: true, before: s, after };
  }
  throw new Error(`Ação desconhecida: ${action}`);
}

const isOurs = (handler) => handler && (String(handler.command ?? '').includes(HOOK_MARK) || (Array.isArray(handler.args) && handler.args.some((a) => String(a).includes(HOOK_MARK))));
const groupIsOurs = (g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs);

/** Removes our groups from a hooks map (other apps' hooks stay exactly where they are). */
function withoutOurs(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept = Array.isArray(groups) ? groups.filter((g) => !groupIsOurs(g)) : groups;
    if (!Array.isArray(kept) || kept.length) out[event] = kept;
  }
  return out;
}

/**
 * Claude Code settings.json hooks (pure, tested). Exec form (`command` + `args`, no shell: works on Windows
 * without Git Bash) and onFailure "continue": if the village is closed the terminal dialog goes on as usual.
 */
export function planClaudeHooks(settings, action, nodeBin = process.execPath, script = HOOK) {
  const s = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  const installed = Object.values(s.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some(groupIsOurs));
  if (action === 'status') return { action, installed };
  if (action === 'uninstall') {
    if (!installed) return { action, changed: false, reason: 'não instalado', before: s, after: s };
    const after = { ...s, hooks: withoutOurs(s.hooks) };
    if (!Object.keys(after.hooks).length) delete after.hooks;
    return { action, changed: true, before: s, after };
  }
  if (action !== 'install') throw new Error(`Ação desconhecida: ${action}`);
  const hooks = withoutOurs(s.hooks); // reinstall = update in place, never duplicate
  const handler = (args, timeout, extra = {}) => ({ type: 'command', command: nodeBin, args: [script, ...args], timeout, onFailure: 'continue', ...extra });
  hooks.PermissionRequest = [...(hooks.PermissionRequest ?? []), { matcher: '*', hooks: [handler(['permission', 'claude'], CLAUDE_PERMISSION_TIMEOUT_S, { statusMessage: STATUS_MESSAGE })] }];
  hooks.Notification = [...(hooks.Notification ?? []), { matcher: 'idle_prompt', hooks: [handler(['notify', 'claude', 'idle_prompt'], 10)] }];
  const after = { ...s, hooks };
  return { action, changed: JSON.stringify(after) !== JSON.stringify(s), reason: 'já instalado', before: s, after };
}

/** Codex <CODEX_HOME>/hooks.json (pure, tested). Appended at the END of the list: other apps keep their trust. */
export function planCodexHooks(file, action, nodeBin = process.execPath, script = HOOK) {
  const f = file && typeof file === 'object' ? structuredClone(file) : {};
  const installed = Object.values(f.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some(groupIsOurs));
  if (action === 'status') return { action, installed };
  if (action === 'uninstall') {
    if (!installed) return { action, changed: false, reason: 'não instalado', before: f, after: f };
    return { action, changed: true, before: f, after: { ...f, hooks: withoutOurs(f.hooks) } };
  }
  if (action !== 'install') throw new Error(`Ação desconhecida: ${action}`);
  const command = `${quote(nodeBin)} ${quote(script)} permission codex`;
  const current = (f.hooks?.PermissionRequest ?? []).find(groupIsOurs);
  if (current && current.hooks.some((h) => h.command === command && h.timeout === CODEX_PERMISSION_TIMEOUT_S)) return { action, changed: false, reason: 'já instalado', before: f, after: f };
  const group = { hooks: [{ type: 'command', command, timeout: CODEX_PERMISSION_TIMEOUT_S, statusMessage: STATUS_MESSAGE }] };
  const hooks = { ...(f.hooks ?? {}) };
  const list = [...(hooks.PermissionRequest ?? [])];
  const at = list.findIndex(groupIsOurs);
  if (at >= 0) list[at] = group; else list.push(group); // same position on update
  hooks.PermissionRequest = list;
  return { action, changed: true, before: f, after: { ...f, hooks } };
}

function readJsonFile(file) {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

function apply(file, plan, yes, describe) {
  if (!plan.changed) { console.log(`  ${file}: nada a fazer (${plan.reason}).`); return false; }
  console.log(`  ${file}:`);
  console.log(describe(plan));
  if (!yes) return true;
  if (existsSync(file)) {
    const backup = `${file}.agent-village-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
    console.log(`    backup: ${backup}`);
  } else mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(plan.after, null, 2)}\n`);
  console.log('    aplicado.');
  return true;
}

function main() {
  const argv = process.argv.slice(2);
  const [what, action = 'status'] = argv;
  const yes = argv.includes('--yes');
  const ci = argv.indexOf('--conta');
  const only = ci >= 0 ? argv[ci + 1] : null;
  const accounts = discoverAccounts({ env: process.env });
  const pick = (list) => list.filter((a) => !only || a.id === only || a.key === only);
  if (what === 'contas') {
    for (const a of [...accounts.claude, ...accounts.codex]) console.log(`${a.runtime.padEnd(12)} ${a.id.padEnd(20)} ${a.dir}${a.isDefault ? '  (padrão)' : ''}`);
    return;
  }
  if (what !== 'statusline' && what !== 'hooks') {
    console.log('Uso: npm run village:setup -- <contas|statusline|hooks> <status|install|uninstall> [--yes] [--conta <id>]');
    process.exit(what ? 1 : 0);
  }
  let pending = false;
  if (what === 'statusline') {
    for (const a of pick(accounts.claude)) {
      const file = path.join(a.dir, 'settings.json');
      const plan = planStatusline(readJsonFile(file), action);
      if (action === 'status') { console.log(`${plan.installed ? 'instalado' : 'não instalado'}: ${file}`); continue; }
      pending = apply(file, plan, yes, (p) => `    statusLine antes:  ${JSON.stringify(p.before.statusLine ?? null)}\n    statusLine depois: ${JSON.stringify(p.after.statusLine ?? null)}`) || pending;
    }
    if (action !== 'status' && yes) console.log('Abra uma sessão do Claude Code para a cota aparecer na Fonte de Elixir.');
  } else {
    for (const a of pick(accounts.claude)) {
      const file = path.join(a.dir, 'settings.json');
      const plan = planClaudeHooks(readJsonFile(file), action);
      if (action === 'status') { console.log(`Claude Code (${a.id}): ${plan.installed ? 'hooks instalados' : 'hooks não instalados'} — ${file}`); continue; }
      pending = apply(file, plan, yes, (p) => `    hooks depois: ${JSON.stringify({ PermissionRequest: p.after.hooks?.PermissionRequest, Notification: p.after.hooks?.Notification })}`) || pending;
    }
    for (const a of pick(accounts.codex)) {
      if (!existsSync(a.dir)) continue;
      const file = path.join(a.dir, 'hooks.json');
      const plan = planCodexHooks(readJsonFile(file), action);
      if (action === 'status') { console.log(`Codex (${a.id}): ${plan.installed ? 'hook instalado' : 'hook não instalado'} — ${file}`); continue; }
      pending = apply(file, plan, yes, (p) => `    PermissionRequest depois: ${JSON.stringify(p.after.hooks?.PermissionRequest ?? [])}`) || pending;
    }
    if (action === 'install' && yes) {
      console.log('\nPronto. Abra sessões novas do Claude Code. No Codex, abra uma sessão e aprove o hook da Agent Village em /hooks (o Codex só roda hooks que você confiou).');
      console.log('Precisa do Node no computador. Com a vila fechada (ou sem página aberta), os pedidos continuam só no terminal.');
    }
  }
  if (pending && !yes) console.log('\nPrévia apenas. Rode de novo com --yes para aplicar (um backup é criado antes de cada arquivo).');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
