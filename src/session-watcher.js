import { watch, watchFile, unwatchFile } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

const ROLLOUT_PATTERN = /^rollout-.*\.jsonl$/i;

export function chooseLatest(candidates) {
  return [...candidates].sort((a, b) => (b.activityMs ?? b.mtimeMs) - (a.activityMs ?? a.mtimeMs) || b.path.localeCompare(a.path))[0] ?? null;
}

export async function findRollouts(root) {
  const found = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) throw error;
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return visit(fullPath);
      if (!entry.isFile() || !ROLLOUT_PATTERN.test(entry.name)) return;
      try {
        const info = await stat(fullPath);
        found.push({ path: fullPath, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // A session may rotate between discovery and stat.
      }
    }));
  }

  await visit(root);
  return found;
}

export class LineAccumulator {
  constructor(onLine) {
    this.onLine = onLine;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
  }

  push(buffer) {
    const text = this.partial + this.decoder.write(buffer);
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  }

  reset() {
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
  }
}

export class SessionWatcher {
  constructor({ root, onLine, onSwitch, onDebug, onError, discoveryInterval = 4_000, watchInterval = 750, initialBytes = 600_000 }) {
    this.root = root;
    this.onLine = onLine;
    this.onSwitch = onSwitch;
    this.onDebug = onDebug;
    this.onError = onError;
    this.discoveryInterval = discoveryInterval;
    this.watchInterval = watchInterval;
    this.initialBytes = initialBytes;
    this.current = null;
    this.offset = 0;
    this.linesProcessed = 0;
    this.rootWatcher = null;
    this.discoveryTimer = null;
    this.discoveryDebounce = null;
    this.reading = false;
    this.readAgain = false;
    this.switchGeneration = 0;
    this.fileObservations = new Map();
    this.accumulator = new LineAccumulator((line) => {
      this.linesProcessed += 1;
      this.onLine(line);
      this.emitDebug();
    });
  }

  async start() {
    await this.discover();
    try {
      this.rootWatcher = watch(this.root, { recursive: true }, () => this.scheduleDiscovery());
      this.rootWatcher.on('error', (error) => this.reportError(error));
    } catch {
      // The periodic discovery below is the defensive fallback.
    }
    this.discoveryTimer = setInterval(() => this.discover().catch((error) => this.reportError(error)), this.discoveryInterval);
    this.discoveryTimer.unref?.();
  }

  stop() {
    if (this.current?.path) unwatchFile(this.current.path);
    this.rootWatcher?.close();
    clearInterval(this.discoveryTimer);
    clearTimeout(this.discoveryDebounce);
  }

  scheduleDiscovery() {
    clearTimeout(this.discoveryDebounce);
    this.discoveryDebounce = setTimeout(() => this.discover().catch((error) => this.reportError(error)), 120);
  }

  async discover() {
    const now = Date.now();
    const files = await findRollouts(this.root);
    const observed = files.map((file) => {
      const previous = this.fileObservations.get(file.path);
      const changed = previous && (previous.size !== file.size || previous.mtimeMs !== file.mtimeMs);
      const activityMs = changed ? now : previous?.activityMs ?? file.mtimeMs;
      const next = { ...file, activityMs };
      this.fileObservations.set(file.path, next);
      return next;
    });
    const currentPaths = new Set(files.map((file) => file.path));
    for (const filePath of this.fileObservations.keys()) {
      if (!currentPaths.has(filePath)) this.fileObservations.delete(filePath);
    }
    const latest = chooseLatest(observed);
    if (!latest) {
      this.emitDebug();
      return;
    }
    if (!this.current || latest.path !== this.current.path) {
      await this.switchTo(latest);
      return;
    }
    this.current = { ...this.current, ...latest };
    this.emitDebug();
  }

  async switchTo(file) {
    const generation = ++this.switchGeneration;
    if (this.current?.path) unwatchFile(this.current.path);
    this.current = file;
    this.offset = 0;
    this.linesProcessed = 0;
    this.accumulator.reset();
    this.onSwitch(file);

    try {
      const info = await stat(file.path);
      const start = Math.max(0, info.size - this.initialBytes);
      const buffer = Buffer.alloc(info.size - start);
      if (buffer.length) {
        const handle = await open(file.path, 'r');
        try {
          await handle.read(buffer, 0, buffer.length, start);
        } finally {
          await handle.close();
        }
      }
      if (generation !== this.switchGeneration) return;
      let usable = buffer;
      if (start > 0) {
        const newline = buffer.indexOf(0x0a);
        usable = newline >= 0 ? buffer.subarray(newline + 1) : Buffer.alloc(0);
      }
      this.offset = info.size;
      if (usable.length) this.accumulator.push(usable);
      this.current = { ...this.current, path: file.path, size: info.size, mtimeMs: info.mtimeMs };
      this.emitDebug();
    } catch (error) {
      this.reportError(error);
    }

    watchFile(file.path, { interval: this.watchInterval, persistent: false }, (current, previous) => {
      this.current = { ...this.current, path: file.path, size: current.size, mtimeMs: current.mtimeMs };
      if (current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) {
        this.tail().catch((error) => this.reportError(error));
        this.scheduleDiscovery();
      }
    });
    await this.tail();
  }

  async tail() {
    if (!this.current?.path) return;
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    const generation = this.switchGeneration;
    try {
      do {
        this.readAgain = false;
        const info = await stat(this.current.path);
        if (info.size < this.offset) {
          this.offset = 0;
          this.accumulator.reset();
        }
        if (info.size > this.offset) {
          const handle = await open(this.current.path, 'r');
          try {
            while (this.offset < info.size && generation === this.switchGeneration) {
              const length = Math.min(256_000, info.size - this.offset);
              const buffer = Buffer.alloc(length);
              const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
              if (!bytesRead) break;
              this.offset += bytesRead;
              this.accumulator.push(buffer.subarray(0, bytesRead));
            }
          } finally {
            await handle.close();
          }
        }
        this.current = { ...this.current, path: this.current.path, size: info.size, mtimeMs: info.mtimeMs };
        this.emitDebug();
      } while (this.readAgain && generation === this.switchGeneration);
    } finally {
      this.reading = false;
    }
  }

  emitDebug() {
    this.onDebug?.({
      root: this.root,
      path: this.current?.path ?? null,
      lastWriteTime: this.current?.mtimeMs ? new Date(this.current.mtimeMs).toISOString() : null,
      lastObservedActivity: this.current?.activityMs ? new Date(this.current.activityMs).toISOString() : null,
      offset: this.offset,
      size: this.current?.size ?? 0,
      linesProcessed: this.linesProcessed,
      partialBytesBuffered: Buffer.byteLength(this.accumulator.partial, 'utf8'),
      strategy: 'bounded bootstrap + byte-offset tail; fs.watch with periodic discovery fallback',
    });
  }

  reportError(error) {
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
