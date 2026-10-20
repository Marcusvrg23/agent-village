// Accounts: one Claude Code config dir or one Codex home per account (pattern learned from Habblaud, MIT;
// implementation original). Only folder EXISTENCE is checked — credentials, auth.json and config files are
// never opened. Labels come from ~/.agent-village/accounts.json, written by the operator.
//
// Discovery (stable order: the account the CLI uses by default first, then alphabetical):
//   Claude: VILLAGE_CLAUDE_DIRS (list separated by ";", replaces everything) or CLAUDE_CONFIG_DIR, ~/.claude
//           and ~/.claude-* folders with a projects/ folder (and that are not Codex homes).
//   Codex:  VILLAGE_CODEX_HOMES (list separated by ";") or CODEX_HOME, ~/.codex and ~/.codex-* folders that
//           look like a Codex home (sessions/, archived_sessions/ or config.toml present).
// Running a mission for an account only changes CLAUDE_CONFIG_DIR / CODEX_HOME for the child process, and never
// for the default account (on macOS the login lives in the keychain under the default location).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const splitList = (v) => String(v ?? '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
export const expandHome = (p, home) => path.resolve(String(p).trim().replace(/^~(?=[\\/]|$)/, home));

/** A Codex home also has sessions/; it must never become a Claude account (existence checks only). */
export function isCodexHome(dir) {
  if (isDir(path.join(dir, 'projects'))) return false;
  if (isDir(path.join(dir, 'archived_sessions')) || isFile(path.join(dir, 'config.toml')) || isFile(path.join(dir, 'auth.json'))) return true;
  try { return readdirSync(path.join(dir, 'sessions'), { withFileTypes: true }).some((e) => e.isDirectory() && /^\d{4}$/.test(e.name)); } catch { return false; }
}

export function isClaudeDir(dir) {
  return isDir(path.join(dir, 'projects')) && !isCodexHome(dir);
}

function homeChildren(home, prefix) {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (e.name === prefix || e.name.startsWith(`${prefix}-`) || e.name.startsWith(`${prefix}_`)))
      .map((e) => path.join(home, e.name));
  } catch { return []; }
}

/** Account id from the folder: ".claude-trabalho" -> "claude-trabalho". */
export function accountIdOf(dir) {
  return path.basename(dir).replace(/^\./, '').replace(/[^\w.-]/g, '_') || 'conta';
}

export function readAccountLabels(dataDir) {
  try {
    const j = JSON.parse(readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

function build(runtime, dirs, defaultDir, labels) {
  const unique = [...new Set(dirs.map((d) => path.resolve(d)))];
  unique.sort((a, b) => (a === defaultDir ? -1 : b === defaultDir ? 1 : a.localeCompare(b)));
  const used = new Set();
  return unique.map((dir) => {
    let id = accountIdOf(dir);
    while (used.has(id)) id = `${id}_`;
    used.add(id);
    const isDefault = dir === defaultDir;
    const meta = labels[id] && typeof labels[id] === 'object' ? labels[id] : {};
    return {
      key: isDefault ? runtime : `${runtime}@${id}`, runtime, id, dir, isDefault,
      label: typeof meta.label === 'string' && meta.label.trim() ? meta.label.trim().slice(0, 40) : isDefault ? 'principal' : id,
      enabled: meta.enabled !== false,
      captureId: path.basename(dir), // name used by the status line tap for this account's quota file
    };
  }).filter((a) => a.enabled);
}

/** Discovers the Claude Code and Codex accounts on this machine. Pure apart from existence checks. */
export function discoverAccounts({ env = process.env, home = env.HOME || env.USERPROFILE || os.homedir(), dataDir } = {}) {
  const labels = dataDir ? readAccountLabels(dataDir) : {};
  const claudeDefault = (env.CLAUDE_CONFIG_DIR ?? '').split(',')[0].trim() ? expandHome(env.CLAUDE_CONFIG_DIR.split(',')[0], home) : path.join(home, '.claude');
  const codexDefault = env.CODEX_HOME?.trim() ? expandHome(env.CODEX_HOME, home) : path.join(home, '.codex');

  const claudeOverride = splitList(env.VILLAGE_CLAUDE_DIRS).map((p) => expandHome(p, home));
  const claudeDirs = claudeOverride.length
    ? claudeOverride.filter((d) => !isCodexHome(d))
    : [claudeDefault, ...homeChildren(home, '.claude')].filter((d) => d === claudeDefault || isClaudeDir(d));
  const codexOverride = splitList(env.VILLAGE_CODEX_HOMES).map((p) => expandHome(p, home));
  const codexDirs = codexOverride.length
    ? codexOverride
    : [codexDefault, ...homeChildren(home, '.codex')].filter((d) => d === codexDefault || (isCodexHome(d) || isDir(path.join(d, 'sessions'))));

  return {
    claude: build('claude-code', claudeDirs, claudeDefault, labels),
    codex: build('codex', codexDirs, codexDefault, labels),
  };
}

/** Environment for a child process of this account (default account: unchanged). */
export function accountEnv(base, account) {
  if (!account || account.isDefault) return base;
  const env = { ...base };
  if (account.runtime === 'claude-code') env.CLAUDE_CONFIG_DIR = account.dir;
  else env.CODEX_HOME = account.dir;
  return env;
}

export const exists = existsSync;
