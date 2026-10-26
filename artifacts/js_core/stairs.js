// Stairs link two adjacent floors. A stair is an object layered over the pixel maps:
//
//   { id, type: 'straight' | 'return', x, y, length, width, rotation, lower, upper, landingDepth? }
//
// (x, y) is the top-left corner of the footprint. Shapes are described in stair-local
// coordinates: u runs along the direction of ascent (0 → length) and v across it
// (0 → width). `rotation` (0, 90, 180, 270) points the ascent east, south, west or north.
//
// Straight flight: the lower floor owns u < length / 2 and the upper floor the rest.
// Crossing the line u = length / 2 changes floor.
//
// 180° return: two opposing flights separated by a transparent divider, then a landing.
//   v ∈ [0, lane)              lower flight: climb from u = 0 towards the landing
//   v ∈ [lane, lane + 3)       divider
//   v ∈ [lane + 3, width)      upper flight: continue from the landing back to u = 0
//   u ∈ [flightLength, length) landing (plain floor, adds no height)
// Crossing the landing's centre line, v = width / 2, changes floor.
//
// Placing a stair clears its walkway to floor on both floors and surrounds it with
// 3 px transparent rails. Later hand edits are kept: stairs are never re-stamped.

import { MATERIAL } from './materials.js';
import { CHAIR_SIZE, GRID, WALL_THICKNESS } from './scale.js';
import { ROTATIONS, boxesOverlap } from './geometry.js';
import { fillRect } from './raster.js';
import { ensureMap } from './map.js';

/** Flight length per half-floor rise. A straight stair is two flights long. */
export const STAIR_FLIGHT_LENGTH = 18;
/** Clear width of one flight (3 blocks). */
export const STAIR_FLIGHT_WIDTH = 9;
/** Return stairs: two flights plus the divider. */
export const STAIR_RETURN_WIDTH = 2 * STAIR_FLIGHT_WIDTH + WALL_THICKNESS;
export const STAIR_LANDING_DEPTH = 9;
export const MAX_STAIRS = 128;

// Tags saved with each map so that later versions know how its stairs were generated.
/** Stairs have 3 px transparent rails (older saves had opaque mass, or no rails: 'open'). */
export const STAIR_STYLE = 'transparent-3px';
/** Return stairs have a full flight plus a separate landing (older return stairs were 32 px deep). */
export const STAIR_GEOMETRY = 'equal-half-flights-v1';

/** Landing depth of return stairs saved before `landingDepth` was stored. */
const DEFAULT_LANDING_DEPTH = 8;

/** Floor kept clear on both floors either side of the crossing line, so the explorer can straddle it. */
const SEAM_HALF_WIDTH = 3;

// ---------------------------------------------------------------------------
// Geometry

export function connectsFloor(stair, floor) {
  return stair.lower === floor || stair.upper === floor;
}

/** Footprint size along the map axes. */
export function stairSize(stair) {
  return stair.rotation % 180 ? { w: stair.width, h: stair.length } : { w: stair.length, h: stair.width };
}

/** Map coordinates → stair-local { u, v }. */
export function worldToStair(stair, x, y) {
  const dx = x - stair.x, dy = y - stair.y;
  switch (stair.rotation) {
    case 90: return { u: dy, v: stair.width - dx };
    case 180: return { u: stair.length - dx, v: stair.width - dy };
    case 270: return { u: stair.length - dy, v: dx };
    default: return { u: dx, v: dy };
  }
}

/** Stair-local (u, v) → map coordinates { x, y }. */
export function stairToWorld(stair, u, v) {
  switch (stair.rotation) {
    case 90: return { x: stair.x + stair.width - v, y: stair.y + u };
    case 180: return { x: stair.x + stair.length - u, y: stair.y + stair.width - v };
    case 270: return { x: stair.x + v, y: stair.y + stair.length - u };
    default: return { x: stair.x + u, y: stair.y + v };
  }
}

