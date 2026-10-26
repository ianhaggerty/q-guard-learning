// Sampled events: weighted Poisson arrivals and exact detection thresholds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventSimulation, MATERIAL, World, cloneMap, encodeMap, fillRect } from '../packages/core/src/index.js';
import { seededRandom, weightedMap, within } from './helpers.js';

const near = within(1e-8);

test('arrival weights use exact per-pixel values on all materials and floors; nonpositive excluded', () => {
  const map = weightedMap([[0, 12, 9, 1], [0, 13, 9, 3, 1], [1, 12, 9, 2, 2], [1, 13, 9, 0, 3], [0, 12, 10, -9]]);
  const events = new EventSimulation(map, seededRandom());
  assert.equal(events.candidates.length, 3);
  near(events.totalWeight, 6);
  assert.deepEqual(events.floorWeights, [4, 2]);

  const counts = {};
  for (let i = 0; i < 6000; i++) {
    const event = events.spawn(), key = `${event.floor}:${Math.floor(event.x)}:${Math.floor(event.y)}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  for (const [key, expected] of [['0:12:9', 1000], ['0:13:9', 3000], ['1:12:9', 2000]]) {
    assert.ok(Math.abs(counts[key] - expected) < 150, JSON.stringify(counts));
  }
  assert.equal(Object.keys(counts).length, 3);
});

test('Poisson arrival clock uses rate × sum of values and does not give newborns exposure from before birth', () => {
  const world = new World(weightedMap([[0, 12, 9, 2]]), { random: seededRandom() }), events = world.events;
  events.setRate(0.5); // 0.5 × weight 2 = one arrival per second
  events.birthBudget = 0.3;
  events.advance(0.2, world);
  assert.equal(events.spawned, 0);
  events.advance(0.100001, world);
  assert.equal(events.spawned, 1);
  near(events.active[0].born, 0.3);
  assert.ok(events.active[0].detectionBudget > 0);
});

test('spotted events resolve exactly once and generate finite-lived feedback', () => {
  const world = new World(weightedMap([[0, 12, 9, 1]]), { random: seededRandom() }), events = world.events;
  events.setRate(0);
  const event = events.spawn();
  const hazard = -Math.log1p(-world.detectionAt(event.x, event.y));
  event.detectionBudget = hazard * 0.5; // spotted after half a second in view
  world.advance(0.4);
  assert.equal(events.active.length, 1);
  world.advance(0.2);
  assert.equal(events.active.length, 0);
  assert.equal(events.resolved, 1);
  near(events.recent[0].resolvedAt, 0.5);
  assert.equal(events.resolvedFx.length, 1);
  world.advance(2);
  assert.equal(events.resolved, 1);
  assert.equal(events.resolvedFx.length, 0);
});

test('events outside arc, on another floor or behind opaque walls remain unresolved', () => {
  for (const reason of ['rear', 'floor', 'wall']) {
    const map = weightedMap([[reason === 'floor' ? 1 : 0, 12, 9, 1]]);
    if (reason === 'wall') fillRect(map.floors[0].pixels, 18, 18, 9, 0, 3, 18, MATERIAL.OPAQUE);
    const world = new World(map, { random: seededRandom() }), events = world.events;
    events.setRate(0);
    events.spawn().detectionBudget = 0.01;
    if (reason === 'rear') world.setLook('back');
    world.advance(2);
    assert.equal(events.resolved, 0, reason);

    if (reason === 'rear') world.setLook('forward');
    if (reason === 'floor') world.activateFloor(1);
    if (reason === 'wall') fillRect(map.floors[0].pixels, 18, 18, 9, 0, 3, 18, MATERIAL.TRANSPARENT);
    world.advance(2);
    assert.equal(events.resolved, 1, reason);
  }
});

test('detection threshold integrates partial exposure using existing distance/eccentricity probabilities', () => {
  const world = new World(weightedMap([[0, 12, 9, 1]]), { random: seededRandom() }), events = world.events;
  events.setRate(0);
  const event = events.spawn(), hazard = -Math.log1p(-world.detectionAt(event.x, event.y));
  event.detectionBudget = hazard;
  world.advance(0.4);
  near(event.detectionBudget, 0.6 * hazard);
  world.setLook('back');
  world.advance(3);
  near(event.detectionBudget, 0.6 * hazard);
  world.setLook('forward');
  world.advance(0.61);
  assert.equal(events.resolved, 1);
  near(events.recent[0].resolvedAt, 4);
});

test('static arrival and resolution results agree across frame subdivisions with seeded randomness', () => {
  const map = weightedMap([[0, 12, 9, 1], [0, 4, 3, 2], [1, 10, 9, 3]]);
  const once = new World(cloneMap(map), { random: seededRandom(99) }), sliced = new World(cloneMap(map), { random: seededRandom(99) });
  once.events.setRate(0.1);
  sliced.events.setRate(0.1);
  once.advance(10);
  for (let i = 0; i < 1000; i++) sliced.advance(0.01);
  assert.equal(once.events.spawned, sliced.events.spawned);
  assert.equal(once.events.resolved, sliced.events.resolved);
  const summary = world => world.events.active.map(event => [event.id, event.x, event.y, event.floor]);
  assert.deepEqual(summary(once), summary(sliced));
  near(once.events.birthBudget, sliced.events.birthBudget);
  for (let i = 0; i < once.events.active.length; i++) near(once.events.active[i].detectionBudget, sliced.events.active[i].detectionBudget);
});

test('pause freezes events; zero birth rate still permits spotting; restart clears event state', () => {
  const map = weightedMap([[0, 12, 9, 1]]), world = new World(map, { random: seededRandom() }), events = world.events;
  events.setRate(0);
  events.spawn().detectionBudget = 0.1;
  world.paused = true;
  const before = JSON.stringify(events);
  world.advance(30);
  assert.equal(JSON.stringify(events), before);
  world.paused = false;
  world.advance(2);
  assert.equal(events.spawned, 1);
  assert.equal(events.resolved, 1);
  const next = new World(map, { random: seededRandom() });
  assert.equal(next.events.spawned, 0);
  assert.equal(next.events.active.length, 0);
});

test('empty weight maps spawn nothing, events do not change map, energy model or values', () => {
  const map = weightedMap(), world = new World(map, { random: seededRandom() }), saved = encodeMap(map);
  world.events.setRate(100);
  world.advance(2);
  assert.equal(world.events.spawned, 0);
  assert.deepEqual(encodeMap(map), saved);
  near(world.energy.kcal, 1.3 * 70 * 2 / 3600);
  for (const rate of [-1, NaN, Infinity]) assert.throws(() => world.events.setRate(rate));
  assert.throws(() => world.events.advance(-1, world));
});
