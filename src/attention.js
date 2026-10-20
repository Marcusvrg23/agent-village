// "Precisa de você": permission requests and waiting prompts coming from Claude Code / Codex hooks.
// Flow (pattern learned from Habblaud's permission hook, MIT; implementation original):
//   hook -> POST /api/village/hooks/permission  (only accepted while a village page is open)
//   hook -> GET  /api/village/hooks/permission/:id/wait  (long-poll, ~25 s per call)
//   page -> POST /api/village/attention/:id     {behavior: allow | deny | terminal, message?}
// The terminal dialog keeps working in parallel: whatever the operator answers first wins. Anything unclear
// (timeout, village closed, unknown answer) makes the hook exit without a decision, so the CLI asks as usual.
// Nothing here can approve by itself: every decision comes from a click in the page.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const MAX_PENDING = 30;
export const DEFAULT_TIMEOUT_MS = 300_000;
const NOTICE_TTL_MS = 30 * 60_000;
/** The hook polls continuously; silence this long means the CLI killed it (answered in the terminal). */
export const ORPHAN_MS = 40_000;
const PREVIEW_MAX = 400;

const str = (v, max = PREVIEW_MAX) => (typeof v === 'string' ? v.slice(0, max) : null);
const base = (p) => (typeof p === 'string' && p ? path.basename(p.replaceAll('\\', '/')) : null);

/** Short, human summary of what the agent wants to do (shown on the card; never the whole input). */
export function summarize(toolName, input = {}) {
  const t = String(toolName ?? 'ferramenta');
  const i = input && typeof input === 'object' ? input : {};
  if (/^(Bash|shell|exec_command|local_shell|PowerShell)$/i.test(t)) {
    const cmd = Array.isArray(i.command) ? i.command.join(' ') : i.command ?? i.cmd;
    return { kind: 'command', title: 'executar um comando', detail: str(cmd) ?? '', description: str(i.description, 160) };
  }
  if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/i.test(t)) {
    return { kind: 'edit', title: t === 'Write' ? 'criar ou sobrescrever um arquivo' : 'editar um arquivo', detail: i.file_path ?? i.notebook_path ?? i.path ?? '', file: base(i.file_path ?? i.notebook_path ?? i.path) };
  }
  if (/^(WebFetch|WebSearch)$/i.test(t)) return { kind: 'web', title: t === 'WebFetch' ? 'abrir uma página' : 'buscar na web', detail: str(i.url ?? i.query) ?? '' };
  if (t === 'AskUserQuestion') {
    const qs = Array.isArray(i.questions) ? i.questions.slice(0, 4) : [];
    return {
      kind: 'question', title: 'responder uma pergunta', detail: str(qs[0]?.question) ?? '',
      questions: qs.map((q) => ({ question: str(q?.question, 300) ?? '', options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o) => str(o?.label, 80) ?? '') })),
    };
  }
  if (t === 'ExitPlanMode') return { kind: 'plan', title: 'aprovar o plano e sair do modo de planejamento', detail: str(i.plan, 600) ?? '' };
  if (t.startsWith('mcp__')) return { kind: 'mcp', title: `usar a ferramenta ${t.split('__').slice(1).join(' › ')}`, detail: '' };
  return { kind: 'tool', title: `usar ${t}`, detail: '' };
}

