import test from 'node:test';
import assert from 'node:assert/strict';
import { LineAccumulator, chooseLatest } from '../src/session-watcher.js';

test('chooseLatest selects the most recently written rollout', () => {
  const selected = chooseLatest([
    { path: 'older.jsonl', mtimeMs: 100, size: 5 },
    { path: 'newer.jsonl', mtimeMs: 200, size: 5 },
  ]);
  assert.equal(selected.path, 'newer.jsonl');
});

test('chooseLatest prefers observed growth over stale LastWriteTime', () => {
  const selected = chooseLatest([
    { path: 'newer-start.jsonl', mtimeMs: 300, activityMs: 300 },
    { path: 'actively-growing.jsonl', mtimeMs: 100, activityMs: 500 },
  ]);
  assert.equal(selected.path, 'actively-growing.jsonl');
});

test('LineAccumulator holds a partial JSONL line until it is complete', () => {
  const lines = [];
  const accumulator = new LineAccumulator((line) => lines.push(line));
  accumulator.push(Buffer.from('{"type":"event_msg"'));
  assert.deepEqual(lines, []);
  accumulator.push(Buffer.from(',"payload":{}}\n{"next":1}\n'));
  assert.deepEqual(lines, ['{"type":"event_msg","payload":{}}', '{"next":1}']);
  assert.equal(accumulator.partial, '');
});

test('LineAccumulator preserves UTF-8 characters split across chunks', () => {
  const lines = [];
  const accumulator = new LineAccumulator((line) => lines.push(line));
  const data = Buffer.from('{"summary":"edição"}\n');
  const marker = data.indexOf(Buffer.from('ç'));
  accumulator.push(data.subarray(0, marker + 1));
  accumulator.push(data.subarray(marker + 1));
  assert.deepEqual(lines, ['{"summary":"edição"}']);
});
