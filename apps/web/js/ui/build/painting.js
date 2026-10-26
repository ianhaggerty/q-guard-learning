// Brush, line, rectangle, fill and eraser strokes on the active floor. A stroke is one
// undo step, however long the drag.

import { brushBounds, eraseAt, floodFill, gridLine, gridRect, paintGrid } from '../../core/index.js';
import { state, invalidateRaster } from '../state.js';
import { byId, pluralize, toast } from '../dom.js';
import { commitEdit, rememberForUndo } from '../document.js';
import { syncFloors } from './floors.js';
import { resetStairHint } from './stairs.js';

const isFreehand = () => state.tool === 'brush' || state.tool === 'erase';

export function beginStroke(pixel) {
  rememberForUndo();
  // Line and rectangle previews redraw from the pixels as they were before the stroke.
  state.drag = { kind: 'stroke', start: pixel, last: pixel, before: state.map.pixels.slice(), erasedStairs: 0 };
  if (state.tool === 'fill') {
    floodFill(state.map.pixels, state.map.width, state.map.height, pixel.x, pixel.y, state.material);
    state.drag = null;
    commitEdit();
    return;
  }
  if (isFreehand()) stamp(pixel.x, pixel.y);
  else drawShape(pixel, pixel);
  invalidateRaster();
}

export function continueStroke(pixel) {
  const drag = state.drag;
  if (isFreehand()) {
    gridLine(drag.last, pixel, stamp);
  } else {
    state.map.pixels.set(drag.before);
    drawShape(drag.start, pixel);
  }
  drag.last = pixel;
  invalidateRaster();
}

export function finishStroke(drag) {
  commitEdit();
  if (drag.erasedStairs) {
    toast(`${pluralize(drag.erasedStairs, 'stairway')} removed from both connected floors. Undo to restore.`);
  }
}

/** One brush or eraser stamp centred on (x, y). */
function stamp(x, y) {
  if (state.tool !== 'erase') {
    paintGrid(state.map, x, y, state.brushSize, state.material);
    return;
  }
  const bounds = brushBounds(x, y, state.brushSize), half = Math.floor(bounds.size / 2);
  const removedStairs = eraseAt(state.map, bounds.x + half, bounds.y + half, bounds.size);
  if (!removedStairs.length) return;
  if (removedStairs.includes(state.selectedStairId)) state.selectedStairId = null;
  state.selectedChairId = null;
  state.selectedStartIndex = null;
  state.valueSelection = null;
  if (state.drag) state.drag.erasedStairs += removedStairs.length;
  syncFloors();
  resetStairHint();
}

function drawShape(a, b) {
  if (state.tool === 'line') gridLine(a, b, stamp);
  else gridRect(state.map, a, b, state.brushSize, state.material, byId('filledRect').checked);
}
