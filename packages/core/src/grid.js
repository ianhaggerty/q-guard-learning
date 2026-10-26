// Drawing on the 3 × 3 grid. Every editor tool paints whole cells, so floors stay grid-aligned.

import { GRID } from './scale.js';
import { fillRect, traceLine } from './raster.js';

/** Round a pixel coordinate down to the start of its grid cell. */
export function snap(n) {
  return Math.floor(n / GRID) * GRID;
}

/** The square, cell-aligned area a brush of `size` pixels covers when centred on (x, y). */
export function brushBounds(x, y, size = GRID) {
  size = Math.max(GRID, Math.ceil(size / GRID) * GRID);
  const offset = Math.floor((size / GRID - 1) / 2) * GRID;
  return { x: snap(x) - offset, y: snap(y) - offset, size };
}

/** Paint a brush stamp on the active floor. */
export function paintGrid(map, x, y, size, value) {
  const bounds = brushBounds(x, y, size);
  fillRect(map.pixels, map.width, map.height, bounds.x, bounds.y, bounds.size, bounds.size, value);
}

/** Visit the top-left pixel of every cell on the line between the cells containing a and b. */
export function gridLine(a, b, visit) {
  const cellA = { x: snap(a.x) / GRID, y: snap(a.y) / GRID };
  const cellB = { x: snap(b.x) / GRID, y: snap(b.y) / GRID };
  traceLine(cellA, cellB, (x, y) => visit(x * GRID, y * GRID));
}

/**
 * Draw the cell-aligned rectangle spanned by corners a and b on the active floor:
 * filled, or as an outline whose thickness is the brush size.
 */
export function gridRect(map, a, b, size, value, filled = false) {
  const x = snap(Math.min(a.x, b.x)), y = snap(Math.min(a.y, b.y));
  const w = snap(Math.max(a.x, b.x)) - x + GRID, h = snap(Math.max(a.y, b.y)) - y + GRID;
  const fill = (rx, ry, rw, rh) => fillRect(map.pixels, map.width, map.height, rx, ry, rw, rh, value);
  if (filled) {
    fill(x, y, w, h);
    return;
  }
  const thickness = Math.max(GRID, Math.ceil(size / GRID) * GRID);
  const horizontal = Math.min(thickness, h), vertical = Math.min(thickness, w);
  fill(x, y, w, horizontal);
  fill(x, y + h - horizontal, w, horizontal);
  fill(x, y, vertical, h);
  fill(x + w - vertical, y, vertical, h);
}
