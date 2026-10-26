// One room: explorers for humans, inputs applied on fixed ticks, and compact snapshots.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlans } from '../src/plans.js';
import { Room, TICK_SECONDS, parseInput } from '../src/room.js';

const plans = loadPlans();
const plan = id => plans.find(p => p.id === id);
const session = id => ({ id, name: `Guest ${id}` });

test('inputs are validated', () => {
  assert.deepEqual(parseInput({ move: [1, -1], gait: 'run', look: 'left' }), { dx: 1, dy: -1, gait: 'run', look: 'left' });
  for (const bad of [{ move: [2, 0], gait: 'run', look: 'left' }, { move: [1], gait: 'run', look: 'left' },
    { move: [0, 0], gait: 'jog', look: 'left' }, { move: [0, 0], gait: 'walk', look: 'toString' }, {}]) {
    assert.equal(parseInput(bad), null, JSON.stringify(bad));
  }
});

test('each human gets an explorer, starting from the numbered starts in turn', () => {
  const room = new Room('r1', plan('2'));
  const [a, b, c] = ['a', 'b', 'c'].map(session);
  const explorers = [a, b, c].map(s => room.addMember(s));
  assert.equal(room.humans, 3);
  assert.deepEqual(explorers.map(e => e.startIndex), [0, 1, 0]);
  assert.deepEqual(explorers.map(e => e.id), ['a', 'b', 'c']);
  room.removeMember(b);
  assert.equal(room.humans, 2);
  assert.equal(room.world.explorers.length, 2);
});

test('inputs take effect at the next tick and persist until changed', () => {
  const room = new Room('r1', plan('2')), human = session('a');
  const explorer = room.addMember(human), x = explorer.position.x;
  room.setInput(human, { dx: 1, dy: 0, gait: 'run', look: 'forward' });
  assert.equal(explorer.position.x, x);
  for (let tick = 0; tick < 10; tick++) room.step();
  assert.equal(room.tick, 10);
  assert.ok(Math.abs(room.world.time - 10 * TICK_SECONDS) < 1e-9);
  assert.ok(explorer.position.x > x);
  assert.equal(explorer.gait, 'run');
});

test('a sit request sits down at a nearby chair, and another stands up', () => {
  const room = new Room('r1', plan('1')), human = session('a');
  const explorer = room.addMember(human);
  explorer.position = { x: 93, y: 10.5 }; // in front of the corridor's chair
  room.requestSit(human);
  room.step();
  assert.equal(explorer.sitting, true);
  room.requestSit(human);
  room.step();
  assert.equal(explorer.sitting, false);
});

test('a room holds at most maxHumans', () => {
  const room = new Room('r1', plan('1'), { maxHumans: 2 });
  room.addMember(session('a'));
  assert.equal(room.full, false);
  room.addMember(session('b'));
  assert.equal(room.full, true);
});

test('snapshots carry every explorer, open doors per floor and the score', () => {
  const room = new Room('r1', plan('6'));
  room.addMember(session('a'));
  room.addMember(session('b'));
  for (let tick = 0; tick < 4; tick++) room.step();
  const snapshot = room.snapshot();
  assert.equal(snapshot.type, 'state');
  assert.equal(snapshot.tick, 4);
  assert.deepEqual(snapshot.explorers.map(e => e.name), ['Guest a', 'Guest b']);
  assert.equal(snapshot.doors.length, room.world.map.floors.length);
  for (const explorer of snapshot.explorers) {
    for (const field of ['x', 'y', 'floor', 'heading', 'facing', 'gait', 'look', 'sitting', 'credit', 'kcal']) assert.ok(field in explorer, field);
  }
  assert.ok(snapshot.psum > 0);
  assert.ok(JSON.stringify(snapshot).length < 2000);
});

