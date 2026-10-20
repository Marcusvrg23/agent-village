import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissionTracker, applyAssignments, claudeClaims, codexClaims, project, taskLabel } from '../public/village/projector.js';
import { ROLE_ORDER, Village } from '../public/village/life-engine.js';
import { reservoirLevel } from '../public/village/control-ui.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const world = JSON.parse(await readFile(path.join(root, 'public/village/world.json'), 'utf8'));
const NOW = Date.parse('2026-10-20T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

test('Projector: no real input means no assignment (nothing is invented)', () => {
  assert.equal(project([]).size, 0);
  assert.deepEqual(codexClaims(null, NOW), []);
  assert.deepEqual(claudeClaims(undefined, NOW), []);
  assert.deepEqual(new MissionTracker().claims(), []);
});

test('Projector: Codex registry agents become claims only while active and fresh', () => {
  const room = { agents: [
    { id: 'root', role: 'LEAD', state: 'planning', task: 'Plano atualizado', updatedAt: iso(5_000) },
    { id: 'old', role: 'WORKER', state: 'working', task: 'Editing a.js', updatedAt: iso(120_000) }, // stale
    { id: 'idle', role: 'QA', state: 'idle', task: 'N/A', updatedAt: iso(1_000) }, // not active
    { id: 'gen', role: 'GENERIC', state: 'exploring', task: 'N/A', updatedAt: iso(1_000) },
  ] };
  const claims = codexClaims(room, NOW);
  assert.deepEqual(claims.map((c) => [c.agentId, c.role, c.source, c.label]), [
    ['root', 'LEAD', 'codex-observed', 'Plano atualizado'], ['gen', 'WORKER', 'codex-observed', null],
  ]);
});

test('Projector: Claude sessions and subagents map to roles with tool target only (no content)', () => {
  const sessions = [{ id: 's1', active: true, state: 'working', role: 'WORKER', lastAt: iso(2_000), lastTool: { name: 'Edit', target: 'quota.js' },
    subagents: [{ id: 'a1', active: true, state: 'testing', role: 'QA', lastAt: iso(3_000), lastTool: { name: 'Bash' } },
      { id: 'a2', active: false, state: 'exploring', role: 'EXPLORER', lastAt: iso(1_000) }] }];
  const claims = claudeClaims(sessions, NOW);
  assert.deepEqual(claims.map((c) => [c.agentId, c.role, c.label]), [['s1', 'WORKER', 'Edit · quota.js'], ['a1', 'QA', 'Bash']]);
  assert.ok(claims.every((c) => c.provider === 'claude-code' && c.source === 'claude-observed'));
});

test('Projector: mission events win over observed agents; completed missions release', () => {
  const t = new MissionTracker();
  t.push({ type: 'agent.spawned', source: 'orchestrator-controlled', missionId: 'M-1', role: 'WORKER', provider: 'codex', agentId: 'th-1', at: iso(9_000) });
  t.push({ type: 'agent.state', source: 'orchestrator-controlled', missionId: 'M-1', role: 'WORKER', state: 'testing', provider: 'codex', agentId: 'th-1', label: 'npm test', at: iso(8_000) });
  t.push({ type: 'agent.state', source: 'codex-observed', missionId: 'M-X', role: 'LEAD', state: 'working' }); // ignored: not orchestrator
  const observed = { role: 'WORKER', state: 'working', provider: 'claude-code', agentId: 's9', at: NOW, source: 'claude-observed', label: 'Edit' };
  const out = project([...t.claims(), observed]);
  assert.equal(out.size, 1);
  const w = out.get('WORKER');
  assert.equal(w.source, 'orchestrator-controlled');
  assert.equal(w.state, 'testing');
  assert.equal(w.others, 1);
  assert.match(taskLabel(w), /missão da vila · testando · npm test \(\+1\)/);
  // the same real agent moving to another role releases the previous avatar (one agent = one avatar)
  t.push({ type: 'agent.state', source: 'orchestrator-controlled', missionId: 'M-1', role: 'REVIEWER', state: 'reviewing', provider: 'codex', agentId: 'th-1', label: 'command_execution', at: iso(1_000) });
  assert.deepEqual(t.claims().map((c) => [c.role, c.label]), [['REVIEWER', 'executando comando']]);
  t.push({ type: 'agent.spawned', source: 'orchestrator-controlled', missionId: 'M-1', role: 'QA', provider: 'claude-code', agentId: 'sub-2', at: iso(500) });
  assert.equal(t.claims().length, 2, 'a second real agent (subagent) gets its own avatar');
  t.push({ type: 'mission.completed', source: 'orchestrator-controlled', missionId: 'M-1' });
  assert.equal(t.claims().length, 0);
  t.push({ type: 'agent.state', source: 'orchestrator-controlled', missionId: 'M-2', role: 'QA', state: 'testing' });
  t.sync([]); // server restarted / cancelled: nothing running any more
  assert.equal(t.claims().length, 0);
});

test('Projector: applyAssignments sets ACTIVE presence and releases back to STANDBY', () => {
  const v = new Village(world, { seed: 7 });
  const claims = [{ role: 'QA', state: 'testing', provider: 'codex', agentId: 'x', missionId: null, at: NOW, source: 'codex-observed', label: 'npm test' }];
  let r = applyAssignments(v, project(claims), ROLE_ORDER);
  assert.deepEqual(r.assigned, ['QA']);
  const qa = v.agent('QA');
  assert.equal(qa.presence, 'verified');
  assert.equal(qa.task.source, 'codex-observed');
  assert.equal(qa.task.provider, 'codex');
  r = applyAssignments(v, project(claims), ROLE_ORDER); // unchanged -> no re-walk
  assert.deepEqual(r.assigned, []);
  r = applyAssignments(v, project([]), ROLE_ORDER);
  assert.deepEqual(r.released, ['QA']);
  assert.equal(v.agent('QA').presence, 'standby');
  assert.ok(ROLE_ORDER.filter((x) => x !== 'QA').every((role) => v.agent(role).presence === 'standby'));
});

test('Fonte de Elixir: level comes from the tightest real window; no data stays unknown (never 0%)', () => {
  assert.equal(reservoirLevel(undefined), null);
  assert.equal(reservoirLevel({ windows: {}, expired: ['fiveHour'] }), null);
  assert.equal(reservoirLevel({ windows: { fiveHour: { usedPercent: 30 }, weekly: { usedPercent: 85 } } }), 15);
  assert.equal(reservoirLevel({ windows: {}, noQuota: true }), 0);
});
