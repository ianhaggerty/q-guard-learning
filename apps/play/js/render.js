// Draws a room: the floor the player is on, with open doors, stairs and chairs, every
// explorer on that floor with its view cone, and events spotted in the last moments.
// The map is decoded and its doors grouped exactly as the room server does, so the
// server's door indices line up with ours.

import {
  CHAIR_SIZE, COLORS, EXPLORER_RADIUS, FIELD_OF_VIEW, MATERIAL, RGB,
  alignGrid, connectsFloor, decodeMap, groupDoors, stairCrossing, stairToWorld,
} from '@pixel-map-lab/core';

/** Explorer colours, handed out in the order explorers are first seen. */
const EXPLORER_COLORS = ['#e9ef89', '#78c6c0', '#dda457', '#a893db', '#e48f8f', '#8fb7e4', '#9fd19a', '#d9a4cf'];

/** Smallest on-screen sizes, in screen pixels, so explorers stay visible on large maps. */
const MIN_BODY_RADIUS = 7, MIN_CONE_RADIUS = 70;

/** Radius of the drawn view cone in map pixels: a hint of direction, not the detection range. */
const CONE_RADIUS = 14;

const STAIR_FILL = '#71876b33', STAIR_LINE = '#a893db', CHAIR_SEAT = '#c49a62', SPOT = '#dda457';

export class RoomView {
  constructor(canvas, savedMap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = alignGrid(decodeMap(savedMap));
    const { width, height } = this.map;
    this.doorGroups = this.map.floors.map(floor => groupDoors({ width, height, pixels: floor.pixels }));
    this.raster = document.createElement('canvas');
    this.raster.width = width;
    this.raster.height = height;
    this.rasterKey = null;
    this.colors = new Map();
  }

  colorFor(id) {
    if (!this.colors.has(id)) this.colors.set(id, EXPLORER_COLORS[this.colors.size % EXPLORER_COLORS.length]);
    return this.colors.get(id);
  }

  /** Paint `floor`'s materials, showing its open doors as floor. */
  paintRaster(floor, openDoors) {
    const key = floor + ':' + openDoors.join(',');
    if (key === this.rasterKey) return;
    this.rasterKey = key;
    const { pixels } = this.map.floors[floor], { ids } = this.doorGroups[floor], open = new Set(openDoors);
    const context = this.raster.getContext('2d'), image = context.createImageData(this.map.width, this.map.height);
    for (let i = 0; i < pixels.length; i++) {
      const material = pixels[i] === MATERIAL.DOOR && open.has(ids[i]) ? MATERIAL.FLOOR : pixels[i];
      image.data.set(RGB[material], i * 4);
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }

  /**
   * Draw one frame. `explorers` are the (interpolated) explorers, `floor` the floor to show,
   * `openDoors[floor]` its open door indices, `spots` recently spotted events, `selfId` the player.
   */
  draw({ explorers, floor, openDoors, spots, selfId }) {
    const { canvas, ctx, map } = this;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.paintRaster(floor, openDoors[floor] || []);

    const scale = Math.min(width / map.width, height / map.height) * 0.94;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, scale, (width - map.width * scale) / 2, (height - map.height * scale) / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = COLORS[MATERIAL.FLOOR];
    ctx.fillRect(0, 0, map.width, map.height);
    ctx.drawImage(this.raster, 0, 0);

    for (const stair of map.stairs) if (connectsFloor(stair, floor)) this.drawStair(stair);
    for (const chair of map.chairs) {
      if (chair.floor !== floor) continue;
      ctx.fillStyle = CHAIR_SEAT;
      ctx.fillRect(chair.x, chair.y, CHAIR_SIZE, CHAIR_SIZE);
    }
    for (const spot of spots) {
      if (spot.floor !== floor) continue;
      ctx.beginPath();
      ctx.strokeStyle = SPOT;
      ctx.lineWidth = 0.8;
      ctx.arc(spot.x, spot.y, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    const here = explorers.filter(explorer => explorer.floor === floor);
    for (const explorer of here) this.drawCone(explorer, Math.max(CONE_RADIUS, MIN_CONE_RADIUS / scale));
    for (const explorer of here) this.drawExplorer(explorer, explorer.id === selfId, scale);
  }

  /** The stair's footprint and its floor-change line. */
  drawStair(stair) {
    const { ctx } = this, corners = [[0, 0], [stair.length, 0], [stair.length, stair.width], [0, stair.width]];
    ctx.beginPath();
    corners.forEach(([u, v], k) => {
      const point = stairToWorld(stair, u, v);
      if (k) ctx.lineTo(point.x, point.y);
      else ctx.moveTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fillStyle = STAIR_FILL;
    ctx.fill();
    const line = stairCrossing(stair);
    const [a, b] = line.axis === 'u'
      ? [stairToWorld(stair, line.at, line.from), stairToWorld(stair, line.at, line.to)]
      : [stairToWorld(stair, line.from, line.at), stairToWorld(stair, line.to, line.at)];
    ctx.beginPath();
    ctx.strokeStyle = STAIR_LINE;
    ctx.lineWidth = 1;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  drawCone(explorer, radius) {
    const { ctx } = this, angle = explorer.facing * Math.PI / 4, half = FIELD_OF_VIEW * Math.PI / 360;
    const gradient = ctx.createRadialGradient(explorer.x, explorer.y, 0, explorer.x, explorer.y, radius);
    gradient.addColorStop(0, this.colorFor(explorer.id) + '66');
    gradient.addColorStop(1, this.colorFor(explorer.id) + '00');
    ctx.beginPath();
    ctx.moveTo(explorer.x, explorer.y);
    ctx.arc(explorer.x, explorer.y, radius, angle - half, angle + half);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  drawExplorer(explorer, isSelf, scale) {
    const { ctx } = this, { x, y } = explorer, angle = explorer.facing * Math.PI / 4;
    const radius = Math.max(EXPLORER_RADIUS, MIN_BODY_RADIUS / scale);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = this.colorFor(explorer.id);
    ctx.fill();
    ctx.lineWidth = (isSelf ? 2.5 : 1.2) / scale;
    ctx.strokeStyle = '#263d36';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * radius * 1.6, y + Math.sin(angle) * radius * 1.6);
    ctx.stroke();
    ctx.font = `${12 / scale}px "DM Sans", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#263d36';
    ctx.fillText(isSelf ? 'You' : explorer.name, x, y - radius - 5 / scale);
  }
}