test('the agent request describes every explorer in training terms and names the driven ones', () => {
  const room = new Room('r1', plan('6'));
  const [human, driven] = [session('a'), session('b')];
  room.addMember(human);
  const explorer = room.addMember(driven);
  assert.equal(room.agentRequest(), null);
  room.setAutopilot(driven, true);
  explorer.setLook('left');
  explorer.setGait('sprint');
  const request = room.agentRequest();
  assert.equal(request.plan, '6');
  assert.deepEqual(request.ids, ['b']);
  assert.deepEqual(request.agents, [1]);
  assert.equal(request.explorers.length, 2);
  assert.deepEqual(
    { look: request.explorers[1].look, gait: request.explorers[1].gait, seat: request.explorers[1].seat },
    { look: 6, gait: 2, seat: -1 },
  );
  const means = new Float32Array(Buffer.from(request.means, 'base64').buffer.slice(0));
  assert.equal(means.length, room.world.events.candidates.length);
});

test('agent actions steer like the training simulator: moves, gait and absolute gaze', () => {
  const room = new Room('r1', plan('2')), driven = session('a');
  const explorer = room.addMember(driven);
  room.setAutopilot(driven, true);
  const x = explorer.position.x;
  room.applyActions(['a'], [[1, 1, 2]]); // east, running, gaze south
  room.step();
  assert.equal(explorer.heading, 0);
  assert.equal(explorer.facing, 2);
  assert.equal(explorer.look, 'right');
  assert.equal(explorer.gait, 'run');
  assert.ok(explorer.position.x > x);
  room.applyActions(['a'], [[0, 0, 5]]); // stop and look north-west
  room.step();
  const stopped = explorer.position.x;
  room.step();
  assert.equal(explorer.position.x, stopped);
  assert.equal(explorer.facing, 5);
});

test('the sit action seats the explorer facing as the chair does, then looks where the agent says', () => {
  const room = new Room('r1', plan('1')), driven = session('a');
  const explorer = room.addMember(driven);
  explorer.position = { x: 93, y: 10.5 };
  room.setAutopilot(driven, true);
  room.applyActions(['a'], [[9, 0, 4]]);
  room.step();
  assert.equal(explorer.sitting, true);
  assert.equal(explorer.facing, 4);
});

test('while the autopilot drives, the player\'s input is ignored; taking control back stops the explorer', () => {
  const room = new Room('r1', plan('2')), player = session('a');
  const explorer = room.addMember(player);
  room.setAutopilot(player, true);
  room.setInput(player, { dx: 0, dy: 1, gait: 'sprint', look: 'back' });
  room.requestSit(player);
  room.step();
  assert.equal(explorer.gait, 'walk');
  room.applyActions(['a'], [[1, 0, 0]]);
  room.step();
  room.setAutopilot(player, false);
  const x = explorer.position.x;
  room.step();
  assert.equal(explorer.position.x, x);
  room.applyActions(['a'], [[1, 0, 0]]);
  room.step();
  assert.equal(explorer.position.x, x, 'late actions for a player who took back control are dropped');
});

test('the heatmap has one byte per 3 × 3 block per floor and grows where nobody looks', () => {
  const room = new Room('r1', plan('6'));
  room.addMember(session('a'));
  const fresh = room.heat();
  assert.equal(fresh.type, 'heat');
  assert.equal(fresh.block, 3);
  assert.equal(fresh.floors.length, 2);
  const bytes = floor => Buffer.from(fresh.floors[floor], 'base64');
  assert.equal(bytes(0).length, fresh.width * fresh.height);
  assert.ok(bytes(0).every(value => value === 0));
  for (let tick = 0; tick < 1200; tick++) room.step(); // a minute
  const upper = Buffer.from(room.heat().floors[1], 'base64');
  assert.ok(Math.max(...upper) > 0, 'the floor nobody is on warms up');
});

test('an agent whose player has left keeps its place; the player returns to the same explorer', () => {
  const room = new Room('r1', plan('2'));
  const [player, other] = [session('a'), session('b')];
  const explorer = room.addMember(player);
  room.addMember(other);
  room.setAutopilot(player, true);
  room.detachMember(player);
  assert.deepEqual([room.humans, room.agents, room.members.size], [1, 1, 2]);
  assert.deepEqual(room.present, [other]);
  assert.equal(room.addMember(player), explorer);
  assert.equal(room.humans, 2);
});
