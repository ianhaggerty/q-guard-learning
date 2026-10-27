// Entry point: one WebSocket per tab is this tab's session. The server greets it with the
// player it belongs to (the signed-in user, or a guest for this tab) and the lobby; the page
// switches between the lobby and a room as the server says. Closing the tab ends the session:
// a guest's agents stop with it, a signed-in player's play on for a while.

import { byId, toast } from './dom.js';
import { showAgents, showPlans, showRooms } from './lobby.js';
import { showAccount } from './account.js';
import { Game } from './game.js';

const roomElements = {
  canvas: byId('roomCanvas'), floor: byId('floorLabel'), title: byId('roomTitle'), code: byId('roomCode'),
  score: byId('hudScore'), team: byId('hudTeam'), unspotted: byId('hudUnspotted'), spotted: byId('hudSpotted'),
  kcal: byId('hudKcal'), pose: byId('hudPose'), time: byId('hudTime'), roster: byId('roster'),
  autopilot: byId('autopilotToggle'), autopilotNote: byId('autopilotNote'), heatmap: byId('heatmapToggle'),
  leave: byId('leaveRoom'), agentPanel: byId('agentPanel'), agentMap: byId('agentMap'), agentStatus: byId('agentStatus'),
  tuning: byId('tuningToggle'), blend: byId('blendSlider'), blendValue: byId('blendValue'), resetAgent: byId('resetAgent'),
  agentKept: byId('agentKept'),
};

let socket = null, player = null, plans = [], game = null, autopilotAvailable = false;

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function showLobby(rooms) {
  game?.stop();
  game = null;
  byId('room').hidden = true;
  byId('lobby').hidden = false;
  if (rooms) showRooms(byId('roomList'), byId('noRooms'), rooms, room => send({ type: 'join', room }));
}

const handlers = {
  welcome(message) {
    player = message.player;
    send({ type: 'blend', value: Number(byId('blendSlider').value) / 100 });
    plans = message.plans;
    autopilotAvailable = message.autopilot;
    byId('sessionName').textContent = player.signedIn ? 'Signed in' : player.name;
    showPlans(byId('planList'), plans, plan => send({ type: 'create', plan }));
    showLobby(message.rooms);
  },
  rooms(message) {
    showRooms(byId('roomList'), byId('noRooms'), message.rooms, room => send({ type: 'join', room }));
  },
  agents(message) {
    showAgents(byId('agentsPanel'), byId('agentList'), message.agents, room => send({ type: 'join', room }));
    byId('agentsNote').textContent = message.offlineSeconds
      ? `They keep playing for up to ${Math.round(message.offlineSeconds / 60)} minutes after you close every tab.`
      : 'They stop when you close this tab. Sign in to keep them.';
  },
  tuning(message) {
    game?.onTuning(message);
  },
  joined(message) {
    game?.stop();
    byId('lobby').hidden = true;
    byId('room').hidden = false;
    game = new Game({ connection: { send }, elements: roomElements, selfId: player.id, signedIn: player.signedIn, joined: message, autopilot: autopilotAvailable });
  },
  state(message) {
    game?.onState(message);
  },
  heat(message) {
    game?.onHeat(message);
  },
  left(message) {
    showLobby();
    if (message.reason) toast(message.reason);
  },
  error(message) {
    toast(message.message);
  },
};

function connect() {
  const url = new URL('/rooms', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(url);
  socket.addEventListener('open', () => { byId('disconnected').hidden = true; });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    handlers[message.type]?.(message);
  });
  socket.addEventListener('close', () => {
    game?.stop();
    game = null;
    byId('sessionName').textContent = 'Offline';
    byId('disconnected').hidden = false;
  });
}

byId('leaveRoom').onclick = () => send({ type: 'leave' });
// How closely agents copy this player is the player's choice for the whole session.
byId('blendSlider').oninput = event => {
  byId('blendValue').textContent = `${event.target.value}%`;
  send({ type: 'blend', value: Number(event.target.value) / 100 });
};
byId('reconnect').onclick = () => {
  byId('room').hidden = true;
  byId('lobby').hidden = false;
  connect();
};
showAccount();
connect();
