// The map being edited: committing edits, replacing the whole map, and undo/redo.
// Undo snapshots cover the entire building (every floor, stair, chair, start and value).

import { alignGrid, cloneMap, normalizeMap, pruneChairs } from '../core/index.js';
import { state, view, clearSelections, invalidateRaster, isExploring } from './state.js';
import { byId } from './dom.js';
import { scheduleSave } from './autosave.js';
import { fitView } from './viewport.js';
import { syncFloors } from './build/floors.js';
import { syncChairPanel } from './build/chairs.js';
import { syncStartPanel } from './build/starts.js';
import { setMode } from './explore/session.js';

const UNDO_LIMIT = 50;
let undoStack = [];
let redoStack = [];

/** Snapshot the map before an edit so that it can be undone. Clears the redo history. */
export function rememberForUndo() {
  undoStack.push(cloneMap(state.map));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  syncHistoryButtons();
}

/** Finish an edit: drop chairs that lost their floor, refresh the panels and autosave. */
export function commitEdit() {
  pruneChairs(state.map);
  syncChairPanel();
  syncStartPanel();
  invalidateRaster();
  scheduleSave();
  syncHistoryButtons();
}

/** Replace the whole map (a new blank map or an import), as an undoable change. */
export function loadMap(map) {
  if (isExploring()) setMode('build');
  rememberForUndo();
  state.map = alignGrid(normalizeMap(map));
  clearSelections();
  state.world = null;
  invalidateRaster();
  view.fitToScreen = true;
  syncMapControls();
  fitView();
  scheduleSave();
}

export function undo() {
  restoreSnapshot(undoStack, redoStack);
}

export function redo() {
  restoreSnapshot(redoStack, undoStack);
}

function restoreSnapshot(from, to) {
  if (!from.length || isExploring()) return;
  to.push(cloneMap(state.map));
  state.map = from.pop();
  clearSelections();
  byId('floorLive').textContent = '';
  syncMapControls();
  invalidateRaster();
  fitView();
  scheduleSave();
  syncHistoryButtons();
}

export function syncHistoryButtons() {
  byId('undo').disabled = !undoStack.length || isExploring();
  byId('redo').disabled = !redoStack.length || isExploring();
}

/** Refresh every control that shows the map, after it was replaced or renamed. */
export function syncMapControls() {
  const { map } = state;
  syncFloors();
  byId('mapName').value = map.name;
  byId('mapTab').textContent = map.name;
  byId('mapWidth').value = map.width;
  byId('mapHeight').value = map.height;
  byId('coordinates').textContent = `${map.width} × ${map.height} pixels`;
}
