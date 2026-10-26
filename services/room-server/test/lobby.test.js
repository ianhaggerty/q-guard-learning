// The lobby without a network: sessions on fake sockets that record what they are sent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlans } from '../src/plans.js';
import { Lobby } from '../src/lobby.js';

function fakeSocket() {
  const sent = [];
  return {
    readyState: 1, bufferedAmount: 0, sent,
    send: text => sent.push(JSON.parse(text)),
    last: type => sent.filter(message => message.type === type).at(-1),
  };
}

function lobbyWith(options = {}) {
  return new Lobby({ plans: loadPlans(), ...options });
}

test('a session is welcomed with a unique id, the plans and the rooms', () => {
  const lobby = lobbyWith();
  const [a, b] = [fakeSocket(), fakeSocket()];
  const [sessionA, sessionB] = [lobby.connect(a), lobby.connect(b)];
  assert.notEqual(sessionA.id, sessionB.id);
  assert.equal(a.last('welcome').session.id, sessionA.id);
  assert.equal(a.last('welcome').plans.length, 7);
});

test('create, join and leave; the last one out destroys the room', () => {
  const lobby = lobbyWith();
  const [hostSocket, guestSocket, watcherSocket] = [fakeSocket(), fakeSocket(), fakeSocket()];
  const [host, guest] = [lobby.connect(hostSocket), lobby.connect(guestSocket)];
  lobby.connect(watcherSocket);

  lobby.handle(host, { type: 'create', plan: '4' });
  const { room } = hostSocket.last('joined');
  assert.equal(room.plan, '4');
  assert.equal(hostSocket.last('state').explorers.length, 1);
  assert.equal(watcherSocket.last('rooms').rooms[0].humans, 1);

  lobby.handle(guest, { type: 'join', room: room.id });
  assert.equal(guestSocket.last('joined').room.id, room.id);
  assert.equal(watcherSocket.last('rooms').rooms[0].humans, 2);

  lobby.handle(host, { type: 'leave' });
  assert.ok(hostSocket.last('left'));
  assert.equal(lobby.rooms.size, 1);
  lobby.disconnect(guest);
  assert.equal(lobby.rooms.size, 0);
  assert.deepEqual(watcherSocket.last('rooms').rooms, []);
});

test('creating or joining another room leaves the current one', () => {
  const lobby = lobbyWith();
  const socket = fakeSocket(), human = lobby.connect(socket);
  lobby.handle(human, { type: 'create', plan: '1' });
  const first = human.room;
  lobby.handle(human, { type: 'create', plan: '2' });
  assert.notEqual(human.room, first);
  assert.equal(lobby.rooms.has(first.id), false, 'the first room emptied and closed');
});

test('ticks advance rooms and send snapshots every other tick, skipping clients that are too far behind', () => {
  const lobby = lobbyWith();
  const [fast, slow] = [fakeSocket(), fakeSocket()];
  const [a, b] = [lobby.connect(fast), lobby.connect(slow)];
  lobby.handle(a, { type: 'create', plan: '2' });
  lobby.handle(b, { type: 'join', room: a.room.id });
  slow.bufferedAmount = 10 << 20;
  const counts = () => [fast, slow].map(s => s.sent.filter(m => m.type === 'state').length);
  const before = counts();
  for (let tick = 0; tick < 4; tick++) lobby.tick();
  const after = counts();
  assert.equal(after[0] - before[0], 2);
  assert.equal(after[1] - before[1], 0);
});

test('room and server limits', () => {
  const lobby = lobbyWith({ maxRooms: 1, maxHumansPerRoom: 1 });
  const [s1, s2] = [fakeSocket(), fakeSocket()];
  const [a, b] = [lobby.connect(s1), lobby.connect(s2)];
  lobby.handle(a, { type: 'create', plan: '1' });
  lobby.handle(b, { type: 'join', room: a.room.id });
  assert.equal(s2.last('error').message, 'That room is full.');
  lobby.handle(b, { type: 'create', plan: '2' });
  assert.match(s2.last('error').message, /No room is free/);
  lobby.draining = true;
  lobby.handle(b, { type: 'join', room: a.room.id });
  assert.match(s2.last('error').message, /shutting down/);
});

