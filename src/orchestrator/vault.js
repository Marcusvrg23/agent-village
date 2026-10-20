// Context Vault: durable local mission artifacts (never the LLM history as the only memory). Lives under
// the village data folder (~/.agent-village/orchestrator) so it never writes into the user's repositories.
//   missions/<id>/mission.json · spec.md · events.jsonl · handoffs/ · evidence/ · release.md
//   audit.jsonl (approvals, runs, cancellations)
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^M-\d{8}-\d{6}-[a-z0-9]{4}$/;
const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

export function redact(text) {
  return String(text ?? '').replace(SECRET, '[segredo removido]');
}

export function newMissionId(now = new Date(), rand = Math.random) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const suffix = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)]).join('');
  return `M-${stamp}-${suffix}`;
}

export class ContextVault {
  constructor(root) {
    this.root = root;
    this.missionsDir = path.join(root, 'missions');
    mkdirSync(this.missionsDir, { recursive: true });
  }

  dir(id) {
    if (!SAFE_ID.test(id)) throw new Error(`Id de missão inválido: ${id}`);
    return path.join(this.missionsDir, id);
  }

  save(mission) {
    const d = this.dir(mission.id);
    mkdirSync(path.join(d, 'handoffs'), { recursive: true });
    mkdirSync(path.join(d, 'evidence'), { recursive: true });
    writeFileSync(path.join(d, 'mission.json'), `${JSON.stringify(mission, null, 2)}\n`);
  }

  writeArtifact(id, name, content) {
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(name) || name.includes('..')) throw new Error(`Nome de artefato inválido: ${name}`);
    const file = path.join(this.dir(id), name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, redact(content));
    return file;
  }

  appendEvent(id, event) {
    appendFileSync(path.join(this.dir(id), 'events.jsonl'), `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`);
  }

  audit(entry) {
    appendFileSync(path.join(this.root, 'audit.jsonl'), `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
  }

  load(id) {
    try { return JSON.parse(readFileSync(path.join(this.dir(id), 'mission.json'), 'utf8')); } catch { return null; }
  }

  list(limit = 30) {
    if (!existsSync(this.missionsDir)) return [];
    return readdirSync(this.missionsDir).filter((n) => SAFE_ID.test(n)).sort().reverse().slice(0, limit).map((id) => this.load(id)).filter(Boolean);
  }

  /** A retry must not accidentally serve the result of the previous attempt. */
  clearResult(id) {
    rmSync(path.join(this.dir(id), 'result.md'), { force: true });
  }

  /** Read a mission-local artifact without accepting arbitrary paths from callers. */
  readArtifact(id, name) {
    if (name !== 'result.md' && name !== 'release.md') throw new Error('Artefato não permitido.');
    const file = path.join(this.dir(id), name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  /** Durable team message bus: actual submitted prompts/replies/handoffs, not invented avatar chatter. */
  appendTeamMessage(id, message) {
    const entry = { ...message, text: redact(message.text) };
    appendFileSync(path.join(this.dir(id), 'team-conversation.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  teamMessages(id) {
    const file = path.join(this.dir(id), 'team-conversation.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  clearTeamMessages(id) {
    rmSync(path.join(this.dir(id), 'team-conversation.jsonl'), { force: true });
  }

  /** Measured acceptance per provider (for routing). Only gate outcomes count, never guesses. */
  history() {
    const out = {};
    for (const m of this.list(200)) {
      if (!m.adapter || !m.gate) continue;
      const h = (out[m.adapter] ??= { accepted: 0, total: 0 });
      h.total += 1;
      if (m.gate.status === 'READY') h.accepted += 1;
    }
    return out;
  }
}
