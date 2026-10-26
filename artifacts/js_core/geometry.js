// Small geometric predicates. Boxes are { x, y, w, h } with exclusive right/bottom edges.

export function boxesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** True when a circle overlaps the box at (x, y) of size w × h. Touching does not count. */
export function circleOverlapsBox(cx, cy, radius, x, y, w, h) {
  const nearestX = Math.max(x, Math.min(cx, x + w));
  const nearestY = Math.max(y, Math.min(cy, y + h));
  return (cx - nearestX) ** 2 + (cy - nearestY) ** 2 < radius * radius;
}

/** True when a circle overlaps any 1 × 1 pixel cell for which `isBlocked(x, y)` is true. */
export function circleHitsCell(cx, cy, radius, isBlocked) {
  for (let y = Math.floor(cy - radius); y <= Math.floor(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.floor(cx + radius); x++) {
      if (circleOverlapsBox(cx, cy, radius, x, y, 1, 1) && isBlocked(x, y)) return true;
    }
  }
  return false;
}

/** Unit vectors for the four editor rotations (east, south, west, north). */
export const ROTATION_VECTORS = Object.freeze({ 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] });

export const ROTATIONS = Object.freeze([0, 90, 180, 270]);
