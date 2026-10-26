// Replays an action sequence in the JS core (packages/core/src) and dumps the trajectory.
// usage: bun validation/js_rollout.mjs <coreDir> <plan.json> <actions.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [coreDir, planPath, actionsPath, outPath] = process.argv.slice(2);
const core = await import(pathToFileURL(coreDir + '/index.js').href);
const { decodeMap, World } = core;
const spec = JSON.parse(readFileSync(actionsPath, 'utf8'));
const map = decodeMap(JSON.parse(readFileSync(planPath, 'utf8')));
if (spec.start) { map.spawn.x = spec.start.x; map.spawn.y = spec.start.y; map.spawn.floor = spec.start.floor; map.starts[0] = map.spawn; }
const world = new World(map, { random: () => 0.5 });
const GAITS = ['walk', 'run', 'sprint'];
const LOOKS = ['forward', 'forward-right', 'right', 'back-right', 'back', 'back-left', 'left', 'forward-left'];
const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
const out = [];
for (const [move, gait, look] of spec.actions) {
  world.setGait(GAITS[gait]);
  world.setLook(LOOKS[look]);
  let dx = 0, dy = 0;
  if (move === 9) { if (!world.sitting) world.setSitting(true); }
  else if (move >= 1) { dx = DX[move - 1]; dy = DY[move - 1]; }
  world.advance(spec.dt, dx, dy);
  out.push({ x: world.player.x, y: world.player.y, floor: world.floorIndex, heading: world.heading, facing: world.facing,
    sitting: world.sitting, kcal: world.energy.kcal, psum: world.probabilities.sum, metres: world.energy.metres });
}
writeFileSync(outPath, JSON.stringify(out));
