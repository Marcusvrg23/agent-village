// Shared test helper: temp HOME with fake `claude`/`codex` CLIs on PATH (shell wrappers on Unix, .cmd on Windows).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
export const unix = process.platform !== 'win32';
export const tmp = (prefix = 'av-') => mkdtempSync(path.join(os.tmpdir(), prefix));

export function sandbox(extraEnv = {}, { claudeDirs = ['.claude'], codexDirs = ['.codex'] } = {}) {
  const home = tmp('av-home-');
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    if (unix) {
      const f = path.join(bin, name);
      writeFileSync(f, `#!/bin/sh\nFAKE_CLI_NAME=${name} exec "${process.execPath}" "${FAKE}" "$@"\n`);
      chmodSync(f, 0o755);
    } else {
      writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\nset FAKE_CLI_NAME=${name}\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
    }
  }
  for (const d of claudeDirs) mkdirSync(path.join(home, d, 'projects'), { recursive: true });
  for (const d of codexDirs) mkdirSync(path.join(home, d, 'sessions'), { recursive: true });
  mkdirSync(path.join(home, 'proj'));
  const log = path.join(home, 'calls.jsonl');
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    HOME: home, USERPROFILE: home, AGENT_VILLAGE_HOME: path.join(home, '.agent-village'), VILLAGE_PROJECT_ROOTS: home, FAKE_LOG: log, ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { home, env, calls, proj: path.join(home, 'proj') };
}

export const waitFor = async (fn, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout');
};
