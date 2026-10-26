// Per-pixel values: defaults, custom values, selections and persistence.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignGrid, assignValue, cloneMap, decodeMap, defaultValue, encodeMap, normalizeMap, paintGrid, selectionRect, toRGBA,
  valueAt, valueSummary,
} from '../dist/js/core/index.js';

/** A blank, grid-aligned 30 × 30 single-floor map. */
function blankMap() {
  return alignGrid(normalizeMap({ width: 30, height: 30, pixels: new Uint8Array(900), name: 'Values', spawn: { x: 4, y: 4 } }));
}

test('materials default to floor 1 and opaque, transparent and door 0', () => {
  const map = blankMap();
  for (const [material, value] of [[0, 1], [1, 0], [2, 0], [3, 0]]) {
    paintGrid(map, 6, 6, 3, material);
    assert.equal(valueAt(map, 6, 6), value);
    assert.equal(defaultValue(material), value);
  }
});

test('rectangle snaps in either direction and assigns every pixel of full grid cells', () => {
  const map = blankMap(), selection = selectionRect(map, { x: 14, y: 10 }, { x: 7, y: 5 });
  assert.deepEqual(selection, { x: 6, y: 3, w: 9, h: 9, floor: 0 });
  const materialsBefore = map.pixels.slice();
  assert.equal(assignValue(map, selection, 2.5), 81);
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 30; x++) assert.equal(valueAt(map, x, y), x >= 6 && x < 15 && y >= 3 && y < 12 ? 2.5 : 1);
  }
  assert.deepEqual(map.pixels, materialsBefore);
});

test('custom zero, negative and fractional values survive repainting, clone and JSON export', () => {
  const map = blankMap(), selection = selectionRect(map, { x: 6, y: 6 }, { x: 8, y: 8 });
  for (const value of [0, -3, 0.125]) {
    assignValue(map, selection, value);
    paintGrid(map, 6, 6, 3, 1);
    assert.equal(valueAt(map, 6, 6), value);
    const saved = encodeMap(map);
    assert.equal(saved.floors[0].values[186], value);
    assert.equal(saved.floors[0].valueOverrides[186], value);
    assert.equal(valueAt(decodeMap(saved), 6, 6), value);
    const copy = cloneMap(map);
    assignValue(copy, selection, 42);
    assert.equal(valueAt(map, 6, 6), value);
  }
});

test('reset restores defaults for each material and leaves custom pixels outside the rectangle', () => {
  const map = blankMap();
  assignValue(map, selectionRect(map, { x: 0, y: 0 }, { x: 29, y: 29 }), 8);
  for (const material of [0, 1, 2, 3]) paintGrid(map, material * 3, 0, 3, material);
  const selection = selectionRect(map, { x: 0, y: 0 }, { x: 11, y: 2 });
  assignValue(map, selection, null);
  for (const material of [0, 1, 2, 3]) assert.equal(valueAt(map, material * 3, 0), defaultValue(material));
  assert.equal(valueAt(map, 12, 0), 8);
  assert.equal(valueSummary(map, selection).custom, 0);
});

test('selected values affect only their own floor and snapshots restore values and materials together', () => {
  const map = blankMap();
  map.floors.push({ name: 'Upper', pixels: new Uint8Array(900) });
  const selection = selectionRect(map, { x: 6, y: 6 }, { x: 11, y: 11 }), before = cloneMap(map);
  assignValue(map, selection, 4);
  map.activeFloor = 1;
  assert.equal(valueAt(map, 6, 6), 1);
  assert.equal(valueAt(map, 6, 6, 0), 4);
  assignValue(map, selectionRect(map, { x: 6, y: 6 }, { x: 11, y: 11 }), -1);
  const after = cloneMap(map);
  assert.equal(valueAt(before, 6, 6, 0), 1);
  assert.equal(valueAt(after, 6, 6, 0), 4);
  assert.equal(valueAt(after, 6, 6, 1), -1);
});

test('mixed selection reports custom count and min/max, even when a custom value equals the default', () => {
  const map = blankMap(), selection = selectionRect(map, { x: 0, y: 0 }, { x: 5, y: 2 });
  paintGrid(map, 3, 0, 3, 1);
  assignValue(map, { x: 0, y: 0, w: 3, h: 3, floor: 0 }, 1);
  assert.deepEqual(valueSummary(map, selection), { count: 18, min: 0, max: 1, custom: 9 });
});

test('legacy JSON without values acquires dynamic defaults and PNG materials are unaffected', () => {
  const map = blankMap();
  paintGrid(map, 0, 0, 3, 2);
  const saved = encodeMap(map);
  delete saved.floors[0].values;
  delete saved.floors[0].valueOverrides;
  const restored = decodeMap(saved);
  assert.equal(valueAt(restored, 0, 0), 0);
  assert.equal(valueAt(restored, 6, 6), 1);
  const png = toRGBA(restored);
  assignValue(restored, selectionRect(restored, { x: 0, y: 0 }, { x: 29, y: 29 }), 15);
  assert.deepEqual(toRGBA(restored), png);
});

test('legacy grid padding reindexes custom pixel values without changing their coordinates', () => {
  const map = normalizeMap({ width: 31, height: 32, name: 'Old', pixels: new Uint8Array(31 * 32), spawn: { x: 4, y: 4 } });
  map.floors[0].valueOverrides[5 * 31 + 8] = 7;
  alignGrid(map);
  assert.equal(map.width, 33);
  assert.equal(valueAt(map, 8, 5), 7);
  assert.equal(valueAt(map, 7, 5), 1);
  assert.equal(valueAt(map, 32, 32), 1);
});

test('reject invalid numbers, malformed value arrays, override keys and unaligned rectangles', () => {
  const map = blankMap(), selection = selectionRect(map, { x: 0, y: 0 }, { x: 2, y: 2 });
  for (const value of [NaN, Infinity, -Infinity, '2']) assert.throws(() => assignValue(map, selection, value));
  for (const bad of [{ ...selection, x: 1 }, { ...selection, w: 0 }, { ...selection, floor: 2 }]) assert.throws(() => assignValue(map, bad, 1));
  for (const values of [[0], new Array(900).fill(null), new Array(900).fill(Infinity)]) {
    const saved = encodeMap(map);
    saved.floors[0].values = values;
    assert.throws(() => decodeMap(saved));
  }
  for (const overrides of [{ 900: 3 }, { '-1': 3 }, { '01': 3 }, { 0: NaN }, []]) {
    const saved = encodeMap(map);
    saved.floors[0].valueOverrides = overrides;
    assert.throws(() => decodeMap(saved));
  }
});

test('value arrays from imports without override metadata retain differing pixel values', () => {
  const saved = encodeMap(blankMap());
  delete saved.floors[0].valueOverrides;
  saved.floors[0].values[0] = -4;
  const map = decodeMap(saved);
  assert.equal(valueAt(map, 0, 0), -4);
  assert.equal(valueAt(map, 1, 0), 1);
});
