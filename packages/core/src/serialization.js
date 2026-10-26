// The JSON file format, also used for autosave and undo snapshots.
//
// Version 2 stores every floor's exact pixels, plus effective `values` and sparse
// `valueOverrides` per floor, stairs, chairs, numbered starts (with `spawn` mirroring
// Start 1), the active floor and the map name. Version 1 files hold one floor.

import { COLORS, MATERIAL_NAMES } from './materials.js';
import { GRID } from './scale.js';
import { MAX_FLOORS, ensureMap, normalizeMap } from './map.js';
import { defaultValue } from './values.js';
import { MAX_STAIRS, STAIR_GEOMETRY, STAIR_STYLE, validateStair } from './stairs.js';
import { MAX_CHAIRS, validateChair } from './chairs.js';
import { MAX_STARTS } from './starts.js';
import { upgradeSavedStairs } from './migrations.js';

const FILE_FORMAT = 'pixel-map-lab';
const FILE_VERSION = 2;
export const MIN_MAP_SIZE = 16;
export const MAX_MAP_SIZE = 513;

export function encodeMap(map) {
  ensureMap(map);
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    stairStyle: STAIR_STYLE,
    stairGeometry: STAIR_GEOMETRY,
    ...(map.gridSize === GRID ? { gridSize: GRID } : {}),
    width: map.width,
    height: map.height,
    name: map.name,
    spawn: { ...map.spawn },
    starts: [map.spawn, ...map.starts.slice(1)].map(start => ({ ...start })),
    activeFloor: map.activeFloor,
    materials: [...MATERIAL_NAMES],
    palette: [...COLORS],
    floors: map.floors.map(floor => ({
      name: floor.name,
      pixels: Array.from(floor.pixels),
      values: Array.from(floor.pixels, (material, i) => floor.valueOverrides?.[i] ?? defaultValue(material)),
      valueOverrides: { ...floor.valueOverrides },
    })),
    stairs: map.stairs.map(stair => ({ ...stair })),
    chairs: (map.chairs || []).map(chair => ({ ...chair })),
  };
}

/** Validate a parsed JSON file and build a map from it. Throws a user-facing Error when invalid. */
export function decodeMap(saved) {
  if (!saved || saved.format !== FILE_FORMAT || ![1, 2].includes(saved.version)) {
    throw new Error('Use a Pixel Map Lab JSON map.');
  }
  const singleFloor = saved.version === 1;
  const { width, height } = saved;
  checkDimensions(width, height);

  const floors = singleFloor ? [{ name: 'Ground floor', pixels: saved.pixels }] : saved.floors;
  checkFloors(floors, width * height);

  const spawn = saved.spawn, spawnFloor = singleFloor ? 0 : spawn?.floor;
  if (!spawn || !isPointOnMap(spawn, width, height) || !isFloorIndex(spawnFloor, floors.length)) {
    throw new Error('The map has an invalid start position or floor.');
  }
  const starts = singleFloor || saved.starts === undefined ? [{ x: spawn.x, y: spawn.y, floor: spawnFloor }] : saved.starts;
  checkStarts(starts, spawn, spawnFloor, width, height, floors.length);

  const activeFloor = singleFloor ? 0 : saved.activeFloor;
  if (!isFloorIndex(activeFloor, floors.length)) throw new Error('The active floor is invalid.');
  const stairs = singleFloor ? [] : saved.stairs;
  if (!Array.isArray(stairs) || stairs.length > MAX_STAIRS) throw new Error('Invalid stairs list.');

  const map = normalizeMap({
    width,
    height,
    name: typeof saved.name === 'string' ? saved.name.slice(0, 70) : 'Untitled map',
    floors: floors.map((floor, i) => ({
      name: typeof floor.name === 'string' ? floor.name.slice(0, 40) : `Floor ${i + 1}`,
      pixels: new Uint8Array(floor.pixels),
      valueOverrides: readValueOverrides(floor),
    })),
    activeFloor,
    spawn: { x: spawn.x, y: spawn.y, floor: spawnFloor },
    starts: starts.map(start => ({ x: start.x, y: start.y, floor: start.floor })),
    stairs: stairs.map(stair => ({ ...stair })),
  });

  const chairs = singleFloor || saved.chairs === undefined ? [] : saved.chairs;
  if (!Array.isArray(chairs) || chairs.length > MAX_CHAIRS) throw new Error(`Use at most ${MAX_CHAIRS} chairs.`);
  map.chairs = chairs.map(chair => ({ ...chair }));
  for (const chair of map.chairs) validateChair(map, chair, map.chairs);

  const stairIds = new Set();
  for (const stair of map.stairs) {
    if (typeof stair.id !== 'string' || !stair.id || stairIds.has(stair.id)) throw new Error('Stairs need unique IDs.');
    stairIds.add(stair.id);
    validateStair(map, stair, map.stairs);
  }

  upgradeSavedStairs(map, saved);
  if (saved.gridSize === GRID) map.gridSize = GRID;
  return map;
}

