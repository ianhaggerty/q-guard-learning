// Upgrading maps made by earlier versions of the editor.

import { MATERIAL } from './materials.js';
import { GRID, WALL_THICKNESS } from './scale.js';
import { fillRect } from './raster.js';
import { ensureMap } from './map.js';
import { snap } from './grid.js';
import {
  STAIR_FLIGHT_WIDTH, STAIR_GEOMETRY, STAIR_LANDING_DEPTH, STAIR_RETURN_WIDTH, STAIR_STYLE,
  clearGeneratedStairBoundary, isStairGridAligned, rasterizeStair, stairFlightLength, stairSize, worldToStair,
} from './stairs.js';
import { pruneChairs } from './chairs.js';

// ---------------------------------------------------------------------------
// The 3 × 3 grid

/** True when the canvas, every stair and every floor's pixels are made of whole grid cells. */
export function isGridAligned(map) {
  if (map.width % GRID || map.height % GRID) return false;
  if (!map.stairs.every(isStairGridAligned)) return false;
  return map.floors.every(floor => isFloorGridAligned(floor.pixels, map.width, map.height));
}

function isFloorGridAligned(pixels, width, height) {
  for (let y = 0; y < height; y += GRID) {
    for (let x = 0; x < width; x += GRID) {
      const material = pixels[y * width + x];
      for (let dy = 0; dy < GRID; dy++) {
        for (let dx = 0; dx < GRID; dx++) if (pixels[(y + dy) * width + x + dx] !== material) return false;
      }
    }
  }
  return true;
}

/**
 * Migrate a map to the 3 × 3 grid, in place. The canvas grows to a multiple of 3, each
 * cell takes its majority material, custom values keep their coordinates, and stairs are
 * resized, snapped and re-stamped. Already aligned maps keep their pixels (including
 * hand-edited stair rails); only their stair widths are brought up to date.
 */
export function alignGrid(map) {
  ensureMap(map);
  if (map.gridSize === GRID && isGridAligned(map)) return pruneChairs(equalizeStairWidths(map));

  // Remove only generated transparent rails; they are rebuilt at aligned positions below.
  for (const stair of map.stairs) clearGeneratedStairBoundary(map, stair);

  const oldWidth = map.width, oldHeight = map.height;
  const width = Math.ceil(oldWidth / GRID) * GRID, height = Math.ceil(oldHeight / GRID) * GRID;
  for (const floor of map.floors) {
    floor.pixels = quantizeToGrid(floor.pixels, oldWidth, oldHeight, width, height);
    if (floor.valueOverrides) floor.valueOverrides = reindexOverrides(floor.valueOverrides, oldWidth, width);
  }
  map.width = width;
  map.height = height;
  map.gridSize = GRID;

  for (const stair of map.stairs) {
    const flight = stairFlightLength(stair);
    if (stair.type === 'straight') {
      stair.length = Math.ceil(stair.length / (2 * GRID)) * (2 * GRID);
      stair.width = STAIR_FLIGHT_WIDTH;
    } else {
      stair.length = Math.ceil(flight / GRID) * GRID + STAIR_LANDING_DEPTH;
      stair.width = STAIR_RETURN_WIDTH;
      stair.landingDepth = STAIR_LANDING_DEPTH;
    }
    keepStairInside(map, stair, Math.round(stair.x / GRID) * GRID, Math.round(stair.y / GRID) * GRID);
    rasterizeStair(map, stair);
  }
  return pruneChairs(map);
}

/**
 * Resample a floor onto whole grid cells, padding new canvas with floor. Each cell takes
 * its majority material; ties prefer door, then transparent, then opaque, then floor.
 */
function quantizeToGrid(oldPixels, oldWidth, oldHeight, width, height) {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += GRID) {
    for (let x = 0; x < width; x += GRID) {
      const counts = [0, 0, 0, 0];
      for (let dy = 0; dy < GRID; dy++) {
        for (let dx = 0; dx < GRID; dx++) {
          const inside = y + dy < oldHeight && x + dx < oldWidth;
          counts[inside ? oldPixels[(y + dy) * oldWidth + x + dx] : MATERIAL.FLOOR]++;
        }
      }
      let majority = MATERIAL.FLOOR;
      for (const material of [MATERIAL.OPAQUE, MATERIAL.TRANSPARENT, MATERIAL.DOOR]) {
        if (counts[material] >= counts[majority]) majority = material;
      }
      fillRect(pixels, width, height, x, y, GRID, GRID, majority);
    }
  }
  return pixels;
}

/** Re-key sparse per-pixel values for a wider canvas, keeping their (x, y) positions. */
function reindexOverrides(overrides, oldWidth, width) {
  return Object.fromEntries(Object.entries(overrides).map(([index, value]) => {
    const i = Number(index);
    return [Math.floor(i / oldWidth) * width + i % oldWidth, value];
  }));
}

