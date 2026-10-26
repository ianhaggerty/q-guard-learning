// Several explorers in one world: shared doors, chairs and probability field, additive
// detection, hazard-proportional credit, independent floors and deterministic stepping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MATERIAL, World, addChair, alignGrid, chairFront, fillRect, normalizeMap } from '../src/index.js';
import { blankBuilding, courtyard, seededRandom, weightedMap, within } from './helpers.js';

const near = within(1e-9);

/** A 40 × 26 room split by an opaque wall at x = 19 with an 8 px door at y = 9-16. */
function doorRoom() {
  const width = 40, height = 26, pixels = new Uint8Array(width * height);
  fillRect(pixels, width, height, 19, 0, 2, height, MATERIAL.OPAQUE);
  fillRect(pixels, width, height, 19, 9, 2, 8, MATERIAL.DOOR);
  return normalizeMap({ width, height, pixels, spawn: { x: 8, y: 13 }, name: 'Door room' });
}

/** Explorers placed at the given poses, standing still; returns them in order. */
function place(world, poses) {
  return poses.map(({ x, y, floor = 0, heading = 0 }, k) => {
    const explorer = world.explorers[k] || world.addExplorer();
    explorer.activateFloor(floor);
    explorer.position = { x, y };
    explorer.heading = heading;
    explorer.setLook('forward');
    return explorer;
  });
}

test('an empty world has no explorers, yet events arrive and the field grows unobserved', () => {
  const world = new World(weightedMap([[0, 12, 9, 1]]), { empty: true, random: seededRandom() });
  assert.equal(world.explorers.length, 0);
  assert.equal(world.primary, undefined);
  world.events.setRate(1);
  world.advanceAll(5);
  assert.ok(world.events.spawned > 0);
  assert.equal(world.events.resolved, 0);
  near(world.probabilities.sum, -Math.expm1(-5));
});

test('added explorers get unique ids and start at the chosen numbered start', () => {
  const map = courtyard();
  map.starts.push({ x: 40.5, y: 40.5, floor: 0 });
  const world = new World(map);
  const second = world.addExplorer({ startIndex: 1 });
  const named = world.addExplorer({ id: 'agent-7' });
  assert.deepEqual(world.explorers.map(explorer => explorer.id), [1, 2, 'agent-7']);
  assert.deepEqual(second.position, { x: 40.5, y: 40.5 });
  assert.equal(world.addExplorer().id, 3);
  assert.throws(() => world.addExplorer({ startIndex: 5 }), /existing numbered start/);
  assert.throws(() => world.addExplorer({ id: 'agent-7' }), /own id/);
});

test('explorers on different floors collide with their own floor and leave the map active floor alone', () => {
  const map = alignGrid(blankBuilding({ width: 30, height: 30, spawn: { x: 6.5, y: 6.5, floor: 0 } }));
  fillRect(map.floors[0].pixels, 30, 30, 12, 0, 3, 30, MATERIAL.OPAQUE);
  map.activeFloor = 0;
  const world = new World(map);
  const [lower, upper] = place(world, [{ x: 6.5, y: 15.5 }, { x: 6.5, y: 15.5, floor: 1 }]);
  lower.setMovement(1, 0);
  upper.setMovement(1, 0);
  world.advanceAll(2);
  assert.ok(lower.position.x < 12, 'the wall on the lower floor stops the lower explorer');
  assert.ok(upper.position.x > 20, 'the upper floor has no wall');
  assert.equal(map.activeFloor, 0);
  assert.equal(upper.canStand(13.5, 15.5), true);
  assert.equal(lower.canStand(13.5, 15.5), false);
});

