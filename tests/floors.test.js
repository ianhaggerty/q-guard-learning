// Floors and stairs: independent floor pixels, crossing between floors, rails, legacy
// stair migration and erasing stairs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL, WALL_THICKNESS, World, addStair, cloneMap, decodeMap, encodeMap,
  eraseAt, fillRect, removeStair, stairFlightLength, stairSize, stairToWorld, traceLine, worldToStair,
} from '../packages/core/src/index.js';
import { blankBuilding, courtyard, pixelIndexAt, readFixture } from './helpers.js';

const ROTATIONS = [0, 90, 180, 270];

function twoFloors() {
  return blankBuilding({ width: 96, height: 96, name: 'Stair test', spawn: { x: 10, y: 30, floor: 0 } });
}

/** The pre-grid default stair shapes these tests were written for. */
function testStair(type = 'straight', rotation = 0) {
  return { id: 'test', type, x: 25, y: 25, length: 32, width: type === 'return' ? 22 : 10, rotation, lower: 0, upper: 1 };
}

/** Put the explorer at stair-local (u, v), which must be a spot where they fit. */
function placeExplorer(world, stair, u, v) {
  world.player = stairToWorld(stair, u, v);
  assert.equal(world.canStand(world.player.x, world.player.y), true);
}

/** Take `steps` short steps in the stair-local direction (du, dv). */
function walk(world, stair, du, dv, steps) {
  const origin = stairToWorld(stair, 0, 0), direction = stairToWorld(stair, du, dv);
  for (let n = 0; n < steps; n++) world.step(0.025, direction.x - origin.x, direction.y - origin.y);
}

test('new opening layout has two distinct pixel floors and both stair types', () => {
  const map = courtyard();
  assert.equal(map.floors.length, 2);
  assert.deepEqual(map.stairs.map(stair => stair.type), ['straight', 'return']);
  assert.notDeepEqual(map.floors[0].pixels, map.floors[1].pixels);
  // Painting the active (ground) floor leaves the upper floor alone.
  const i = 60 * map.width + 60, upperBefore = map.floors[1].pixels[i];
  map.pixels[i] = MATERIAL.TRANSPARENT;
  assert.equal(map.floors[1].pixels[i], upperBefore);
});

for (const rotation of ROTATIONS) {
  test(`straight stairs cross halfway in both directions at ${rotation} degrees`, () => {
    const map = twoFloors(), stair = testStair('straight', rotation);
    addStair(map, stair);
    const world = new World(map);
    placeExplorer(world, stair, 12, 5);
    walk(world, stair, 1, 0, 5);
    assert.equal(world.floorIndex, 0);
    walk(world, stair, 1, 0, 4);
    assert.equal(world.floorIndex, 1);
    assert.equal(world.floorChanges, 1);
    // Standing near the line does not bounce between floors.
    for (let n = 0; n < 15; n++) world.step(0.05, 0, 0);
    assert.equal(world.floorChanges, 1);
    walk(world, stair, -1, 0, 5);
    assert.equal(world.floorIndex, 0);
    assert.equal(world.floorChanges, 2);
  });

  test(`return stairs use plain landing and switch across its line at ${rotation} degrees`, () => {
    const map = twoFloors(), stair = testStair('return', rotation);
    addStair(map, stair);
    const world = new World(map);
    placeExplorer(world, stair, 27.5, 8);
    walk(world, stair, 0, 1, 3);
    assert.equal(world.floorIndex, 0);
    walk(world, stair, 0, 1, 4);
    assert.equal(world.floorIndex, 1);
    assert.equal(world.floorChanges, 1);
    walk(world, stair, 0, -1, 4);
    assert.equal(world.floorIndex, 0);
    assert.equal(world.floorChanges, 2);
    assert.equal(map.floors[0].pixels[pixelIndexAt(map, stairToWorld(stair, 28, 9))], MATERIAL.FLOOR);
    assert.equal(map.floors[1].pixels[pixelIndexAt(map, stairToWorld(stair, 28, 14))], MATERIAL.FLOOR);
  });
}

test('transparent return divider blocks sideways movement but allows sight', () => {
  const map = twoFloors(), stair = testStair('return');
  addStair(map, stair);
  const world = new World(map);
  placeExplorer(world, stair, 10, 7);
  walk(world, stair, 0, 1, 20);
  assert.equal(world.floorIndex, 0);
  assert.ok(worldToStair(stair, world.player.x, world.player.y).v < 9);
  const otherLane = stairToWorld(stair, 10, 16);
  world.orient(otherLane.x - world.player.x, otherLane.y - world.player.y);
  assert.equal(world.visibleTo(otherLane.x, otherLane.y), true);
});

