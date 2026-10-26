// Numbered explore starts, { x, y, floor }. Start 1 is also stored as `map.spawn`.

import { MATERIAL } from './materials.js';
import { CHAIR_SIZE, EXPLORER_RADIUS } from './scale.js';
import { circleHitsCell, circleOverlapsBox } from './geometry.js';

export const MAX_STARTS = 128;

/** Starts on one floor must be at least one block apart. */
const MIN_START_SPACING = 3;

/**
 * Check that `start` may be stored at `index` (an existing index to move a start, or
 * starts.length to add one): on clear floor with room for the explorer, away from
 * chairs and from the other starts on its floor.
 */
export function validateStart(map, start, index = map.starts.length) {
  const validIndex = Number.isInteger(index) && index >= 0 && index <= map.starts.length;
  const validPoint = start && Number.isFinite(start.x) && Number.isFinite(start.y)
    && Number.isInteger(start.floor) && start.floor >= 0 && start.floor < map.floors.length;
  if (!validIndex || !validPoint) throw new Error('Invalid numbered start.');
  if (index === map.starts.length && map.starts.length >= MAX_STARTS) {
    throw new Error(`Use at most ${MAX_STARTS} starts.`);
  }

  const { width, height } = map, pixels = map.floors[start.floor].pixels, r = EXPLORER_RADIUS;
  const blocked = (x, y) => x < 0 || y < 0 || x >= width || y >= height || pixels[y * width + x] !== MATERIAL.FLOOR;
  if (circleHitsCell(start.x, start.y, r, blocked)) {
    throw new Error('Place the start on clear floor with room for the character.');
  }
  for (const chair of map.chairs) {
    if (chair.floor !== start.floor) continue;
    if (circleOverlapsBox(start.x, start.y, r, chair.x, chair.y, CHAIR_SIZE, CHAIR_SIZE)) {
      throw new Error('A start needs clear floor away from chairs.');
    }
  }
  const crowded = map.starts.some((other, i) => i !== index && other.floor === start.floor
    && Math.hypot(start.x - other.x, start.y - other.y) < MIN_START_SPACING);
  if (crowded) throw new Error('Leave at least one block between starts.');
}

/** Add (index = starts.length) or move a numbered start. */
export function setStart(map, index, start) {
  validateStart(map, start, index);
  map.starts[index] = { x: start.x, y: start.y, floor: start.floor };
  map.spawn = map.starts[0];
  return index;
}

/** Remove a start; the starts after it are renumbered. */
export function removeStart(map, index) {
  if (!Number.isInteger(index) || index < 0 || index >= map.starts.length) throw new Error('Choose a numbered start.');
  if (map.starts.length === 1) throw new Error('Keep at least one start.');
  map.starts.splice(index, 1);
  map.spawn = map.starts[0];
}
