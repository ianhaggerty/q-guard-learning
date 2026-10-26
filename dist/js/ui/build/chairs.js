// The Chair tool: placing, turning and removing chairs on the active floor.

import { addChair, chairContains, removeChair, snap, validateChair } from '../../core/index.js';
import { state, isExploring } from '../state.js';
import { byId, toast } from '../dom.js';
import { commitEdit, rememberForUndo } from '../document.js';

/** Drop a selection that no longer exists on the active floor, and update the Remove button. */
export function syncChairPanel() {
  const { map } = state;
  const selectionExists = map.chairs.some(chair => chair.id === state.selectedChairId && chair.floor === map.activeFloor);
  if (state.selectedChairId && !selectionExists) state.selectedChairId = null;
  byId('removeChair').disabled = isExploring() || !state.selectedChairId;
}

/** The chair the panel settings describe, on the grid cell containing `pixel`. */
export function chairFromControls(pixel) {
  return {
    id: 'C' + Date.now().toString(36),
    x: snap(pixel.x),
    y: snap(pixel.y),
    floor: state.map.activeFloor,
    rotation: Number(byId('chairRotation').value),
  };
}

/** Select the chair under `pixel`, or else place a new one there. */
export function placeChair(pixel) {
  const { map } = state;
  const existing = map.chairs.find(chair => chair.floor === map.activeFloor && chairContains(chair, pixel.x, pixel.y));
  if (existing) {
    state.selectedChairId = existing.id;
    byId('chairRotation').value = existing.rotation;
    syncChairPanel();
    byId('chairHint').textContent = 'Chair selected · 0.50 × 0.50 m footprint · Change facing direction or remove.';
    return;
  }
  try {
    const chair = chairFromControls(pixel);
    validateChair(map, chair);
    rememberForUndo();
    addChair(map, chair);
    state.selectedChairId = chair.id;
    commitEdit();
    toast('Chair placed · 0.50 × 0.50 m. Approach its front in Explore to sit.');
  } catch (error) {
    toast(error.message);
  }
}

export function initChairs() {
  byId('chairRotation').onchange = () => {
    if (isExploring() || !state.selectedChairId) return;
    const chair = state.map.chairs.find(c => c.id === state.selectedChairId);
    if (!chair) return;
    rememberForUndo();
    chair.rotation = Number(byId('chairRotation').value);
    commitEdit();
  };

  byId('removeChair').onclick = () => {
    if (isExploring() || !state.selectedChairId) return;
    rememberForUndo();
    removeChair(state.map, state.selectedChairId);
    state.selectedChairId = null;
    commitEdit();
    toast('Chair removed.');
  };
}
