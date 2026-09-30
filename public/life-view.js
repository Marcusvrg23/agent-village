// V1.1 Life Mode view: reuses fixed DOM nodes and one 1s ticker; never opens its own connection.
import { AmbientDirector, ROOM_MODES, STATION_ROLES, deriveRoomMode, formatAge, stationVisual, taskBubbles } from './life-mode.js';

const stage = document.querySelector('.room-stage');
const modePill = document.querySelector('#life-mode');
const lastActivity = document.querySelector('#last-activity');
const actors = new Map([...document.querySelectorAll('.actor[data-role]')].map((node) => [node.dataset.role, node]));
const bubbles = new Map([...document.querySelectorAll('.life-bubble[data-role]')].map((node) => [node.dataset.role, node]));
const cards = new Map([...document.querySelectorAll('.role-card[data-role]')].map((node) => [node.dataset.role, node]));
const director = new AmbientDirector();
let latest = null;
let stations = [];

function set(node, key, value) {
  if (node && node.dataset[key] !== value) node.dataset[key] = value;
}

function text(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function applyStation(role, room, now) {
  const station = stations.find((item) => item.role === role) ?? { role, displayState: 'idle' };
  const { visual, presence } = stationVisual({ ...station, mode: room.mode }, now);
  set(actors.get(role), 'visual', visual);
  set(actors.get(role), 'presence', presence);
  const card = cards.get(role);
  if (!card) return;
  set(card, 'presence', presence);
  if (presence !== 'standby') return; // Current real states keep the V1 card rendering untouched.
  // Standby (always in IDLE) overrides stale card states; outside TASK the card keeps the last observed summary.
  set(card, 'state', 'IDLE');
  text(card.querySelector('em'), 'standby');
  if (room.mode !== ROOM_MODES.TASK) text(card.querySelector('p'), station.task ? `Standby · last: ${station.task}` : 'Standby · no observed activity');
}

function applyBubbles(room, now) {
  const ambient = director.tick(now, room.mode);
  const shown = room.mode === ROOM_MODES.IDLE
    ? (ambient ? [ambient] : [])
    : taskBubbles({ mode: room.mode, stations, room: latest.room, now });
  for (const [role, node] of bubbles) {
    const bubble = shown.find((item) => item.role === role);
    set(node, 'show', String(Boolean(bubble)));
    if (!bubble) continue;
    set(node, 'kind', bubble.kind);
    const label = node.firstElementChild;
    if (label.textContent !== bubble.text) {
      label.textContent = bubble.text;
      node.title = bubble.kind === 'ambient' ? 'Ambient idle line — not Codex activity' : 'Derived from a real rollout event';
    }
  }
}

function apply(now = Date.now()) {
  if (!latest) return;
  const room = deriveRoomMode(latest, now);
  set(stage, 'lifeMode', room.mode);
  set(modePill, 'mode', room.mode);
  text(modePill, room.label);
  text(lastActivity, `Last activity: ${formatAge(room.ageMs)}`);
  for (const role of STATION_ROLES) applyStation(role, room, now);
  applyBubbles(room, now);
}

export function updateLife(state, nextStations = []) {
  latest = state;
  stations = nextStations;
  apply();
}

// Time alone moves TASK → COMPLETED → IDLE, so re-evaluate without waiting for a new snapshot.
setInterval(() => {
  if (!document.hidden) apply();
}, 1_000);
