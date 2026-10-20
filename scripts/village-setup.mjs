#!/usr/bin/env node
// Agent Village setup helper. Only one optional change today: hook the Claude Code status line so the
// village can read the Pro/Max plan quota. It edits <CLAUDE_CONFIG_DIR|~/.claude>/settings.json ONLY with
// --yes, after showing the exact change, and always writes a timestamped backup first.
//
//   npm run village:setup -- statusline status
//   npm run village:setup -- statusline install            (dry run: shows the change)
//   npm run village:setup -- statusline install --yes      (applies, with backup)
//   npm run village:setup -- statusline uninstall --yes    (restores the original command)
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAP = path.join(ROOT, 'scripts', 'claude-statusline-tap.mjs');
const MARK = 'claude-statusline-tap.mjs';

export function settingsPath(env = process.env, home = os.homedir()) {
  const dir = (env.CLAUDE_CONFIG_DIR ?? '').split(',')[0].trim() || path.join(home, '.claude');
  return path.join(dir, 'settings.json');
}

const quote = (p) => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

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

function main() {
  const [what, action = 'status', ...rest] = process.argv.slice(2);
  if (what !== 'statusline') {
    console.log('Uso: npm run village:setup -- statusline <status|install|uninstall> [--yes]');
    process.exit(what ? 1 : 0);
  }
  const file = settingsPath();
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const plan = planStatusline(settings, action);
  if (action === 'status') {
    console.log(plan.installed ? `Tap do statusline instalado em ${file}` : `Tap não instalado (${file})`);
    return;
  }
  if (!plan.changed) { console.log(`Nada a fazer: ${plan.reason}.`); return; }
  console.log(`Arquivo: ${file}`);
  console.log(`statusLine antes:  ${JSON.stringify(plan.before.statusLine ?? null)}`);
  console.log(`statusLine depois: ${JSON.stringify(plan.after.statusLine ?? null)}`);
  if (!rest.includes('--yes')) { console.log('\nPrévia apenas. Rode de novo com --yes para aplicar (um backup é criado antes).'); return; }
  if (existsSync(file)) {
    const backup = `${file}.agent-village-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
    console.log(`Backup: ${backup}`);
  }
  writeFileSync(file, `${JSON.stringify(plan.after, null, 2)}\n`);
  console.log('Aplicado. Abra uma sessão do Claude Code para a cota aparecer na Fonte de Elixir.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
