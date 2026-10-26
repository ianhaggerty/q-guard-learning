// The Stairs tool: placing, selecting and removing stairs that link adjacent floors.

import {
  STAIR_FLIGHT_LENGTH, STAIR_FLIGHT_WIDTH, STAIR_LANDING_DEPTH, STAIR_RETURN_WIDTH, WALL_THICKNESS,
  addStair, connectsFloor, removeStair, snap, stairContains, validateStair,
} from '../../core/index.js';
import { state, clearSelections, invalidateRaster, isExploring } from '../state.js';
import { byId, replaceOptions, toast } from '../dom.js';
import { commitEdit, rememberForUndo } from '../document.js';
import { syncFloors } from './floors.js';

const DEFAULT_HINT = '9 px (3 blocks) flight width · 18 px half-floor run · 9 px return landing · 3 px transparent boundaries.';

export function resetStairHint() {
  byId('stairHint').textContent = DEFAULT_HINT;
}

/** Offer the floors directly above and below the active floor as stair destinations. */
export function syncStairPanel() {
  const { map } = state, current = map.activeFloor, target = byId('stairTarget');
  const previous = Number(target.value);
  replaceOptions(target, map.floors.map((floor, i) => [i, floor.name]).filter(([i]) => Math.abs(i - current) === 1));
  const keepPrevious = Math.abs(previous - current) === 1 && previous < map.floors.length;
  target.value = keepPrevious ? previous : current === 0 ? 1 : current - 1;
  byId('removeStair').disabled = isExploring() || !state.selectedStairId;
}

/** The stair the panel settings describe, with its corner at the grid cell containing `pixel`. */
export function stairFromControls(pixel) {
  const { map } = state, type = byId('stairType').value, targetValue = byId('stairTarget').value;
  if (!targetValue && map.activeFloor === 0 && map.floors.length < 2) throw new Error('Add another floor first.');
  const target = Number(targetValue), isReturn = type === 'return';
  return {
    id: 'S' + Date.now().toString(36),
    type,
    x: snap(pixel.x),
    y: snap(pixel.y),
    length: isReturn ? STAIR_FLIGHT_LENGTH + STAIR_LANDING_DEPTH : 2 * STAIR_FLIGHT_LENGTH,
    width: isReturn ? STAIR_RETURN_WIDTH : STAIR_FLIGHT_WIDTH,
    ...(isReturn ? { landingDepth: STAIR_LANDING_DEPTH } : {}),
    rotation: Number(byId('stairRotation').value),
    lower: Math.min(target, map.activeFloor),
    upper: Math.max(target, map.activeFloor),
  };
}

/** Select the stair under `pixel`, or else place a new one there. */
export function placeStair(pixel) {
  const { map } = state;
  const existing = map.stairs.find(stair => connectsFloor(stair, map.activeFloor)
    && stairContains(stair, pixel.x, pixel.y, WALL_THICKNESS));
  if (existing) {
    state.selectedStairId = existing.id;
    const kind = existing.type === 'return' ? '180° return' : 'straight';
    byId('stairHint').textContent = `${existing.id}: ${kind} · ${map.floors[existing.lower].name} ↔ ${map.floors[existing.upper].name}`;
    syncFloors();
    invalidateRaster();
    return;
  }
  try {
    const stair = stairFromControls(pixel);
    validateStair(map, stair);
    rememberForUndo();
    addStair(map, stair);
    state.selectedStairId = stair.id;
    commitEdit();
    syncFloors();
    byId('stairHint').textContent = 'Paired stair placed: 9 px (3 blocks) wide flights, 18 px runs, 3 px transparent boundaries.';
    toast('Stair added on both connected floors.');
  } catch (error) {
    toast(error.message);
  }
}

export function initStairs() {
  byId('removeStair').onclick = () => {
    if (isExploring() || !state.selectedStairId) return;
    rememberForUndo();
    removeStair(state.map, state.selectedStairId);
    clearSelections();
    commitEdit();
    syncFloors();
    byId('stairHint').textContent = 'Click to place. Both floors are prepared together.';
    toast('Stair removed; its footprint is now floor on both levels.');
  };
}
