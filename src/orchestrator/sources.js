// Read-only local sources for real runtime data. Nothing here writes to provider folders, reads
// credentials (auth.json, keychains) or calls the network.
//  - Claude Code transcripts: <CLAUDE_CONFIG_DIR|~/.claude>/projects/<project>/<sessionId>.jsonl and
//    <sessionId>/subagents/agent-<id>.jsonl (format learned from Habblaud's parser, MIT).
//  - Codex rollouts: ~/.codex/sessions/**/rollout-*.jsonl (token_count.total_token_usage + rate_limits).
//  - Claude status line capture written by scripts/claude-statusline-tap.mjs (rate_limits only).
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeRateLimits, parseCodexRateLimits, toEpochMs } from './quota.js';
import { usageFromClaude, usageFromCodex } from './ledger.js';

const TAIL_BYTES = 512 * 1024;
export const ACTIVE_WINDOW_MS = 45_000;
const RECENT_MS = 24 * 3600_000;

export function claudeConfigDir(env = process.env, home = os.homedir()) {
  const raw = (env.CLAUDE_CONFIG_DIR ?? '').split(',')[0].trim();
  return raw ? path.resolve(raw.replace(/^~(?=[\\/]|$)/, home)) : path.join(home, '.claude');
}
export function codexHome(env = process.env, home = os.homedir()) {
  const raw = (env.CODEX_HOME ?? '').trim();
  return raw ? path.resolve(raw.replace(/^~(?=[\\/]|$)/, home)) : path.join(home, '.codex');
}
export function villageDataDir(env = process.env, home = os.homedir()) {
  const raw = (env.AGENT_VILLAGE_HOME ?? '').trim();
  return raw ? path.resolve(raw) : path.join(home, '.agent-village');
}

function safeStat(p) {
  try { return statSync(p); } catch { return null; }
}
function safeList(p) {
  try { return readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

/** Reads at most the last `max` bytes of a file (whole lines only). */
export function readTail(file, max = TAIL_BYTES) {
  const st = safeStat(file);
  if (!st?.isFile()) return '';
  const start = Math.max(0, st.size - max);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    closeSync(fd);
  }
}

function* jsonLines(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* partial or invalid line: skipped */ }
  }
}

// ---------------------------------------------------------------- Claude Code

const TEST_CMD = /\b(test|tests|pytest|jest|vitest|mocha|node --test|npm (run )?test|go test|cargo test|phpunit|rspec)\b/i;
const REVIEW_CMD = /\b(git (diff|log|show|status)|lint|eslint|tsc --noEmit|ruff|flake8)\b/i;

/** Claude tool call -> village technical state (and suggested role). Pure. */
export function claudeToolState(name, input = {}) {
  switch (name) {
    case 'Read': case 'Grep': case 'Glob': case 'LS': case 'WebFetch': case 'WebSearch':
      return { state: 'exploring', role: 'EXPLORER' };
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return { state: 'working', role: 'WORKER' };
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'ExitPlanMode':
      return { state: 'planning', role: 'LEAD' };
    case 'Agent': case 'Task':
      return { state: 'integrating', role: 'LEAD' };
    case 'Bash': {
      const cmd = String(input.command ?? '');
      if (TEST_CMD.test(cmd)) return { state: 'testing', role: 'QA' };
      if (REVIEW_CMD.test(cmd)) return { state: 'reviewing', role: 'REVIEWER' };
      return { state: 'working', role: 'WORKER' };
    }
    default:
      return name?.startsWith('mcp__rea') ? { state: 'exploring', role: 'RE_ANALYST' } : { state: 'working', role: 'WORKER' };
  }
}

/**
 * Parses one Claude Code transcript text. Usage per message id is taken as the max seen (lines of the same
 * message repeat the usage, sometimes partially). Never returns prompt or message content.
 */
/** Short label for a running command: its description when Claude gave one, else the start of the command. */
export function commandLabel(input = {}) {
  const d = typeof input.description === 'string' ? input.description.trim() : '';
  if (d) return d.slice(0, 60);
  const c = String(Array.isArray(input.command) ? input.command.join(' ') : input.command ?? '').replace(/\s+/g, ' ').trim();
  return c.length > 48 ? `${c.slice(0, 47)}…` : c;
}

