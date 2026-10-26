// Chairs: placement rules, sitting and standing, and persistence.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAIR_SEAT_HEIGHT, CHAIR_SIZE, MATERIAL, METRES_PER_PIXEL, World, addChair, addStair, alignGrid, assignValue,
  chairFront, cloneMap, decodeMap, encodeMap, eraseAt, fillRect, paintGrid, pruneChairs, valueAt,
} from '../src/index.js';
import { blankBuilding, courtyard, within } from './helpers.js';

const near = within(1e-8);

function room() {
  return alignGrid(blankBuilding({ width: 42, height: 42, name: 'Chairs', spawn: { x: 6, y: 6, floor: 0 } }));
}

function testChair(rotation = 0, floor = 0) {
  return { id: 'seat', x: 15, y: 15, rotation, floor };
}

test('chair is one half-metre grid block with a 45 cm seat height; starter provides chairs on both floors', () => {
  near(CHAIR_SIZE * METRES_PER_PIXEL, 0.5);
  near(CHAIR_SEAT_HEIGHT, 0.45);
  const map = courtyard();
  assert.deepEqual(map.chairs.map(chair => chair.floor), [0, 1]);
  const world = new World(map);
  assert.equal(world.nearbyChair().id, 'C1');
  assert.ok(world.setSitting(true));
});

for (const rotation of [0, 90, 180, 270]) {
  test(`chair at ${rotation}° supports front approach, sitting, safe exit and automatic standing`, () => {
    const map = room(), chair = testChair(rotation);
    addChair(map, chair);
    const world = new World(map), front = chairFront(chair);
    world.player = { ...front };
    assert.equal(world.nearbyChair().id, chair.id);

    assert.ok(world.setSitting(true));
    assert.deepEqual(world.player, { x: 16.5, y: 16.5 });
    assert.equal(world.canStand(world.player.x, world.player.y), false);
    assert.equal(world.sitting, true);
    world.advance(60);
    near(world.energy.byActivity.sitting.kcal, 70 / 60);
    near(world.distance, 0);

    assert.ok(world.setSitting(false));
    assert.deepEqual(world.player, front);
    assert.ok(world.canStand(world.player.x, world.player.y));

    // Moving away from the chair stands the explorer up first.
    assert.ok(world.setSitting(true));
    const direction = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[rotation];
    world.advance(0.5, ...direction);
    assert.equal(world.sitting, false);
    assert.ok(world.canStand(world.player.x, world.player.y));
    near(world.energy.byActivity.walk.seconds, 0.5);
    near(world.energy.byActivity.sitting.seconds, 60);
    assert.equal(world.floorIndex, 0);
  });
}

test('sitting is unavailable without a nearby chair or for a chair on another floor', () => {
  const map = room(), world = new World(map);
  assert.equal(world.setSitting(true), false);
  world.advance(1);
  assert.equal(world.energy.byActivity.sitting.seconds, 0);
  addChair(map, testChair(0, 1));
  world.player = chairFront(testChair());
  assert.equal(world.nearbyChair(), null);
  assert.equal(world.setSitting(true), false);
});

test('chair blocks walking but permits sight, without changing material or tile-value data', () => {
  const map = room(), materialsBefore = map.pixels.slice();
  addChair(map, testChair());
  const world = new World(map);
  world.player = { x: 10, y: 16.5 };
  assert.equal(world.canStand(16.5, 16.5), false);
  assert.equal(world.visibleTo(25, 16.5), true);
  world.advance(3, 1, 0);
  assert.ok(world.player.x <= 13.9 + 1e-8);
  assert.deepEqual(map.pixels, materialsBefore);
  assert.equal(valueAt(map, 16, 16), 1);
});

test('blocked chair front cannot be used through mass', () => {
  const map = room();
  addChair(map, testChair());
  paintGrid(map, 18, 15, 3, MATERIAL.OPAQUE);
  const world = new World(map);
  world.player = { x: 21.6, y: 19 };
  assert.ok(world.canStand(world.player.x, world.player.y));
  assert.equal(world.nearbyChair(), null);
  assert.equal(world.setSitting(true), false);
});

