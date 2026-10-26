// Energy use: activity METs, speeds, stairs, sitting, pausing and time slicing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES, BODY_MASS_KG, EnergyTracker, MATERIAL, METRES_PER_PIXEL, World, addChair, addStair, alignGrid, assignValue,
  cloneMap, encodeMap, fillRect, selectionRect, stairToWorld,
} from '../src/index.js';
import { blankBuilding, courtyard, within } from './helpers.js';

const near = within(1e-8);
const kcal = (met, seconds) => met * 70 * seconds / 3600;

function room() {
  return alignGrid(blankBuilding({ width: 192, height: 192, name: 'Energy', spawn: { x: 60, y: 60, floor: 0 } }));
}

/** A grid-sized stair at (60, 60), plus the map-axis vector pointing up its flight. */
function addTestStair(map, type, rotation) {
  const stair = {
    id: 'stair', type, x: 60, y: 60, length: type === 'straight' ? 36 : 27, width: type === 'straight' ? 9 : 21,
    landingDepth: 9, rotation, lower: 0, upper: 1,
  };
  addStair(map, stair);
  const origin = stairToWorld(stair, 0, 0), ahead = stairToWorld(stair, 1, 0);
  return { stair, up: [ahead.x - origin.x, ahead.y - origin.y] };
}

const gaitSuffix = gait => ({ walk: '', run: 'Run', sprint: 'Sprint' })[gait];

test('fixed mass, map scale and published activity presets', () => {
  assert.equal(BODY_MASS_KG, 70);
  assert.equal(3 * METRES_PER_PIXEL, 0.5);
  const expected = { sitting: 1, standing: 1.3, walk: 3.8, run: 9.3, sprint: 23, stairsUp: 6.8, stairsDown: 3.5 };
  for (const [activity, met] of Object.entries(expected)) assert.equal(ACTIVITIES[activity].met, met);
});

for (const activity of Object.keys(ACTIVITIES)) {
  test(`${activity}: one hour uses MET × 70 kcal, with independent time and distance totals`, () => {
    const tracker = new EnergyTracker();
    tracker.record(activity, 3600, 6);
    near(tracker.kcal, ACTIVITIES[activity].met * 70);
    near(tracker.seconds, 3600);
    near(tracker.metres, 1);
    near(tracker.byActivity[activity].kcal, tracker.kcal);
    near(tracker.byActivity[activity].seconds, 3600);
  });
}

for (const gait of ['walk', 'run', 'sprint']) {
  test(`${gait} speed matches map scale and energy follows elapsed time`, () => {
    const world = new World(room());
    world.setGait(gait);
    world.advance(1, 1, 0);
    near(world.energy.metres, ACTIVITIES[gait].speed);
    near(world.distance, world.energy.metres / METRES_PER_PIXEL);
    near(world.energy.kcal, kcal(ACTIVITIES[gait].met, 1));
    near(world.time, 1);
    near(world.energy.seconds, 1);
  });
}

test('diagonal movement does not increase speed or energy', () => {
  const straight = new World(room()), diagonal = new World(room());
  straight.advance(1, 1, 0);
  diagonal.advance(1, 1, 1);
  near(straight.energy.kcal, diagonal.energy.kcal);
  near(straight.energy.metres, diagonal.energy.metres);
});

test('sitting and standing consume resting calories without movement; movement stands up', () => {
  const map = room();
  addChair(map, { id: 'seat', x: 54, y: 57, floor: 0, rotation: 0 });
  const world = new World(map);
  assert.ok(world.setSitting(true));
  world.advance(60);
  near(world.energy.byActivity.sitting.kcal, 70 / 60);
  near(world.energy.metres, 0);
  world.setSitting(false);
  world.advance(60);
  near(world.energy.byActivity.standing.kcal, 1.3 * 70 / 60);
  world.setSitting(true);
  world.advance(1, 1, 0);
  assert.equal(world.sitting, false);
  assert.equal(world.energy.activity, 'walk');
  near(world.energy.seconds, 121);
});