test('stair placement prepares its own flight but preserves other materials outside it', () => {
  const map = twoFloors(), stair = testStair();
  const lowerHalf = pixelIndexAt(map, stairToWorld(stair, 5, 5)), upperHalf = pixelIndexAt(map, stairToWorld(stair, 26, 5));
  map.floors[0].pixels[upperHalf] = MATERIAL.TRANSPARENT;
  map.floors[1].pixels[lowerHalf] = MATERIAL.DOOR;
  addStair(map, stair);
  assert.equal(map.floors[0].pixels[lowerHalf], MATERIAL.FLOOR);
  assert.equal(map.floors[1].pixels[lowerHalf], MATERIAL.DOOR);
  assert.equal(map.floors[0].pixels[upperHalf], MATERIAL.TRANSPARENT);
  assert.equal(map.floors[1].pixels[upperHalf], MATERIAL.FLOOR);
});

test('floor and stair JSON round-trips losslessly; undo snapshots do not alias', () => {
  const map = courtyard();
  map.activeFloor = 1;
  assert.deepEqual(decodeMap(JSON.parse(JSON.stringify(encodeMap(map)))), map);
  const copy = cloneMap(map);
  copy.floors[0].pixels[0] = MATERIAL.TRANSPARENT;
  copy.stairs[0].x++;
  assert.notEqual(map.floors[0].pixels[0], MATERIAL.TRANSPARENT);
  assert.notEqual(copy.stairs[0].x, map.stairs[0].x);
});

test('legacy single-floor maps import on one floor', () => {
  const legacy = readFixture('legacy-courtyard.json');
  const map = decodeMap(legacy);
  assert.equal(map.floors.length, 1);
  assert.equal(map.spawn.floor, 0);
  assert.deepEqual(map.starts, [map.spawn]);
  assert.deepEqual(Array.from(map.pixels), legacy.pixels);
});

test('stairs reject overlaps, unknown floors, non-adjacent floors and canvas edges', () => {
  const map = twoFloors(), stair = testStair();
  addStair(map, stair);
  const patches = [{ x: 0 }, { upper: 2 }, { lower: 1, upper: 0 }, { rotation: 17 }, { type: 'spiral' }, { width: 5 }, {}];
  for (const patch of patches) assert.throws(() => addStair(map, { ...stair, id: 'x', ...patch }));
  const saved = encodeMap(map);
  saved.stairs[0].upper = 9;
  assert.throws(() => decodeMap(saved));
});

test('independent floor door states close when player changes floors', () => {
  const map = twoFloors();
  for (const floor of map.floors) fillRect(floor.pixels, map.width, map.height, 15, 20, 2, 8, MATERIAL.DOOR);
  const world = new World(map);
  world.player = { x: 12, y: 24 };
  world.updateDoors();
  assert.equal(world.floorDoors[0].doors[0].open, true);
  assert.equal(world.floorDoors[1].doors[0].open, false);
  world.activateFloor(1);
  world.player = { x: 40, y: 40 };
  world.updateDoors();
  assert.equal(world.floorDoors[0].doors[0].open, false);
});

test('opening layout is playable: straight flight connects, then return flight descends', () => {
  const map = courtyard(), world = new World(map);
  for (let n = 0; n < 45; n++) world.step(0.03, 1, 0);
  assert.equal(world.floorIndex, 1);
  const returnStair = map.stairs[1];
  placeExplorer(world, returnStair, stairFlightLength(returnStair) + 3.5, 16);
  walk(world, returnStair, 0, -1, 12);
  assert.equal(world.floorIndex, 0);
});

test('a complete 180-degree route climbs one flight, turns on the landing and exits the opposing flight', () => {
  const map = twoFloors(), stair = testStair('return');
  addStair(map, stair);
  const world = new World(map), u = () => worldToStair(stair, world.player.x, world.player.y).u;
  placeExplorer(world, stair, -4, 5);
  walk(world, stair, 1, 0, 54); // up the lower flight onto the landing
  assert.equal(world.floorIndex, 0);
  assert.ok(u() > 27);
  walk(world, stair, 0, 1, 20); // across the landing's centre line
  assert.equal(world.floorIndex, 1);
  walk(world, stair, -1, 0, 54); // out along the upper flight
  assert.ok(u() < 0);
  assert.equal(world.floorIndex, 1);
  walk(world, stair, 1, 0, 54); // and back down again
  walk(world, stair, 0, -1, 20);
  assert.equal(world.floorIndex, 0);
  walk(world, stair, -1, 0, 54);
  assert.ok(u() < 0);
  assert.equal(world.floorChanges, 2);
});

