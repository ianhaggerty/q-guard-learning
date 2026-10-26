// The 3 × 3 editing grid: grid-aligned drawing and migration of older maps.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL, WALL_THICKNESS, World, addStair, alignGrid, brushBounds, decodeMap, encodeMap, eraseAt,
  floodFill, gridLine, gridRect, isGridAligned, normalizeMap, paintGrid, stairFlightLength, stairToWorld, validateStair,
} from '../src/index.js';
import { courtyard } from './helpers.js';

/** A blank grid-aligned single-floor map (built from the legacy single-floor shape). */
function blankAligned(width = 60, height = 60) {
  return alignGrid(normalizeMap({ width, height, pixels: new Uint8Array(width * height), spawn: { x: 10, y: 10 }, name: 'Grid' }));
}

/** blankAligned(96, 96) with a second floor. */
function twoFloorAligned() {
  const map = blankAligned(96, 96);
  map.floors.push({ name: 'Upper', pixels: new Uint8Array(96 * 96) });
  return map;
}

test('starter uses complete 3 × 3 material cells on both floors, including stairs', () => {
  const map = courtyard();
  assert.ok(isGridAligned(map));
  assert.equal(map.height, 129);
  for (const stair of map.stairs) for (const key of ['x', 'y', 'length', 'width']) assert.equal(stair[key] % 3, 0);
  assert.deepEqual(map.stairs.map(stairFlightLength), [18, 18]);
});

for (const material of [0, 1, 2, 3]) {
  for (const size of [1, 3, 4, 6, 9, 24]) {
    test(`brush ${size} with material ${material} draws only complete cells at edges and between grid lines`, () => {
      const map = blankAligned();
      map.pixels.fill(MATERIAL.TRANSPARENT);
      for (const [x, y] of [[0, 0], [59, 59], [17, 22], [33, 32]]) paintGrid(map, x, y, size, material);
      assert.ok(isGridAligned(map));
    });
  }
}

test('diagonal line and tiny filled / outlined rectangles cannot produce partial cells', () => {
  const map = blankAligned();
  gridLine({ x: 1, y: 2 }, { x: 44, y: 38 }, (x, y) => paintGrid(map, x, y, 3, MATERIAL.OPAQUE));
  assert.ok(isGridAligned(map));
  for (const filled of [true, false]) {
    gridRect(map, { x: 11, y: 14 }, { x: 11, y: 14 }, 3, MATERIAL.DOOR, filled);
    assert.equal(map.pixels[12 * map.width + 9], MATERIAL.DOOR);
    assert.ok(isGridAligned(map));
    gridRect(map, { x: 47, y: 50 }, { x: 7, y: 8 }, 6, MATERIAL.TRANSPARENT, filled);
    assert.ok(isGridAligned(map));
  }
});

test('fill changes full cells and leaves adjacent material cells intact', () => {
  const map = blankAligned();
  gridRect(map, { x: 6, y: 6 }, { x: 36, y: 36 }, 3, MATERIAL.OPAQUE);
  floodFill(map.pixels, map.width, map.height, 12, 12, MATERIAL.DOOR);
  assert.ok(isGridAligned(map));
  assert.equal(map.pixels[12 * map.width + 12], MATERIAL.DOOR);
  assert.equal(map.pixels[0], MATERIAL.FLOOR);
});

test('legacy maps and imported images pad and quantize; migration is idempotent and export round trips', () => {
  const map = blankAligned(61, 62);
  assert.equal(map.width, 63);
  assert.equal(map.height, 63);
  delete map.gridSize;
  // Five opaque pixels in the first cell outvote four floor pixels.
  for (const i of [0, 1, 2, 63, 64]) map.pixels[i] = MATERIAL.OPAQUE;
  alignGrid(map);
  assert.equal(map.pixels[0], MATERIAL.OPAQUE);
  assert.ok(isGridAligned(map));

  const saved = encodeMap(map);
  alignGrid(map);
  assert.deepEqual(encodeMap(map), saved);
  assert.deepEqual(encodeMap(alignGrid(decodeMap(saved))), saved);
});

