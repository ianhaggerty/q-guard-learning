// Stair, chair and start annotations. These are canvas drawings over the materials and
// never appear in exported PNGs.

import {
  CHAIR_SIZE, chairContains, chairFront, connectsFloor, returnLanes, stairClearance, stairCrossing,
  stairFlightLength, stairToWorld,
} from '../../core/index.js';
import { state, view, isExploring } from '../state.js';
import { ctx, toPixel } from '../viewport.js';
import { stairFromControls } from '../build/stairs.js';
import { chairFromControls } from '../build/chairs.js';

const SELECTION = '#79539b';
const STAIR_COLORS = { tread: '#71876b', crossing: '#a893db', arrow: '#766393', outline: '#9a7cc0' };
const CHAIR_COLORS = { seat: '#c49a62', back: '#78583d' };

// ---------------------------------------------------------------------------
// Stairs: treads on this floor's flight, the purple floor-change line, an arrow
// pointing up the flight, and a dashed outline when selected or previewed.

export function drawStairs() {
  const { map } = state;
  for (const stair of map.stairs) {
    if (!connectsFloor(stair, map.activeFloor)) continue;
    const lower = map.activeFloor === stair.lower;
    drawTreads(stair, lower);
    drawCrossingLine(stair);
    drawStairArrow(stair, lower);
    if (!isExploring() && state.selectedStairId === stair.id) drawStairOutline(stair, [3, 3]);
  }
  if (!isExploring() && state.tool === 'stairs' && state.hover) {
    try {
      drawStairOutline(stairFromControls(toPixel(state.hover)), [4, 3]);
    } catch {
      // No valid stair can be described yet (for example, there is only one floor).
    }
  }
}

/** Stroke a line between two stair-local points. */
function stairSegment(stair, u1, v1, u2, v2, color, width = 0.45) {
  const a = stairToWorld(stair, u1, v1), b = stairToWorld(stair, u2, v2);
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawTreads(stair, lower) {
  if (stair.type === 'straight') {
    const half = stair.length / 2;
    for (let u = lower ? 1 : half + 1; u < (lower ? half : stair.length); u += 2) {
      stairSegment(stair, u, 1, u, stair.width - 1, STAIR_COLORS.tread, 0.5);
    }
    return;
  }
  const { lane, upperLane } = returnLanes(stair);
  const from = lower ? 1 : upperLane + 1, to = lower ? lane - 1 : stair.width - 1;
  for (let u = 1; u < stairFlightLength(stair); u += 2) stairSegment(stair, u, from, u, to, STAIR_COLORS.tread, 0.5);
}

function drawCrossingLine(stair) {
  const line = stairCrossing(stair);
  if (line.axis === 'u') stairSegment(stair, line.at, line.from, line.at, line.to, STAIR_COLORS.crossing, 1);
  else stairSegment(stair, line.from, line.at, line.to, line.at, STAIR_COLORS.crossing, 1);
}

function drawStairArrow(stair, lower) {
  const straight = stair.type === 'straight', { lane, upperLane } = returnLanes(stair);
  const u = straight ? (lower ? stair.length / 4 : 3 * stair.length / 4) : stairFlightLength(stair) / 2;
  const v = straight ? stair.width / 2 : lower ? lane / 2 : (upperLane + stair.width) / 2;
  // The upper flight of a return stair climbs back towards u = 0.
  const direction = straight || lower ? 1 : -1;
  const tail = stairToWorld(stair, u, v), tip = stairToWorld(stair, u + direction * 3, v);
  ctx.beginPath();
  ctx.strokeStyle = STAIR_COLORS.arrow;
  ctx.lineWidth = 0.7;
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
  ctx.beginPath();
  ctx.moveTo(tip.x - Math.cos(angle - 0.65) * 2, tip.y - Math.sin(angle - 0.65) * 2);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(tip.x - Math.cos(angle + 0.65) * 2, tip.y - Math.sin(angle + 0.65) * 2);
  ctx.stroke();
}

function drawStairOutline(stair, dashPattern) {
  const box = stairClearance(stair);
  ctx.strokeStyle = STAIR_COLORS.outline;
  ctx.lineWidth = 1 / view.zoom;
  ctx.setLineDash(dashPattern.map(length => length / view.zoom));
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------------------
// Chairs: a seat with its backrest on the side opposite the facing direction.

const BACKREST = {
  0: [0, 0, 1, 3],
  90: [0, 0, 3, 1],
  180: [2, 0, 1, 3],
  270: [0, 2, 3, 1],
};

export function drawChairs() {
  const { map } = state;
  for (const chair of map.chairs) if (chair.floor === map.activeFloor) drawChair(chair);
  if (!isExploring() && state.tool === 'chair' && state.hover) {
    const preview = chairFromControls(toPixel(state.hover));
    const occupied = map.chairs.some(chair => chair.floor === preview.floor && chairContains(chair, state.hover.x, state.hover.y));
    if (!occupied) drawChair(preview, true);
  }
}

function drawChair(chair, preview = false) {
  ctx.save();
  if (preview) ctx.globalAlpha = 0.5;
  ctx.fillStyle = CHAIR_COLORS.seat;
  ctx.fillRect(chair.x, chair.y, CHAIR_SIZE, CHAIR_SIZE);
  const [dx, dy, w, h] = BACKREST[chair.rotation];
  ctx.fillStyle = CHAIR_COLORS.back;
  ctx.fillRect(chair.x + dx, chair.y + dy, w, h);
  if (!isExploring() && (state.selectedChairId === chair.id || preview)) {
    // Outline the chair and mark where the explorer stands to sit.
    ctx.strokeStyle = SELECTION;
    ctx.lineWidth = 1 / view.zoom;
    ctx.strokeRect(chair.x, chair.y, CHAIR_SIZE, CHAIR_SIZE);
    const front = chairFront(chair);
    ctx.fillStyle = SELECTION;
    ctx.fillRect(front.x - 0.3, front.y - 0.3, 0.6, 0.6);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Numbered starts: the Explore start is highlighted, the selected start outlined.

export function drawStarts() {
  const { map } = state;
  map.starts.forEach((start, i) => {
    if (start.floor !== map.activeFloor) return;
    const radius = Math.max(1.5, 8 / view.zoom), selected = state.selectedStartIndex === i;
    ctx.save();
    ctx.beginPath();
    ctx.arc(start.x, start.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = i === state.exploreStartIndex ? '#e9ef89' : '#e7edf6';
    ctx.fill();
    ctx.strokeStyle = selected ? SELECTION : '#263d36';
    ctx.lineWidth = (selected ? 2 : 1) / view.zoom;
    ctx.stroke();
    ctx.fillStyle = '#263d36';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(2, 10 / view.zoom)}px sans-serif`;
    ctx.fillText(String(i + 1), start.x, start.y, radius * 1.7);
    ctx.restore();
  });
}
