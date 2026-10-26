// The plans shipped in dist/plans/ must be valid maps, and the manifest must name one of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { World, alignGrid, decodeMap, isGridAligned } from '../dist/js/core/index.js';

const PLANS_FOLDER = new URL('../dist/plans/', import.meta.url);
const readPlan = name => JSON.parse(readFileSync(new URL(encodeURIComponent(name), PLANS_FOLDER), 'utf8'));
const planFiles = readdirSync(PLANS_FOLDER).filter(name => name.endsWith('.json') && name !== 'index.json');

test('the plans manifest names an existing default plan', () => {
  assert.ok(planFiles.includes(readPlan('index.json').default));
});

for (const name of planFiles) {
  test(`plan "${name}" loads on the 3 × 3 grid and can be explored from every start`, () => {
    const map = alignGrid(decodeMap(readPlan(name)));
    assert.ok(isGridAligned(map));
    map.starts.forEach((start, startIndex) => {
      const world = new World(map, { startIndex, random: () => 0.5 });
      assert.ok(world.canStand(world.player.x, world.player.y), `start ${startIndex + 1}`);
    });
  });
}
