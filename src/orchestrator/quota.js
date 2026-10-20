// Provider quota windows (plan allowance) — pure parsing, rollover and state machine.
// Sources are local and read-only: Codex rollouts (token_count.rate_limits), the Codex app-server
// (account/rateLimits/read, no model turn) and the Claude Code status line capture (rate_limits).
// Rules (V2.1 spec): a window whose reset already passed has NO data (never shown as 0%); quota is per
// provider/account, never split per avatar; a visual refill only happens after provider-confirmed data.

export const PROVIDERS = Object.freeze(['claude-code', 'codex']);
export const STATES = Object.freeze(['UNKNOWN', 'FRESH', 'LOW', 'EXHAUSTED', 'AWAITING_PROVIDER_RESET', 'STALE']);
export const STALE_AFTER_MS = 30 * 60_000;
export const LOW_AT_PERCENT = 80;
const WINDOW_BY_MINUTES = { 300: 'fiveHour', 10080: 'weekly' };

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
export const toEpochMs = (v) => {
  const n = num(v);
  if (n !== undefined) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
};
const clampPct = (v) => Math.min(100, Math.max(0, v));

function codexWindow(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const used = num(raw.used_percent ?? raw.usedPercent);
  const minutes = num(raw.window_minutes ?? raw.windowDurationMins);
  const key = minutes !== undefined ? WINDOW_BY_MINUTES[minutes] : undefined;
  if (used === undefined || !key) return undefined;
  const w = { usedPercent: clampPct(used), windowMinutes: minutes };
  const resets = toEpochMs(raw.resets_at ?? raw.resetsAt);
  if (resets !== undefined) w.resetsAt = resets;
  return { key, window: w };
}

/**
 * Codex rate limits (rollout snake_case or app-server camelCase) -> snapshot. Only the default "codex"
 * quota is used: models with their own quota (other limit_id) would make the number jump between buckets.
 */
export function parseCodexRateLimits(raw, fetchedAt, source = 'codex-rollout') {
  if (!raw || typeof raw !== 'object') return undefined;
  const limit = raw.limit_id ?? raw.limitId;
  if (limit && limit !== 'codex') return undefined;
  const snap = { provider: 'codex', source, fetchedAt, windows: {} };
  const plan = raw.plan_type ?? raw.planType;
  if (typeof plan === 'string' && plan && plan !== 'unknown') snap.plan = plan;
  for (const w of [raw.primary, raw.secondary]) {
    const parsed = codexWindow(w);
    if (parsed && !snap.windows[parsed.key]) snap.windows[parsed.key] = parsed.window;
  }
  if (!raw.primary && (raw.rate_limit_reached_type ?? raw.rateLimitReachedType)) snap.noQuota = true;
  return Object.keys(snap.windows).length || snap.noQuota ? snap : undefined;
}

/** account/rateLimits/read response -> snapshot (prefers the "codex" bucket of the multi-bucket view). */
export function parseCodexAppServerLimits(result, fetchedAt) {
  if (!result || typeof result !== 'object') return undefined;
  const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  return parseCodexRateLimits(bucket, fetchedAt, 'codex-app-server');
}

/** Claude Code status line `rate_limits` ({five_hour, seven_day}: used_percentage, resets_at seconds). */
export function parseClaudeRateLimits(raw, fetchedAt, source = 'claude-statusline') {
  if (!raw || typeof raw !== 'object') return undefined;
  const snap = { provider: 'claude-code', source, fetchedAt, windows: {} };
  for (const [from, key, minutes] of [['five_hour', 'fiveHour', 300], ['seven_day', 'weekly', 10080]]) {
    const w = raw[from];
    const used = num(w?.used_percentage ?? w?.utilization ?? w?.used_percent);
    if (used === undefined) continue;
    const win = { usedPercent: clampPct(used), windowMinutes: minutes };
    const resets = toEpochMs(w.resets_at);
    if (resets !== undefined) win.resetsAt = resets;
    snap.windows[key] = win;
  }
  return Object.keys(snap.windows).length ? snap : undefined;
}