/** Give every stair its standard 9 px flight width, re-stamping any stair that changes. */
function equalizeStairWidths(map) {
  for (const stair of map.stairs) {
    const width = stair.type === 'return' ? STAIR_RETURN_WIDTH : STAIR_FLIGHT_WIDTH;
    if (stair.width === width) continue;
    clearGeneratedStairBoundary(map, stair);
    stair.width = width;
    keepStairInside(map, stair, stair.x, stair.y);
    rasterizeStair(map, stair);
  }
  return map;
}

/** Move a stair to (x, y), clamped so that its rails stay inside the canvas. */
function keepStairInside(map, stair, x, y) {
  const size = stairSize(stair), margin = WALL_THICKNESS;
  stair.x = Math.max(margin, Math.min(snap(map.width - size.w - margin), x));
  stair.y = Math.max(margin, Math.min(snap(map.height - size.h - margin), y));
}

// ---------------------------------------------------------------------------
// Stairs in saved files

/** Older editors drew stairs with 2 px opaque collars and 8 px landings. */
const LEGACY_WALL = 2, LEGACY_LANDING = 8;

/** Return stairs used to be 32 px deep; they now have a 16 px flight and an 8 px landing. */
const LEGACY_RETURN_LENGTH = 32, RETURN_LENGTH = 24;

/**
 * Upgrade the stairs of a version 2 file, according to the style and geometry tags it
 * was saved with:
 * - Before 'open' stairs, editors generated opaque collars, dividers and filled
 *   inactive halves. That generated mass is cleared once.
 * - 32 px return stairs shrink to 24 px, keeping their entrance where it was.
 * - Stairs without transparent rails, and resized stairs, get rails wherever the rail
 *   pixels are still floor, so custom walls, doors and barriers survive.
 */
export function upgradeSavedStairs(map, saved) {
  if (saved.version !== 2) return;
  if (!['open', STAIR_STYLE].includes(saved.stairStyle)) {
    for (const stair of map.stairs) clearLegacyStairMass(map, stair);
  }
  for (const stair of map.stairs) {
    let resized = false;
    if (saved.stairGeometry !== STAIR_GEOMETRY && stair.type === 'return' && stair.length === LEGACY_RETURN_LENGTH) {
      if (saved.stairStyle === STAIR_STYLE) clearGeneratedStairBoundary(map, stair);
      shrinkLegacyReturnStair(stair);
      resized = true;
    }
    if (resized || saved.stairStyle !== STAIR_STYLE) {
      rasterizeStair(map, stair, { boundaryOnly: true, preserveExisting: true });
    }
  }
}

/** Clear opaque pixels around a stair that were not part of the old walkway. */
function clearLegacyStairMass(map, stair) {
  const { w, h } = stairSize(stair);
  for (const floor of [stair.lower, stair.upper]) {
    const pixels = map.floors[floor].pixels;
    for (let y = stair.y - LEGACY_WALL; y < stair.y + h + LEGACY_WALL; y++) {
      for (let x = stair.x - LEGACY_WALL; x < stair.x + w + LEGACY_WALL; x++) {
        const { u, v } = worldToStair(stair, x + 0.5, y + 0.5), i = y * map.width + x;
        if (!wasLegacyWalkway(stair, floor, u, v) && pixels[i] === MATERIAL.OPAQUE) pixels[i] = MATERIAL.FLOOR;
      }
    }
  }
}

function wasLegacyWalkway(stair, floor, u, v) {
  if (stair.type === 'straight') {
    const half = stair.length / 2;
    return v >= 0 && v < stair.width && (floor === stair.lower ? u >= -LEGACY_WALL && u < half : u >= half && u < stair.length + LEGACY_WALL);
  }
  const run = stair.length - LEGACY_LANDING, lane = (stair.width - LEGACY_WALL) / 2, middle = stair.width / 2;
  const onFlight = u >= -LEGACY_WALL && u < run, onLanding = u >= run && u < stair.length;
  return floor === stair.lower
    ? (onFlight && v >= 0 && v < lane) || (onLanding && v >= 0 && v < middle)
    : (onFlight && v >= stair.width - lane && v < stair.width) || (onLanding && v >= middle && v < stair.width);
}

/** Shorten a 32 px return stair, moving its origin so the entrance (u = 0) stays put. */
function shrinkLegacyReturnStair(stair) {
  const reduction = stair.length - RETURN_LENGTH;
  stair.length = RETURN_LENGTH;
  if (stair.rotation === 180) stair.x += reduction;
  if (stair.rotation === 270) stair.y += reduction;
}
