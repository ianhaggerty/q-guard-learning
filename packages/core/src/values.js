// Per-pixel numeric values. Each material has a default value; any pixel can be given a
// custom value that survives repainting. Values only weight event arrivals: they never
// affect movement, sight or energy.

import { MATERIAL } from './materials.js';
import { GRID } from './scale.js';
import { snap } from './grid.js';

export function defaultValue(material) {
  return material === MATERIAL.FLOOR ? 1 : 0;
}

export function valueAt(map, x, y, floor = map.activeFloor) {
  const level = map.floors[floor], i = Math.floor(y) * map.width + Math.floor(x);
  return level.valueOverrides?.[i] ?? defaultValue(level.pixels[i]);
}

export function hasCustomValue(level, index) {
  return Object.hasOwn(level.valueOverrides || {}, index);
}

/** The cell-aligned rectangle on the active floor spanned by points a and b. */
export function selectionRect(map, a, b) {
  const x = Math.max(0, snap(Math.min(a.x, b.x)));
  const y = Math.max(0, snap(Math.min(a.y, b.y)));
  const right = Math.min(map.width, snap(Math.max(a.x, b.x)) + GRID);
  const bottom = Math.min(map.height, snap(Math.max(a.y, b.y)) + GRID);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y), floor: map.activeFloor };
}

/**
 * Give every pixel in a selection a custom value, or restore material defaults when
 * `value` is null. Returns the number of pixels changed.
 */
export function assignValue(map, selection, value = null) {
  if (value !== null && !Number.isFinite(value)) throw new Error('Enter a finite numeric value.');
  const { x, y, w, h, floor } = selection;
  const aligned = [x, y, w, h].every(n => Number.isInteger(n) && n % GRID === 0);
  const inside = x >= 0 && y >= 0 && w >= GRID && h >= GRID && x + w <= map.width && y + h <= map.height;
  if (!Number.isInteger(floor) || !map.floors[floor] || !aligned || !inside) {
    throw new Error('Select a rectangle on the 3 × 3 grid.');
  }
  const level = map.floors[floor];
  if (!level.valueOverrides) level.valueOverrides = {};
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const i = row * map.width + col;
      if (value === null) delete level.valueOverrides[i];
      else level.valueOverrides[i] = value;
    }
  }
  return w * h;
}

/** Pixel count, value range and number of custom values in a selection. */
export function valueSummary(map, selection) {
  const level = map.floors[selection.floor];
  let min = Infinity, max = -Infinity, custom = 0;
  for (let y = selection.y; y < selection.y + selection.h; y++) {
    for (let x = selection.x; x < selection.x + selection.w; x++) {
      const value = valueAt(map, x, y, selection.floor);
      min = Math.min(min, value);
      max = Math.max(max, value);
      if (hasCustomValue(level, y * map.width + x)) custom++;
    }
  }
  return { count: selection.w * selection.h, min, max, custom };
}
