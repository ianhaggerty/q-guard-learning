// Materials, doors, collision, sight and the basic raster tools.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL, RGB, World, decodeMap, encodeMap, fillRect, floodFill, groupDoors, toRGBA, traceLine,
} from '../dist/js/core/index.js';
import { courtyard } from './helpers.js';

/** A 40 × 26 single-floor room split by a 2 px opaque wall at x = 19, with an 8 px gap of `gapMaterial`. */
function splitRoom(gapMaterial = MATERIAL.DOOR) {
  const width = 40, height = 26, pixels = new Uint8Array(width * height);
  fillRect(pixels, width, height, 19, 0, 2, height, MATERIAL.OPAQUE);
  fillRect(pixels, width, height, 19, 9, 2, 8, gapMaterial);
  return { width, height, pixels, spawn: { x: 8, y: 13 }, name: 'Test room' };
}

test('lossless per-pixel JSON round trip, including doors and spawn', () => {
  const map = courtyard();
  const restored = decodeMap(JSON.parse(JSON.stringify(encodeMap(map))));
  assert.deepEqual(restored, map);
  assert.deepEqual(encodeMap(map).materials, ['floor', 'opaque', 'transparent', 'opaque-door']);
});

test('reject malformed or oversized imports and unknown pixel types', () => {
  const saved = encodeMap(courtyard());
  const unknownMaterial = saved.floors[0].pixels.map((material, i) => (i ? material : 4));
  const changes = [
    { version: 3 },
    { width: 513 },
    { floors: [{ name: 'Bad', pixels: [0, 1] }] },
    { spawn: { x: -1, y: 2, floor: 0 } },
    { floors: [{ name: 'Bad', pixels: unknownMaterial }] },
  ];
  for (const change of changes) assert.throws(() => decodeMap({ ...saved, ...change }));
});

test('opaque and transparent masses both collide; only opaque blocks vision', () => {
  for (const material of [MATERIAL.OPAQUE, MATERIAL.TRANSPARENT]) {
    const world = new World(splitRoom(material));
    assert.equal(world.canStand(20, 13), false);
    assert.equal(world.visibleTo(30, 13), material === MATERIAL.TRANSPARENT);
    for (let n = 0; n < 100; n++) world.step(0.05, 1, 0);
    assert.ok(world.player.x < 19);
  }
});

test('door pixels group by 4-neighbor connectivity, not diagonals', () => {
  const map = splitRoom();
  map.pixels[2 * map.width + 2] = MATERIAL.DOOR;
  map.pixels[3 * map.width + 3] = MATERIAL.DOOR;
  const { doors } = groupDoors(map);
  assert.equal(doors.length, 3);
  assert.equal(doors[2].cells.length, 16);
});

test('approach opens the whole doorway, allows passage, then automatically closes', () => {
  const map = splitRoom(), original = map.pixels.slice(), world = new World(map);
  assert.equal(world.doors[0].open, false);
  assert.equal(world.visibleTo(30, 13), false);
  for (let n = 0; n < 14; n++) world.step(0.05, 1, 0);
  assert.ok(world.player.x > 21);
  assert.equal(world.doors[0].open, true);
  assert.equal(world.effectiveMaterial(19, 10), MATERIAL.FLOOR);
  assert.equal(world.effectiveMaterial(20, 16), MATERIAL.FLOOR);
  assert.equal(world.visibleTo(8, 13), false);
  world.setLook('back');
  assert.equal(world.visibleTo(8, 13), true);
  for (let n = 0; n < 3; n++) world.step(0.05, 1, 0);
  assert.equal(world.doors[0].open, false);
  assert.equal(world.effectiveMaterial(19, 10), MATERIAL.DOOR);
  assert.deepEqual(map.pixels, original);
});

