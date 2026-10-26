// The one-second detection probability and how World applies it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MATERIAL, World, detectionChance, encodeMap, fillRect } from '../packages/core/src/index.js';
import { blankBuilding, within } from './helpers.js';

const near = within(1e-10);

function room() {
  return blankBuilding({ width: 192, height: 192, name: 'Detection', floorNames: ['Ground'], spawn: { x: 60, y: 60, floor: 0 } });
}

test('one-second probability falls linearly with absolute eccentricity at fixed distance', () => {
  for (const distance of [0, 5, 10, 1000]) {
    const ahead = detectionChance(distance, 0);
    for (const angle of [0, 25, 50, 75, 100, 120, 180]) {
      near(detectionChance(distance, angle), ahead * Math.max(0, 1 - angle / 100));
      near(detectionChance(distance, angle), detectionChance(distance, -angle));
    }
  }
});

test('inverse-distance attenuation has no finite cutoff and half distance is configurable', () => {
  near(detectionChance(0, 0), 0.9);
  near(detectionChance(10, 0), 0.45);
  near(detectionChance(10, 50), 0.225);
  near(detectionChance(20, 0, 20), 0.45);
  let previous = 1;
  for (const distance of [0, 1, 10, 100, 1e3, 1e6]) {
    const chance = detectionChance(distance, 0);
    assert.ok(chance > 0 && chance < previous);
    previous = chance;
  }
});

test('World detection rotates consistently through all eight directions', () => {
  const world = new World(room());
  for (let heading = 0; heading < 8; heading++) {
    world.heading = heading;
    world.setLook('forward');
    for (const angle of [-120, -100, -75, -50, 0, 50, 75, 100, 120]) {
      // 30 px = 5 m away at `angle` degrees from the facing direction.
      const radians = (heading * 45 + angle) * Math.PI / 180;
      near(world.detectionAt(60 + 30 * Math.cos(radians), 60 + 30 * Math.sin(radians)), detectionChance(5, angle));
    }
  }
});

test('distance beyond old 70 pixel radius remains detectable, while rear is zero', () => {
  const world = new World(room());
  assert.ok(world.detectionAt(180, 60) > 0);
  near(world.detectionAt(0, 60), 0);
});

test('opaque mass and closed doors occlude detection; transparent mass and open doors permit it', () => {
  for (const material of [MATERIAL.OPAQUE, MATERIAL.TRANSPARENT, MATERIAL.DOOR]) {
    const map = room();
    fillRect(map.pixels, map.width, map.height, 66, 0, 3, 192, material);
    const world = new World(map);
    near(world.detectionAt(75, 60), material === MATERIAL.TRANSPARENT ? detectionChance(2.5, 0) : 0);
    if (material === MATERIAL.DOOR) {
      world.player = { x: 64, y: 60 };
      world.updateDoors();
      assert.ok(world.detectionAt(75, 60) > 0);
    }
  }
});

test('time accumulation is stable across time subdivisions and stays bounded', () => {
  const world = new World(room()), oneSecond = world.detectionAt(90, 60);
  near(world.detectionAt(90, 60, 0), 0);
  near(world.detectionAt(90, 60, 2), 1 - (1 - oneSecond) ** 2);
  const tenth = world.detectionAt(90, 60, 0.1);
  near(1 - (1 - tenth) ** 10, oneSecond);
  assert.ok(world.detectionAt(90, 60, 1e6) <= 1);
  near(world.detectionAt(60, 60), 0.9);
});

test('invalid parameters rejected and detection queries leave energy/materials untouched', () => {
  const map = room(), world = new World(map), saved = encodeMap(map), energy = JSON.stringify(world.energy);
  for (const range of [0, -1, NaN, Infinity]) assert.throws(() => world.setDetectionHalfRange(range));
  for (const seconds of [-1, NaN, Infinity]) assert.throws(() => world.detectionAt(90, 60, seconds));
  assert.throws(() => world.detectionAt(NaN, 60));
  assert.throws(() => detectionChance(-1, 0));
  world.setDetectionHalfRange(20);
  near(world.detectionAt(180, 60), 0.45);
  assert.equal(JSON.stringify(world.energy), energy);
  assert.deepEqual(encodeMap(map), saved);
});
