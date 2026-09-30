import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, mapAgentRole, normalizeState, readUsage, communicationEndpoints, STATES } from '../src/agent-registry.js';

const timestamp = '2026-09-30T12:00:00.000Z';
const now = Date.parse(timestamp);
const line = (type, payload, at = timestamp) => JSON.stringify({ type, payload, timestamp: at });
function registry() {
  const r = new AgentRegistry();
  r.select('main-id');
  r.metadata({ type: 'session_meta', payload: { id: 'main-id', cwd: 'C:\\test' } });
  return r;
}
const child = (id, path, kind = 'started', extra = {}) => line('event_msg', { type: 'sub_agent_activity', agent_thread_id: id, agent_path: path, kind, ...extra });

test('V1 role mapping respects metadata, canonical paths and observed tools', () => {
  for (const [name, role] of Object.entries({ root: 'LEAD', default: 'LEAD', main: 'LEAD', explorer: 'EXPLORER', worker: 'WORKER', review: 'REVIEWER', reviewer: 'REVIEWER', security: 'REVIEWER', qa: 'QA', test: 'QA', tests: 'QA', tester: 'QA' })) {
    assert.equal(mapAgentRole({ agentPath: `/root/${name}` }), role);
  }
  assert.equal(mapAgentRole({ role: 'security', agentPath: '/root/worker' }), 'REVIEWER');
  assert.equal(mapAgentRole({ activityRole: 'QA' }), 'QA');
  assert.equal(mapAgentRole({ agentPath: '/root/unfamiliar' }), 'GENERIC');
});

test('V1 parent child supports grandchildren and excludes unrelated sessions', () => {
  const r = registry();
  r.ingest(child('worker-id', '/root/worker'));
  r.ingest(child('qa-id', '/root/worker/tests'));
  const state = r.snapshot(now);
  const lead = state.agents.find((a) => a.role === 'LEAD');
  const worker = state.agents.find((a) => a.role === 'WORKER');
  const qa = state.agents.find((a) => a.role === 'QA');
  assert.equal(worker.parentId, lead.id);
  assert.equal(qa.parentId, worker.id);
  r.select('other');
  assert.equal(r.snapshot(now).agents.length, 1);
});

test('V1 explicit parent metadata handles non-hierarchical agent IDs', () => {
  const r = new AgentRegistry();
  r.select('child');
  r.metadata({ payload: { id: 'child', parent_thread_id: 'parent', agent_role: 'reviewer' } });
  const state = r.snapshot(now);
  assert.equal(state.agents.length, 2);
  assert.ok(state.agents.find((a) => a.role === 'REVIEWER').parentId);
});

test('V1 unknown agents stay generic and cycles cannot form', () => {
  const r = registry();
  r.ingest(child('unknown', '/root/strange'));
  const unknown = r.agents.get('unknown');
  r.attach(r.agents.get('main-id'), 'unknown');
  assert.equal(r.agents.get('main-id').parentId, null);
  assert.equal(unknown.role, 'GENERIC');
});

test('V1 normalized states cover phases and do not equate tool success with task done', () => {
  for (const state of STATES) assert.equal(normalizeState({}, state), state);
  for (const [role, state] of Object.entries({ EXPLORER: 'exploring', WORKER: 'working', REVIEWER: 'reviewing', QA: 'testing' })) {
    assert.equal(normalizeState({ state: 'ACTIVE', role }), state);
  }
  assert.equal(normalizeState({ state: 'DONE' }), 'waiting');
  assert.equal(normalizeState({ sourceSubtype: 'task_complete' }), 'done');
  assert.equal(normalizeState({ state: 'ERROR' }), 'failed');
});

test('V1 stale events never animate fictitious current work', () => {
  const r = registry();
  r.ingest(child('worker', '/root/worker'));
  assert.equal(r.snapshot(now).budget.activeAgents, 1);
  assert.equal(r.snapshot(now + 60_000).budget.activeAgents, 0);
});

