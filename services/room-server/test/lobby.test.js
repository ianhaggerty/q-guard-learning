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
