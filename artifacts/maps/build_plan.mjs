// Turns a raw plan spec written by generate_curriculum.py into a valid Pixel Map Lab file,
// using the editor's own core (so stairs are rasterised and chairs/starts validated exactly
// as the app would).  usage: bun maps/build_plan.mjs <coreDir> <spec.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [coreDir, specPath, outPath] = process.argv.slice(2);
const core = await import(pathToFileURL(coreDir + '/index.js').href);
const { normalizeMap, addStair, addChair, setStart, encodeMap, decodeMap } = core;
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const map = normalizeMap({
  width: spec.width, height: spec.height, name: spec.name,
  spawn: spec.starts[0],
  floors: spec.floors.map((f, i) => ({ name: f.name || `Floor ${i + 1}`, pixels: new Uint8Array(f.pixels), valueOverrides: f.valueOverrides || {} })),
  stairs: [],
});
map.gridSize = 3;
for (const s of spec.stairs || []) addStair(map, s);
for (const c of spec.chairs || []) { try { addChair(map, c); } catch (e) { console.error('chair skipped', e.message); } }
let placed = 0;
for (const s of spec.starts) {
  try { setStart(map, placed === 0 ? 0 : map.starts.length, s); placed++; }
  catch (e) { console.error('start skipped', e.message); }
}
const saved = encodeMap(map);
decodeMap(JSON.parse(JSON.stringify(saved)));   // round-trip validation
writeFileSync(outPath, JSON.stringify(saved));
console.log('ok', outPath, 'starts', map.starts.length, 'chairs', map.chairs.length, 'stairs', map.stairs.length);
