// Pointer input on the map canvas: panning in both modes, and the Build tools.

import { valueAt } from '../../core/index.js';
import { state, view, invalidateRaster, isExploring } from '../state.js';
import { byId, focusCanvas } from '../dom.js';
import { canvas, clampToMap, isOnMap, toMapPoint, toPixel, updateBrushCursor } from '../viewport.js';
import { beginStroke, continueStroke, finishStroke } from './painting.js';
import { beginValueSelection, extendValueSelection, finishValueSelection } from './values.js';
import { placeChair } from './chairs.js';
import { placeStair } from './stairs.js';
import { placeStart } from './starts.js';

const MIDDLE_BUTTON = 1, RIGHT_BUTTON = 2;

function onPointerDown(event) {
  if (event.button === RIGHT_BUTTON || event.button === MIDDLE_BUTTON || state.spaceHeld) {
    state.drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, offsetX: view.offsetX, offsetY: view.offsetY };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  focusCanvas();
  if (isExploring()) return;
  const point = toMapPoint(event);
  if (!isOnMap(point)) return;
  const pixel = toPixel(point);
  switch (state.tool) {
    case 'chair':
      placeChair(pixel);
      break;
    case 'stairs':
      placeStair(pixel);
      break;
    case 'starts':
      placeStart(pixel);
      break;
    case 'value':
      canvas.setPointerCapture(event.pointerId);
      beginValueSelection(pixel);
      break;
    default:
      canvas.setPointerCapture(event.pointerId);
      beginStroke(pixel);
  }
}

function onPointerMove(event) {
  const point = toMapPoint(event);
  state.hover = isOnMap(point) ? point : null;
  showPointerReadout(point);
  const drag = state.drag;
  if (drag?.kind === 'pan') {
    view.fitToScreen = false;
    view.offsetX = drag.offsetX + event.clientX - drag.startX;
    view.offsetY = drag.offsetY + event.clientY - drag.startY;
    invalidateRaster();
    return;
  }
  if (drag?.kind === 'value') {
    extendValueSelection(clampToMap(point));
    return;
  }
  if (drag?.kind === 'stroke') continueStroke(clampToMap(point));
  updateBrushCursor(point);
}

/** End the current drag, if any (also called when leaving Build mode or changing floor). */
export function endDrag() {
  const drag = state.drag;
  state.drag = null;
  if (drag?.kind === 'value') finishValueSelection();
  else if (drag?.kind === 'stroke') finishStroke(drag);
}

/** The status bar shows what is under the pointer: position and value, or detection odds when exploring. */
function showPointerReadout(point) {
  const { map, world } = state;
  let text = `${map.width} × ${map.height} pixels`;
  if (state.hover && isExploring()) {
    const unresolved = world.probabilities.probabilityAt(point.x, point.y, world.floorIndex) * 100;
    const detection = world.detectionAt(point.x, point.y) * 100;
    text = `Unresolved ${unresolved.toFixed(2)}% · Detection ${detection.toFixed(1)}%/s`;
  } else if (state.hover) {
    text = `x ${Math.floor(point.x)}  y ${Math.floor(point.y)} · value ${valueAt(map, point.x, point.y)} · ${map.width} × ${map.height}`;
  }
  byId('coordinates').textContent = text;
}

export function initPointer() {
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, endDrag);
  canvas.addEventListener('pointerleave', () => {
    state.hover = null;
    byId('brushCursor').hidden = true;
  });
}
