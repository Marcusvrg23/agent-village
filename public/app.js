import { renderAgents } from './agents.js';

const elements = {
  project: document.querySelector('#project'),
  sessionStatus: document.querySelector('#session-status'),
  mode: document.querySelector('#mode'),
  source: document.querySelector('#source'),
  progress: document.querySelector('#progress'),
  connection: document.querySelector('#connection'),
  activityList: document.querySelector('#activity-list'),
  activityUpdated: document.querySelector('#activity-updated'),
  debugButton: document.querySelector('#debug-button'),
  debugDialog: document.querySelector('#debug-dialog'),
  debugData: document.querySelector('#debug-data'),
  debugUnknown: document.querySelector('#debug-unknown'),
};

const roleCards = new Map([...document.querySelectorAll('[data-role]')].map((node) => [node.dataset.role, node]));
let latestState = null;

function time(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString('pt-BR', { hour12: false });
}

function valueOrDash(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  return String(value);
}

function renderRole(role, data) {
  const card = roleCards.get(role);
  if (!card || !data) return;
  card.dataset.state = data.state ?? 'IDLE';
  card.querySelector('em').textContent = data.state ?? 'IDLE';
  card.querySelector('p').textContent = data.summary ?? 'No observable activity';
  card.title = `${role}: ${data.summary ?? 'No observable activity'}`;
}

function renderActivity(items) {
  elements.activityList.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Waiting for observable events…';
    elements.activityList.append(empty);
    return;
  }
  for (const event of items.slice(0, 5)) {
    const item = document.createElement('li');
    const timestamp = document.createElement('span');
    timestamp.className = 'time';
    timestamp.textContent = time(event.timestamp);
    const role = document.createElement('span');
    role.className = 'activity-role';
    role.textContent = event.role === 'UNKNOWN' ? 'ACTIVITY' : event.role;
    const summary = document.createElement('span');
    summary.textContent = event.summary;
    summary.title = event.summary;
    item.append(timestamp, role, summary);
    elements.activityList.append(item);
  }
}

function renderDebug(state) {
  const debug = state.debug ?? {};
  const rows = [
    ['Rollout path', debug.rolloutPath],
    ['LastWriteTime', debug.lastWriteTime],
    ['Last observed activity', debug.lastObservedActivity],
    ['Offset / size', `${valueOrDash(debug.offset)} / ${valueOrDash(debug.size)} bytes`],
    ['Lines processed', debug.linesProcessed],
    ['Recognized events', debug.recognizedEvents],
    ['Unknown events', debug.unknownEvents],
    ['Last recognized', debug.lastRecognized],
    ['Partial bytes buffered', debug.partialBytesBuffered],
    ['Frontend / backend', `${debug.connectedClients ?? 0} SSE client(s)`],
    ['Mode', state.modeLabel],
    ['Observed agents', state.agents?.length ? state.agents.join(', ') : 'None verified'],
    ['Watcher', debug.watcherStrategy],
    ['Read only', debug.readOnly],
  ];
  elements.debugData.replaceChildren();
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = valueOrDash(value);
    elements.debugData.append(term, description);
  }
  elements.debugUnknown.replaceChildren();
  const unknown = debug.recentUnknown?.length ? debug.recentUnknown : ['None'];
  for (const value of unknown) {
    const item = document.createElement('li');
    item.textContent = value;
    elements.debugUnknown.append(item);
  }
}

function render(state) {
  latestState = state;
  elements.project.textContent = state.project ?? 'Unknown';
  elements.sessionStatus.textContent = state.session?.status ?? 'IDLE';
  elements.mode.textContent = state.modeLabel ?? 'SINGLE AGENT / ACTIVITY VIEW';
  elements.source.textContent = state.session?.source ?? 'Waiting for rollout';
  elements.source.title = state.session?.source ?? '';
  elements.progress.textContent = state.progress ?? 'No measured progress';
  elements.activityUpdated.textContent = time(state.updatedAt);
  for (const [role, data] of Object.entries(state.roles ?? {})) renderRole(role, data);
  renderActivity(state.activity);
  renderDebug(state);
  renderAgents(state);
}

function setConnection(online) {
  elements.connection.dataset.online = String(online);
  elements.connection.textContent = online ? 'LIVE' : 'RECONNECTING';
}

elements.debugButton.addEventListener('click', () => {
  if (latestState) renderDebug(latestState);
  elements.debugDialog.showModal();
});

const stream = new EventSource('/events');
stream.addEventListener('open', () => setConnection(true));
stream.addEventListener('error', () => setConnection(false));
stream.addEventListener('snapshot', (event) => {
  try {
    render(JSON.parse(event.data));
    setConnection(true);
  } catch {
    setConnection(false);
  }
});
