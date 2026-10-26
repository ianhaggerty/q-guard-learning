// Entry point: one WebSocket per tab is this tab's session. The server greets it with a
// session id and the lobby; the page switches between the lobby and a room as the server
// says, and closing the tab ends the session (and leaves any room).

import { byId, toast } from './dom.js';
import { showPlans, showRooms } from './lobby.js';
import { Game } from './game.js';

const roomElements = {
  canvas: byId('roomCanvas'), floor: byId('floorLabel'), title: byId('roomTitle'), code: byId('roomCode'),
  score: byId('hudScore'), team: byId('hudTeam'), unspotted: byId('hudUnspotted'), spotted: byId('hudSpotted'),
  kcal: byId('hudKcal'), pose: byId('hudPose'), time: byId('hudTime'), roster: byId('roster'),
  autopilot: byId('autopilotToggle'), autopilotNote: byId('autopilotNote'), heatmap: byId('heatmapToggle'),
};

let socket = null, session = null, plans = [], game = null, autopilotAvailable = false;

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
    session = message.session;
    plans = message.plans;
    autopilotAvailable = message.autopilot;
    byId('sessionName').textContent = session.name;
    showPlans(byId('planList'), plans, plan => send({ type: 'create', plan }));
    showLobby(message.rooms);
  },
  rooms(message) {
    showRooms(byId('roomList'), byId('noRooms'), message.rooms, room => send({ type: 'join', room }));
  },
  joined(message) {
    game?.stop();
    byId('lobby').hidden = true;
    byId('room').hidden = false;
    game = new Game({ connection: { send }, elements: roomElements, selfId: session.id, joined: message, autopilot: autopilotAvailable });
  },
  state(message) {
    game?.onState(message);
  },
  heat(message) {
    game?.onHeat(message);
  },
  left() {
    showLobby();
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
byId('reconnect').onclick = () => {
  byId('room').hidden = true;
  byId('lobby').hidden = false;
  connect();
};
connect();