test('pause freezes movement, clock and every calorie total; resume has no catch-up', () => {
  const world = new World(room());
  world.advance(1, 1, 0);
  const energy = JSON.stringify(world.energy), position = { ...world.player }, time = world.time;
  world.paused = true;
  world.advance(600, 1, 0);
  assert.equal(JSON.stringify(world.energy), energy);
  assert.deepEqual(world.player, position);
  assert.equal(world.time, time);
  world.paused = false;
  world.advance(1);
  near(world.energy.seconds, 2);
});

test('movement blocked by a wall is standing, not walking or sprinting', () => {
  const map = room();
  fillRect(map.pixels, map.width, map.height, 63, 0, 3, 192, MATERIAL.OPAQUE);
  const world = new World(map);
  world.player = { x: 61.9, y: 60 };
  world.setGait('sprint');
  world.advance(1, 1, 0);
  near(world.energy.byActivity.standing.seconds, 1);
  near(world.energy.byActivity.sprint.seconds, 0);
  near(world.energy.metres, 0);
});

test('interval subdivision preserves expenditure and distance', () => {
  const once = new World(room()), sliced = new World(room());
  once.advance(2, 1, 0);
  for (let i = 0; i < 200; i++) sliced.advance(0.01, 1, 0);
  near(once.energy.kcal, sliced.energy.kcal);
  near(once.energy.metres, sliced.energy.metres);
});

for (const type of ['straight', 'return']) {
  for (const rotation of [0, 90, 180, 270]) {
    test(`${type} stair ascent/descent use their own METs and speed at ${rotation} degrees`, () => {
      const map = room(), { stair, up: [dx, dy] } = addTestStair(map, type, rotation);
      const world = new World(map);
      world.player = stairToWorld(stair, 5, 4.5);
      world.setGait('walk');
      world.advance(0.5, dx, dy);
      near(world.energy.byActivity.stairsUp.seconds, 0.5);
      near(world.energy.byActivity.stairsUp.kcal, kcal(6.8, 0.5));
      near(world.energy.metres, 0.25);
      world.advance(0.5, -dx, -dy);
      near(world.energy.byActivity.stairsDown.seconds, 0.5);
      near(world.energy.byActivity.stairsDown.kcal, kcal(3.5, 0.5));
      near(world.energy.metres, 0.55);
      if (type === 'return') {
        // The upper flight of a return stair climbs in the opposite direction.
        world.activateFloor(1);
        world.player = stairToWorld(stair, 10, 16.5);
        world.advance(0.5, -dx, -dy);
        near(world.energy.byActivity.stairsUp.seconds, 1);
      }
    });
  }
}

test('straight halfway crossing neither teleports distance nor duplicates energy', () => {
  const map = courtyard(), world = new World(map);
  world.player = stairToWorld(map.stairs[0], 17.9, 4.5);
  world.advance(0.2, 1, 0);
  assert.equal(world.floorIndex, 1);
  near(world.energy.seconds, 0.2);
  near(world.energy.byActivity.stairsUp.seconds, 0.2);
  near(world.energy.metres, 0.1);
  near(world.energy.kcal, kcal(6.8, 0.2));
});

test('return landing is level movement, including the instantaneous floor change', () => {
  const map = courtyard(), world = new World(map);
  world.player = stairToWorld(map.stairs[1], 22.5, 9.8);
  world.advance(0.2, 0, 1);
  assert.equal(world.floorIndex, 1);
  near(world.energy.byActivity.walk.seconds, 0.2);
  near(world.energy.byActivity.stairsUp.seconds, 0);
});

test('custom tile values do not change speed, calories, collision or material data', () => {
  const plain = room(), valued = cloneMap(plain);
  assignValue(valued, selectionRect(valued, { x: 0, y: 0 }, { x: 191, y: 191 }), -9000);
  const saved = encodeMap(valued), plainWorld = new World(plain), valuedWorld = new World(valued);
  plainWorld.advance(1, 1, 0);
  valuedWorld.advance(1, 1, 0);
  assert.deepEqual(plainWorld.energy, valuedWorld.energy);
  assert.deepEqual(plainWorld.player, valuedWorld.player);
  assert.deepEqual(encodeMap(valued), saved);
});

