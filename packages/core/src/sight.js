// Line of sight from a viewpoint to the pixels of its floor, computed on demand and kept
// for recently used viewpoints. A viewpoint is a floor, the viewer's pixel and the open or
// closed state of that floor's doors; sight does not depend on who is looking or which way
// they face. Explorers therefore share entries, and an explorer returning to a pixel finds
// its entry still there. Facing, distance and so each explorer's own detection hazard and
// credit are not cached here, so sharing changes no result.
//
// Lines are traced exactly as Explorer.lineOfSight traces them, but over a flat grid of
// sight-blocking pixels built once per floor and door state, which is much faster than
// asking the explorer about every pixel.

import { MATERIAL } from './materials.js';
import { traceLine } from './raster.js';

const UNKNOWN = 0, VISIBLE = 1, HIDDEN = 2;

/** Blocking grids kept for recently seen floor and door states. */
const MAX_BLOCKING_GRIDS = 16;

/** Default memory for cached sight, per world: about 200 viewpoints on a 192 × 192 map. */
export const SIGHT_CACHE_BYTES = 8 * 2 ** 20;

export class SightCache {
  constructor(map, maxBytes = SIGHT_CACHE_BYTES) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('Sight cache size must be zero or positive.');
    this.pixelCount = map.width * map.height;
    this.width = map.width;
    this.maxEntries = Math.max(1, Math.floor(maxBytes / this.pixelCount));
    this.entries = new Map(); // in least- to most-recently-used order
    this.blockingGrids = new Map(); // likewise
  }

  /**
   * The viewpoint of `explorer` given its floor's door states (one 0/1 per door):
   * { from, blocking, seen }, where `seen` records each pixel's sight once it is traced.
   */
  entryFor(explorer, doorStates) {
    const { position, floorIndex } = explorer;
    const from = { x: Math.floor(position.x), y: Math.floor(position.y) };
    const doorKey = floorIndex + ':' + doorStates.join('');
    const key = [from.x, from.y, doorKey].join(':');
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
    } else {
      entry = { from, blocking: this.blockingGrid(explorer, doorKey), seen: new Uint8Array(this.pixelCount) };
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, entry);
    return entry;
  }

  /** 1 for every pixel of the explorer's floor that blocks sight: opaque mass and closed doors. */
  blockingGrid(explorer, doorKey) {
    let grid = this.blockingGrids.get(doorKey);
    if (grid) {
      this.blockingGrids.delete(doorKey);
    } else {
      grid = new Uint8Array(this.pixelCount);
      const pixels = explorer.map.floors[explorer.floorIndex].pixels, { doors, doorIds } = explorer;
      for (let i = 0; i < this.pixelCount; i++) {
        grid[i] = +(pixels[i] === MATERIAL.OPAQUE || (pixels[i] === MATERIAL.DOOR && !doors[doorIds[i]].open));
      }
      if (this.blockingGrids.size >= MAX_BLOCKING_GRIDS) this.blockingGrids.delete(this.blockingGrids.keys().next().value);
    }
    this.blockingGrids.set(doorKey, grid);
    return grid;
  }

  /** Whether the viewpoint `entry` has a clear line to (x, y); the same rule as Explorer.lineOfSight. */
  visible(entry, x, y) {
    const to = { x: Math.floor(x), y: Math.floor(y) }, i = to.y * this.width + to.x;
    if (entry.seen[i] === UNKNOWN) {
      const { from, blocking } = entry, width = this.width;
      const clear = traceLine(from, to, (cellX, cellY) => {
        const isEndpoint = (cellX === from.x && cellY === from.y) || (cellX === to.x && cellY === to.y);
        return isEndpoint || !blocking[cellY * width + cellX];
      });
      entry.seen[i] = clear ? VISIBLE : HIDDEN;
    }
    return entry.seen[i] === VISIBLE;
  }
}
