// Draws one frame of the map canvas. The active floor's materials are cached in an
// offscreen raster; annotations and overlays are drawn on top in map coordinates.

import { COLORS, GRID, MATERIAL, RGB } from '@pixel-map-lab/core';
import { state, view, isExploring } from '../state.js';
import { byId } from '../dom.js';
import { ctx, viewportSize } from '../viewport.js';
import { drawChairs, drawStairs, drawStarts } from './objects.js';
import { drawValues } from './values.js';
import { drawEvents, drawExplorer, drawSight } from './explore.js';

/** The grid overlay is only drawn once cells are at least this many screen pixels wide. */
const GRID_MIN_ZOOM = 3;

const raster = document.createElement('canvas');
const rasterContext = raster.getContext('2d');

/** Paint the active floor's materials into the raster, showing open doors as floor while exploring. */
function rebuildRaster() {
  const { map, world } = state;
  raster.width = map.width;
  raster.height = map.height;
  const image = rasterContext.createImageData(map.width, map.height);
  for (let i = 0; i < map.pixels.length; i++) {
    let material = map.pixels[i];
    if (isExploring() && material === MATERIAL.DOOR && world.doors[world.doorIds[i]].open) material = MATERIAL.FLOOR;
    const [r, g, b] = RGB[material];
    image.data[i * 4] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = 255;
  }
  rasterContext.putImageData(image, 0, 0);
  state.rasterStale = false;
}

function drawSheet() {
  const { map } = state;
  ctx.save();
  ctx.shadowColor = '#263d361c';
  ctx.shadowBlur = 20 / view.zoom;
  ctx.shadowOffsetY = 5 / view.zoom;
  ctx.fillStyle = COLORS[MATERIAL.FLOOR];
  ctx.fillRect(0, 0, map.width, map.height);
  ctx.restore();
  ctx.drawImage(raster, 0, 0);
}

function drawGrid() {
  const { map } = state;
  ctx.beginPath();
  ctx.strokeStyle = '#263d3620';
  ctx.lineWidth = 0.5 / view.zoom;
  for (let x = 0; x <= map.width; x += GRID) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, map.height);
  }
  for (let y = 0; y <= map.height; y += GRID) {
    ctx.moveTo(0, y);
    ctx.lineTo(map.width, y);
  }
  ctx.stroke();
}

export function renderFrame() {
  if (state.rasterStale) rebuildRaster();
  const { width, height } = viewportSize();
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.zoom, view.zoom);
  drawSheet();
  if (byId('gridToggle').checked && view.zoom >= GRID_MIN_ZOOM && !isExploring()) drawGrid();
  drawStairs();
  drawChairs();
  if (isExploring()) {
    if (byId('sightToggle').checked) drawSight();
    drawEvents();
    drawExplorer();
  } else {
    drawValues();
    drawStarts();
  }
  ctx.restore();
}