test('removing a stair clears its footprint and a snapshot restores prior materials', () => {
  const map = courtyard(), stair = map.stairs[0];
  const i = pixelIndexAt(map, stairToWorld(stair, 26, 5));
  map.floors[0].pixels[i] = MATERIAL.OPAQUE;
  const copy = cloneMap(map);
  removeStair(map, stair.id);
  assert.equal(map.stairs.length, 1);
  assert.equal(copy.stairs.length, 2);
  assert.equal(map.floors[0].pixels[i], MATERIAL.FLOOR);
  assert.equal(copy.floors[0].pixels[i], MATERIAL.OPAQUE);
});

for (const type of ['straight', 'return']) {
  for (const rotation of ROTATIONS) {
    test(`${type} stairs add transparent boundaries without opaque mass at ${rotation} degrees`, () => {
      const map = twoFloors(), stair = testStair(type, rotation);
      addStair(map, stair);
      for (const floor of map.floors) assert.ok(floor.pixels.every(m => m === MATERIAL.FLOOR || m === MATERIAL.TRANSPARENT));
      assert.ok(map.floors[0].pixels.includes(MATERIAL.TRANSPARENT));
      const world = new World(map);
      for (const floor of [0, 1]) {
        world.activateFloor(floor);
        const seam = type === 'return' ? stairToWorld(stair, 28, 11) : stairToWorld(stair, 16, 5);
        assert.equal(world.canStand(seam.x, seam.y), true);
      }
    });
  }
}

test('manual stair walls survive unrelated edits, JSON reload and collision checks at the seam', () => {
  const map = twoFloors(), stair = testStair();
  addStair(map, stair);
  const seam = stairToWorld(stair, 16, 5), i = pixelIndexAt(map, seam);
  map.floors[0].pixels[i] = MATERIAL.OPAQUE;
  const restored = decodeMap(encodeMap(map));
  assert.equal(restored.floors[0].pixels[i], MATERIAL.OPAQUE);
  assert.equal(restored.floors[0].pixels[0], MATERIAL.FLOOR);
  assert.equal(new World(restored).canStand(seam.x, seam.y), false);
});

test('old generated stair mass is migrated once while unrelated and nonopaque pixels survive', () => {
  const legacy = readFixture('legacy-stair-walls.json');
  const map = decodeMap(legacy);
  const inactiveHalf = 33 * 64 + 20, collar = 14 * 64 + 20;
  assert.equal(legacy.floors[0].pixels[inactiveHalf], MATERIAL.OPAQUE);
  assert.equal(map.floors[0].pixels[inactiveHalf], MATERIAL.FLOOR);
  assert.equal(map.floors[0].pixels[collar], MATERIAL.TRANSPARENT);
  assert.equal(map.floors[0].pixels[2 * 64 + 2], MATERIAL.OPAQUE);
  assert.equal(map.floors[0].pixels[17 * 64 + 17], MATERIAL.TRANSPARENT);
  assert.equal(map.floors[0].pixels[33 * 64 + 17], MATERIAL.TRANSPARENT);
  // A wall painted there afterwards is kept on reload.
  map.floors[0].pixels[inactiveHalf] = MATERIAL.OPAQUE;
  const saved = encodeMap(map);
  assert.equal(saved.stairStyle, 'transparent-3px');
  assert.equal(decodeMap(saved).floors[0].pixels[inactiveHalf], MATERIAL.OPAQUE);
});

