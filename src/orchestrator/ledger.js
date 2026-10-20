// Usage Ledger — append-only JSONL of measured token usage, kept local (.orchestrator/ledger/usage.jsonl).
// Each record is a cumulative snapshot of ONE session (provider-reported counters), deduplicated by id.
// Totals = sum over sessions of their latest snapshot, so restarts never double count and a quota reset
// never erases history. Unknown fields stay null (never 0, never estimated).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const TOKEN_FIELDS = Object.freeze(['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning']);

const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

export function normalizeUsage(raw = {}) {
  return Object.fromEntries(TOKEN_FIELDS.map((k) => [k, n(raw[k])]));
}

/** Codex `total_token_usage` / `turn.completed.usage` -> ledger usage (input already includes cached). */
export function usageFromCodex(raw = {}) {
  return normalizeUsage({
    input: raw.input_tokens, cachedInput: raw.cached_input_tokens, cacheWrite: raw.cache_write_input_tokens,
    output: raw.output_tokens, reasoning: raw.reasoning_output_tokens,
  });
}

/** Claude message usage -> ledger usage. Claude reports cache reads/writes separately from input. */
export function usageFromClaude(raw = {}) {
  const base = n(raw.input_tokens);
  const read = n(raw.cache_read_input_tokens);
  const write = n(raw.cache_creation_input_tokens);
  const input = base === null && read === null && write === null ? null : (base ?? 0) + (read ?? 0) + (write ?? 0);
  return normalizeUsage({ input, cachedInput: read, cacheWrite: write, output: raw.output_tokens, reasoning: null });
}

export function addUsage(a, b) {
  return Object.fromEntries(TOKEN_FIELDS.map((k) => [k, a[k] === null && b[k] === null ? null : (a[k] ?? 0) + (b[k] ?? 0)]));
}

export class UsageLedger {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'usage.jsonl') : null;
    this.ids = new Set();
    this.sessions = new Map(); // `${provider}:${sessionId}` -> latest record
    if (this.file && existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.#absorb(JSON.parse(line)); } catch { /* a broken line never stops the ledger */ }
      }
    }
  }

  #absorb(rec) {
    if (!rec?.id || this.ids.has(rec.id)) return false;
    this.ids.add(rec.id);
    const key = `${rec.provider}:${rec.sessionId}`;
    const prev = this.sessions.get(key);
    if (!prev || rec.at >= prev.at) this.sessions.set(key, { ...prev, ...rec, missionId: rec.missionId ?? prev?.missionId ?? null });
    return true;
  }

  /**
   * Records a cumulative session snapshot. Ignored when nothing changed since the last record for that
   * session (the id is derived from the counters, so identical snapshots dedupe across restarts too).
   */
  record({ provider, sessionId, missionId = null, agentId = null, model = null, usage, at = Date.now(), source }) {
    if (!provider || !sessionId || !usage) return false;
    const u = normalizeUsage(usage);
    const prev = this.sessions.get(`${provider}:${sessionId}`);
    if (prev && TOKEN_FIELDS.every((k) => prev.usage[k] === u[k]) && (missionId ?? null) === (prev.missionId ?? null)) return false;
    const id = `${provider}:${sessionId}:${TOKEN_FIELDS.map((k) => u[k] ?? '-').join('.')}:${missionId ?? ''}`;
    const rec = { id, provider, sessionId, missionId, agentId, model, usage: u, at, source, quality: 'exact' };
    if (!this.#absorb(rec)) return false;
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    }
    return true;
  }

  /** Links a session to a mission (village-launched runs) without inventing usage. */
  attachMission(provider, sessionId, missionId) {
    const prev = this.sessions.get(`${provider}:${sessionId}`);
    if (prev) return this.record({ ...prev, missionId, at: Date.now() });
    return false;
  }

  totals() {
    const empty = normalizeUsage({});
    const byProvider = {};
    const byMission = {};
    for (const rec of this.sessions.values()) {
      byProvider[rec.provider] = addUsage(byProvider[rec.provider] ?? empty, rec.usage);
      if (rec.missionId) byMission[rec.missionId] = addUsage(byMission[rec.missionId] ?? empty, rec.usage);
    }
    return { byProvider, byMission, sessions: this.sessions.size };
  }

  session(provider, sessionId) {
    return this.sessions.get(`${provider}:${sessionId}`) ?? null;
  }
}