export class AttentionDesk extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.items = new Map(); // id -> item
    this.waiters = new Map(); // id -> Set(resolve)
    this.viewers = 0; // open village pages (set by the control plane)
  }

  /**
   * Registers a permission request. Returns null when nobody could answer (no page open, queue full):
   * the hook then exits at once and the CLI shows its own dialog.
   */
  request({ provider, account = null, sessionId, agentId = null, toolName, toolInput, cwd = null, timeoutMs = DEFAULT_TIMEOUT_MS, lan = false } = {}) {
    this.#sweep();
    if (this.viewers < 1) return null;
    if ([...this.items.values()].filter((x) => x.status === 'pending').length >= MAX_PENDING) return null;
    const id = `A-${randomBytes(6).toString('hex')}`;
    const at = this.now();
    const item = {
      id, type: 'permission', status: 'pending', provider: provider === 'codex' ? 'codex' : 'claude-code', account: str(account, 60),
      sessionId: str(sessionId, 120), agentId: str(agentId, 120), tool: str(toolName, 80) ?? 'ferramenta', summary: summarize(toolName, toolInput),
      project: base(cwd), createdAt: at, lastPollAt: at, expiresAt: at + Math.max(5_000, Math.min(86_400_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)), decision: null,
    };
    // Codex fails closed on fields it does not support yet, so its answers are allow/deny/terminal only.
    item.canAnswer = item.summary.kind !== 'question';
    this.items.set(id, item);
    this.emit('change', { type: 'attention.new', item: this.publicItem(item) });
    return item;
  }

  /** "Waiting for you in the terminal" notices (Notification hook, idle_prompt / permission_prompt). */
  notice({ provider, account = null, sessionId, kind = 'idle_prompt', message = null, cwd = null } = {}) {
    this.#sweep();
    const key = `${provider}:${sessionId}`;
    for (const x of this.items.values()) if (x.type === 'notice' && x.key === key) this.items.delete(x.id);
    const id = `N-${randomBytes(6).toString('hex')}`;
    const at = this.now();
    const item = {
      id, key, type: 'notice', status: 'pending', provider: provider === 'codex' ? 'codex' : 'claude-code', account: str(account, 60), sessionId: str(sessionId, 120),
      kind: kind === 'permission_prompt' ? 'permission_prompt' : 'idle_prompt', message: str(message, 200), project: base(cwd), createdAt: at, expiresAt: at + NOTICE_TTL_MS, canAnswer: false,
    };
    this.items.set(id, item);
    this.emit('change', { type: 'attention.new', item: this.publicItem(item) });
    return item;
  }

  /** A session showed activity again: its "waiting in the terminal" notice is no longer true. */
  clearSession(provider, sessionId) {
    for (const x of [...this.items.values()]) {
      if (x.type === 'notice' && x.provider === provider && x.sessionId === sessionId) this.#resolve(x, { behavior: 'gone' });
    }
  }

  /** Operator decision from the page. */
  decide(id, { behavior, message = '' } = {}) {
    const item = this.items.get(id);
    if (!item || item.status !== 'pending') throw Object.assign(new Error('Pedido não encontrado ou já respondido.'), { status: 404 });
    if (item.type === 'notice') { this.#resolve(item, { behavior: 'seen' }); return this.publicItem(item); }
    if (!['allow', 'deny', 'terminal'].includes(behavior)) throw Object.assign(new Error('Resposta inválida.'), { status: 400 });
    if (behavior === 'allow' && !item.canAnswer) throw Object.assign(new Error('Este pedido só pode ser respondido no terminal.'), { status: 400 });
    this.#resolve(item, { behavior, message: str(String(message ?? '').trim(), 500) ?? '' });
    return this.publicItem(item);
  }

  /** Long-poll used by the hook. Resolves with {status:'decided', behavior, message} or {status:'pending'}. */
  wait(id, ms = 25_000) {
    const item = this.items.get(id);
    if (!item) return Promise.resolve({ status: 'gone' });
    if (item.status !== 'pending') return Promise.resolve({ status: 'decided', ...item.decision });
    if (this.now() >= item.expiresAt) { this.#resolve(item, { behavior: 'timeout' }); return Promise.resolve({ status: 'decided', behavior: 'timeout' }); }
    item.lastPollAt = this.now();
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const done = (v) => { clearTimeout(timer); set.delete(done); item.lastPollAt = this.now(); resolve(v); };
      const timer = setTimeout(() => done({ status: 'pending' }), Math.max(10, Math.min(ms, item.expiresAt - this.now())));
      timer.unref?.();
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  /** The hook gave up (CLI answered in the terminal, timeout): drop the card. */
  cancel(id) {
    const item = this.items.get(id);
    if (item && item.status === 'pending') this.#resolve(item, { behavior: 'terminal-answered' });
  }

  #resolve(item, decision) {
    item.status = 'resolved';
    item.decision = decision;
    item.resolvedAt = this.now();
    for (const done of this.waiters.get(item.id) ?? []) done({ status: 'decided', ...decision });
    this.waiters.delete(item.id);
    this.emit('change', { type: 'attention.resolved', id: item.id, behavior: decision.behavior });
  }

  #sweep() {
    const now = this.now();
    for (const x of [...this.items.values()]) {
      if (x.status === 'pending' && now >= x.expiresAt) this.#resolve(x, { behavior: 'timeout' });
      else if (x.status === 'pending' && x.type === 'permission' && !(this.waiters.get(x.id)?.size) && now - x.lastPollAt > ORPHAN_MS) this.#resolve(x, { behavior: 'terminal-answered' });
      if (x.status === 'resolved' && now - (x.resolvedAt ?? 0) > 60_000) this.items.delete(x.id);
    }
  }

  publicItem(x) {
    return {
      id: x.id, type: x.type, status: x.status, provider: x.provider, account: x.account, sessionId: x.sessionId, agentId: x.agentId ?? null,
      tool: x.tool ?? null, summary: x.summary ?? null, kind: x.kind ?? null, message: x.message ?? null, project: x.project, canAnswer: x.canAnswer,
      createdAt: x.createdAt, expiresAt: x.expiresAt,
    };
  }

  list() {
    this.#sweep();
    return [...this.items.values()].filter((x) => x.status === 'pending').sort((a, b) => a.createdAt - b.createdAt).map((x) => this.publicItem(x));
  }
}
