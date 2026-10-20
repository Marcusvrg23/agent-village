#!/usr/bin/env node
// Agent Village — Claude Code status line tap. Captures ONLY the plan quota windows that Claude Code sends
// to the status line command (`rate_limits.five_hour` / `seven_day`, present for Pro/Max subscribers) and
// writes them to <AGENT_VILLAGE_HOME|~/.agent-village>/usage/<config-dir-name>.json. It never stores the
// prompt, transcript, cost or anything else from stdin, never reads credentials and never calls the network.
//
// Placed "in front of" an existing status line:  node claude-statusline-tap.mjs -- <original command>
// It forwards the same stdin to the original command and exits with its code. Any capture failure is
// silent: the status line must never break or slow down because of the village. (Pattern learned from
// Habblaud's statusline tap, MIT; implementation original.)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_REWRITE_MS = 10_000;

export function configDirOf(input, env = process.env, home = os.homedir()) {
  const tp = typeof input?.transcript_path === 'string' ? input.transcript_path : '';
  const norm = tp.replace(/\\/g, '/');
  const at = norm.lastIndexOf('/projects/');
  if (at > 0) return path.resolve(tp.slice(0, at));
  const fromEnv = (env.CLAUDE_CONFIG_DIR ?? '').split(',')[0].trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(home, '.claude');
}

function windowOf(w) {
  if (!w || typeof w !== 'object') return undefined;
  const raw = w.used_percentage ?? w.utilization ?? w.used_percent;
  const used = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  const out = { used_percentage: Math.min(100, Math.max(0, used)) };
  if (typeof w.resets_at === 'number' || typeof w.resets_at === 'string') out.resets_at = w.resets_at;
  return out;
}

/** Builds the minimal record to persist, or undefined when there is no quota data. Pure (tested). */
export function captureRecord(input, now = Date.now(), env = process.env, home = os.homedir()) {
  const rl = input?.rate_limits;
  const five = windowOf(rl?.five_hour);
  const week = windowOf(rl?.seven_day);
  if (!five && !week) return undefined;
  const configDir = configDirOf(input, env, home);
  const rec = { accountId: path.basename(configDir), fetchedAt: now };
  if (five) rec.five_hour = five;
  if (week) rec.seven_day = week;
  return rec;
}

export function writeCapture(rec, dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${rec.accountId.replace(/[^\w.-]/g, '_')}.json`);
  try {
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    const same = JSON.stringify({ ...prev, fetchedAt: 0 }) === JSON.stringify({ ...rec, fetchedAt: 0 });
    if (same && rec.fetchedAt - prev.fetchedAt < MIN_REWRITE_MS) return file;
  } catch { /* first write */ }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, file); // atomic: readers never see half a file
  return file;
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks);
  try {
    const rec = captureRecord(JSON.parse(raw.toString('utf8')));
    const home = (process.env.AGENT_VILLAGE_HOME ?? '').trim() || path.join(os.homedir(), '.agent-village');
    if (rec) writeCapture(rec, path.join(home, 'usage'));
  } catch { /* never break the status line */ }
  const i = process.argv.indexOf('--');
  const original = i >= 0 ? process.argv.slice(i + 1).join(' ').trim() : '';
  if (!original) return;
  // The original status line command is the user's own configured command, run the way Claude Code runs it.
  const child = spawn(original, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(raw);
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', () => process.exit(0));
}

const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && sameFile(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main();
}
