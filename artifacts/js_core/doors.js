// Doors. Edge-connected door pixels form one door, which opens while the explorer is
// within DOOR_TRIGGER_DISTANCE of any of its pixels and closes as soon as they are not.
// Opening a door never changes the saved pixels.

import { MATERIAL } from './materials.js';
import { neighbours } from './raster.js';

export const DOOR_TRIGGER_DISTANCE = 5;

/**
 * Group the door pixels of one floor.
 * Returns { ids, doors }: `ids[pixel]` is the index of the pixel's door (or -1), and
 * each door is { cells: pixelIndices, open }.
 */
export function groupDoors({ width, height, pixels }) {
  const ids = new Int32Array(pixels.length).fill(-1), doors = [];
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] !== MATERIAL.DOOR || ids[i] !== -1) continue;
    const id = doors.length, cells = [], stack = [i];
    ids[i] = id;
    while (stack.length) {
      const cell = stack.pop();
      cells.push(cell);
      for (const next of neighbours(cell, width, height)) {
        if (pixels[next] !== MATERIAL.DOOR || ids[next] !== -1) continue;
        ids[next] = id;
        stack.push(next);
      }
    }
    doors.push({ cells, open: false });
  }
  return { ids, doors };
}

/** Distance from (x, y) to the nearest edge of any of the door's pixels. */
export function doorDistance(door, width, x, y) {
  let best = Infinity;
  for (const cell of door.cells) {
    const cellX = cell % width, cellY = Math.floor(cell / width);
    const dx = Math.max(cellX - x, 0, x - cellX - 1), dy = Math.max(cellY - y, 0, y - cellY - 1);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}