export function parseClaudeTranscript(text) {
  const perMsg = new Map();
  const out = { sessionId: null, cwd: null, model: null, lastAt: 0, lastTool: null, toolCalls: 0, ended: false, gitBranch: null, pendingCommand: null, lastCommand: null };
  const commands = new Map(); // tool_use_id -> running Bash call (foreground only)
  for (const j of jsonLines(text)) {
    const at = toEpochMs(j.timestamp) ?? 0;
    if (at > out.lastAt) out.lastAt = at;
    if (typeof j.sessionId === 'string') out.sessionId = j.sessionId;
    if (typeof j.cwd === 'string') out.cwd = j.cwd;
    if (typeof j.gitBranch === 'string') out.gitBranch = j.gitBranch;
    if (j.type === 'user' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b?.type !== 'tool_result' || !commands.has(b.tool_use_id)) continue;
        const c = commands.get(b.tool_use_id);
        commands.delete(b.tool_use_id);
        out.lastCommand = { ...c, ok: b.is_error !== true, doneAt: at };
      }
      continue;
    }
    if (j.type !== 'assistant' || !j.message || typeof j.message !== 'object') continue;
    const m = j.message;
    if (typeof m.model === 'string' && m.model !== '<synthetic>') out.model = m.model;
    const id = m.id ?? j.requestId ?? j.uuid;
    if (id && m.usage) {
      const u = usageFromClaude(m.usage);
      const prev = perMsg.get(id);
      perMsg.set(id, prev ? Object.fromEntries(Object.keys(u).map((k) => [k, Math.max(prev[k] ?? 0, u[k] ?? 0) || (prev[k] ?? u[k])])) : u);
    }
    out.ended = m.stop_reason === 'end_turn';
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type !== 'tool_use') continue;
      out.toolCalls += 1;
      const target = typeof b.input?.file_path === 'string' ? path.basename(b.input.file_path) : null;
      out.lastTool = { name: String(b.name ?? 'tool'), at, target, ...claudeToolState(b.name, b.input ?? {}) };
      out.ended = false;
      if (b.name === 'Bash' && b.id && b.input?.run_in_background !== true) {
        commands.set(b.id, { at, label: commandLabel(b.input), ...claudeToolState('Bash', b.input) });
      }
    }
  }
  // The newest foreground command still without a result is "running" (tests, build, deploy...).
  for (const c of commands.values()) if (!out.pendingCommand || c.at > out.pendingCommand.at) out.pendingCommand = c;
  const usage = { input: null, cachedInput: null, cacheWrite: null, output: null, reasoning: null };
  for (const u of perMsg.values()) for (const k of Object.keys(usage)) if (u[k] !== null) usage[k] = (usage[k] ?? 0) + u[k];
  out.usage = usage;
  out.messages = perMsg.size;
  return out;
}

/** Recent Claude Code sessions with their subagents. Reads only files modified in the last 24 h. */
export function scanClaudeSessions({ configDir = claudeConfigDir(), now = Date.now(), cache = new Map() } = {}) {
  const projects = path.join(configDir, 'projects');
  const sessions = [];
  for (const proj of safeList(projects)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(projects, proj.name);
    for (const f of safeList(pdir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(pdir, f.name);
      const st = safeStat(file);
      if (!st || now - st.mtimeMs > RECENT_MS) continue;
      const parsed = cachedParse(cache, file, st);
      const sessionId = parsed.sessionId ?? f.name.replace(/\.jsonl$/, '');
      const subDir = path.join(pdir, sessionId, 'subagents');
      const subagents = [];
      for (const s of safeList(subDir)) {
        const m = /^agent-([\w-]+)\.jsonl$/.exec(s.name);
        if (!m) continue;
        const sf = path.join(subDir, s.name);
        const sst = safeStat(sf);
        if (!sst) continue;
        const sp = cachedParse(cache, sf, sst);
        subagents.push(summarize(`${sessionId}:${m[1]}`, sp, sst.mtimeMs, now, sessionId));
      }
      sessions.push({ ...summarize(sessionId, parsed, st.mtimeMs, now, null), subagents });
    }
  }
  return sessions.sort((a, b) => b.lastAt - a.lastAt);
}

function cachedParse(cache, file, st) {
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.parsed;
  const parsed = parseClaudeTranscript(st.size > 8 * 1024 * 1024 ? readTail(file, 8 * 1024 * 1024) : readFileSync(file, 'utf8'));
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, parsed });
  return parsed;
}

export const COMMAND_MAX_MS = 6 * 3600_000; // a "running" command older than this is treated as abandoned

