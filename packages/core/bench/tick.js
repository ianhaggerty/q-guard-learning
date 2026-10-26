// Time per 0.05 s tick with 1, 2, 4 and 8 explorers wandering a plan: the room server's
// per-room cost. usage: npm run bench -w packages/core [-- path/to/plan.json]
// Without a plan it uses the two-floor courtyard test fixture.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { World, alignGrid, decodeMap } from '../src/index.js';

const TICK_SECONDS = 0.05, WARM_UP_TICKS = 40, TIMED_TICKS = 200;
const planPath = process.argv[2] || new URL('../test/fixtures/courtyard.json', import.meta.url);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const label = process.argv[2] ? basename(planPath, '.json') : plan.name;

/** A deterministic linear congruential generator in [0, 1). */
function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

for (const count of [1, 2, 4, 8]) {
  const world = new World(alignGrid(decodeMap(plan)), { empty: true, random: seededRandom(1) });
  for (let k = 0; k < count; k++) world.addExplorer({ startIndex: k % world.map.starts.length });
  const random = seededRandom(5);
  const tick = () => {
    for (const explorer of world.explorers) {
      if (random() < 0.1) explorer.setMovement(Math.round(random() * 2 - 1) || 1, Math.round(random() * 2 - 1));
    }
    world.advanceAll(TICK_SECONDS);
  };
  for (let i = 0; i < WARM_UP_TICKS; i++) tick();
  const start = performance.now();
  for (let i = 0; i < TIMED_TICKS; i++) tick();
  const milliseconds = (performance.now() - start) / TIMED_TICKS;
  console.log(`${label}: ${count} explorer${count > 1 ? 's' : ' '} ${milliseconds.toFixed(2)} ms/tick (${(100 * milliseconds / (TICK_SECONDS * 1000)).toFixed(0)}% of a tick)`);
}