/** A fake agent service: records requests and answers with `reply` (or rejects when it throws). */
function fakeAgents(reply = request => request.agents.map(() => [0, 0, 0])) {
  const requests = [];
  return { requests, act: async request => { requests.push(request); return reply(request); } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('without an agent service the autopilot is unavailable', () => {
  const lobby = lobbyWith();
  const socket = fakeSocket(), human = lobby.connect(socket);
  assert.equal(socket.last('welcome').autopilot, false);
  lobby.handle(human, { type: 'create', plan: '2' });
  lobby.handle(human, { type: 'autopilot', on: true });
  assert.match(socket.last('error').message, /not available/);
});

test('autopilot explorers get a decision every 0.5 s from the agent service', async () => {
  const agents = fakeAgents(request => request.agents.map(() => [1, 0, 0]));
  const lobby = lobbyWith({ agents });
  const socket = fakeSocket(), human = lobby.connect(socket);
  assert.equal(socket.last('welcome').autopilot, true);
  lobby.handle(human, { type: 'create', plan: '2' });
  lobby.handle(human, { type: 'autopilot', on: true });
  const explorer = human.room.members.get(human).explorer, x = explorer.position.x;
  for (let tick = 0; tick < 10; tick++) lobby.tick();
  await settle();
  assert.equal(agents.requests.length, 1);
  assert.equal(agents.requests[0].ids, undefined, 'ids stay in the room server');
  for (let tick = 0; tick < 10; tick++) lobby.tick();
  await settle();
  assert.ok(explorer.position.x > x);
  assert.equal(agents.requests.length, 2);
  assert.equal(socket.last('state').explorers[0].autopilot, true);
});

test('when the agent service fails, autopilot explorers stop and their players are told once', async () => {
  const agents = fakeAgents(() => { throw new Error('down'); });
  const lobby = lobbyWith({ agents });
  const socket = fakeSocket(), human = lobby.connect(socket);
  lobby.handle(human, { type: 'create', plan: '2' });
  lobby.handle(human, { type: 'autopilot', on: true });
  for (let round = 0; round < 3; round++) {
    for (let tick = 0; tick < 10; tick++) lobby.tick();
    await settle();
  }
  assert.equal(agents.requests.length, 3);
  assert.equal(socket.sent.filter(message => message.type === 'error').length, 1);
  assert.deepEqual(human.room.members.get(human).explorer.movement, { dx: 0, dy: 0 });
});

test('heatmaps go only to the players who asked, twice a second', () => {
  const lobby = lobbyWith();
  const [cheat, honest] = [fakeSocket(), fakeSocket()];
  const [a, b] = [lobby.connect(cheat), lobby.connect(honest)];
  lobby.handle(a, { type: 'create', plan: '3' });
  lobby.handle(b, { type: 'join', room: a.room.id });
  lobby.handle(a, { type: 'heatmap', on: true });
  assert.ok(cheat.last('heat'), 'sent at once on asking');
  for (let tick = 0; tick < 20; tick++) lobby.tick();
  assert.equal(cheat.sent.filter(m => m.type === 'heat').length, 3);
  assert.equal(honest.sent.filter(m => m.type === 'heat').length, 0);
  lobby.handle(a, { type: 'heatmap', on: false });
  for (let tick = 0; tick < 20; tick++) lobby.tick();
  assert.equal(cheat.sent.filter(m => m.type === 'heat').length, 3);
});

test('a player who leaves while their agent drives leaves it playing, and gets it back on rejoining', async () => {
  const lobby = lobbyWith({ agents: fakeAgents() });
  const [socket, watcherSocket] = [fakeSocket(), fakeSocket()];
  const human = lobby.connect(socket);
  lobby.connect(watcherSocket);
  lobby.handle(human, { type: 'create', plan: '2' });
  const room = human.room;
  lobby.handle(human, { type: 'autopilot', on: true });
  lobby.handle(human, { type: 'leave' });
  assert.ok(socket.last('left'));
  assert.equal(lobby.rooms.size, 1, 'the room lives on with the agent');
  const [listed] = watcherSocket.last('rooms').rooms;
  assert.deepEqual([listed.humans, listed.agents, listed.explorers], [0, 1, 1]);
  assert.deepEqual(socket.last('agents').agents, [{ plan: '2', planName: 'Simple Centre', room: room.id }]);
  const statesBefore = socket.sent.filter(m => m.type === 'state').length;
  for (let tick = 0; tick < 4; tick++) lobby.tick();
  assert.equal(socket.sent.filter(m => m.type === 'state').length, statesBefore, 'no snapshots while away');
  assert.equal(room.snapshot().explorers[0].away, true);

  lobby.handle(human, { type: 'join', room: room.id });
  assert.equal(socket.last('joined').you.autopilot, true, 'back in agent mode');
  assert.deepEqual(socket.last('agents').agents, []);
  assert.equal(room.members.size, 1);
});

test('one agent per map per player: joining another room on that map withdraws it', () => {
  const lobby = lobbyWith({ agents: fakeAgents() });
  const socket = fakeSocket(), human = lobby.connect(socket);
  lobby.handle(human, { type: 'create', plan: '2' });
  const first = human.room;
  lobby.handle(human, { type: 'autopilot', on: true });
  lobby.handle(human, { type: 'leave' });
  lobby.handle(human, { type: 'create', plan: '3' }); // another map: the agent keeps playing
  assert.ok(lobby.rooms.has(first.id));
  lobby.handle(human, { type: 'leave' });
  lobby.handle(human, { type: 'create', plan: '2' }); // same map: the agent moves here with them
  assert.equal(lobby.rooms.has(first.id), false);
  assert.equal(human.room.members.size, 1);
});

test('closing the tab stops every agent of the player', () => {
  const agents = fakeAgents();
  const lobby = lobbyWith({ agents });
  const socket = fakeSocket(), human = lobby.connect(socket);
  for (const plan of ['2', '3']) {
    lobby.handle(human, { type: 'create', plan });
    lobby.handle(human, { type: 'autopilot', on: true });
    lobby.handle(human, { type: 'leave' });
  }
  assert.equal(lobby.rooms.size, 2);
  lobby.disconnect(human);
  assert.equal(lobby.rooms.size, 0);
});