for (const type of ['straight', 'return']) {
  for (const rotation of ROTATIONS) {
    test(`${type} rails are exactly three map pixels thick at ${rotation} degrees`, () => {
      const map = twoFloors(), stair = testStair(type, rotation);
      addStair(map, stair);
      const materialAt = (floor, u, v) => map.floors[floor].pixels[pixelIndexAt(map, stairToWorld(stair, u, v))];
      assert.equal(WALL_THICKNESS, 3);
      for (const floor of [0, 1]) {
        for (const v of [-0.5, -1.5, -2.5]) assert.equal(materialAt(floor, 10.5, v), MATERIAL.TRANSPARENT);
        assert.equal(materialAt(floor, 10.5, -3.5), MATERIAL.FLOOR);
        assert.equal(materialAt(floor, 10.5, 0.5), MATERIAL.FLOOR);
        for (const v of [stair.width + 0.5, stair.width + 1.5, stair.width + 2.5]) assert.equal(materialAt(floor, 10.5, v), MATERIAL.TRANSPARENT);
        assert.equal(materialAt(floor, 10.5, stair.width + 3.5), MATERIAL.FLOOR);
        if (type === 'return') {
          for (const v of [9.5, 10.5, 11.5]) assert.equal(materialAt(floor, 10.5, v), MATERIAL.TRANSPARENT);
          assert.equal(materialAt(floor, 10.5, 8.5), MATERIAL.FLOOR);
          assert.equal(materialAt(floor, 10.5, 12.5), MATERIAL.FLOOR);
        }
        // Each floor's entrance stays open.
        const entranceU = type === 'return' || floor === 0 ? -1 : 33;
        const entranceV = type === 'return' ? (floor === 0 ? 4 : 17) : 5;
        const entrance = stairToWorld(stair, entranceU, entranceV), world = new World(map);
        world.activateFloor(floor);
        assert.equal(world.canStand(entrance.x, entrance.y), true);
      }
    });
  }
}

test('open-stair saves receive transparent defaults once without replacing custom mass or doors', () => {
  const map = twoFloors(), stair = testStair();
  addStair(map, stair);
  const saved = encodeMap(map);
  saved.stairStyle = 'open';
  for (const floor of saved.floors) floor.pixels.fill(MATERIAL.FLOOR);
  const at = (u, v) => pixelIndexAt(map, stairToWorld(stair, u, v));
  const wall = at(10.5, -1.5), door = at(12.5, -1.5), rail = at(14.5, -1.5);
  saved.floors[0].pixels[wall] = MATERIAL.OPAQUE;
  saved.floors[0].pixels[door] = MATERIAL.DOOR;

  const migrated = decodeMap(saved);
  assert.equal(migrated.floors[0].pixels[wall], MATERIAL.OPAQUE);
  assert.equal(migrated.floors[0].pixels[door], MATERIAL.DOOR);
  assert.equal(migrated.floors[0].pixels[rail], MATERIAL.TRANSPARENT);
  // Once upgraded, a removed rail stays removed.
  migrated.floors[0].pixels[rail] = MATERIAL.FLOOR;
  assert.equal(decodeMap(encodeMap(migrated)).floors[0].pixels[rail], MATERIAL.FLOOR);
});

test('both opening stair types allocate exactly 18 pixels per half-floor rise', () => {
  const map = courtyard();
  const straight = map.stairs.find(stair => stair.type === 'straight'), turn = map.stairs.find(stair => stair.type === 'return');
  assert.equal(stairFlightLength(straight), 18);
  assert.equal(stairFlightLength(turn), 18);
  assert.equal(straight.length, 36);
  assert.equal(turn.length, 27);
  assert.equal(turn.length - stairFlightLength(turn), 9);
  assert.equal(encodeMap(map).stairGeometry, 'equal-half-flights-v1');
});

for (const rotation of ROTATIONS) {
  test(`new 16-pixel return flights climb and descend across the landing at ${rotation} degrees`, () => {
    const map = twoFloors(), stair = { ...testStair('return', rotation), length: 24 };
    addStair(map, stair);
    const world = new World(map), u = () => worldToStair(stair, world.player.x, world.player.y).u;
    placeExplorer(world, stair, -4, 5);
    walk(world, stair, 1, 0, 40);
    assert.equal(world.floorIndex, 0);
    assert.ok(Math.abs(u() - 20) < 0.1);
    walk(world, stair, 0, 1, 20);
    assert.equal(world.floorIndex, 1);
    walk(world, stair, -1, 0, 40);
    assert.ok(u() < 0);
    walk(world, stair, 1, 0, 40);
    walk(world, stair, 0, -1, 20);
    assert.equal(world.floorIndex, 0);
    walk(world, stair, -1, 0, 40);
    assert.ok(u() < 0);
    assert.equal(world.floorChanges, 2);
  });

  test(`old return stairs shrink, move the seam, and retain entrance positions at ${rotation} degrees`, () => {
    const map = twoFloors(), old = testStair('return', rotation);
    addStair(map, old);
    const entrance = stairToWorld(old, 0, 5), farCap = stairToWorld(old, 33.5, 17.5), divider = stairToWorld(old, 20.5, 10.5);
    const saved = encodeMap(map);
    delete saved.stairGeometry;
    const migrated = decodeMap(saved), stair = migrated.stairs[0];
    assert.equal(stair.length, 24);
    assert.deepEqual(stairToWorld(stair, 0, 5), entrance);
    assert.equal(map.floors[0].pixels[pixelIndexAt(map, farCap)], MATERIAL.TRANSPARENT);
    assert.equal(migrated.floors[0].pixels[pixelIndexAt(map, farCap)], MATERIAL.FLOOR);
    assert.equal(map.floors[0].pixels[pixelIndexAt(map, divider)], MATERIAL.TRANSPARENT);
    assert.equal(migrated.floors[0].pixels[pixelIndexAt(map, divider)], MATERIAL.FLOOR);

    const world = new World(migrated);
    placeExplorer(world, stair, 20, 8);
    walk(world, stair, 0, 1, 7);
    assert.equal(world.floorIndex, 1);
    assert.deepEqual(decodeMap(encodeMap(migrated)), migrated);
  });
}

