// The room server end to end: real WebSocket sessions against a server on a free port,
// with a fast clock so simulated time passes quickly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket as Client } from 'ws';
import { MemoryAccounts, SESSION_COOKIE } from '@pixel-map-lab/accounts';
import { startServer } from '../src/server.js';

const TICK_MS = 2;

async function server(options = {}) {
  const started = await startServer({ port: 0, tickMs: TICK_MS, ...options });
  return started;
}

/** A WebSocket client that queues messages and lets a test wait for the next one of a type. */
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rooms`);
  const inbox = [], waiters = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const waiter = waiters.findIndex(({ match }) => match(message));
    if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message);
    else inbox.push(message);
  });
  const closed = new Promise(resolve => ws.addEventListener('close', event => resolve(event.code)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return {
    ws,
    closed,
    send: message => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
    /** The next message of `type` (and passing `test`), from the queue or as it arrives. */
    next(type, check = () => true, timeout = 2000) {
      const match = message => message.type === type && check(message);
      const queued = inbox.findIndex(match);
      if (queued >= 0) return Promise.resolve(inbox.splice(queued, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} message`)), timeout);
        waiters.push({ match, resolve: message => { clearTimeout(timer); resolve(message); } });
      });
    },
    close: () => { ws.close(); return closed; },
  };
}