export function stairContains(stair, x, y, pad = 0) {
  const { w, h } = stairSize(stair);
  return x >= stair.x - pad && x < stair.x + w + pad && y >= stair.y - pad && y < stair.y + h + pad;
}

/** The footprint grown by the rail thickness on every side: everything a stair owns. */
export function stairClearance(stair) {
  const { w, h } = stairSize(stair), t = WALL_THICKNESS;
  return { x: stair.x - t, y: stair.y - t, w: w + 2 * t, h: h + 2 * t };
}

function landingDepth(stair) {
  return stair.landingDepth || DEFAULT_LANDING_DEPTH;
}

/** Length of one flight: half a straight stair, or a return stair minus its landing. */
export function stairFlightLength(stair) {
  return stair.type === 'straight' ? stair.length / 2 : stair.length - landingDepth(stair);
}

/** Where a return stair's lower lane ends and its upper lane begins (across v). */
export function returnLanes(stair) {
  const lane = Math.floor((stair.width - WALL_THICKNESS) / 2);
  return { lane, upperLane: lane + WALL_THICKNESS };
}

/**
 * The floor-change line in stair-local coordinates: the line `axis` = `at`, crossable
 * where the other coordinate lies between `from` and `to`.
 */
export function stairCrossing(stair) {
  return stair.type === 'straight'
    ? { axis: 'u', at: stair.length / 2, from: 0, to: stair.width }
    : { axis: 'v', at: stair.width / 2, from: stairFlightLength(stair), to: stair.length };
}

export function isStairGridAligned(stair) {
  if (['x', 'y', 'width', 'length'].some(key => stair[key] % GRID)) return false;
  // Each half of a straight flight, each return lane and the landing must be whole cells.
  if (stair.type === 'straight') return stair.length % (2 * GRID) === 0;
  return (stair.width - WALL_THICKNESS) % (2 * GRID) === 0 && landingDepth(stair) % GRID === 0;
}

// ---------------------------------------------------------------------------
// Which pixels belong to which part of a stair, as seen from one of its floors

function insideFootprint(stair, u, v) {
  return u >= 0 && u < stair.length && v >= 0 && v < stair.width;
}

/** The flight (plus a rail-width apron at its entrance) and landing half this floor walks on. */
function isWalkway(stair, floor, u, v) {
  const t = WALL_THICKNESS;
  if (stair.type === 'straight') {
    const half = stair.length / 2, across = v >= 0 && v < stair.width;
    return across && (floor === stair.lower ? u >= -t && u < half : u >= half && u < stair.length + t);
  }
  const run = stairFlightLength(stair), { lane, upperLane } = returnLanes(stair), middle = stair.width / 2;
  const onFlight = u >= -t && u < run, onLanding = u >= run && u < stair.length;
  return floor === stair.lower
    ? (onFlight && v >= 0 && v < lane) || (onLanding && v >= 0 && v < middle)
    : (onFlight && v >= upperLane && v < stair.width) || (onLanding && v >= middle && v < stair.width);
}

/** A strip of floor either side of the crossing line, cleared on both floors. */
function isSeam(stair, u, v) {
  const line = stairCrossing(stair);
  const across = line.axis === 'u' ? u : v, along = line.axis === 'u' ? v : u;
  return along >= line.from && along < line.to && Math.abs(across - line.at) < SEAM_HALF_WIDTH;
}

/**
 * Generated transparent rails: side rails along both long edges, plus end caps.
 * A straight stair caps each floor where its half of the flight ends (the far end on
 * the lower floor, the near end on the upper floor). A return stair caps the far end,
 * caps the near end except for this floor's own lane, and has the divider between lanes.
 */
