// Events on opaque pixels are seen through the wall's surface: they take the best
// detection chance of a visible, edge-adjacent see-through neighbour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MATERIAL, World, fillRect, updateUnresolvedMean } from '../dist/js/core/index.js';
import { weightedMap, within } from './helpers.js';

const near = within(1e-9);
const SIZE = 24;

/** A 3 × 3 opaque block at (12, 12) on the ground floor; only pixel (x, y) has value 1. */
function wallMap(x = 12, y = 13) {
  const map = weightedMap([], { size: SIZE, name: 'Wall events', spawn: { x: 6.5, y: 13.5, floor: 0 } });
  fillRect(map.floors[0].pixels, SIZE, SIZE, 12, 12, 3, 3, MATERIAL.OPAQUE);
  map.floors[0].valueOverrides[y * SIZE + x] = 1;
  return map;
}

// [face, explorer x/y, wall pixel x/y, facing dx/dy, see-through neighbour centre x/y]
const FACES = [
  ['west', 6.5, 13.5, 12, 13, 1, 0, 11.5, 13.5],
  ['east', 20.5, 13.5, 14, 13, -1, 0, 15.5, 13.5],
  ['north', 13.5, 6.5, 13, 12, 0, 1, 13.5, 11.5],
  ['south', 13.5, 20.5, 13, 14, 0, -1, 13.5, 15.5],
];

for (const [face, px, py, wallX, wallY, dx, dy, nx, ny] of FACES) {
  test(`${face} opaque face copies its visible neighbour probability and resolves`, () => {
    const world = new World(wallMap(wallX, wallY), { random: () => 0.5 });
    world.player = { x: px, y: py };
    world.orient(dx, dy);
    const neighbour = world.detectionAt(nx, ny);
    assert.ok(neighbour > 0);
    near(world.detectionAt(wallX + 0.5, wallY + 0.5), neighbour);
    near(world.detectionAt(wallX + 0.5, wallY + 0.5, 2), 1 - (1 - neighbour) ** 2);

    world.events.setRate(0);
    world.events.spawn().detectionBudget = -Math.log1p(-neighbour) * 0.2;
    world.advance(0.3);
    assert.equal(world.events.resolved, 1);
    assert.equal(world.events.active.length, 0);
  });
}

test('transparent mass is an eligible neighbour with exactly the same chance as clear floor', () => {
  const map = wallMap();
  map.floors[0].pixels[13 * SIZE + 11] = MATERIAL.TRANSPARENT;
  const world = new World(map);
  near(world.detectionAt(12.5, 13.5), world.detectionAt(11.5, 13.5));
  assert.ok(world.detectionAt(12.5, 13.5) > 0);
  assert.equal(world.canStand(11.5, 13.5), false);
});

test('closed doors do not relay visibility; opening a neighbouring door enables it', () => {
  const map = wallMap();
  map.floors[0].pixels[13 * SIZE + 11] = MATERIAL.DOOR;
  const world = new World(map);
  near(world.detectionAt(12.5, 13.5), 0);
  world.updateDoors();
  assert.ok(world.doors[0].open);
  near(world.detectionAt(12.5, 13.5), world.detectionAt(11.5, 13.5));
  assert.ok(world.detectionAt(12.5, 13.5) > 0);
});

test('no relay through opaque neighbours or walls, and looking away prevents detection', () => {
  const world = new World(wallMap(13, 13));
  near(world.detectionAt(13.5, 13.5), 0); // the block's centre has no see-through neighbour
  assert.equal(world.visibleTo(18.5, 13.5), false);
  near(world.detectionAt(18.5, 13.5), 0);
  world.setLook('back');
  near(world.detectionAt(12.5, 13.5), 0);

  const map = wallMap();
  fillRect(map.floors[0].pixels, SIZE, SIZE, 6, 0, 3, SIZE, MATERIAL.OPAQUE);
  map.spawn.x = 4.5;
  near(new World(map).detectionAt(12.5, 13.5), 0);
});

test('multiple visible neighbours use maximum probability, never sum independent chances', () => {
  const world = new World(wallMap(12, 12));
  world.player = { x: 8.5, y: 8.5 };
  world.orient(1, 1);
  const below = world.detectionAt(11.5, 12.5), right = world.detectionAt(12.5, 11.5);
  assert.ok(below > 0 && right > 0);
  near(world.detectionAt(12.5, 12.5), Math.max(below, right));
});

test('probability field uses the same surface hazard as sampled-event resolution', () => {
  const world = new World(wallMap(), { random: () => 0.5 });
  const mu = -Math.log1p(-world.detectionAt(12.5, 13.5));
  world.events.setRate(0.1);
  world.advance(0.3);
  near(world.probabilities.hazards[0], mu);
  const expected = -Math.expm1(-updateUnresolvedMean(0, 0.1, mu, 0.3));
  near(world.probabilities.probabilityAt(12, 13, 0), expected);
  near(world.probabilities.sum, expected);
  world.setLook('back');
  world.advance(0.1);
  near(world.probabilities.hazards[0], 0);
  assert.ok(world.probabilities.sum > expected);
});

test('same-floor requirement still applies to opaque surface events', () => {
  const map = wallMap();
  map.floors[1].pixels.set(map.floors[0].pixels);
  map.floors[0].valueOverrides[13 * SIZE + 12] = 0;
  map.floors[1].valueOverrides[13 * SIZE + 12] = 1;
  const world = new World(map, { random: () => 0.5 });
  world.events.setRate(0);
  world.events.spawn().detectionBudget = 0.01;
  world.advance(1);
  assert.equal(world.events.resolved, 0);
  world.activateFloor(1);
  world.advance(1);
  assert.equal(world.events.resolved, 1);
});