test('a door opens while any explorer on its floor is near, and every explorer sees through it', () => {
  const world = new World(doorRoom());
  const [watcher, opener] = place(world, [{ x: 5, y: 13 }, { x: 8, y: 22 }]);
  world.updateDoors();
  assert.equal(world.floorDoors[0].doors[0].open, false);
  assert.equal(watcher.visibleTo(30, 13), false);

  opener.position = { x: 16, y: 13 };
  assert.ok(world.updateDoors());
  assert.equal(watcher.doors[0].open, true);
  assert.equal(watcher.visibleTo(30, 13), true, 'the watcher sees through the door the opener holds');
  assert.equal(watcher.effectiveMaterial(19, 13), MATERIAL.FLOOR);

  opener.position = { x: 8, y: 22 };
  world.updateDoors();
  assert.equal(watcher.visibleTo(30, 13), false);
});

test('an explorer near a door on another floor does not open it', () => {
  const map = doorRoom();
  map.floors.push({ name: 'Upper', pixels: new Uint8Array(map.width * map.height), valueOverrides: {} });
  const world = new World(map);
  place(world, [{ x: 5, y: 13 }, { x: 16, y: 13, floor: 1 }]);
  world.updateDoors();
  assert.equal(world.floorDoors[0].doors[0].open, false);
});

test('explorers pass through each other', () => {
  const world = new World(doorRoom());
  const [east, west] = place(world, [{ x: 4, y: 4 }, { x: 10, y: 4 }]);
  east.setMovement(1, 0);
  west.setMovement(-1, 0);
  world.advanceAll(1);
  assert.ok(east.position.x > 10 && west.position.x < 4, JSON.stringify([east.position, west.position]));
});

test('a chair holds one explorer at a time', () => {
  const map = alignGrid(blankBuilding({ width: 42, height: 42, spawn: { x: 6, y: 6, floor: 0 } }));
  const chair = { id: 'seat', x: 15, y: 15, rotation: 0, floor: 0 };
  addChair(map, chair);
  const world = new World(map);
  const front = chairFront(chair);
  const [first, second] = place(world, [front, front]);
  assert.ok(first.setSitting(true));
  assert.equal(second.nearbyChair(), null);
  assert.equal(second.setSitting(true), false);
  assert.ok(first.setSitting(false));
  assert.ok(second.setSitting(true));
  assert.equal(second.seatedChair, 'seat');
});

test('removing an explorer frees its chair and lets its doors close', () => {
  const map = doorRoom();
  addChair(map, { id: 'seat', x: 3, y: 3, rotation: 0, floor: 0 });
  const world = new World(map);
  const front = chairFront(map.chairs[0]);
  const [, sitter, opener] = place(world, [{ x: 5, y: 22 }, front, { x: 16, y: 13 }]);
  assert.ok(sitter.setSitting(true));
  world.updateDoors();
  assert.equal(world.floorDoors[0].doors[0].open, true);
  assert.ok(world.removeExplorer(sitter));
  assert.ok(world.removeExplorer(opener));
  assert.equal(world.removeExplorer(opener), false);
  world.advanceAll(0.05);
  assert.equal(world.floorDoors[0].doors[0].open, false);
  world.primary.position = { ...front };
  assert.equal(world.primary.nearbyChair().id, 'seat');
});

test('detection hazards of different explorers add', () => {
  const map = () => alignGrid(blankBuilding({ width: 36, height: 36, floorNames: ['Only'], spawn: { x: 6.5, y: 6.5, floor: 0 } }));
  const poses = [{ x: 8.5, y: 10.5, heading: 0 }, { x: 25.5, y: 20.5, heading: 3 }];
  const together = new World(map());
  place(together, poses);
  together.advanceAll(1);
  const alone = poses.map(pose => {
    const world = new World(map());
    place(world, [pose]);
    world.advanceAll(1);
    return world.probabilities.hazards;
  });
  const { hazards } = together.probabilities;
  let shared = 0;
  for (let j = 0; j < hazards.length; j++) {
    near(hazards[j], alone[0][j] + alone[1][j]);
    if (alone[0][j] > 0 && alone[1][j] > 0) shared++;
  }
  assert.ok(shared > 0, 'some pixels are seen by both explorers');
});