function summarize(id, p, mtimeMs, now, parentId) {
  const lastAt = Math.max(p.lastAt, 0) || mtimeMs;
  // A long command writes nothing to the transcript while it runs: it keeps the session active on its own.
  const pending = p.pendingCommand && now - p.pendingCommand.at < COMMAND_MAX_MS ? p.pendingCommand : null;
  const active = (now - Math.max(lastAt, mtimeMs) < ACTIVE_WINDOW_MS && !p.ended) || Boolean(pending);
  return {
    provider: 'claude-code', id, parentId, project: p.cwd ? path.basename(p.cwd) : null, model: p.model, lastAt,
    active, state: pending ? pending.state : active ? p.lastTool?.state ?? 'working' : p.ended ? 'done' : 'idle',
    role: pending ? pending.role : p.lastTool?.role ?? (parentId ? 'WORKER' : 'LEAD'),
    lastTool: p.lastTool ? { name: p.lastTool.name, target: p.lastTool.target } : null, toolCalls: p.toolCalls, usage: p.usage,
    wait: pending ? { since: pending.at, label: pending.label } : null,
    lastCommand: p.lastCommand ? { ok: p.lastCommand.ok, at: p.lastCommand.doneAt, label: p.lastCommand.label, role: p.lastCommand.role } : null,
  };
}

// ---------------------------------------------------------------- Codex

/** Most recent rollouts (by mtime) under the sessions folder. */
export function recentRollouts(root, limit = 8, now = Date.now()) {
  const found = [];
  const walk = (dir, depth) => {
    for (const e of safeList(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        const st = safeStat(p);
        if (st && now - st.mtimeMs < 14 * RECENT_MS) found.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** Latest Codex quota + per-rollout cumulative usage, from the tails of recent rollouts. */
export function scanCodex({ home = codexHome(), now = Date.now() } = {}) {
  const sessionsRoot = path.join(home, 'sessions');
  let quota;
  const sessions = [];
  for (const r of recentRollouts(sessionsRoot, 8, now)) {
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(r.file)?.[1] ?? path.basename(r.file);
    let usage = null;
    let at = 0;
    for (const j of jsonLines(readTail(r.file))) {
      if (j.type !== 'event_msg' || j.payload?.type !== 'token_count') continue;
      const t = toEpochMs(j.timestamp) ?? r.mtimeMs;
      const total = j.payload.info?.total_token_usage;
      if (total && t >= at) { usage = usageFromCodex(total); at = t; }
      const snap = parseCodexRateLimits(j.payload.rate_limits, t);
      if (snap && (!quota || snap.fetchedAt > quota.fetchedAt)) quota = snap;
    }
    if (usage) sessions.push({ provider: 'codex', id, usage, at, file: path.basename(r.file) });
  }
  return { quota, sessions };
}

// ---------------------------------------------------------------- Claude status line capture

export function statuslineDir(env = process.env, home = os.homedir()) {
  return path.join(villageDataDir(env, home), 'usage');
}

/** Newest Claude quota snapshot among the tap files (one per Claude config dir). */
export function readClaudeStatusline(dir = statuslineDir(), now = Date.now(), captureId = null) {
  let best;
  // One file per Claude config dir, named after the folder (".claude.json", ".claude-trabalho.json").
  const only = captureId ? `${String(captureId).replace(/[^\w.-]/g, '_')}.json` : null;
  for (const e of safeList(dir)) {
    if (!e.isFile() || !e.name.endsWith('.json') || (only && e.name !== only)) continue;
    const file = path.join(dir, e.name);
    const st = safeStat(file);
    if (!st || st.size > 64 * 1024) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      const at = Math.min(now, toEpochMs(j.fetchedAt) ?? st.mtimeMs);
      const snap = parseClaudeRateLimits(j, at);
      if (snap && (!best || snap.fetchedAt > best.fetchedAt)) best = { ...snap, account: typeof j.accountId === 'string' ? j.accountId : null };
    } catch { /* half-written file: next poll */ }
  }
  return best;
}

/** Status line tap heartbeat ({seenAt, rateLimits}) for one Claude config dir, or null. */
export function readTapStatus(dir = statuslineDir(), captureId = '.claude') {
  try {
    const j = JSON.parse(readFileSync(path.join(dir, `${String(captureId).replace(/[^\w.-]/g, '_')}.tap`), 'utf8'));
    return typeof j.seenAt === 'number' ? { seenAt: j.seenAt, rateLimits: Boolean(j.rateLimits) } : null;
  } catch { return null; }
}

export const exists = existsSync;
