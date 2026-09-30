// Read-only replay of a real, explicitly selected rollout. Never a live PASS substitute.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { AgentRegistry, readSessionMetadata } from '../src/agent-registry.js';
import { EventNormalizer } from '../src/event-normalizer.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/verify-v1-recording.mjs <existing rollout>');
const metadata = await readSessionMetadata(file);
const registry = new AgentRegistry();
registry.select(metadata?.payload?.id ?? metadata?.payload?.session_id);
registry.metadata(metadata);
const normalizer = new EventNormalizer();
let lines = 0;
for await (const line of createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })) {
  registry.ingest(line, normalizer.ingestLine(line));
  lines++;
}
const state = registry.snapshot();
console.log(JSON.stringify({ source: 'existing real recording; read-only', lines,
  agents: state.agents.map(({ id, role, parentId, agentPath, usage }) => ({ id, role, parentId, agentPath, usage })),
  communications: state.communications.map(({ from, to, kind, label }) => ({ from, to, kind, label })),
  usage: state.usage, duplicatesIgnored: state.duplicatesIgnored,
}, null, 2));
