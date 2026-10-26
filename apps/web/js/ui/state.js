// State shared by the UI modules. There is one map, one mode and at most one Explore
// session at a time; modules read and update these fields directly.

import { GRID, MATERIAL } from '@pixel-map-lab/core';

export const state = {
  /** The building being edited. Set at startup; replaced on undo/redo, new maps and imports. */
  map: null,
  /** 'build' (editing) or 'explore' (walking around as the explorer). */
  mode: 'build',
  /** The Explore session (a core World) while exploring. */
  world: null,

  material: MATERIAL.OPAQUE,
  tool: 'brush',
  brushSize: GRID,

  /** The pointer gesture in progress: { kind: 'pan' | 'stroke' | 'value', … }. */
  drag: null,
  /** Map coordinates under the pointer, or null when it is off the map. */
  hover: null,
  /** Space + drag pans the canvas. */
  spaceHeld: false,

  selectedStairId: null,
  selectedChairId: null,
  /** Index of the start being moved; null means clicking adds a new start. */
  selectedStartIndex: null,
  /** Rectangle chosen with the Set values tool. */
  valueSelection: null,
  /** Which numbered start Explore begins from. */
  exploreStartIndex: 0,

  /** The active floor's raster needs redrawing before the next frame. */
  rasterStale: true,
  /** Timestamp of the last animation frame, for frame-time deltas. */
  lastFrameTime: performance.now(),
};

/** Canvas transform: screen position = map position × zoom + offset. */
export const view = { zoom: 1, offsetX: 0, offsetY: 0, fitToScreen: true };

export function isExploring() {
  return state.mode === 'explore';
}

export function clearSelections() {
  state.selectedStairId = null;
  state.selectedChairId = null;
  state.selectedStartIndex = null;
  state.valueSelection = null;
}

export function invalidateRaster() {
  state.rasterStale = true;
}
