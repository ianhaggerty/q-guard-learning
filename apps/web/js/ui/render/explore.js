// Explore overlays: the detection-probability light cone, event markers and the explorer.

import {
  DIRECTIONS, FIELD_OF_VIEW, METRES_PER_PIXEL, detectionChance, eccentricityDegrees, headingVector,
} from '../../core/index.js';
import { state, view } from '../state.js';
import { byId } from '../dom.js';
import { ctx } from '../viewport.js';

// ---------------------------------------------------------------------------
// Sight: a dark fog with a hole whose brightness is the one-second detection chance,
// cut off by rays that stop at opaque mass and closed doors. Cached until the pose changes.

const fog = document.createElement('canvas'), fogContext = fog.getContext('2d');
const light = document.createElement('canvas'), lightContext = light.getContext('2d');
let cachedWorld = null, cachedPose = '';

export function drawSight() {
  const { world } = state, player = world.player;
  const pose = [player.x, player.y, world.floorIndex, world.facing, world.detectionHalfRange, ...world.doors.map(door => +door.open)].join(':');
  if (cachedWorld !== world || cachedPose !== pose) {
    cachedWorld = world;
    cachedPose = pose;
    renderSight();
  }
  ctx.drawImage(fog, 0, 0);
}

function renderSight() {
  const { map, world } = state, player = world.player;
  fog.width = light.width = map.width;
  fog.height = light.height = map.height;

  // Brightness: detection chance at every pixel centre, ignoring walls.
  const heading = headingVector(world.facing), image = lightContext.createImageData(map.width, map.height);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const dx = x + 0.5 - player.x, dy = y + 0.5 - player.y, distance = Math.hypot(dx, dy);
      const eccentricity = distance ? eccentricityDegrees(dx, dy, heading) : 0;
      const i = (y * map.width + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(255 * detectionChance(distance * METRES_PER_PIXEL, eccentricity, world.detectionHalfRange));
    }
  }
  lightContext.putImageData(image, 0, 0);

  // Occlusion: keep only the area reached by rays cast across the field of view.
  // Rays stop at the map edge or the first view-blocking pixel; there is no range limit.
  const facingAngle = world.facing * Math.PI / 4, halfField = FIELD_OF_VIEW * Math.PI / 360;
  const diagonal = Math.hypot(map.width, map.height);
  const maxSteps = Math.ceil(diagonal * 2) + 2, rays = Math.max(640, Math.ceil(diagonal * 4));
  lightContext.globalCompositeOperation = 'destination-in';
  lightContext.fillStyle = '#fff';
  lightContext.beginPath();
  lightContext.moveTo(player.x, player.y);
  for (let i = 0; i <= rays; i++) {
    const angle = facingAngle - halfField + i / rays * halfField * 2;
    const stepX = Math.cos(angle) * 0.5, stepY = Math.sin(angle) * 0.5;
    let x = player.x, y = player.y;
    for (let step = 0; step < maxSteps; step++) {
      x += stepX;
      y += stepY;
      if (world.blocksSight(x, y)) break;
    }
    lightContext.lineTo(x, y);
  }
  lightContext.closePath();
  lightContext.fill();
  lightContext.globalCompositeOperation = 'source-over';

  fogContext.fillStyle = '#152b28f2';
  fogContext.fillRect(0, 0, map.width, map.height);
  fogContext.globalCompositeOperation = 'destination-out';
  fogContext.drawImage(light, 0, 0);
  fogContext.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------------------
// Events: pulsing amber diamonds for active events on this floor (an observer overlay,
// independent of what the explorer has seen) and a fading green ring when one is spotted.

const RESOLUTION_EFFECT_SECONDS = 1.8;

export function drawEvents() {
  const { world } = state, events = world.events;
  ctx.save();
  if (byId('eventObserver').checked) {
    for (const event of events.active) {
      if (event.floor === world.floorIndex) drawActiveEvent(event, events.elapsed);
    }
  }
  for (const event of events.resolvedFx) {
    if (event.floor !== world.floorIndex) continue;
    const progress = Math.max(0, events.elapsed - event.resolvedAt) / RESOLUTION_EFFECT_SECONDS;
    ctx.globalAlpha = 1 - progress;
    ctx.strokeStyle = '#63d9b0';
    ctx.lineWidth = 1.8 / view.zoom;
    ctx.beginPath();
    ctx.arc(event.x, event.y, 1.8 + 4 * progress, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#bfffe3';
    ctx.font = 'bold 3px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✓', event.x, event.y - 1 - 3 * progress);
  }
  ctx.restore();
}

function drawActiveEvent(event, now) {
  const pulse = 1 + 0.18 * Math.sin((now - event.born) * 5);
  ctx.save();
  ctx.translate(event.x, event.y);
  ctx.scale(pulse, pulse);
  ctx.beginPath();
  ctx.moveTo(0, -1.6);
  ctx.lineTo(1.6, 0);
  ctx.lineTo(0, 1.6);
  ctx.lineTo(-1.6, 0);
  ctx.closePath();
  ctx.fillStyle = '#f5ab51';
  ctx.fill();
  ctx.strokeStyle = '#673816';
  ctx.lineWidth = 0.65 / view.zoom;
  ctx.stroke();
  ctx.fillStyle = '#452d18';
  ctx.font = 'bold 2px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The explorer: body (blue while seated), a ring, a facing marker and compass label.

export function drawExplorer() {
  const { world } = state, { x, y } = world.player;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, world.radius, 0, Math.PI * 2);
  ctx.fillStyle = world.sitting ? '#9fd8eb' : '#e9ef89';
  ctx.fill();
  ctx.lineWidth = 1 / view.zoom;
  ctx.strokeStyle = '#263d36';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 2.8, 0, Math.PI * 2);
  ctx.strokeStyle = '#e9ef8970';
  ctx.lineWidth = 0.6 / view.zoom;
  ctx.stroke();

  const facing = world.facing * Math.PI / 4;
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(facing) * 1.4, y + Math.sin(facing) * 1.4);
  ctx.lineTo(x + Math.cos(facing) * 3.8, y + Math.sin(facing) * 3.8);
  ctx.strokeStyle = '#e9ef89';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = '#263d36';
  ctx.font = 'bold 3px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(DIRECTIONS[world.facing], x, y - 4);
  ctx.restore();
}
