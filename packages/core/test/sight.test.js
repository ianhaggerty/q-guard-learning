// The shared line-of-sight cache: it must agree with each explorer's own sight lines,
// share viewpoints between explorers, and never change a result when it evicts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MATERIAL, SightCache, World, fillRect, normalizeMap } from '../src/index.js';
import { courtyard } from './helpers.js';

/** A 40 × 26 room split by an opaque wall at x = 19 with an 8 px door at y = 9-16, plus a pillar. */
function doorRoom() {
  const width = 40, height = 26, pixels = new Uint8Array(width * height);
  fillRect(pixels, width, height, 19, 0, 2, height, MATERIAL.OPAQUE);
  fillRect(pixels, width, height, 19, 9, 2, 8, MATERIAL.DOOR);
  fillRect(pixels, width, height, 8, 4, 3, 3, MATERIAL.OPAQUE);
  return normalizeMap({ width, height, pixels, spawn: { x: 5, y: 13 }, name: 'Door room' });
}

function doorStates(explorer) {
  return explorer.doors.map(door => +door.open);
}

test('cached sight agrees with the explorer\'s own sight lines, doors open or closed', () => {
  const world = new World(doorRoom());
  const explorer = world.primary, cache = new SightCache(world.map);
  for (const position of [{ x: 5, y: 13 }, { x: 16.5, y: 12.5 }, { x: 30, y: 20 }]) {
    explorer.position = position;
    world.updateDoors();
    const entry = cache.entryFor(explorer, doorStates(explorer));
    for (let y = 0; y < world.map.height; y++) {
      for (let x = 0; x < world.map.width; x++) {
        assert.equal(cache.visible(entry, x + 0.5, y + 0.5), explorer.lineOfSight(x + 0.5, y + 0.5), `${JSON.stringify(position)} → ${x},${y}`);
      }
    }
  }
});

test('explorers at the same pixel and door states share one entry; other viewpoints get their own', () => {
  const world = new World(doorRoom());
  const [a, b] = [world.primary, world.addExplorer()];
  const cache = new SightCache(world.map);
  a.position = { x: 5.2, y: 13.7 };
  b.position = { x: 5.9, y: 13.1 };
  b.heading = 4;
  assert.equal(cache.entryFor(a, doorStates(a)), cache.entryFor(b, doorStates(b)));
  b.position = { x: 6.1, y: 13.1 };
  assert.notEqual(cache.entryFor(a, doorStates(a)), cache.entryFor(b, doorStates(b)));
  const open = doorStates(a).map(() => 1);
  assert.notEqual(cache.entryFor(a, doorStates(a)), cache.entryFor(a, open));
});

test('the least recently used viewpoint is evicted first', () => {
  const world = new World(doorRoom()), explorer = world.primary;
  const cache = new SightCache(world.map, 2 * world.map.width * world.map.height);
  const at = x => {
    explorer.position = { x, y: 20.5 };
    return cache.entryFor(explorer, doorStates(explorer));
  };
  const first = at(2.5), second = at(3.5);
  assert.equal(at(2.5), first); // now the most recent
  at(4.5); // evicts 3.5
  assert.equal(at(2.5), first);
  assert.notEqual(at(3.5), second);
});

test('a cache too small to keep anything still gives the same hazards and credit', () => {
  const run = sightCacheBytes => {
    const world = new World(courtyard(), { sightCacheBytes });
    const helper = world.addExplorer();
    world.primary.setMovement(1, 0);
    helper.setMovement(0, 1);
    for (let tick = 0; tick < 60; tick++) {
      if (tick === 30) helper.setLook('back');
      world.advanceAll(0.05);
    }
    return [Array.from(world.probabilities.hazards), world.explorers.map(explorer => explorer.credit)];
  };
  assert.deepEqual(run(0), run(undefined));
});
