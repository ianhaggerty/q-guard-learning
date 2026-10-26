// The eraser clears materials to floor and deletes whole objects it touches.

import { MATERIAL } from './materials.js';
import { boxesOverlap } from './geometry.js';
import { fillRect } from './raster.js';
import { ensureMap } from './map.js';
import { connectsFloor, removeStair, stairClearance } from './stairs.js';
import { chairBox } from './chairs.js';

/**
 * Erase a size × size square centred on (x, y) on the active floor. Any stair whose
 * footprint or rails it touches is removed from both connected floors, and any chair it
 * touches is removed. Returns the IDs of the removed stairs.
 */
export function eraseAt(map, x, y, size = 1) {
  ensureMap(map);
  const half = Math.floor(size / 2);
  const brush = { x: x - half, y: y - half, w: size, h: size };

  const removed = map.stairs
    .filter(stair => connectsFloor(stair, map.activeFloor) && boxesOverlap(brush, stairClearance(stair)))
    .map(stair => stair.id);
  for (const id of removed) removeStair(map, id);

  map.chairs = map.chairs.filter(chair => chair.floor !== map.activeFloor || !boxesOverlap(brush, chairBox(chair)));
  fillRect(map.pixels, map.width, map.height, brush.x, brush.y, size, size, MATERIAL.FLOOR);
  return removed;
}
