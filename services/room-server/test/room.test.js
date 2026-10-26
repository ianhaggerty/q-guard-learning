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