/** Windows whose reset already passed are dropped: the old percentage no longer means anything. */
export function rollover(snap, now) {
  if (!snap) return snap;
  const windows = {};
  const expired = [];
  for (const [k, w] of Object.entries(snap.windows ?? {})) {
    if (w.resetsAt !== undefined && w.resetsAt <= now) expired.push(k);
    else windows[k] = w;
  }
  return { ...snap, windows, expired };
}

export function deriveState(view, now) {
  if (!view.snapshot) return 'UNKNOWN';
  const snap = view.snapshot;
  const values = Object.values(snap.windows);
  if (!values.length && snap.expired?.length) return 'AWAITING_PROVIDER_RESET';
  if (now - snap.fetchedAt > STALE_AFTER_MS && !values.some((w) => w.usedPercent >= 100) && !snap.noQuota) return 'STALE';
  if (snap.noQuota || values.some((w) => w.usedPercent >= 100)) return 'EXHAUSTED';
  if (values.some((w) => w.usedPercent >= LOW_AT_PERCENT)) return 'LOW';
  if (!values.length) return snap.expired?.length ? 'AWAITING_PROVIDER_RESET' : 'UNKNOWN';
  return 'FRESH';
}

/** Keeps the newest snapshot per provider and decides what the Fountain shows. */
export class QuotaStore {
  constructor() {
    this.latest = new Map();
    this.refills = new Map(); // provider -> epoch ms of the last provider-confirmed refill
    this.lastState = new Map();
  }

  /** Returns true when the stored data changed. Detects a verified reset (refill) on the way in. */
  set(snap, now = Date.now()) {
    if (!snap || !PROVIDERS.includes(snap.provider)) return false;
    const prev = this.latest.get(snap.provider);
    if (prev && snap.fetchedAt < prev.fetchedAt) return false;
    const before = this.view(snap.provider, now);
    this.latest.set(snap.provider, snap);
    const after = this.view(snap.provider, now);
    const wasEmpty = ['AWAITING_PROVIDER_RESET', 'EXHAUSTED'].includes(before.state);
    const lower = (k) => before.snapshot?.windows?.[k] && after.snapshot.windows[k]
      && after.snapshot.windows[k].usedPercent < before.snapshot.windows[k].usedPercent;
    if (wasEmpty && ['FRESH', 'LOW'].includes(after.state) && (before.state === 'AWAITING_PROVIDER_RESET' || lower('fiveHour') || lower('weekly'))) {
      this.refills.set(snap.provider, now);
    }
    return JSON.stringify(prev) !== JSON.stringify(snap);
  }

  view(provider, now = Date.now()) {
    const raw = this.latest.get(provider);
    const snapshot = raw ? rollover(raw, now) : null;
    const v = { provider, snapshot };
    v.state = deriveState(v, now);
    v.quality = snapshot && Object.keys(snapshot.windows).length ? 'exact' : 'unavailable';
    v.stale = Boolean(raw && now - raw.fetchedAt > STALE_AFTER_MS);
    v.refilledAt = this.refills.get(provider) ?? null;
    const resets = Object.values(snapshot?.windows ?? {}).map((w) => w.resetsAt).filter(Boolean);
    v.nextReset = resets.length ? Math.min(...resets) : null;
    return v;
  }

  publicView(now = Date.now()) {
    return Object.fromEntries(PROVIDERS.map((p) => {
      const v = this.view(p, now);
      return [p, {
        state: v.state, quality: v.quality, stale: v.stale, refilledAt: v.refilledAt, nextReset: v.nextReset,
        plan: v.snapshot?.plan ?? null, source: v.snapshot?.source ?? null, fetchedAt: v.snapshot?.fetchedAt ?? null,
        windows: v.snapshot?.windows ?? {}, expired: v.snapshot?.expired ?? [], noQuota: Boolean(v.snapshot?.noQuota),
      }];
    }));
  }
}
