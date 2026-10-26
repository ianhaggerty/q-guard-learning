// Chairs: furniture objects on one floor, { id, x, y, floor, rotation }.
// A chair fills one clear 3 × 3 floor block, blocks walking but not sight, and faces
// `rotation` (0 east, 90 south, 180 west, 270 north). The explorer sits by approaching
// its front.

import { MATERIAL } from './materials.js';
import { CHAIR_SIZE, EXPLORER_RADIUS, GRID } from './scale.js';
import { ROTATIONS, ROTATION_VECTORS, boxesOverlap } from './geometry.js';
import { ensureMap } from './map.js';
import { connectsFloor, stairClearance } from './stairs.js';

/** Nominal seat height in metres (cf. a typical 45 cm dining chair). */
export const CHAIR_SEAT_HEIGHT = 0.45;
export const MAX_CHAIRS = 512;

export function chairBox(chair) {
  return { x: chair.x, y: chair.y, w: CHAIR_SIZE, h: CHAIR_SIZE };
}

export function chairContains(chair, x, y) {
  return x >= chair.x && x < chair.x + CHAIR_SIZE && y >= chair.y && y < chair.y + CHAIR_SIZE;
}

/** True when the chair's block is in bounds, entirely floor material and clear of stairs. */
export function isChairSpotClear(map, chair) {
  const level = map.floors[chair.floor];
  if (!level) return false;
  for (let y = chair.y; y < chair.y + CHAIR_SIZE; y++) {
    for (let x = chair.x; x < chair.x + CHAIR_SIZE; x++) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
      if (level.pixels[y * map.width + x] !== MATERIAL.FLOOR) return false;
    }
  }
  const box = chairBox(chair);
  return !map.stairs.some(stair => connectsFloor(stair, chair.floor) && boxesOverlap(box, stairClearance(stair)));
}

export function validateChair(map, chair, others = map.chairs || []) {
  const wellFormed = chair
    && typeof chair.id === 'string' && chair.id
    && ['x', 'y', 'floor', 'rotation'].every(key => Number.isInteger(chair[key]))
    && chair.x % GRID === 0 && chair.y % GRID === 0
    && ROTATIONS.includes(chair.rotation)
    && isChairSpotClear(map, chair);
  if (!wellFormed) throw new Error('Place a chair on a clear 3 × 3 floor block, away from stairs.');

  const box = chairBox(chair);
  const conflict = others.some(other => other !== chair
    && (other.id === chair.id || (other.floor === chair.floor && boxesOverlap(box, chairBox(other)))));
  if (conflict) throw new Error('A chair already occupies this block.');
}

export function addChair(map, chair) {
  ensureMap(map);
  if (map.chairs.length >= MAX_CHAIRS) throw new Error(`Use at most ${MAX_CHAIRS} chairs.`);
  validateChair(map, chair);
  map.chairs.push({ ...chair });
}

export function removeChair(map, id) {
  map.chairs = map.chairs.filter(chair => chair.id !== id);
}

/** Drop chairs whose block is no longer clear floor (for example after painting walls over them). */
export function pruneChairs(map) {
  map.chairs = (map.chairs || []).filter(chair => isChairSpotClear(map, chair));
  return map;
}

/** Where an explorer of the given radius stands to sit down: just in front of the seat. */
export function chairFront(chair, radius = EXPLORER_RADIUS) {
  const [dx, dy] = ROTATION_VECTORS[chair.rotation];
  const halfChair = CHAIR_SIZE / 2, distance = halfChair + radius + 0.1;
  return { x: chair.x + halfChair + dx * distance, y: chair.y + halfChair + dy * distance };
}
