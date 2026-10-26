// The Starts tool: numbered places where Explore can begin, plus the "Explore from" picker.

import { GRID, removeStart, setStart, snap, validateStart } from '../../core/index.js';
import { state, invalidateRaster, isExploring } from '../state.js';
import { byId, pluralize, replaceOptions, toast } from '../dom.js';
import { scheduleSave } from '../autosave.js';
import { commitEdit, rememberForUndo } from '../document.js';
import { syncFloors } from './floors.js';

/** Clicking within this many pixels of a start marker selects it. */
const MARKER_HIT_RADIUS = 2;

export function syncStartPanel() {
  const { map } = state;
  map.starts[0] = map.spawn;
  state.exploreStartIndex = Math.max(0, Math.min(state.exploreStartIndex, map.starts.length - 1));
  if (state.selectedStartIndex !== null && state.selectedStartIndex >= map.starts.length) state.selectedStartIndex = null;

  const startOptions = map.starts.map((start, i) => [i, `Start ${i + 1} · ${map.floors[start.floor].name}`]);
  const editSelect = byId('startEdit'), exploreSelect = byId('exploreStart');
  replaceOptions(editSelect, [['new', `Add start ${map.starts.length + 1}`], ...startOptions]);
  replaceOptions(exploreSelect, startOptions);
  editSelect.value = state.selectedStartIndex === null ? 'new' : String(state.selectedStartIndex);
  exploreSelect.value = state.exploreStartIndex;
  editSelect.disabled = exploreSelect.disabled = isExploring();

  byId('removeStart').disabled = isExploring() || state.selectedStartIndex === null || map.starts.length === 1;
  byId('startHint').textContent = `${pluralize(map.starts.length, 'numbered start')} · Click clear floor to add. `
    + 'Click a marker or choose it above to move it. Removing a start renumbers those after it. '
    + 'Explore controls one character from the chosen start.';
}

/** Select the start under `pixel`, or else add a start there (or move the selected one). */
export function placeStart(pixel) {
  const { map } = state;
  const existing = map.starts.findIndex(start => start.floor === map.activeFloor
    && Math.hypot(start.x - (pixel.x + 0.5), start.y - (pixel.y + 0.5)) <= MARKER_HIT_RADIUS);
  if (existing >= 0) {
    state.selectedStartIndex = existing;
    state.exploreStartIndex = existing;
    syncStartPanel();
    invalidateRaster();
    return;
  }
  const adding = state.selectedStartIndex === null;
  const index = adding ? map.starts.length : state.selectedStartIndex;
  // Starts sit at the centre of a grid cell.
  const start = { x: snap(pixel.x) + GRID / 2, y: snap(pixel.y) + GRID / 2, floor: map.activeFloor };
  try {
    validateStart(map, start, index);
    rememberForUndo();
    setStart(map, index, start);
    state.exploreStartIndex = index;
    commitEdit();
    toast(`Start ${index + 1} ${adding ? 'added' : 'moved'}.`);
  } catch (error) {
    toast(error.message);
  }
}

export function initStarts() {
  byId('startEdit').onchange = () => {
    const choice = byId('startEdit').value;
    state.selectedStartIndex = choice === 'new' ? null : Number(choice);
    if (state.selectedStartIndex === null) {
      syncStartPanel();
    } else {
      state.exploreStartIndex = state.selectedStartIndex;
      state.map.activeFloor = state.map.starts[state.selectedStartIndex].floor;
      syncFloors();
      scheduleSave();
    }
    invalidateRaster();
  };

  byId('exploreStart').onchange = () => {
    if (isExploring()) return;
    state.exploreStartIndex = Number(byId('exploreStart').value);
    state.map.activeFloor = state.map.starts[state.exploreStartIndex].floor;
    syncFloors();
    invalidateRaster();
    scheduleSave();
  };

  byId('removeStart').onclick = () => {
    if (isExploring() || state.selectedStartIndex === null || state.map.starts.length === 1) return;
    const index = state.selectedStartIndex;
    try {
      rememberForUndo();
      removeStart(state.map, index);
      if (state.exploreStartIndex > index) state.exploreStartIndex--;
      state.selectedStartIndex = null;
      commitEdit();
      toast('Start removed; remaining starts are renumbered.');
    } catch (error) {
      toast(error.message);
    }
  };
}
