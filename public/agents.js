const labels = { LEAD: 'Lead / Coordinator', EXPLORER: 'Explorer', WORKER: 'Worker', REVIEWER: 'Reviewer', QA: 'QA / Test Runner', GENERIC: 'Generic Agent' };
const active = new Set(['planning', 'exploring', 'working', 'reviewing', 'testing', 'integrating']);
const points = { LEAD: [50, 42], EXPLORER: [20, 38], WORKER: [82, 41], REVIEWER: [20, 63], QA: [82, 66] };
let current = null;
let detailId = null;
let selectedRole = null;
const el = (selector) => document.querySelector(selector);
const number = (n) => n == null ? 'N/A' : n.toLocaleString('pt-BR');
const time = (t) => t ? new Date(t).toLocaleTimeString('pt-BR') : 'N/A';
function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function fields(target, rows) {
  target.replaceChildren();
  for (const [key, value] of rows) target.append(node('dt', key), node('dd', value ?? 'N/A'));
}
function usageText(usage) {
  return `Input ${number(usage?.input)} · Cached ${number(usage?.cachedInput)} · Output ${number(usage?.output)} · Total ${number(usage?.total)}`;
}
function showDetail(id, role = null) {
  detailId = id;
  selectedRole = role;
  renderDetail();
  if (!el('#agent-dialog').open) el('#agent-dialog').showModal();
}
function renderDetail() {
  const agent = current?.agents.find((a) => a.id === detailId);
  const target = el('#agent-detail');
  target.replaceChildren();
  el('#agent-title').textContent = agent ? agent.label : labels[selectedRole] ?? 'Agent detail';
  if (!agent) {
    target.append(node('p', 'Nenhum agente real observado nesta estação. No modo single agent, os personagens representam fases operacionais.'));
    return;
  }
  const parent = current.agents.find((a) => a.id === agent.parentId);
  const data = node('dl');
  fields(data, [
    ['Role', labels[agent.role]], ['Role evidence', agent.roleEvidence], ['Agent / session ID', agent.sessionId],
    ['Path', agent.agentPath], ['Parent', parent ? `${parent.label} (${parent.id})` : agent.parentId ?? 'N/A'],
    ['State', agent.state], ['Current task / last operation', agent.task], ['Last activity', time(agent.updatedAt)],
    ['Tools', agent.tools.length ? agent.tools.join(', ') : 'N/A'], ['Usage', usageText(agent.usage)],
  ]);
  target.append(data, node('h3', 'Timeline / últimas atividades'));
  const list = node('ol', null, 'timeline');
  for (const event of [...agent.activities].reverse()) list.append(node('li', `${time(event.timestamp)} · ${event.state} · ${event.summary}`));
  if (!agent.activities.length) list.append(node('li', 'N/A — sem atividade atribuível.'));
  target.append(list);
}
function renderTree() {
  const root = el('#agent-tree');
  root.replaceChildren();
  const agents = current.agents;
  const visited = new Set();
  function add(agent, container) {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    const li = node('li');
    const button = node('button', `${agent.label} · ${labels[agent.role]} · ${agent.state}`);
    button.type = 'button';
    button.addEventListener('click', () => showDetail(agent.id));
    li.append(button);
    const children = agents.filter((a) => a.parentId === agent.id);
    if (children.length) {
      const ul = node('ul');
      children.forEach((child) => add(child, ul));
      li.append(ul);
    }
    container.append(li);
  }
  agents.filter((a) => !a.parentId || !agents.some((parent) => parent.id === a.parentId)).forEach((a) => add(a, root));
  if (!agents.length) root.append(node('li', 'Nenhuma identidade observada.'));
}
function renderCommunications() {
  const feed = el('#communication-list');
  const wires = el('#agent-wires');
  feed.replaceChildren();
  wires.replaceChildren();
  const recent = current.communications.slice(-4).reverse();
  for (const edge of recent) {
    const from = current.agents.find((a) => a.id === edge.from);
    const to = current.agents.find((a) => a.id === edge.to);
    if (!from || !to) continue;
    feed.append(node('li', `${time(edge.timestamp)} ${from.label} → ${to.label}: ${edge.label}`));
    if (!edge.timestamp || Date.now() - Date.parse(edge.timestamp) > 8_000) continue;
    const a = points[from.role], b = points[to.role];
    if (!a || !b || from.role === to.role) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    for (const [key, value] of Object.entries({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] })) line.setAttribute(key, value);
    wires.append(line);
    const bubble = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    bubble.setAttribute('x', (a[0] + b[0]) / 2);
    bubble.setAttribute('y', (a[1] + b[1]) / 2 - 1);
    bubble.textContent = `${from.label} → ${to.label}`;
    wires.append(bubble);
  }
  if (!feed.children.length) feed.append(node('li', 'Nenhuma comunicação com origem e destino verificáveis.'));
}

