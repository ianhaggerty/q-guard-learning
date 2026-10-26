// Eight-direction facing, looking relative to travel, backward walking and the field of view.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES, FIELD_OF_VIEW, MATERIAL, METRES_PER_PIXEL, World, addChair, addStair, chairFront, fillRect,
  stairToWorld,
} from '../src/index.js';
import { blankBuilding, courtyard, within } from './helpers.js';

const near = within(1e-8);

function room() {
  return blankBuilding({ width: 192, height: 192, name: 'Facing', spawn: { x: 60, y: 60, floor: 0 } });
}

const HEADINGS = [[1, 0, 0], [1, 1, 1], [0, 1, 2], [-1, 1, 3], [-1, 0, 4], [-1, -1, 5], [0, -1, 6], [1, -1, 7]];
const LOOKS = [
  ['forward', 0], ['forward-right', 1], ['right', 2], ['back-right', 3],
  ['back', 4], ['back-left', 5], ['left', 6], ['forward-left', 7],
];

for (const [dx, dy, heading] of HEADINGS) {
  for (const [look, offset] of LOOKS) {
    test(`eight-direction facing for ${dx},${dy} looking ${look}, retained when stopped`, () => {
      const world = new World(room());
      world.setLook(look);
      world.advance(0.1, dx, dy);
      assert.equal(world.facing, (heading + offset) % 8);
      const facing = world.facing;
      world.advance(0.1);
      assert.equal(world.facing, facing);
      assert.equal(world.energy.activity, 'standing');
    });
  }
}

for (const gait of ['walk', 'run', 'sprint']) {
  test(`${gait} is overridden by backward walking with distinct time and kcal`, () => {
    const world = new World(room());
    world.setGait(gait);
    world.setLook('back');
    world.advance(1, 1, 0);
    near(world.energy.metres, 0.8);
    near(world.energy.kcal, 4 * 70 / 3600);
    near(world.energy.byActivity.backward.seconds, 1);
    assert.equal(world.gait, gait);
    world.setLook('forward');
    world.advance(1, 1, 0);
    near(world.energy.metres, 0.8 + ACTIVITIES[gait].speed);
  });
}

test('left and right looking preserve normal gait and speed', () => {
  for (const look of ['left', 'right']) {
    for (const gait of ['walk', 'run', 'sprint']) {
      const world = new World(room());
      world.setLook(look);
      world.setGait(gait);
      world.advance(1, 1, 0);
      near(world.energy.metres, ACTIVITIES[gait].speed);
      assert.equal(world.energy.activity, gait);
    }
  }
});

test('forward diagonal looks keep the gait; back diagonal looks walk backwards, also on stairs', () => {
  for (const [look, backward] of [['forward-right', false], ['forward-left', false], ['back-right', true], ['back-left', true]]) {
    const level = new World(room());
    level.setGait('run');
    level.setLook(look);
    level.advance(1, 1, 0);
    assert.equal(level.energy.activity, backward ? 'backward' : 'run', look);
    near(level.energy.metres, backward ? ACTIVITIES.backward.speed : ACTIVITIES.run.speed);

    const map = room(), stair = { id: 's', type: 'straight', x: 60, y: 60, length: 36, width: 9, rotation: 0, lower: 0, upper: 1 };
    addStair(map, stair);
    const climbing = new World(map);
    climbing.player = stairToWorld(stair, 8, 4.5);
    climbing.setGait('run');
    climbing.setLook(look);
    climbing.advance(0.5, 1, 0);
    assert.equal(climbing.energy.activity, backward ? 'stairsUpBackward' : 'stairsUpRun', look);
  }
});

test('200 degree field includes peripheral edges, excludes rear, rotates through all eight directions', () => {
  const world = new World(room());
  assert.equal(FIELD_OF_VIEW, 200);
  const cases = [[0, true], [90, true], [100, true], [100.1, false], [180, false], [-100, true], [-100.1, false]];
  for (let heading = 0; heading < 8; heading++) {
    world.heading = heading;
    world.setLook('forward');
    for (const [angle, visible] of cases) {
      const radians = (heading * 45 + angle) * Math.PI / 180;
      assert.equal(world.visibleTo(60 + 10 * Math.cos(radians), 60 + 10 * Math.sin(radians)), visible, `${heading},${angle}`);
    }
  }
});

