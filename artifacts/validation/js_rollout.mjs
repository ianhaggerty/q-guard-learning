// Replays an action sequence in the JS core (packages/core/src) and dumps the trajectory.
// usage: bun validation/js_rollout.mjs <coreDir> <plan.json> <actions.json> <out.json>
//
// actions.json: { dt, actions, start?, starts? }. With one guard each action is
// [move, gait, look]; with several (one start per guard in `starts`) each step is a list
// of such triples, one per guard. Each output step carries guard 0's fields at the top
// level and every guard's in `guards`.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [coreDir, planPath, actionsPath, outPath] = process.argv.slice(2);
const core = await import(pathToFileURL(coreDir + '/index.js').href);
const { decodeMap, World } = core;
const spec = JSON.parse(readFileSync(actionsPath, 'utf8'));
const map = decodeMap(JSON.parse(readFileSync(planPath, 'utf8')));
const starts = spec.starts || (spec.start ? [spec.start] : [map.spawn]);
map.spawn = { ...starts[0] };
map.starts = [map.spawn, ...starts.slice(1).map(start => ({ ...start }))];
const world = new World(map, { random: () => 0.5, empty: true });
const explorers = starts.map((_, startIndex) => world.addExplorer({ startIndex }));
const GAITS = ['walk', 'run', 'sprint'];
const LOOKS = ['forward', 'forward-right', 'right', 'back-right', 'back', 'back-left', 'left', 'forward-left'];
const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
const out = [];
for (const step of spec.actions) {
  const perGuard = starts.length === 1 && !Array.isArray(step[0]) ? [step] : step;
  perGuard.forEach(([move, gait, look], g) => {
    const explorer = explorers[g];
    explorer.setGait(GAITS[gait]);
    explorer.setLook(LOOKS[look]);
    let dx = 0, dy = 0;
    if (move === 9) { if (!explorer.sitting) explorer.setSitting(true); }
    else if (move >= 1) { dx = DX[move - 1]; dy = DY[move - 1]; }
    explorer.setMovement(dx, dy);
  });
  world.advanceAll(spec.dt);
  const guards = explorers.map(e => ({ x: e.position.x, y: e.position.y, floor: e.floorIndex, heading: e.heading, facing: e.facing,
    sitting: e.sitting, kcal: e.energy.kcal, metres: e.energy.metres, credit: e.credit }));
  out.push({ ...guards[0], psum: world.probabilities.sum, guards });
}
writeFileSync(outPath, JSON.stringify(out));