test('a nearby person holds the door open and leaves its saved encoding intact', () => {
  const map = splitRoom(), world = new World(map);
  world.player = { x: 19.5, y: 13 };
  for (let n = 0; n < 150; n++) world.step(0.05, 0, 0);
  assert.equal(world.doors[0].open, true);
  assert.equal(encodeMap(map).floors[0].pixels[13 * map.width + 19], MATERIAL.DOOR);
});

test('movement substeps prevent tunneling through one-pixel barriers', () => {
  const world = new World(splitRoom(MATERIAL.OPAQUE));
  world.player = { x: 17, y: 13 };
  world.step(50, 1, 0);
  assert.ok(world.player.x <= 17.9);
});

test('fill preserves disconnected regions and line drawing includes both endpoints', () => {
  const map = splitRoom(MATERIAL.OPAQUE);
  floodFill(map.pixels, map.width, map.height, 1, 1, MATERIAL.TRANSPARENT);
  assert.equal(map.pixels[1], MATERIAL.TRANSPARENT);
  assert.equal(map.pixels[30], MATERIAL.FLOOR);
  const points = [];
  traceLine({ x: 1, y: 1 }, { x: 4, y: 4 }, (x, y) => points.push([x, y]));
  assert.deepEqual(points, [[1, 1], [2, 2], [3, 3], [4, 4]]);
});

test('spawn relocates to nearby usable floor; fully blocked maps cannot be explored', () => {
  const map = splitRoom();
  const world = new World({ ...map, spawn: { x: 19, y: 2 } });
  assert.ok(world.canStand(world.player.x, world.player.y));

  const solid = new Uint8Array(map.width * map.height).fill(MATERIAL.OPAQUE);
  const blocked = new World({ width: map.width, height: map.height, name: 'Blocked', spawn: { x: 8, y: 13 }, pixels: solid });
  assert.equal(blocked.canStand(blocked.player.x, blocked.player.y), false);
});

test('PNG pixel buffer uses four exact colors and retains closed door material during play', () => {
  const map = splitRoom(), world = new World(map);
  world.player = { x: 18, y: 13 };
  world.updateDoors();
  assert.equal(world.doors[0].open, true);

  const rgba = toRGBA(map);
  assert.equal(rgba.length, map.width * map.height * 4);
  const door = (13 * map.width + 19) * 4;
  assert.deepEqual(Array.from(rgba.slice(door, door + 4)), [...RGB[MATERIAL.DOOR], 255]);

  const colors = new Set();
  for (let i = 0; i < map.pixels.length; i++) colors.add(Array.from(rgba.slice(i * 4, i * 4 + 3)).join(','));
  assert.ok(colors.size <= 4);
  assert.ok([...colors].every(color => RGB.some(rgb => rgb.join(',') === color)));
});

test('one exact proximity boundary opens and closes doors symmetrically on either side', () => {
  const world = new World(splitRoom()), door = world.doors[0];
  for (const x of [14, 26]) {
    world.player = { x, y: 13 };
    assert.equal(world.doorDistance(door, x, 13), 5);
    world.updateDoors();
    assert.equal(door.open, true);

    world.player.x = x === 14 ? 13.9999 : 26.0001;
    world.updateDoors();
    assert.equal(door.open, false);
    assert.equal(world.effectiveMaterial(19, 13), MATERIAL.DOOR);

    world.player.x = x;
    world.updateDoors();
    assert.equal(door.open, true);
    assert.equal(world.effectiveMaterial(19, 13), MATERIAL.FLOOR);
  }
});

test('stationary nearby players keep doors open, and leaving closes without advancing time', () => {
  const world = new World(splitRoom());
  world.player = { x: 15, y: 13 };
  world.updateDoors();
  assert.equal(world.doors[0].open, true);
  world.time += 1000;
  assert.equal(world.updateDoors(), false);
  assert.equal(world.doors[0].open, true);

  const time = world.time;
  world.player = { x: 13, y: 13 };
  assert.equal(world.updateDoors(), true);
  assert.equal(world.doors[0].open, false);
  assert.equal(world.time, time);
});