test('opaque walls occlude the cone, transparent walls allow it; looking back reveals rear', () => {
  for (const material of [MATERIAL.OPAQUE, MATERIAL.TRANSPARENT]) {
    const map = room();
    fillRect(map.pixels, map.width, map.height, 66, 0, 3, 192, material);
    const world = new World(map);
    assert.equal(world.visibleTo(75, 60), material === MATERIAL.TRANSPARENT);
    assert.equal(world.visibleTo(45, 60), false);
    world.setLook('back');
    assert.equal(world.visibleTo(45, 60), true);
  }
});

for (const type of ['straight', 'return']) {
  for (const rotation of [0, 90, 180, 270]) {
    test(`backward ${type} stairs ${rotation}: no running, separate ascent/descent energy`, () => {
      const map = room();
      const stair = {
        id: 's', type, x: 60, y: 60, length: type === 'straight' ? 36 : 27, width: type === 'straight' ? 9 : 21,
        landingDepth: 9, rotation, lower: 0, upper: 1,
      };
      addStair(map, stair);
      const world = new World(map);
      world.player = stairToWorld(stair, 8, 4.5);
      world.setLook('back');
      world.setGait('sprint');
      const origin = stairToWorld(stair, 0, 0), ahead = stairToWorld(stair, 1, 0), dx = ahead.x - origin.x, dy = ahead.y - origin.y;
      world.advance(0.5, dx, dy);
      near(world.energy.metres, 0.125);
      near(world.energy.byActivity.stairsUpBackward.seconds, 0.5);
      world.advance(0.5, -dx, -dy);
      near(world.energy.metres, 0.275);
      near(world.energy.byActivity.stairsDownBackward.seconds, 0.5);
      near(world.energy.kcal, (6.8 + 3.5) * 70 * 0.5 / 3600);
    });
  }
}

test('backward crossing stairs changes floor once with no extra energy or distance', () => {
  const map = courtyard(), world = new World(map);
  world.player = stairToWorld(map.stairs[0], 17.9, 4.5);
  world.setLook('back');
  world.advance(0.2, 1, 0);
  assert.equal(world.floorIndex, 1);
  near(world.energy.metres, 0.05);
  near(world.energy.seconds, 0.2);
  assert.equal(world.floorChanges, 1);
});

test('blocked backward attempt counts standing; pause freezes facing and totals', () => {
  const map = room();
  fillRect(map.pixels, map.width, map.height, 63, 0, 3, 192, MATERIAL.OPAQUE);
  const world = new World(map);
  world.player = { x: 61.9, y: 60 };
  world.setLook('back');
  world.advance(1, 1, 0);
  near(world.energy.byActivity.standing.seconds, 1);
  near(world.energy.metres, 0);

  world.paused = true;
  const energy = JSON.stringify(world.energy), facing = world.facing;
  world.advance(1, 0, 1);
  assert.equal(world.facing, facing);
  assert.equal(JSON.stringify(world.energy), energy);
  assert.throws(() => world.setLook('diagonal'));
});

test('diagonal axis displacement takes sqrt(2) time and energy at each level gait, including backward', () => {
  for (const gait of ['walk', 'run', 'sprint', 'backward']) {
    const straight = new World(room()), diagonal = new World(room());
    for (const world of [straight, diagonal]) {
      if (gait === 'backward') world.setLook('back');
      else world.setGait(gait);
    }
    // Time to cover one pixel along an axis at this gait.
    const onePixel = METRES_PER_PIXEL / ACTIVITIES[gait].speed;
    straight.advance(onePixel, 1, 0);
    diagonal.advance(onePixel * Math.SQRT2, 1, 1);
    near(straight.player.x - 60, 1);
    near(diagonal.player.x - 60, 1);
    near(diagonal.player.y - 60, 1);
    near(diagonal.energy.metres, straight.energy.metres * Math.SQRT2);
    near(diagonal.energy.seconds, straight.energy.seconds * Math.SQRT2);
    near(diagonal.energy.kcal, straight.energy.kcal * Math.SQRT2);
  }
});

test('sitting keeps chair orientation in eight-direction coordinates', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const map = room(), chair = { id: 'seat', x: 60, y: 60, floor: 0, rotation };
    addChair(map, chair);
    const world = new World(map);
    world.player = chairFront(chair, world.radius);
    assert.ok(world.setSitting(true));
    assert.equal(world.facing, rotation / 45);
  }
});
