// Phone on the local network (optional, VILLAGE_LAN=1). A second port listens on the network; the main port
// stays on 127.0.0.1. What separates the two is the port a connection arrived on, never the Host header.
// Pairing: the computer shows an 8-character code (rotates every 10 min and after each pairing); the phone types
// it once and receives an HttpOnly cookie. Wrong codes are rate limited. A paired phone can only watch the
// village and answer "precisa de você" requests: no missions, no settings, no Ops Room.
// Plain HTTP on the LAN: use only on trusted networks (documented); "Desconectar celulares" revokes everything.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_FAILS = 5;
export const LOCK_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const COOKIE = 'av_lan';

export function newCode(len = 8) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const eq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) out.push(`http://${n.address}:${port}/village/`);
    }
  }
  return out;
}

export function cookieOf(req, name = COOKIE) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export class LanPairing {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.sessions = new Map(); // key -> {createdAt, lastSeen, label, csrf}
    this.fails = [];
    this.lockedUntil = 0;
    this.rotate();
  }

  rotate() {
    this.code = newCode();
    this.codeExpires = this.now() + CODE_TTL_MS;
  }

  current() {
    if (this.now() >= this.codeExpires) this.rotate();
    return { code: this.code, expiresAt: this.codeExpires };
  }

  /** Returns a new session or throws (wrong code, locked). */
  pair(code, label = 'celular') {
    const now = this.now();
    if (now < this.lockedUntil) throw Object.assign(new Error('Muitas tentativas erradas. Espere alguns minutos e gere um código novo no computador.'), { status: 429 });
    this.current();
    const typed = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!typed || !eq(typed, this.code)) {
      this.fails = this.fails.filter((t) => now - t < LOCK_MS);
      this.fails.push(now);
      if (this.fails.length >= MAX_FAILS) { this.lockedUntil = now + LOCK_MS; this.fails = []; this.rotate(); }
      throw Object.assign(new Error('Código incorreto.'), { status: 403 });
    }
    this.fails = [];
    this.rotate(); // one code, one phone
    const key = randomBytes(24).toString('base64url');
    const s = { createdAt: now, lastSeen: now, label: String(label).slice(0, 40), csrf: randomBytes(18).toString('base64url') };
    this.sessions.set(key, s);
    return { key, csrf: s.csrf };
  }

  session(req) {
    const key = cookieOf(req);
    if (!key) return null;
    const s = this.sessions.get(key);
    if (!s) return null;
    if (this.now() - s.createdAt > SESSION_TTL_MS) { this.sessions.delete(key); return null; }
    s.lastSeen = this.now();
    return s;
  }

  revokeAll() {
    this.sessions.clear();
    this.rotate();
  }

  devices() {
    return [...this.sessions.values()].map((s) => ({ label: s.label, createdAt: s.createdAt, lastSeen: s.lastSeen }));
  }
}
