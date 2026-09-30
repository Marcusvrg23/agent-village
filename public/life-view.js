// Life Mode view: reuses fixed DOM nodes and a single wake timer; never opens its own connection.
import { AmbientDirector, ROOM_MODES, STATION_ROLES, deriveRoomMode, formatAge, stationVisual, taskBubbles } from './life-mode.js';
import { CharacterDirector, POSE_FPS, createWakeTimer, needsFrames, poseAt } from './character-mode.js';

const stage = document.querySelector('.room-stage');
const modePill = document.querySelector('#life-mode');
const lastActivity = document.querySelector('#last-activity');
const stationNodes = new Map([...document.querySelectorAll('.station[data-role]')].map((node) => [node.dataset.role, node]));
const rigs = new Map([...stationNodes].map(([role, node]) => [role, node.querySelector('.rig')]));
const says = new Map([...stationNodes].map(([role, node]) => [role, node.querySelector('.say')]));
const screens = new Map([...stationNodes].map(([role, node]) => [role, node.querySelector('.screen')]));
const bubbles = new Map([...document.querySelectorAll('.life-bubble[data-role]')].map((node) => [node.dataset.role, node]));
const cards = new Map([...document.querySelectorAll('.role-card[data-role]')].map((node) => [node.dataset.role, node]));
const director = new AmbientDirector();
const characters = new CharacterDirector();
const timer = createWakeTimer();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const spoken = new Map(); // role -> key of the walk pause that already spoke
const POSE_VARS = { x: '--px', y: '--py', lift: '--lift', flip: '--flip', bodyY: '--body-y', bodyRot: '--body-rot', headRot: '--head-rot', headX: '--head-x', headY: '--head-y', leg1: '--leg1', leg2: '--leg2', lids: '--lids' };
let latest = null;
let stations = [];
let frame = {};
let nextFullAt = 0;

function set(node, key, value) {
  if (node && node.dataset[key] !== value) node.dataset[key] = value;
}

function text(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function style(node, name, value) {
  if (node && node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

function applyStation(role, room, now) {
  const station = stations.find((item) => item.role === role) ?? { role, displayState: 'idle' };
  const result = stationVisual({ ...station, mode: room.mode }, now);
  set(stationNodes.get(role), 'visual', result.visual);
  set(stationNodes.get(role), 'presence', result.presence);
  const card = cards.get(role);
  if (card) {
    set(card, 'presence', result.presence);
    if (result.presence === 'standby') { // Current real states keep the V1 card rendering untouched.
      // Standby (always in IDLE) overrides stale card states; outside TASK the card keeps the last observed summary.
      set(card, 'state', 'IDLE');
      text(card.querySelector('em'), 'standby');
      if (room.mode !== ROOM_MODES.TASK) text(card.querySelector('p'), station.task ? `Standby · last: ${station.task}` : 'Standby · no observed activity');
    }
  }
  return result;
}

function applyCharacters(room, visuals, now) {
  frame = characters.tick(now, { mode: room.mode, visuals, reducedMotion: reducedMotion.matches });
  for (const [role, d] of Object.entries(frame)) {
    const node = stationNodes.get(role);
    set(node, 'action', d.action);
    set(node, 'pose', d.pose);
    set(node, 'walking', String(d.walking));
    if (d.speak && spoken.get(role) !== d.key) { spoken.set(role, d.key); director.say(role, now, room.mode); }
  }
  applyPoses(now);
  return frame;
}

// Only changed pose variables are written, so a still character causes no style work or frames.
function applyPoses(now) {
  for (const [role, d] of Object.entries(frame)) {
    const pose = poseAt(role, d, now, { reducedMotion: reducedMotion.matches });
    const rig = rigs.get(role);
    for (const [key, name] of Object.entries(POSE_VARS)) style(rig, name, String(pose[key]));
    // Monitor activity only for stations doing real work, on the same frame clock.
    const screen = screens.get(role);
    if (stationNodes.get(role).dataset.presence === 'active' && !reducedMotion.matches) {
      style(screen, '--phase', ((now % 1900) / 1900).toFixed(2));
      style(screen, '--pulse', (0.5 + 0.5 * Math.sin(now / 250)).toFixed(2));
      style(screen, '--wave', (0.5 - 0.5 * Math.cos((now / 3600) * 2 * Math.PI)).toFixed(2));
    }
  }
}

function anyActive() {
  for (const node of stationNodes.values()) if (node.dataset.presence === 'active') return true;
  return false;
}

function applyBubbles(room, frame, now) {
  const ambient = director.tick(now, room.mode);
  const shown = room.mode === ROOM_MODES.IDLE
    ? (ambient ? [ambient] : [])
    : taskBubbles({ mode: room.mode, stations, room: latest.room, now });
  for (const [role, node] of bubbles) {
    const bubble = shown.find((item) => item.role === role);
    // A line said by a walking character travels with it and ends when it sits back down;
    // it never jumps into the fixed desk bubble.
    const attached = Boolean(bubble?.attached);
    const travelling = attached && frame[role]?.pose === 'stand';
    set(node, 'show', String(Boolean(bubble) && !attached));
    set(says.get(role), 'show', String(travelling));
    if (!bubble || (attached && !travelling)) continue;
    if (travelling) { text(says.get(role), bubble.text); continue; }
    set(node, 'kind', bubble.kind);
    const label = node.firstElementChild;
    if (label.textContent !== bubble.text) {
      label.textContent = bubble.text;
      node.title = bubble.kind === 'ambient' ? 'Ambient idle line — not Codex activity' : 'Derived from a real rollout event';
    }
  }
}

function apply(full = true) {
  if (!latest) return;
  const now = Date.now();
  if (document.hidden) { // Nothing is visible: check back once a second, render nothing.
    timer.schedule(1_000, () => apply(true));
    return;
  }
  if (!document.hidden) {
    if (full || now >= nextFullAt) {
      const room = deriveRoomMode(latest, now);
      set(stage, 'lifeMode', room.mode);
      set(modePill, 'mode', room.mode);
      text(modePill, room.label);
      text(lastActivity, `Last activity: ${formatAge(room.ageMs)}`);
      const visuals = Object.fromEntries(STATION_ROLES.map((role) => [role, applyStation(role, room, now)]));
      applyBubbles(room, applyCharacters(room, visuals, now), now);
      // Full passes at the next character step, or at most 1 s for clocks and mode changes.
      nextFullAt = Math.min(characters.nextWake(now), now + 1_000);
    } else applyPoses(now);
  }
  // One timer drives everything; pose frames at POSE_FPS only while someone is actually moving.
  const poseDue = !document.hidden && !reducedMotion.matches && (needsFrames(frame, now) || anyActive()) ? now + 1000 / POSE_FPS : Infinity;
  timer.schedule(Math.min(nextFullAt || now + 1_000, poseDue) - now, () => apply(false));
}

export function updateLife(state, nextStations = []) {
  latest = state;
  stations = nextStations;
  apply(true);
}

document.addEventListener('visibilitychange', () => apply(true));

reducedMotion.addEventListener('change', () => apply(true));