test('resizing earlier return stairs preserves custom opaque mass and doors', () => {
  const map = twoFloors(), stair = testStair('return');
  addStair(map, stair);
  const wall = pixelIndexAt(map, stairToWorld(stair, 30.5, -1.5)), door = pixelIndexAt(map, stairToWorld(stair, 33.5, 8.5));
  map.floors[0].pixels[wall] = MATERIAL.OPAQUE;
  map.floors[0].pixels[door] = MATERIAL.DOOR;
  const saved = encodeMap(map);
  delete saved.stairGeometry;
  const restored = decodeMap(saved);
  assert.equal(restored.floors[0].pixels[wall], MATERIAL.OPAQUE);
  assert.equal(restored.floors[0].pixels[door], MATERIAL.DOOR);
});

for (const type of ['straight', 'return']) {
  for (const rotation of ROTATIONS) {
    for (const floor of [0, 1]) {
      test(`eraser removes a ${type} stair from both levels when used on floor ${floor} at ${rotation} degrees`, () => {
        const map = twoFloors(), stair = { ...testStair(type, rotation), length: type === 'return' ? 24 : 32 };
        addStair(map, stair);
        map.activeFloor = floor;
        const before = cloneMap(map), point = stairToWorld(stair, 5.5, 4.5);
        assert.deepEqual(eraseAt(map, Math.floor(point.x), Math.floor(point.y), 1), ['test']);
        assert.equal(map.stairs.length, 0);
        const { w, h } = stairSize(stair);
        for (const level of map.floors) {
          for (let y = stair.y - 3; y < stair.y + h + 3; y++) {
            for (let x = stair.x - 3; x < stair.x + w + 3; x++) assert.equal(level.pixels[y * map.width + x], MATERIAL.FLOOR);
          }
        }
        assert.equal(decodeMap(encodeMap(map)).stairs.length, 0);
        const restored = cloneMap(before);
        assert.equal(restored.stairs.length, 1);
        assert.deepEqual(restored, before);
      });
    }
  }
}

test('eraser brush overlap with a transparent rail deletes the stair even when brush center is outside it', () => {
  const map = twoFloors(), stair = testStair();
  addStair(map, stair);
  assert.deepEqual(eraseAt(map, stair.x + 5, stair.y - 4, 3), ['test']);
  assert.equal(map.stairs.length, 0);
});

test('eraser outside a stair only clears ordinary materials on the active floor', () => {
  const map = twoFloors();
  addStair(map, testStair());
  const i = 10 * map.width + 10;
  map.floors[0].pixels[i] = MATERIAL.OPAQUE;
  map.floors[1].pixels[i] = MATERIAL.TRANSPARENT;
  assert.deepEqual(eraseAt(map, 10, 10, 1), []);
  assert.equal(map.stairs.length, 1);
  assert.equal(map.floors[0].pixels[i], MATERIAL.FLOOR);
  assert.equal(map.floors[1].pixels[i], MATERIAL.TRANSPARENT);
});

test('erasing an unrelated floor does not delete a stair on other levels', () => {
  const map = twoFloors(), stair = testStair();
  addStair(map, stair);
  map.floors.push({ name: 'Third', pixels: new Uint8Array(map.width * map.height) });
  map.activeFloor = 2;
  assert.deepEqual(eraseAt(map, stair.x + 5, stair.y + 5, 3), []);
  assert.equal(map.stairs.length, 1);
});

test('drag erasing can remove multiple stair pairs and one building snapshot restores them all', () => {
  const map = courtyard(), before = cloneMap(map);
  traceLine({ x: 60, y: 57 }, { x: 170, y: 100 }, (x, y) => eraseAt(map, x, y, 3));
  assert.equal(map.stairs.length, 0);
  assert.equal(before.stairs.length, 2);
  assert.deepEqual(decodeMap(encodeMap(before)), before);
});
