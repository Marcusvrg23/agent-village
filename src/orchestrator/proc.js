// Safe process helpers for provider CLIs. User text is NEVER placed on a command line: prompts go through
// stdin. On Windows, npm-installed CLIs are .cmd shims that Node can only start through a shell; that is
// allowed only when every argument is a fixed, inert token (validated below), so no user text reaches cmd.exe.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

const SAFE_ARG = /^[\w@%+=:,./\\-]*$/;

/** Env for provider children: API-key variables are removed so only subscription logins can be used. */
export function subscriptionEnv(base = process.env, strip = []) {
  const env = { ...base };
  for (const k of strip) delete env[k];
  return env;
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
function isExecutable(p) {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

/** Resolves a command on PATH (with PATHEXT on Windows). Returns {file, shell} or null. */
export function resolveCommand(name, { env = process.env, platform = process.platform } = {}) {
  if (!name) return null;
  const win = platform === 'win32';
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const dirs = path.isAbsolute(name) ? [''] : (env.PATH ?? env.Path ?? '').split(win ? ';' : path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of win && !path.extname(name) ? exts : ['']) {
      const file = dir ? path.join(dir, name + ext) : name + ext;
      if (!isFile(file) || (!win && !isExecutable(file))) continue;
      return { file, shell: win && /\.(cmd|bat)$/i.test(file) };
    }
  }
  return null;
}

function checkArgs(resolved, args) {
  if (resolved.shell) {
    for (const a of args) if (!SAFE_ARG.test(a)) throw new Error(`Argumento inseguro para shell: ${JSON.stringify(a)}`);
  }
}

/** Runs a command to completion. {code, stdout, stderr, timedOut}. Never throws for non-zero exits. */
export function runOnce(resolved, args, { cwd, env, input = null, timeoutMs = 20_000 } = {}) {
  checkArgs(resolved, args);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    try {
      child = spawnResolved(resolved, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error.message), timedOut: false, error: true });
      return;
    }
    const timer = setTimeout(() => { if (!done) { child.kill(); resolve({ code: null, stdout, stderr, timedOut: true }); done = true; } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.on('error', (error) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(error.message), timedOut: false, error: true }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut: false }); } });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/**
 * Starts a streaming JSONL process. `onEvent(obj)` per JSON line, `onRaw(line)` for non-JSON lines.
 * Returns {child, done: Promise<{code, signal}>, stop(reason)}.
 */
/**
 * Starts a resolved command. A .cmd shim (Windows) needs a shell: the command line is built here from the
 * quoted path plus arguments already checked by SAFE_ARG, instead of passing an args array with
 * `shell: true` (deprecated in Node, DEP0190, because Node would join them unescaped).
 */
export function spawnResolved(resolved, args, options) {
  if (!resolved.shell) return spawn(resolved.file, args, options);
  checkArgs(resolved, args);
  return spawn(commandLine(resolved.file, args), { ...options, shell: true });
}

/** Pure (tested): "C:\\Program Files\\x\\claude.cmd" -p --verbose */
export function commandLine(file, args) {
  return [`"${file}"`, ...args].join(' ');
}

export function startStream(resolved, args, { cwd, env, input = '', onEvent, onRaw, onStderr } = {}) {
  checkArgs(resolved, args);
  const child = spawnResolved(resolved, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { onRaw?.(line); continue; }
      onEvent?.(obj);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => onStderr?.(d));
  child.stdin.on('error', () => {});
  if (input !== null) child.stdin.end(input); // null keeps stdin open for request/response protocols
  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error: String(error.message) }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    done,
    stop() {
      if (child.exitCode !== null || child.killed) return;
      // SIGINT first lets the CLI end its turn cleanly; force after a grace period.
      try { child.kill('SIGINT'); } catch { /* already gone */ }
      setTimeout(() => { if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, 4_000).unref();
    },
  };
}