test('chairs reject overlap, off-grid positions, invalid direction, mass, stairs and canvas edges', () => {
  const map = room();
  addChair(map, testChair());
  for (const patch of [{ id: 'another' }, { x: 16 }, { rotation: 45 }, { floor: 9 }, { x: 42 }]) {
    assert.throws(() => addChair(map, { ...testChair(), ...patch }));
  }
  paintGrid(map, 6, 6, 3, MATERIAL.TRANSPARENT);
  assert.throws(() => addChair(map, { ...testChair(), id: 'glass', x: 6, y: 6 }));
  const starter = courtyard(), stair = starter.stairs[0];
  assert.throws(() => addChair(starter, { ...testChair(), x: stair.x, y: stair.y }));
});

test('stairs cannot overwrite existing chairs', () => {
  const map = room();
  addChair(map, testChair());
  assert.throws(() => addStair(map, { id: 'stair', type: 'straight', x: 6, y: 15, length: 24, width: 9, rotation: 0, lower: 0, upper: 1 }));
  assert.equal(map.chairs.length, 1);
});

test('eraser removes a whole chair only from its own floor; undo restores furniture and values', () => {
  const map = room();
  addChair(map, testChair());
  addChair(map, { ...testChair(0, 1), id: 'upper' });
  assignValue(map, { x: 15, y: 15, w: 3, h: 3, floor: 0 }, 5);
  const before = cloneMap(map);
  eraseAt(map, 16, 16, 3);
  assert.deepEqual(map.chairs.map(chair => chair.id), ['upper']);
  assert.equal(valueAt(map, 16, 16), 5);
  assert.equal(before.chairs.length, 2);
  assert.deepEqual(decodeMap(encodeMap(before)), before);
});

test('painting mass over furniture removes that chair; painting floor and editing values retain it', () => {
  const map = room();
  addChair(map, testChair());
  assignValue(map, { x: 15, y: 15, w: 3, h: 3, floor: 0 }, 3);
  paintGrid(map, 15, 15, 3, MATERIAL.FLOOR);
  pruneChairs(map);
  assert.equal(map.chairs.length, 1);
  paintGrid(map, 15, 15, 3, MATERIAL.OPAQUE);
  pruneChairs(map);
  assert.equal(map.chairs.length, 0);
  assert.equal(valueAt(map, 15, 15), 3);
});

test('chair JSON round-trips and snapshots do not alias; old files import with no chairs', () => {
  const map = room();
  addChair(map, testChair());
  const saved = encodeMap(map), restored = decodeMap(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored, map);
  restored.chairs[0].rotation = 90;
  assert.equal(map.chairs[0].rotation, 0);
  delete saved.chairs;
  assert.deepEqual(decodeMap(saved).chairs, []);
});

test('malformed chair lists and duplicate chair IDs are rejected', () => {
  const map = room();
  addChair(map, testChair());
  for (const chairs of [null, {}, [{ ...testChair(), rotation: 20 }], [testChair(), { ...testChair(), x: 21 }]]) {
    const saved = encodeMap(map);
    saved.chairs = chairs;
    assert.throws(() => decodeMap(saved));
  }
});

test('blocked exit keeps the person seated rather than putting them into a wall', () => {
  const map = room(), chair = testChair();
  addChair(map, chair);
  const world = new World(map);
  world.player = chairFront(chair);
  assert.ok(world.setSitting(true));
  fillRect(map.pixels, map.width, map.height, 18, 12, 6, 9, MATERIAL.OPAQUE);
  assert.equal(world.setSitting(false), false);
  world.advance(1, 1, 0);
  assert.equal(world.sitting, true);
  near(world.energy.byActivity.sitting.seconds, 1);
  near(world.energy.byActivity.walk.seconds, 0);
});
