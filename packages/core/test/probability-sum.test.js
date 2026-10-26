// The deterministic probability field: expected unresolved events per pixel and ΣP.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MATERIAL, World, cloneMap, encodeMap, fillRect, updateUnresolvedMean } from '../src/index.js';
import { weightedMap, within } from './helpers.js';

const near = within(1e-9);
const sumMap = points => weightedMap(points, { name: 'Sum' });
const explore = map => new World(map, { random: () => 0.5 });

test('closed-form mean handles no observation, continued viewing, zero births and short intervals', () => {
  near(updateUnresolvedMean(2, 0.3, 0, 4), 3.2);
  near(updateUnresolvedMean(0, 0.3, 0.5, 4), 0.6 * (1 - Math.exp(-2)));
  near(updateUnresolvedMean(2, 0, 0.5, 4), 2 * Math.exp(-2));
  near(updateUnresolvedMean(2, 0.3, 0.5, 0), 2);
  near(updateUnresolvedMean(0, 0.3, 1e-12, 4), 1.2, 1e-10);
  assert.throws(() => updateUnresolvedMean(0, -1, 0, 1));
});

test('unobserved pixels on other floors accumulate exact occupancy probabilities and sums', () => {
  const world = explore(sumMap([[1, 12, 9, 1], [1, 13, 9, 2], [1, 13, 10, -2]])), field = world.probabilities;
  world.events.setRate(0.1);
  world.advance(2);
  const p1 = 1 - Math.exp(-0.2), p2 = 1 - Math.exp(-0.4);
  near(field.probabilityAt(12, 9, 1), p1);
  near(field.probabilityAt(13, 9, 1), p2);
  near(field.sum, p1 + p2);
  near(field.floorSums[0], 0);
  near(field.floorSums[1], field.sum);
  near(field.probabilityAt(13, 10, 1), 0);
});

test('visible risk follows analytic immigration/detection model and is lower than unseen risk', () => {
  const world = explore(sumMap([[0, 12, 9, 2], [1, 12, 9, 2]])), field = world.probabilities;
  world.events.setRate(0.1);
  const mu = -Math.log1p(-world.detectionAt(12.5, 9.5));
  world.advance(3);
  const seen = 1 - Math.exp(-0.2 / mu * (1 - Math.exp(-mu * 3)));
  near(field.probabilityAt(12, 9, 0), seen);
  assert.ok(seen < field.probabilityAt(12, 9, 1));
  near(field.sum, field.floorSums[0] + field.floorSums[1]);
});

test('opaque occlusion and rear direction prevent risk reduction; transparent material permits it', () => {
  const unseen = 1 - Math.exp(-0.2);
  for (const material of [MATERIAL.OPAQUE, MATERIAL.TRANSPARENT]) {
    const map = sumMap([[0, 12, 9, 1]]);
    fillRect(map.floors[0].pixels, 18, 18, 9, 0, 3, 18, material);
    const world = explore(map);
    world.events.setRate(0.1);
    world.advance(2);
    if (material === MATERIAL.OPAQUE) near(world.probabilities.sum, unseen);
    else assert.ok(world.probabilities.sum < unseen);
  }
  const world = explore(sumMap([[0, 12, 9, 1]]));
  world.events.setRate(0.1);
  world.setLook('back');
  world.advance(2);
  near(world.probabilities.sum, unseen);
});

test('positive opaque/transparent/door pixel values contribute; zero and negative values remain zero', () => {
  const world = explore(sumMap([[1, 3, 3, 1, 1], [1, 4, 3, 2, 2], [1, 5, 3, 3, 3], [1, 6, 3, 0], [1, 7, 3, -3]]));
  world.events.setRate(0.1);
  world.advance(1);
  near(world.probabilities.sum, [1, 2, 3].reduce((sum, value) => sum + 1 - Math.exp(-0.1 * value), 0));
  assert.equal(world.probabilities.means.length, 3);
});

test('stationary results are invariant to frame subdivision and event randomness', () => {
  const map = sumMap([[0, 12, 9, 1], [1, 12, 9, 3]]);
  const once = explore(cloneMap(map)), sliced = new World(cloneMap(map), { random: () => 0.2 });
  once.events.setRate(0.2);
  sliced.events.setRate(0.2);
  once.advance(4);
  for (let i = 0; i < 400; i++) sliced.advance(0.01);
  near(once.probabilities.sum, sliced.probabilities.sum);
  const floorSums = world => Array.from(world.probabilities.floorSums).map(n => n.toFixed(8));
  assert.deepEqual(floorSums(once), floorSums(sliced));
});

test('viewing history, rate changes and pause matter; sampled resolution does not reset expectation', () => {
  const map = sumMap([[0, 12, 9, 1]]), world = explore(map), field = world.probabilities;
  world.events.setRate(0.1);
  world.setLook('back');
  world.advance(2);
  world.setLook('forward');
  world.events.setRate(0);
  const unseen = field.sum;
  world.advance(1);
  assert.ok(field.sum < unseen);

  const means = Array.from(field.means), sum = field.sum, elapsed = field.elapsed;
  world.paused = true;
  world.advance(10);
  assert.deepEqual(Array.from(field.means), means);
  assert.equal(field.sum, sum);
  assert.equal(field.elapsed, elapsed);
  world.paused = false;

  world.events.spawn().detectionBudget = 1e-6;
  world.advance(0.1);
  assert.equal(world.events.resolved, 1);
  assert.ok(field.sum > 0);
  assert.equal(explore(map).probabilities.sum, 0);
});

test('door opening and floor changes invalidate cached detection rates', () => {
  const map = sumMap([[0, 12, 9, 1], [1, 12, 9, 1]]);
  fillRect(map.floors[0].pixels, 18, 18, 9, 0, 3, 18, MATERIAL.DOOR);
  const world = explore(map), field = world.probabilities;
  world.events.setRate(0.1);
  world.player.x = 3; // too far for the door to open
  world.advance(1);
  near(field.probabilityAt(12, 9, 0), 1 - Math.exp(-0.1));
  world.player.x = 6; // the door opens
  world.events.setRate(0);
  world.advance(1);
  assert.ok(field.probabilityAt(12, 9, 0) < 1 - Math.exp(-0.1));
  const upperBefore = field.floorSums[1];
  world.activateFloor(1);
  world.advance(1);
  assert.ok(field.floorSums[1] < upperBefore);
});

test('every pixel sum matches a direct lookup sum, stays bounded and does not mutate architecture', () => {
  const map = sumMap([[0, 12, 9, 0.5], [0, 13, 9, 2], [1, 12, 9, 3]]), saved = encodeMap(map), world = explore(map);
  world.events.setRate(0.1);
  world.advance(2);
  let sum = 0;
  for (let floor = 0; floor < 2; floor++) {
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 18; x++) {
        const p = world.probabilities.probabilityAt(x, y, floor);
        assert.ok(p >= 0 && p <= 1);
        sum += p;
      }
    }
  }
  near(world.probabilities.sum, sum);
  assert.deepEqual(encodeMap(map), saved);
  for (const x of [-1, 18, NaN]) assert.equal(world.probabilities.probabilityAt(x, 0, 0), 0);
});
