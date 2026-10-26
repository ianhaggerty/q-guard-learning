// The map canvas: device-pixel sizing, zoom, fit, and screen ↔ map coordinates.

import { brushBounds } from '../core/index.js';
import { state, view, invalidateRaster, isExploring } from './state.js';
import { byId } from './dom.js';

export const canvas = byId('mapCanvas');
export const ctx = canvas.getContext('2d');
const container = byId('viewport');

const MIN_ZOOM = 0.25, MAX_ZOOM = 32;
/** Space left around a fitted map for the overlays at the canvas edges. */
const FIT_MARGIN_X = 74, FIT_MARGIN_Y = 90;
const WHEEL_ZOOM_STEP = 1.12;

export function viewportSize() {
  return { width: container.clientWidth, height: container.clientHeight };
}

/** Centre the map at the largest zoom that fits, unless the user has zoomed or panned. */
export function fitView() {
  const { width, height } = viewportSize(), { map } = state;
  if (view.fitToScreen) {
    view.zoom = Math.max(MIN_ZOOM, Math.min((width - FIT_MARGIN_X) / map.width, (height - FIT_MARGIN_Y) / map.height));
    view.offsetX = (width - map.width * view.zoom) / 2;
    view.offsetY = (height - map.height * view.zoom) / 2;
  }
  showZoom();
  invalidateRaster();
}

/** Zoom by `factor`, keeping the screen point (x, y) fixed. Defaults to the centre. */
function zoomAt(factor, x = container.clientWidth / 2, y = container.clientHeight / 2) {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
  view.offsetX = x - (x - view.offsetX) * zoom / view.zoom;
  view.offsetY = y - (y - view.offsetY) * zoom / view.zoom;
  view.zoom = zoom;
  view.fitToScreen = false;
  showZoom();
  invalidateRaster();
}

function showZoom() {
  byId('zoomValue').textContent = Math.round(view.zoom * 100) + '%';
}

/** Match the canvas backing store to its CSS size at the device pixel ratio. */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1, { width, height } = viewportSize();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  fitView();
}

/** Map coordinates { x, y } and canvas-relative screen coordinates { screenX, screenY } of a pointer event. */
export function toMapPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  const screenX = event.clientX - bounds.left, screenY = event.clientY - bounds.top;
  return { x: (screenX - view.offsetX) / view.zoom, y: (screenY - view.offsetY) / view.zoom, screenX, screenY };
}

export function isOnMap(point) {
  return point.x >= 0 && point.y >= 0 && point.x < state.map.width && point.y < state.map.height;
}

export function toPixel(point) {
  return { x: Math.floor(point.x), y: Math.floor(point.y) };
}

/** The map pixel nearest to a point, which may be off the map. */
export function clampToMap(point) {
  return {
    x: Math.max(0, Math.min(state.map.width - 1, Math.floor(point.x))),
    y: Math.max(0, Math.min(state.map.height - 1, Math.floor(point.y))),
  };
}

/** Whether any part of the map rectangle is on screen. */
export function isOnScreen(x, y, w, h) {
  const { width, height } = viewportSize();
  const left = x * view.zoom + view.offsetX, top = y * view.zoom + view.offsetY;
  return (x + w) * view.zoom + view.offsetX >= 0 && left <= width && (y + h) * view.zoom + view.offsetY >= 0 && top <= height;
}

/** Outline the area the brush, eraser or line tool would paint at `point`. */
export function updateBrushCursor(point) {
  const cursor = byId('brushCursor');
  const show = !isExploring() && state.hover && ['brush', 'erase', 'line'].includes(state.tool) && !state.spaceHeld;
  cursor.hidden = !show;
  if (!show) return;
  const bounds = brushBounds(point.x, point.y, state.brushSize);
  cursor.style.width = state.brushSize * view.zoom + 'px';
  cursor.style.height = state.brushSize * view.zoom + 'px';
  cursor.style.left = bounds.x * view.zoom + view.offsetX + 'px';
  cursor.style.top = bounds.y * view.zoom + view.offsetY + 'px';
}

export function initViewport() {
  resizeCanvas();
  new ResizeObserver(resizeCanvas).observe(container);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const point = toMapPoint(event);
    zoomAt(event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP, point.screenX, point.screenY);
  }, { passive: false });
  byId('zoomIn').onclick = () => zoomAt(1.25);
  byId('zoomOut').onclick = () => zoomAt(0.8);
  byId('fitView').onclick = () => {
    view.fitToScreen = true;
    fitView();
  };
}