function isRail(stair, floor, u, v) {
  const t = WALL_THICKNESS;
  const across = v >= 0 && v < stair.width;
  const beyondFarEnd = u >= stair.length && u < stair.length + t;
  const beforeNearEnd = u >= -t && u < 0;
  const sideRail = u >= -t && u < stair.length + t && ((v >= -t && v < 0) || (v >= stair.width && v < stair.width + t));
  if (stair.type === 'straight') {
    // Each floor is capped where its half of the flight ends.
    return sideRail || (across && (floor === stair.lower ? beyondFarEnd : beforeNearEnd));
  }
  const { lane, upperLane } = returnLanes(stair);
  const ownEntrance = floor === stair.lower ? v >= 0 && v < lane : v >= upperLane && v < stair.width;
  const divider = u >= 0 && u < stairFlightLength(stair) && v >= lane && v < upperLane;
  return sideRail || (beyondFarEnd && across) || (beforeNearEnd && across && !ownEntrance) || divider;
}

/** Visit every in-bounds pixel of the stair's clearance box with its stair-local centre. */
function forEachStairPixel(map, stair, visit) {
  const box = stairClearance(stair);
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      visit(y * map.width + x, worldToStair(stair, x + 0.5, y + 0.5));
    }
  }
}

/**
 * Stamp a stair onto both of its floors: clear the walkway and seam to floor, then draw
 * the transparent rails.
 *   boundaryOnly:     only draw rails (used when upgrading older saves)
 *   preserveExisting: only draw rails over floor, keeping hand-painted walls and doors
 */
export function rasterizeStair(map, stair, { boundaryOnly = false, preserveExisting = false } = {}) {
  for (const floor of [stair.lower, stair.upper]) {
    const pixels = map.floors[floor].pixels;
    forEachStairPixel(map, stair, (i, { u, v }) => {
      // On grid-aligned maps the whole footprint is cleared, so no partial cells remain.
      const open = isWalkway(stair, floor, u, v) || (map.gridSize === GRID && insideFootprint(stair, u, v)) || isSeam(stair, u, v);
      if (open && !boundaryOnly) pixels[i] = MATERIAL.FLOOR;
      if (isRail(stair, floor, u, v) && (!preserveExisting || pixels[i] === MATERIAL.FLOOR)) pixels[i] = MATERIAL.TRANSPARENT;
    });
  }
}

/** Remove the stair's generated rails (transparent pixels where rails belong) before resizing it. */
export function clearGeneratedStairBoundary(map, stair) {
  for (const floor of [stair.lower, stair.upper]) {
    const pixels = map.floors[floor].pixels;
    forEachStairPixel(map, stair, (i, { u, v }) => {
      if (isRail(stair, floor, u, v) && pixels[i] === MATERIAL.TRANSPARENT) pixels[i] = MATERIAL.FLOOR;
    });
  }
}

// ---------------------------------------------------------------------------
// Editing

function isEvenOrMultipleOf3(n) {
  return n % 2 === 0 || n % 3 === 0;
}

export function validateStair(map, stair, others = map.stairs) {
  const integerKeys = ['x', 'y', 'length', 'width', 'rotation', 'lower', 'upper'];
  const wellFormed = stair
    && ['straight', 'return'].includes(stair.type)
    && integerKeys.every(key => Number.isInteger(stair[key]))
    && ROTATIONS.includes(stair.rotation)
    && stair.length >= 16 && stair.length <= 66 && isEvenOrMultipleOf3(stair.length)
    && stair.width >= 6 && stair.width <= 40 && isEvenOrMultipleOf3(stair.width)
    && stair.lower >= 0 && stair.upper === stair.lower + 1 && stair.upper < map.floors.length;
  if (!wellFormed) throw new Error('Invalid stair geometry or connected floors.');

  if (stair.type === 'return' && (stair.width < 14 || stair.length < 24)) {
    throw new Error('Return stairs need room for two flights and a landing.');
  }
  if (map.gridSize === GRID && !isStairGridAligned(stair)) {
    throw new Error('Stairs must align to the 3 × 3 grid, with complete half-floor flights.');
  }

  const clearance = stairClearance(stair);
  for (const chair of map.chairs || []) {
    const chairBox = { x: chair.x, y: chair.y, w: CHAIR_SIZE, h: CHAIR_SIZE };
    if (connectsFloor(stair, chair.floor) && boxesOverlap(clearance, chairBox)) {
      throw new Error('Keep stair footprints clear of chairs.');
    }
  }
  const insideCanvas = clearance.x >= 0 && clearance.y >= 0
    && clearance.x + clearance.w <= map.width && clearance.y + clearance.h <= map.height;
  if (!insideCanvas) throw new Error('Keep the entire stair footprint inside the canvas.');

  for (const other of others) {
    const sharesFloor = connectsFloor(other, stair.lower) || connectsFloor(other, stair.upper);
    if (other === stair || !sharesFloor) continue;
    if (boxesOverlap(clearance, stairClearance(other))) {
      throw new Error('Leave space between stair footprints on connected floors.');
    }
  }
}

