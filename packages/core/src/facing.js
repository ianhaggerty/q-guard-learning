// Eight-direction headings. Index 0 is east and indices increase clockwise in 45° steps
// (the map's y axis points down).

export const DIRECTIONS = Object.freeze(['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']);

/** Where the explorer looks, as 45° heading steps clockwise from the direction of travel. */
export const LOOK_OFFSETS = Object.freeze({
  forward: 0, 'forward-right': 1, right: 2, 'back-right': 3, back: 4, 'back-left': 5, left: 6, 'forward-left': 7,
});

/** Looking more than 90° away from the direction of travel means walking backwards. */
export function isBackwardLook(look) {
  const offset = LOOK_OFFSETS[look];
  return offset >= 3 && offset <= 5;
}

/** The nearest of the eight headings to the vector (dx, dy). */
export function headingFromVector(dx, dy) {
  return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
}

/** Unit vector { x, y } for a heading index. */
export function headingVector(heading) {
  const angle = heading * Math.PI / 4;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/** Absolute angle in degrees between a heading and the direction (dx, dy). */
export function eccentricityDegrees(dx, dy, heading) {
  const { x: hx, y: hy } = heading;
  return Math.abs(Math.atan2(dy * hx - dx * hy, dx * hx + dy * hy)) * 180 / Math.PI;
}