for (const rotation of [0, 90, 180, 270]) {
  for (const type of ['straight', 'return']) {
    test(`legacy ${type} stairs migrate with aligned rails and work in both directions at ${rotation}°`, () => {
      const map = normalizeMap({
        width: 96, height: 96, name: 'Old', spawn: { x: 5, y: 5, floor: 0 },
        floors: [{ pixels: new Uint8Array(96 * 96) }, { pixels: new Uint8Array(96 * 96) }], stairs: [],
      });
      const straight = type === 'straight';
      addStair(map, { id: 's', type, rotation, x: 25, y: 25, width: straight ? 10 : 22, length: straight ? 32 : 24, lower: 0, upper: 1 });
      alignGrid(map);
      assert.ok(isGridAligned(map));

      // Points one pixel either side of the floor-change line.
      const stair = map.stairs[0], world = new World(map);
      const before = straight ? stairToWorld(stair, stair.length / 2 - 1, 6) : stairToWorld(stair, stairFlightLength(stair) + 4.5, stair.width / 2 - 1);
      const after = straight ? stairToWorld(stair, stair.length / 2 + 1, 6) : stairToWorld(stair, stairFlightLength(stair) + 4.5, stair.width / 2 + 1);
      world.player = { ...before };
      assert.ok(world.tryMove(after.x, after.y));
      assert.equal(world.floorIndex, 1);
      assert.ok(world.tryMove(before.x, before.y));
      assert.equal(world.floorIndex, 0);

      const brush = brushBounds(stair.x + 2, stair.y + 2, 3);
      eraseAt(map, brush.x + 1, brush.y + 1, brush.size);
      assert.equal(map.stairs.length, 0);
      assert.ok(isGridAligned(map));
    });
  }
}

test('grid markers cannot bypass normalization of partial material cells', () => {
  const map = blankAligned();
  map.pixels[0] = MATERIAL.OPAQUE;
  assert.equal(isGridAligned(map), false);
  alignGrid(map);
  assert.ok(isGridAligned(map));
});

test('new stairs reject unaligned dimensions and origins', () => {
  const map = courtyard();
  for (const patch of [{ x: 79 }, { width: 10 }, { length: 33 }]) {
    assert.throws(() => validateStair(map, { ...map.stairs[0], ...patch }, []));
  }
});

test('opening return flights match the straight flight width and preserve the 18 px half-floor run', () => {
  const map = courtyard(), [straight, turn] = map.stairs;
  assert.equal(straight.width, 9);
  assert.equal(turn.width, 2 * straight.width + WALL_THICKNESS);
  assert.equal(turn.length, 27);
  assert.equal((turn.width - WALL_THICKNESS) / 2, 9);
  assert.equal(stairFlightLength(turn), stairFlightLength(straight));
  assert.ok(isGridAligned(map));
});

for (const rotation of [0, 90, 180, 270]) {
  test(`saved 27 px return stairs shrink once with a 3 px divider and 9 px lanes at ${rotation}°`, () => {
    const map = twoFloorAligned();
    addStair(map, { id: 'return', type: 'return', x: 30, y: 30, length: 27, width: 27, landingDepth: 9, rotation, lower: 0, upper: 1 });
    paintGrid(map, 3, 3, 3, MATERIAL.DOOR);
    alignGrid(map);

    const turn = map.stairs[0];
    assert.equal(turn.width, 21);
    assert.ok(isGridAligned(map));
    assert.equal(map.pixels[3 * 96 + 3], MATERIAL.DOOR);
    const materialAt = (u, v) => {
      const point = stairToWorld(turn, u, v);
      return map.pixels[Math.floor(point.y) * 96 + Math.floor(point.x)];
    };
    for (const v of [0.5, 8.5, 12.5, 20.5]) assert.equal(materialAt(6.5, v), MATERIAL.FLOOR);
    for (const v of [9.5, 10.5, 11.5]) assert.equal(materialAt(6.5, v), MATERIAL.TRANSPARENT);

    const saved = encodeMap(map);
    alignGrid(map);
    assert.deepEqual(encodeMap(map), saved);
    assert.deepEqual(encodeMap(alignGrid(decodeMap(saved))), saved);

    const world = new World(map);
    world.player = stairToWorld(turn, 22.5, 9);
    let target = stairToWorld(turn, 22.5, 12);
    assert.ok(world.tryMove(target.x, target.y));
    assert.equal(world.floorIndex, 1);
    target = stairToWorld(turn, 22.5, 9);
    assert.ok(world.tryMove(target.x, target.y));
    assert.equal(world.floorIndex, 0);
  });
}

for (const rotation of [0, 90, 180, 270]) {
  test(`saved straight stairs shrink from four blocks to three at ${rotation}°`, () => {
    const map = twoFloorAligned();
    addStair(map, { id: 'straight', type: 'straight', x: 30, y: 30, length: 36, width: 12, rotation, lower: 0, upper: 1 });
    const migrated = alignGrid(decodeMap(encodeMap(map))), stair = migrated.stairs[0];
    assert.equal(stair.width, 9);
    assert.equal(stair.width / 3, 3);
    assert.ok(isGridAligned(migrated));

    const world = new World(migrated);
    world.player = stairToWorld(stair, 17, 4.5);
    let target = stairToWorld(stair, 19, 4.5);
    assert.ok(world.tryMove(target.x, target.y));
    assert.equal(world.floorIndex, 1);
    target = stairToWorld(stair, 17, 4.5);
    assert.ok(world.tryMove(target.x, target.y));
    assert.equal(world.floorIndex, 0);
    assert.deepEqual(encodeMap(alignGrid(migrated)), encodeMap(migrated));
  });
}
