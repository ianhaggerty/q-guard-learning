// Numbered explore starts.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL, World, addChair, assignValue, cloneMap, decodeMap, encodeMap, fillRect, paintGrid, removeStart,
  selectionRect, setStart,
} from '../src/index.js';
import { blankBuilding } from './helpers.js';

function room() {
  return blankBuilding({ width: 36, height: 24, name: 'Starts', spawn: { x: 4.5, y: 4.5, floor: 0 } });
}

test('legacy start migrates to Start 1 and primary coordinates remain compatible', () => {
  const map = room();
  assert.deepEqual(map.starts, [map.spawn]);
  assert.equal(map.starts[0], map.spawn);
  map.spawn.x = 5.5;
  assert.equal(map.starts[0].x, 5.5);
  const saved = encodeMap(map);
  delete saved.starts;
  const restored = decodeMap(saved);
  assert.deepEqual(restored.starts, [restored.spawn]);
});

test('numbered starts append, move and remove in order across floors', () => {
  const map = room();
  setStart(map, 1, { x: 10.5, y: 10.5, floor: 0 });
  setStart(map, 2, { x: 16.5, y: 10.5, floor: 1 });
  setStart(map, 1, { x: 13.5, y: 10.5, floor: 0 });
  assert.equal(map.starts.length, 3);
  assert.equal(map.starts[1].x, 13.5);
  removeStart(map, 0);
  assert.deepEqual(map.spawn, { x: 13.5, y: 10.5, floor: 0 });
  assert.equal(map.starts[0], map.spawn);
  assert.equal(map.starts[1].floor, 1);
  removeStart(map, 1);
  assert.throws(() => removeStart(map, 0));
});

test('JSON and undo snapshots preserve all numbered starts independently', () => {
  const map = room();
  setStart(map, 1, { x: 10.5, y: 10.5, floor: 1 });
  const saved = encodeMap(map), restored = decodeMap(JSON.parse(JSON.stringify(saved))), snapshot = cloneMap(map);
  assert.deepEqual(restored, map);
  setStart(map, 1, { x: 16.5, y: 10.5, floor: 1 });
  assert.equal(snapshot.starts[1].x, 10.5);
  assert.deepEqual(encodeMap(restored), saved);
});

test('explorer can start at each numbered position without changing the primary start', () => {
  const map = room();
  setStart(map, 1, { x: 16.5, y: 10.5, floor: 1 });
  const world = new World(map, { startIndex: 1, random: () => 0.5 });
  assert.deepEqual(world.player, { x: 16.5, y: 10.5 });
  assert.equal(world.floorIndex, 1);
  assert.equal(world.startIndex, 1);
  assert.deepEqual(map.spawn, { x: 4.5, y: 4.5, floor: 0 });
  assert.throws(() => new World(map, { startIndex: 2 }));
  assert.throws(() => new World(map, { startIndex: -1 }));
});

test('blocked selected start relocates near its own location on its own floor', () => {
  const map = room();
  setStart(map, 1, { x: 28.5, y: 16.5, floor: 1 });
  fillRect(map.floors[1].pixels, 36, 24, 27, 15, 3, 3, MATERIAL.OPAQUE);
  const world = new World(map, { startIndex: 1 });
  assert.equal(world.floorIndex, 1);
  assert.ok(world.canStand(world.player.x, world.player.y));
  assert.ok(world.player.x > 20);
  assert.equal(map.starts[1].x, 28.5);
});

test('starts require clear floor, body clearance and separation from starts and chairs', () => {
  const map = room();
  const invalid = [{ x: 0.5, y: 4.5, floor: 0 }, { x: 4.5, y: 4.5, floor: 0 }, { x: 6, y: 4.5, floor: 0 }, { x: 4.5, y: 4.5, floor: 2 }];
  for (const start of invalid) assert.throws(() => setStart(map, 1, start));
  for (const material of [MATERIAL.OPAQUE, MATERIAL.TRANSPARENT, MATERIAL.DOOR]) {
    paintGrid(map, 9, 9, 3, material);
    assert.throws(() => setStart(map, 1, { x: 10.5, y: 10.5, floor: 0 }));
  }
  paintGrid(map, 9, 9, 3, MATERIAL.FLOOR);
  addChair(map, { id: 'c', x: 9, y: 9, floor: 0, rotation: 0 });
  assert.throws(() => setStart(map, 1, { x: 10.5, y: 10.5, floor: 0 }));
  setStart(map, 1, { x: 4.5, y: 4.5, floor: 1 });
  assert.equal(map.starts.length, 2);
});

test('malformed start imports reject empty, duplicate, mismatched and out-of-bounds positions', () => {
  const saved = encodeMap(room()), first = saved.spawn;
  const malformed = [
    [], null, {}, [{ x: 5.5, y: 4.5, floor: 0 }], [first, { ...first }], [first, { x: 36, y: 5, floor: 0 }],
    [first, { x: 10, y: 10, floor: 2 }], [first, { x: NaN, y: 10, floor: 0 }], Array(129).fill(first),
  ];
  for (const starts of malformed) assert.throws(() => decodeMap({ ...saved, starts }));
});

test('moving and removing starts leaves materials, values and other architectural objects unchanged', () => {
  const map = room(), saved = encodeMap(map);
  assignValue(map, selectionRect(map, { x: 9, y: 9 }, { x: 11, y: 11 }), 7);
  const values = { ...map.floors[0].valueOverrides };
  setStart(map, 1, { x: 16.5, y: 16.5, floor: 0 });
  removeStart(map, 0);
  assert.deepEqual(Array.from(map.floors[0].pixels), saved.floors[0].pixels);
  assert.deepEqual(map.floors[0].valueOverrides, values);
  assert.deepEqual(map.stairs, []);
});
