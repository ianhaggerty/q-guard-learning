// The Values overlay (one number per grid cell, custom cells tinted) and the Set values
// selection rectangle.

import { GRID, MATERIAL, hasCustomValue, valueAt } from '../../core/index.js';
import { state, view } from '../state.js';
import { byId } from '../dom.js';
import { ctx, isOnScreen } from '../viewport.js';

const CUSTOM_TINT = '#9a7cc048';
/** Numbers are only legible once cells are at least this many screen pixels wide. */
const NUMBERS_MIN_ZOOM = 3;

export function drawValues() {
  if (byId('valuesToggle').checked) drawValueOverlay();
  const selection = state.valueSelection;
  if (state.tool === 'value' && selection && selection.floor === state.map.activeFloor) {
    ctx.fillStyle = '#9a7cc01a';
    ctx.fillRect(selection.x, selection.y, selection.w, selection.h);
    ctx.strokeStyle = '#79539b';
    ctx.lineWidth = 1.5 / view.zoom;
    ctx.setLineDash([5 / view.zoom, 3 / view.zoom]);
    ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
    ctx.setLineDash([]);
  }
}

function drawValueOverlay() {
  const { map } = state, level = map.floors[map.activeFloor];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.min(2, 9 / view.zoom)}px sans-serif`;
  for (let y = 0; y < map.height; y += GRID) {
    for (let x = 0; x < map.width; x += GRID) {
      if (!isOnScreen(x, y, GRID, GRID)) continue;
      // A cell shows its top-left value, or "…" when its pixels disagree.
      const value = valueAt(map, x, y);
      let custom = false, mixed = false;
      for (let dy = 0; dy < GRID; dy++) {
        for (let dx = 0; dx < GRID; dx++) {
          if (hasCustomValue(level, (y + dy) * map.width + x + dx)) custom = true;
          if (valueAt(map, x + dx, y + dy) !== value) mixed = true;
        }
      }
      if (custom) {
        ctx.fillStyle = CUSTOM_TINT;
        ctx.fillRect(x, y, GRID, GRID);
      }
      if (view.zoom >= NUMBERS_MIN_ZOOM) {
        const onMass = map.pixels[y * map.width + x] === MATERIAL.OPAQUE;
        ctx.fillStyle = onMass ? (custom ? '#fff3bf' : '#dbe4d3') : (custom ? '#674182' : '#65715d');
        ctx.fillText(mixed ? '…' : String(value), x + GRID / 2, y + GRID / 2, 2.7);
      }
    }
  }
}
