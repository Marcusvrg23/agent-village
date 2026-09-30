import test from 'node:test';
import assert from 'node:assert/strict';
import { EventNormalizer, classifyToolCall, extractWorkdir, parseJsonLine } from '../src/event-normalizer.js';

test('parseJsonLine tolerates malformed and unknown input', () => {
  assert.equal(parseJsonLine('{"type":').kind, 'invalid');
  const normalizer = new EventNormalizer();
  const result = normalizer.ingestLine('{"type":"future_event","payload":{"type":"new_shape"}}');
  assert.equal(result.recognized, false);
  assert.equal(result.unknown, 'future_event:new_shape');
});

test('classifies observable commands into operational phases', () => {
  assert.equal(classifyToolCall('exec', { cmd: 'rg --files src' }).role, 'EXPLORER');
  assert.equal(classifyToolCall('exec', { cmd: 'git diff -- src/app.js' }).role, 'REVIEWER');
  assert.equal(classifyToolCall('exec', { cmd: 'node --test' }).role, 'QA');
  assert.equal(classifyToolCall('apply_patch', '*** Begin Patch').role, 'WORKER');
});

test('derives current project context from an observable exec workdir', () => {
  const source = 'const r = await tools.exec_command({"cmd":"node --test","workdir":"C:\\\\Users\\\\Dell\\\\Desktop\\\\codex agents"});';
  assert.equal(extractWorkdir(source), 'C:\\Users\\Dell\\Desktop\\codex agents');
  const normalizer = new EventNormalizer();
  const event = normalizer.ingestRecord({
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'cwd', input: source },
  });
  assert.equal(event.meta.project, 'codex agents');
});

test('reads real session metadata shape without exposing message content', () => {
  const normalizer = new EventNormalizer();
  const result = normalizer.ingestRecord({
    type: 'session_meta',
    timestamp: '2026-09-22T10:00:00.000Z',
    payload: { id: 'session-1', cwd: 'C:\\work\\ops-room', base_instructions: 'private' },
  });
  assert.deepEqual(result.meta, { sessionId: 'session-1', cwd: 'C:\\work\\ops-room', project: 'ops-room' });
  assert.equal(result.operational, false);
});

test('suppresses reasoning records', () => {
  const normalizer = new EventNormalizer();
  const result = normalizer.ingestRecord({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'secret' } });
  assert.equal(result.recognized, true);
  assert.equal(result.operational, false);
  assert.equal(result.privateContentSuppressed, true);
});

test('correlates QA tool output and reports objective test progress', () => {
  const normalizer = new EventNormalizer();
  const started = normalizer.ingestRecord({
    type: 'response_item',
    timestamp: '2026-09-22T10:00:00.000Z',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input: '{"cmd":"node --test"}' },
  });
  assert.equal(started.role, 'QA');
  assert.equal(started.state, 'ACTIVE');
  const finished = normalizer.ingestRecord({
    type: 'response_item',
    timestamp: '2026-09-22T10:00:01.000Z',
    payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: '# tests 5\n# pass 5\n# fail 0' },
  });
  assert.equal(finished.state, 'DONE');
  assert.equal(finished.progress, '5 passed');
});

test('recognizes Node test runner informational pass totals', () => {
  const normalizer = new EventNormalizer();
  normalizer.ingestRecord({
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'node-test', input: '{"cmd":"node --test"}' },
  });
  const finished = normalizer.ingestRecord({
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: 'node-test', output: 'ℹ tests 12\nℹ pass 12\nℹ fail 0' },
  });
  assert.equal(finished.progress, '12 passed');
  assert.equal(finished.state, 'DONE');
});

test('switches to multi-agent mode only with observable agent evidence', () => {
  const normalizer = new EventNormalizer();
  const ordinary = normalizer.ingestRecord({
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec', call_id: 'one', arguments: '{"cmd":"Get-Content README.md"}' },
  });
  assert.equal(ordinary.mode, 'SINGLE_AGENT');
  const delegated = normalizer.ingestRecord({
    type: 'response_item',
    payload: { type: 'function_call', name: 'spawn_agent', call_id: 'two', arguments: '{"task_name":"audit"}' },
  });
  assert.equal(delegated.mode, 'MULTI_AGENT');
  assert.deepEqual(delegated.agents, ['audit']);
});

test('does not treat agent words inside a patch as subagent evidence', () => {
  const normalizer = new EventNormalizer();
  const patch = normalizer.ingestRecord({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'patch',
      input: 'const result = await tools.apply_patch("+ spawn_agent example in documentation");',
    },
  });
  assert.equal(patch.mode, 'SINGLE_AGENT');
  assert.deepEqual(patch.agents, []);
  assert.equal(patch.role, 'WORKER');
});

test('uses explicit rollout subagent metadata as verified evidence', () => {
  const normalizer = new EventNormalizer();
  const meta = normalizer.ingestRecord({
    type: 'session_meta',
    payload: { id: 'agent-id', cwd: 'C:\\work', agent_nickname: 'Archimedes', agent_path: '/root/reviewer', forked_from_id: 'parent-id' },
  });
  assert.equal(meta.mode, 'MULTI_AGENT');
  assert.deepEqual(meta.agents, ['Archimedes — /root/reviewer']);
  const activity = normalizer.ingestRecord({
    type: 'event_msg',
    payload: { type: 'sub_agent_activity', kind: 'started', agent_path: '/root/tests', occurred_at_ms: 1_790_000_000_000 },
  });
  assert.equal(activity.mode, 'MULTI_AGENT');
  assert.equal(activity.role, 'LEAD');
  assert.match(activity.summary, /\/root\/tests/);
});
