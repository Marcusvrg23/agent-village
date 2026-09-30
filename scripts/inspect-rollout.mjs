import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.homedir(), '.codex', 'sessions');

async function collect(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(fullPath, result);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
      const info = await stat(fullPath);
      result.push({ path: fullPath, mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  return result;
}

function describe(record) {
  const payload = record?.payload ?? {};
  const contentTypes = Array.isArray(payload.content)
    ? [...new Set(payload.content.map((item) => item?.type).filter(Boolean))].sort()
    : [];
  return {
    type: record?.type ?? 'missing',
    payloadType: payload.type ?? 'missing',
    role: payload.role ?? null,
    name: payload.name ?? payload.tool_name ?? null,
    payloadKeys: Object.keys(payload).sort(),
    contentTypes,
  };
}

const files = await collect(root);
files.sort((a, b) => b.mtimeMs - a.mtimeMs);
const selected = files[0];
if (!selected) throw new Error(`No rollout found under ${root}`);

const sampleBytes = Math.min(selected.size, 1_000_000);
const handle = await open(selected.path, 'r');
const startBuffer = Buffer.alloc(Math.min(sampleBytes, 400_000));
const tailBuffer = Buffer.alloc(Math.min(sampleBytes, 600_000));
await handle.read(startBuffer, 0, startBuffer.length, 0);
await handle.read(tailBuffer, 0, tailBuffer.length, Math.max(0, selected.size - tailBuffer.length));
await handle.close();

const text = `${startBuffer.toString('utf8')}\n${tailBuffer.toString('utf8')}`;
const lines = text.split(/\r?\n/);
const shapes = new Map();
const tools = new Map();
let metadata = null;
let parsed = 0;
const agentEvidence = [];
const subagentKinds = new Map();

for (const line of lines) {
  try {
    const record = JSON.parse(line);
    parsed += 1;
    const shape = describe(record);
    const key = JSON.stringify(shape);
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
    if (shape.name) tools.set(shape.name, (tools.get(shape.name) ?? 0) + 1);
    if (!metadata && record?.type === 'session_meta') {
      metadata = {
        id: record.payload.id ?? null,
        cwd: record.payload.cwd ?? null,
        originator: record.payload.originator ?? null,
        source: record.payload.source ?? null,
        timestamp: record.timestamp ?? null,
      };
    }
    if (record?.type === 'session_meta' && (record.payload?.agent_nickname || record.payload?.forked_from_id)) {
      agentEvidence.push({
        id: record.payload.id ?? null,
        nickname: record.payload.agent_nickname ?? null,
        agentPath: record.payload.agent_path ?? null,
        parentThreadId: record.payload.parent_thread_id ?? null,
        forkedFromId: record.payload.forked_from_id ?? null,
      });
    }
    if (record?.type === 'event_msg' && record.payload?.type === 'sub_agent_activity') {
      const key = `${record.payload.kind ?? 'unknown'} | ${record.payload.agent_path ?? 'unknown'}`;
      subagentKinds.set(key, (subagentKinds.get(key) ?? 0) + 1);
    }
  } catch {
    // Boundary fragments and malformed lines are deliberately ignored.
  }
}

const rankedShapes = [...shapes.entries()]
  .map(([key, count]) => ({ count, ...JSON.parse(key) }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 50);

console.log(JSON.stringify({
  root,
  selected: { path: selected.path, size: selected.size, mtime: new Date(selected.mtimeMs).toISOString() },
  parsedSampleRecords: parsed,
  metadata,
  agentEvidence,
  subagentKinds: Object.fromEntries([...subagentKinds.entries()].sort((a, b) => b[1] - a[1])),
  tools: Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1])),
  shapes: rankedShapes,
}, null, 2));