/** A deep copy, made by a round trip through the file format (used for undo snapshots). */
export function cloneMap(map) {
  return decodeMap(encodeMap(map));
}

function isPointOnMap(point, width, height) {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.y >= 0 && point.x < width && point.y < height;
}

function isFloorIndex(floor, floorCount) {
  return Number.isInteger(floor) && floor >= 0 && floor < floorCount;
}

function checkDimensions(width, height) {
  const valid = [width, height].every(n => Number.isInteger(n) && n >= MIN_MAP_SIZE && n <= MAX_MAP_SIZE);
  if (!valid) throw new Error('Map dimensions must be whole numbers from 16 to 513.');
}

function checkFloors(floors, pixelCount) {
  if (!Array.isArray(floors) || !floors.length || floors.length > MAX_FLOORS) {
    throw new Error('A building needs 1–8 floors.');
  }
  for (const floor of floors) {
    const valid = floor && Array.isArray(floor.pixels) && floor.pixels.length === pixelCount
      && floor.pixels.every(material => Number.isInteger(material) && material >= 0 && material <= 3);
    if (!valid) throw new Error('Each floor must contain one material value (0–3) per pixel.');
  }
  for (const floor of floors) {
    const { values, valueOverrides } = floor;
    if (values !== undefined && !(Array.isArray(values) && values.length === pixelCount && values.every(Number.isFinite))) {
      throw new Error('Each pixel value must be a finite number.');
    }
    if (valueOverrides !== undefined && !areValidOverrides(valueOverrides, pixelCount)) {
      throw new Error('Invalid custom pixel values.');
    }
  }
}

/** A plain object mapping canonical pixel indices ("0", "17", never "017") to finite numbers. */
function areValidOverrides(overrides, pixelCount) {
  if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') return false;
  return Object.entries(overrides).every(([key, value]) => /^\d+$/.test(key)
    && String(Number(key)) === key && Number(key) < pixelCount && Number.isFinite(value));
}

function checkStarts(starts, spawn, spawnFloor, width, height, floorCount) {
  const valid = Array.isArray(starts) && starts.length && starts.length <= MAX_STARTS
    && starts.every(start => start && isPointOnMap(start, width, height) && isFloorIndex(start.floor, floorCount));
  if (!valid) throw new Error('Use 1–128 valid numbered starts.');
  if (starts[0].x !== spawn.x || starts[0].y !== spawn.y || starts[0].floor !== spawnFloor) {
    throw new Error('Start 1 must match the primary start.');
  }
  if (new Set(starts.map(start => `${start.floor}:${start.x}:${start.y}`)).size !== starts.length) {
    throw new Error('Numbered starts must have distinct positions on each floor.');
  }
}

/** Custom values from a saved floor: the sparse overrides, or else any values that differ from the defaults. */
function readValueOverrides(floor) {
  if (floor.valueOverrides) return { ...floor.valueOverrides };
  if (!floor.values) return {};
  return Object.fromEntries(floor.values.flatMap((value, i) => value === defaultValue(floor.pixels[i]) ? [] : [[i, value]]));
}