test('every connection is a new session with a unique id, the seven plans and the room list', async t => {
  const room = await server();
  t.after(room.close);
  const [a, b] = [await connect(room.port), await connect(room.port)];
  const [welcomeA, welcomeB] = [await a.next('welcome'), await b.next('welcome')];
  assert.notEqual(welcomeA.session.id, welcomeB.session.id);
  assert.notEqual(welcomeA.player.id, welcomeB.player.id, 'every guest is their own player');
  assert.match(welcomeA.player.name, /^Guest [0-9a-f]{4}$/);
  assert.equal(welcomeA.player.signedIn, false);
  assert.deepEqual(welcomeA.plans.map(plan => plan.id), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(welcomeA.plans[6].name, 'Alcatraz');
  assert.deepEqual(welcomeA.rooms, []);
  await a.close();
  await b.close();
});

test('creating a room joins it, sends the map and lists it for others in the lobby', async t => {
  const room = await server();
  t.after(room.close);
  const [host, watcher] = [await connect(room.port), await connect(room.port)];
  const { player } = await host.next('welcome');
  await watcher.next('welcome');
  host.send({ type: 'create', plan: '3' });
  const joined = await host.next('joined');
  assert.equal(joined.room.plan, '3');
  assert.equal(joined.map.format, 'pixel-map-lab');
  const state = await host.next('state');
  assert.deepEqual(state.explorers.map(explorer => explorer.id), [player.id]);
  const { rooms } = await watcher.next('rooms', message => message.rooms.length === 1);
  assert.deepEqual(rooms.map(({ id, plan, humans }) => ({ id, plan, humans })), [{ id: joined.room.id, plan: '3', humans: 1 }]);
  await host.close();
  await watcher.close();
});

test('a second human joins an existing room and both explorers appear in its snapshots', async t => {
  const room = await server();
  t.after(room.close);
  const [host, guest] = [await connect(room.port), await connect(room.port)];
  const hostId = (await host.next('welcome')).player.id, guestId = (await guest.next('welcome')).player.id;
  host.send({ type: 'create', plan: '6' });
  const { room: { id } } = await host.next('joined');
  guest.send({ type: 'join', room: id });
  await guest.next('joined');
  const state = await guest.next('state', message => message.explorers.length === 2);
  assert.deepEqual(state.explorers.map(explorer => explorer.id).sort(), [hostId, guestId].sort());
  await host.next('state', message => message.explorers.length === 2);
  await host.close();
  await guest.close();
});

test('inputs move the explorer, and the server keeps score', async t => {
  const room = await server();
  t.after(room.close);
  const human = await connect(room.port);
  await human.next('welcome');
  human.send({ type: 'create', plan: '2' });
  await human.next('joined');
  const start = (await human.next('state')).explorers[0];
  human.send({ type: 'input', move: [1, 0], gait: 'run', look: 'forward' });
  const moved = await human.next('state', message => message.explorers[0].x > start.x + 3);
  const explorer = moved.explorers[0];
  assert.equal(explorer.gait, 'run');
  assert.equal(explorer.heading, 0);
  assert.ok(explorer.kcal > 0);
  assert.ok(explorer.credit > 0);
  await human.close();
});

test('a room is destroyed when its last human leaves or closes the tab', async t => {
  const room = await server();
  t.after(room.close);
  const [host, guest, watcher] = [await connect(room.port), await connect(room.port), await connect(room.port)];
  for (const client of [host, guest, watcher]) await client.next('welcome');
  host.send({ type: 'create', plan: '1' });
  const { room: { id } } = await host.next('joined');
  guest.send({ type: 'join', room: id });
  await guest.next('joined');

  host.send({ type: 'leave' });
  await host.next('left');
  await watcher.next('rooms', message => message.rooms.length === 1 && message.rooms[0].humans === 1);
  assert.equal(room.lobby.rooms.size, 1);

  await guest.close(); // closing the tab ends the session
  await watcher.next('rooms', message => message.rooms.length === 0);
  assert.equal(room.lobby.rooms.size, 0);
  host.send({ type: 'join', room: id });
  assert.equal((await host.next('error')).message, 'That room has closed.');
  await host.close();
  await watcher.close();
});

test('unknown maps, invalid inputs and unreadable messages get an error, not a crash', async t => {
  const room = await server();
  t.after(room.close);
  const human = await connect(room.port);
  await human.next('welcome');
  human.send({ type: 'create', plan: '99' });
  assert.equal((await human.next('error')).message, 'Choose one of the listed maps.');
  human.send('not json');
  assert.equal((await human.next('error')).message, 'Unknown message.');
  human.send({ type: 'create', plan: '1' });
  await human.next('joined');
  human.send({ type: 'input', move: [5, 0], gait: 'run', look: 'forward' });
  assert.equal((await human.next('error')).message, 'That input is not valid.');
  human.send({ type: 'input', move: [1, 0], gait: 'fly', look: 'forward' });
  await human.next('error');
  await human.close();
});

test('a full room turns new humans away', async t => {
  const room = await server({ maxHumansPerRoom: 1 });
  t.after(room.close);
  const [host, guest] = [await connect(room.port), await connect(room.port)];
  await host.next('welcome');
  await guest.next('welcome');
  host.send({ type: 'create', plan: '1' });
  const { room: { id } } = await host.next('joined');
  guest.send({ type: 'join', room: id });
  assert.equal((await guest.next('error')).message, 'That room is full.');
  await host.close();
  await guest.close();
});

test('a draining server refuses new rooms, fails readiness and finishes once rooms empty', async t => {
  const room = await server();
  t.after(room.close);
  const host = await connect(room.port);
  await host.next('welcome');
  host.send({ type: 'create', plan: '1' });
  await host.next('joined');
  const drained = room.draining();
  assert.equal((await fetch(`http://127.0.0.1:${room.port}/readyz`)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${room.port}/healthz`)).status, 200);
  const late = await connect(room.port);
  await late.next('welcome');
  late.send({ type: 'create', plan: '2' });
  assert.match((await late.next('error')).message, /shutting down/);
  await host.close();
  await drained;
  await late.close();
});

test('a session that floods the server is disconnected', async t => {
  const room = await server();
  t.after(room.close);
  const flooder = await connect(room.port);
  await flooder.next('welcome');
  for (let i = 0; i < 200; i++) flooder.send({ type: 'sit' });
  assert.equal(await flooder.closed, 1008);
});

test('a WebSocket that brings a valid login cookie is that user\'s; a bad one makes a guest', async t => {
  const accounts = new MemoryAccounts();
  const user = await accounts.devUser('alice');
  const token = await accounts.createSession(user.id);
  const room = await server({ accounts });
  t.after(room.close);
  const welcome = cookie => new Promise((resolve, reject) => {
    const ws = new Client(`ws://127.0.0.1:${room.port}/rooms`, { headers: { cookie } });
    ws.on('message', data => { resolve(JSON.parse(data)); ws.close(); });
    ws.on('error', reject);
  });
  const signed = await welcome(`${SESSION_COOKIE}=${token}`);
  assert.deepEqual(signed.player, { id: `user:${user.id}`, name: 'dev:alice', signedIn: true });
  const guest = await welcome(`${SESSION_COOKIE}=forged`);
  assert.equal(guest.player.signedIn, false);
});
