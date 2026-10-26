// Shared test helpers.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeMap, normalizeMap } from '../packages/core/src/index.js';

/** A parsed JSON file from tests/fixtures/. */
export function readFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/**
 * A fresh copy of the two-floor courtyard the editor used to generate in code: straight
 * stair S1 at (78, 51), return stair S2 at (138, 90), chairs C1 and C2, one start.
 * Many tests rely on its exact layout, so it is a fixture rather than a user-editable plan.
 */
export function courtyard() {
  return decodeMap(readFixture('courtyard.json'));
}

/** An assertion that two numbers agree to within `tolerance` (overridable per call). */
export function within(tolerance) {
  return (actual, expected, limit = tolerance) => assert.ok(Math.abs(actual - expected) < limit, `${actual} != ${expected}`);
}

/** A deterministic linear congruential generator in [0, 1). */
export function seededRandom(seed = 10) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** A blank building with one empty floor per name. */
export function blankBuilding({ width, height, floorNames = ['Lower', 'Upper'], spawn, name = 'Test' }) {
  return normalizeMap({
    width,
    height,
    name,
    spawn,
    floors: floorNames.map(floorName => ({ name: floorName, pixels: new Uint8Array(width * height) })),
    stairs: [],
  });
}

/**
 * An 18 × 18 (or `size`) two-floor map on which every pixel has value 0, except the
 * listed [floor, x, y, value, material = floor] points. Used for event-weight tests.
 */
export function weightedMap(points = [], { size = 18, name = 'Events', spawn = { x: 4.5, y: 9.5, floor: 0 } } = {}) {
  const pixelCount = size * size;
  const zeroValues = () => Object.fromEntries(Array.from({ length: pixelCount }, (_, i) => [i, 0]));
  const map = normalizeMap({
    width: size,
    height: size,
    name,
    spawn,
    floors: [0, 1].map(i => ({ name: 'Floor ' + i, pixels: new Uint8Array(pixelCount), valueOverrides: zeroValues() })),
    stairs: [],
  });
  for (const [floor, x, y, value, material = 0] of points) {
    map.floors[floor].valueOverrides[y * size + x] = value;
    map.floors[floor].pixels[y * size + x] = material;
  }
  return map;
}

/** Index of the pixel containing a map point. */
export function pixelIndexAt(map, point) {
  return Math.floor(point.y) * map.width + Math.floor(point.x);
}