export function addStair(map, stair) {
  ensureMap(map);
  validateStair(map, stair);
  const added = { ...stair };
  map.stairs.push(added);
  rasterizeStair(map, added);
}

/** Delete a stair and clear everything it owned to floor on both of its floors. */
export function removeStair(map, id) {
  const stair = map.stairs.find(s => s.id === id);
  if (!stair) return;
  const box = stairClearance(stair);
  for (const floor of [stair.lower, stair.upper]) {
    fillRect(map.floors[floor].pixels, map.width, map.height, box.x, box.y, box.w, box.h, MATERIAL.FLOOR);
  }
  map.stairs = map.stairs.filter(s => s.id !== id);
}

// ---------------------------------------------------------------------------
// Moving on stairs

/**
 * If moving from `from` to `to` crosses the stair's floor-change line in the direction
 * that leaves `floor`, with the explorer's body fully inside the crossable span, return
 * the floor the explorer arrives on. Otherwise return null.
 */
export function stairCrossingTarget(stair, floor, from, to, radius) {
  const a = worldToStair(stair, from.x, from.y), b = worldToStair(stair, to.x, to.y);
  const line = stairCrossing(stair), along = line.axis === 'u' ? 'v' : 'u';
  const before = a[line.axis] - line.at, after = b[line.axis] - line.at;
  const rising = floor === stair.lower;
  const crosses = rising ? before <= 0 && after > 0 : before >= 0 && after < 0;
  if (!crosses) return null;
  const t = -before / (after - before);
  const position = a[along] + (b[along] - a[along]) * t;
  if (position < line.from + radius || position > line.to - radius) return null;
  return rising ? stair.upper : stair.lower;
}

/**
 * Whether a movement segment on `floor` climbs ('up') or descends ('down') this stair's
 * flight, or null for level movement (off the stair, on the landing, or sideways).
 * `endFloor` is the floor at the end of the segment.
 */
export function stairFlightDirection(stair, floor, endFloor, from, to) {
  const a = worldToStair(stair, from.x, from.y), b = worldToStair(stair, to.x, to.y);
  const u = (a.u + b.u) / 2, v = (a.v + b.v) / 2, du = b.u - a.u;
  if (!insideFootprint(stair, u, v) || Math.abs(du) < 1e-8) return null;

  if (stair.type === 'straight') {
    // Without a floor change, the segment must start on this floor's own half.
    const startsOnOtherHalf = floor === stair.lower ? a.u >= stair.length / 2 : a.u < stair.length / 2;
    if (floor === endFloor && startsOnOtherHalf) return null;
    return du > 0 ? 'up' : 'down';
  }

  if (u >= stairFlightLength(stair)) return null;
  const laneEdge = (stair.width - WALL_THICKNESS) / 2;
  if (floor === stair.lower && v < laneEdge) return du > 0 ? 'up' : 'down';
  // The upper flight climbs back towards u = 0.
  if (floor === stair.upper && v >= laneEdge + WALL_THICKNESS) return du < 0 ? 'up' : 'down';
  return null;
}