test('V1 communication requires verifiable endpoints; trigger_turn cannot invent them', () => {
  assert.equal(communicationEndpoints({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }), null);
  assert.deepEqual(communicationEndpoints({ type: 'response_item', payload: { type: 'agent_message', author: '/root/worker', recipient: '/root/qa', content: 'PRIVATE' } }), {
    from: '/root/worker', to: '/root/qa', kind: 'message', label: 'Mensagem recebida',
  });
  const r = registry();
  r.ingest(child('worker', '/root/worker'));
  r.ingest(child('qa', '/root/qa'));
  r.ingest(line('response_item', { type: 'agent_message', author: '/root/worker', recipient: '/root/qa', content: 'PRIVATE' }));
  const state = r.snapshot(now);
  assert.equal(state.communications.length, 3);
  assert.equal(state.communications.at(-1).from, state.agents.find((a) => a.role === 'WORKER').id);
  assert.equal(state.communications.at(-1).to, state.agents.find((a) => a.role === 'QA').id);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
});

test('V1 usage is N/A when absent and never computes invented totals', () => {
  assert.deepEqual(readUsage(null), { input: null, cachedInput: null, output: null, total: null });
  assert.equal(readUsage({ input_tokens: 4, output_tokens: 5 }).total, null);
  assert.equal(registry().snapshot(now).usage.total, null);
});

test('V1 usage snapshots replace counts, do not add duplicates, and attribute owner', () => {
  const r = registry();
  r.ingest(line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 } } }));
  r.ingest(line('token_usage_record', { thread_id: 'main-id', thread_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 } }));
  r.ingest(line('token_usage_record', { thread_id: 'unrelated', thread_token_usage: { total_tokens: 9999 } }));
  assert.equal(r.snapshot(now).usage.total, 120);
  assert.equal(r.snapshot(now).usage.cachedInput, 40);
});

test('V1 duplicate events do not duplicate agents, communication, or timeline', () => {
  const r = registry();
  const event = child('one', '/root/worker');
  r.ingest(event); r.ingest(event);
  const state = r.snapshot(now);
  assert.equal(state.agents.length, 2);
  assert.equal(state.communications.length, 1);
  assert.equal(state.agents.find((a) => a.role === 'WORKER').activities.length, 1);
  assert.equal(state.duplicatesIgnored, 1);
});

test('V1 detail includes sanitized IDs, tools and bounded operational timeline only', () => {
  const r = registry();
  r.ingest(line('response_item', { type: 'reasoning', summary: 'PRIVATE', encrypted_content: 'SECRET' }));
  r.ingest(line('response_item', { type: 'function_call', name: 'exec', arguments: 'token=SECRET' }), { operational: true, role: 'EXPLORER', state: 'ACTIVE', summary: 'Reading package.json' });
  const agent = r.snapshot(now).agents[0];
  assert.match(agent.id, /^agent-[a-f0-9]{12}$/);
  assert.deepEqual(agent.tools, ['exec']);
  assert.equal(agent.activities[0].summary, 'Reading package.json');
  assert.ok(!JSON.stringify(agent).includes('SECRET'));
  assert.ok(!JSON.stringify(agent).includes('PRIVATE'));
});

test('V1 max concurrent config is advisory and counts only fresh real agents', () => {
  const r = registry();
  for (let i = 0; i < 4; i++) r.ingest(child(`worker-${i}`, `/root/worker_${i}`));
  const state = r.snapshot(now);
  assert.equal(state.budget.maxConcurrentAgents, 3);
  assert.equal(state.budget.activeAgents, 4);
  assert.equal(state.budget.exceeded, true);
  assert.equal(state.budget.advisoryOnly, true);
  assert.throws(() => new AgentRegistry({ maxConcurrentAgents: 0 }));
});

test('V1 inherited metadata does not overwrite the selected agent identity', () => {
  const r = registry();
  r.ingest(line('session_meta', { id: 'old-parent', agent_path: '/root/worker' }));
  assert.equal(r.snapshot(now).agents.length, 1);
  assert.equal(r.snapshot(now).agents[0].role, 'LEAD');
});