test('new session resets totals without modifying the map or value layer', () => {
  const map = room();
  new World(map).advance(1, 1, 0);
  const next = new World(map);
  assert.equal(next.energy.kcal, 0);
  assert.equal(next.energy.seconds, 0);
  assert.equal(next.distance, 0);
  assert.deepEqual(map.pixels, new Uint8Array(192 * 192));
});

test('invalid inputs are rejected and zero time consumes nothing', () => {
  const world = new World(room());
  for (const dt of [-1, NaN, Infinity]) assert.throws(() => world.advance(dt));
  assert.throws(() => world.setGait('teleport'));
  assert.throws(() => world.advance(1, Infinity, 0));
  world.advance(0, 1, 0);
  assert.equal(world.energy.kcal, 0);
});

for (const gait of ['walk', 'run', 'sprint']) {
  for (const type of ['straight', 'return']) {
    for (const rotation of [0, 90, 180, 270]) {
      test(`${gait} ${type} stair speeds and calorie rates agree in both directions at ${rotation}°`, () => {
        const map = room(), { stair, up: [dx, dy] } = addTestStair(map, type, rotation);
        const world = new World(map), up = 'stairsUp' + gaitSuffix(gait), down = 'stairsDown' + gaitSuffix(gait);
        world.setGait(gait);
        world.player = stairToWorld(stair, 8, 4.5);
        world.advance(0.3, dx, dy);
        near(world.energy.metres, ACTIVITIES[up].speed * 0.3);
        near(world.energy.byActivity[up].seconds, 0.3);
        near(world.energy.kcal, kcal(ACTIVITIES[up].met, 0.3));
        world.advance(0.3, -dx, -dy);
        near(world.energy.metres, (ACTIVITIES[up].speed + ACTIVITIES[down].speed) * 0.3);
        near(world.energy.byActivity[down].seconds, 0.3);
        near(world.energy.kcal, (ACTIVITIES[up].met + ACTIVITIES[down].met) * 70 * 0.3 / 3600);
        if (type === 'return') {
          world.activateFloor(1);
          world.player = stairToWorld(stair, 10, 16.5);
          world.advance(0.3, -dx, -dy);
          near(world.energy.byActivity[up].seconds, 0.6);
        }
      });
    }
  }
}

for (const gait of ['walk', 'run', 'sprint']) {
  test(`${gait}: halfway floor transitions preserve the selected stair gait`, () => {
    const map = courtyard(), world = new World(map), activity = 'stairsUp' + gaitSuffix(gait);
    world.setGait(gait);
    world.player = stairToWorld(map.stairs[0], 17.9, 4.5);
    world.advance(0.2, 1, 0);
    assert.equal(world.floorIndex, 1);
    near(world.energy.byActivity[activity].seconds, 0.2);
    near(world.energy.seconds, 0.2);
    near(world.energy.metres, ACTIVITIES[activity].speed * 0.2);
  });
}

test('original stair-speed table and modelled energy assumptions are explicit', () => {
  const stairActivities = ['stairsUp', 'stairsDown', 'stairsUpRun', 'stairsDownRun', 'stairsUpSprint', 'stairsDownSprint'];
  assert.deepEqual(stairActivities.map(activity => ACTIVITIES[activity].speed), [0.5, 0.6, 1, 1, 1.5, 1.3]);
  near(ACTIVITIES.stairsUpRun.met, 15);
  near(ACTIVITIES.stairsUpSprint.met, 21.85);
  near(ACTIVITIES.stairsDownRun.met, 1.3 + (3.5 - 1.3) / 0.6);
  near(ACTIVITIES.stairsDownSprint.met, 1.3 + (3.5 - 1.3) * 1.3 / 0.6);
  for (const activity of ['stairsUpSprint', 'stairsDownRun', 'stairsDownSprint']) assert.equal(ACTIVITIES[activity].modelled, true);
});