export function renderAgents(state) {
  current = state.room;
  if (!current) return;
  const { budget, usage } = current;
  el('#agent-budget').textContent = `Active agents: ${budget.activeAgents} / ${budget.maxConcurrentAgents}`;
  el('#agent-budget').dataset.exceeded = String(budget.exceeded);
  el('#budget-policy').textContent = `${budget.policy}. Limite informativo; nenhuma sessão é controlada.`;
  el('#usage-total').textContent = `Tokens: ${number(usage.total)}`;
  el('#usage-detail').textContent = `${usageText(usage)} · Cobertura ${usage.knownAgents}/${usage.observedAgents} agentes (total parcial quando incompleto)`;
  el('#agent-count').textContent = `${current.agents.length} observado(s)`;
  for (const card of document.querySelectorAll('.role-card')) {
    const role = card.dataset.role;
    const matching = current.agents.filter((a) => a.role === role).sort((a, b) => Number(active.has(b.state)) - Number(active.has(a.state)) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const agent = matching[0];
    let displayState = agent?.state ?? 'idle';
    let summary = agent ? `${agent.label} · ${agent.task}` : 'Nenhum agente observado';
    if (state.mode === 'SINGLE_AGENT') {
      const observed = state.roles[role];
      const fresh = observed?.updatedAt && Date.now() - Date.parse(observed.updatedAt) <= 45_000;
      if (observed?.state === 'ACTIVE' && fresh) displayState = { EXPLORER: 'exploring', WORKER: 'working', REVIEWER: 'reviewing', QA: 'testing', LEAD: 'working' }[role];
      else if (observed?.state === 'ERROR') displayState = 'failed';
      else if (observed?.state === 'DONE') displayState = role === 'LEAD' && observed.summary === 'Turn complete' ? 'done' : 'waiting';
      else displayState = 'idle';
      summary = `Fase operacional · ${observed?.summary ?? 'Waiting'}`;
    }
    card.dataset.liveState = displayState;
    card.dataset.state = active.has(displayState) ? 'ACTIVE' : displayState === 'failed' ? 'ERROR' : displayState === 'done' ? 'DONE' : 'IDLE';
    card.querySelector('em').textContent = displayState;
    card.querySelector('p').textContent = summary;
    card.title = `${labels[role]}: ${summary}`;
    card.setAttribute('aria-label', `Detalhes ${labels[role]}`);
    card.onclick = () => showDetail(agent?.id ?? (state.mode === 'SINGLE_AGENT' ? current.selectedAgentId : null), role);
  }
  renderTree();
  renderCommunications();
  if (el('#agent-dialog').open) renderDetail();
}

for (const card of document.querySelectorAll('.role-card')) {
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.addEventListener('keydown', (event) => {
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); card.click(); }
  });
}
el('#team-button').addEventListener('click', () => el('#team-dialog').showModal());
setInterval(() => {
  if (current) renderCommunications(); // Expire real links without inventing new activity.
}, 2_000);