test('credit is the detection reduction, shared in proportion to hazard', () => {
  const map = () => alignGrid(blankBuilding({ width: 36, height: 36, floorNames: ['Only'], spawn: { x: 6.5, y: 6.5, floor: 0 } }));
  const seconds = 2;
  const unobserved = new World(map(), { empty: true });
  unobserved.advanceAll(seconds);

  // Two explorers at the same pose split the reduction evenly.
  const twins = new World(map());
  const [a, b] = place(twins, [{ x: 18.5, y: 18.5 }, { x: 18.5, y: 18.5 }]);
  twins.advanceAll(seconds);
  near(a.credit + b.credit, unobserved.probabilities.sum - twins.probabilities.sum);
  near(a.credit, b.credit);
  assert.ok(a.credit > 0);

  // One explorer alone earns the whole reduction.
  const solo = new World(map());
  place(solo, [{ x: 18.5, y: 18.5 }]);
  solo.advanceAll(seconds);
  near(solo.primary.credit, unobserved.probabilities.sum - solo.probabilities.sum);
});

test('an explorer that sees none of the valued pixels earns no credit', () => {
  const map = doorRoom();
  map.floors[0].valueOverrides = Object.fromEntries(Array.from({ length: map.width * map.height }, (_, i) => [i, i % map.width > 21 ? 1 : 0]));
  const world = new World(map);
  const [left, right] = place(world, [{ x: 5, y: 4, heading: 0 }, { x: 30, y: 13, heading: 4 }]);
  world.advanceAll(3);
  assert.equal(left.credit, 0);
  assert.ok(right.credit > 0);
});

test('a sampled event in view of a non-primary explorer is spotted', () => {
  const world = new World(weightedMap([[0, 12, 9, 1]]), { random: seededRandom() });
  const [primary, helper] = place(world, [{ x: 4.5, y: 9.5, floor: 1 }, { x: 8.5, y: 9.5 }]);
  world.events.setRate(0);
  const event = world.events.spawn();
  event.detectionBudget = 1e-6;
  assert.notEqual(primary.floorIndex, event.floor);
  assert.ok(helper.detectionAt(event.x, event.y) > 0);
  world.advanceAll(0.05);
  assert.equal(world.events.resolved, 1);
});

test('each explorer is charged energy for its own activity', () => {
  const world = new World(doorRoom());
  const [runner, stander] = place(world, [{ x: 4, y: 4 }, { x: 10, y: 22 }]);
  runner.setGait('sprint');
  runner.setMovement(0, 1);
  world.advanceAll(0.5);
  near(runner.energy.byActivity.sprint.seconds, 0.5);
  near(stander.energy.byActivity.standing.seconds, 0.5);
  assert.equal(stander.distance, 0);
  assert.ok(runner.distance > 0);
});

test('worlds given the same inputs one slice at a time stay identical', () => {
  const run = () => {
    const world = new World(courtyard(), { random: seededRandom(3) });
    world.events.setRate(0.01);
    for (let k = 0; k < 2; k++) world.addExplorer();
    const inputs = seededRandom(99);
    for (let tick = 0; tick < 400; tick++) {
      for (const explorer of world.explorers) {
        if (inputs() < 0.1) explorer.setMovement(Math.round(inputs() * 2 - 1), Math.round(inputs() * 2 - 1));
        if (inputs() < 0.05) explorer.setLook(['forward', 'left', 'right', 'back'][Math.floor(inputs() * 4)]);
      }
      world.advanceAll(0.05);
    }
    return JSON.stringify({
      explorers: world.explorers.map(e => [e.position, e.floorIndex, e.facing, e.energy.kcal, e.credit]),
      sum: world.probabilities.sum,
      events: [world.events.spawned, world.events.resolved],
    });
  };
  assert.equal(run(), run());
});
