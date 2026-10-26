// The map object: a building of one or more floors that share width and height.
//
//   {
//     name, width, height,
//     floors: [{ name, pixels: Uint8Array, valueOverrides: { [pixelIndex]: number } }],
//     activeFloor,                 // floor shown in Build mode and occupied in Explore mode
//     spawn,                       // Start 1; always the same object as starts[0]
//     starts: [{ x, y, floor }],   // numbered explore starts
//     stairs: [...], chairs: [...],
//     gridSize,                    // 3 once the map has been aligned to the 3 × 3 grid
//     pixels                       // accessor for floors[activeFloor].pixels
//   }

export const MAX_FLOORS = 8;

/**
 * Bring a map object up to the shape described above, in place, and return it.
 * Accepts the old single-floor shape `{ width, height, pixels, spawn }`.
 */
export function normalizeMap(map) {
  if (!Array.isArray(map.floors)) map.floors = [{ name: 'Ground floor', pixels: map.pixels }];
  for (const floor of map.floors) if (!floor.valueOverrides) floor.valueOverrides = {};
  map.activeFloor = Number.isInteger(map.activeFloor) ? map.activeFloor : 0;
  map.stairs = map.stairs || [];
  map.chairs = map.chairs || [];

  const primary = map.spawn || map.starts?.[0];
  map.spawn = { ...primary, floor: primary?.floor || 0 };
  const otherStarts = (map.starts || []).slice(1).map(start => ({ ...start, floor: start.floor || 0 }));
  map.starts = [map.spawn, ...otherStarts];

  delete map.pixels;
  Object.defineProperty(map, 'pixels', {
    configurable: true,
    get() { return this.floors[this.activeFloor].pixels; },
    set(pixels) { this.floors[this.activeFloor].pixels = pixels; },
  });
  return map;
}

/** normalizeMap, unless the map already has floors and the active-floor accessor. */
export function ensureMap(map) {
  const alreadyNormalized = map.floors && Object.getOwnPropertyDescriptor(map, 'pixels')?.get;
  return alreadyNormalized ? map : normalizeMap(map);
}

/** An empty single-floor map, starting in the middle. */
export function createBlankMap(width, height, name = 'Untitled map') {
  return normalizeMap({
    width,
    height,
    name,
    spawn: { x: width / 2 + 0.5, y: height / 2 + 0.5 },
    pixels: new Uint8Array(width * height),
  });
}

/** Append a blank floor and make it the active floor. */
export function addFloor(map) {
  if (map.floors.length >= MAX_FLOORS) throw new Error(`Use at most ${MAX_FLOORS} floors.`);
  map.floors.push({
    name: `Floor ${map.floors.length + 1}`,
    pixels: new Uint8Array(map.width * map.height),
    valueOverrides: {},
  });
  map.activeFloor = map.floors.length - 1;
}
