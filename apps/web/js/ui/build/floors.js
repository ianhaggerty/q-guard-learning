// The floor bar above the canvas: choosing the building floor and adding floors.

import { MAX_FLOORS, addFloor } from '../../core/index.js';
import { state, clearSelections, invalidateRaster, isExploring } from '../state.js';
import { byId, pluralize, replaceOptions, toast } from '../dom.js';
import { scheduleSave } from '../autosave.js';
import { commitEdit, rememberForUndo } from '../document.js';
import { endDrag } from './pointer.js';
import { syncStartPanel } from './starts.js';
import { syncChairPanel } from './chairs.js';
import { syncValuePanel } from './values.js';
import { syncStairPanel } from './stairs.js';

/** Refresh everything that depends on the active floor or the list of floors. */
export function syncFloors() {
  const { map } = state, current = map.activeFloor;
  syncStartPanel();
  syncChairPanel();
  if (state.valueSelection && state.valueSelection.floor !== current) state.valueSelection = null;
  syncValuePanel();

  const floorSelect = byId('floorSelect');
  replaceOptions(floorSelect, map.floors.map((floor, i) => [i, `${i + 1} · ${floor.name}`]));
  floorSelect.value = current;
  byId('floorSummary').textContent = `${pluralize(map.floors.length, 'floor')} · ${pluralize(map.stairs.length, 'stairway')}`;

  byId('hudFloor').textContent = map.floors[current].name;
  const startIndex = isExploring() && state.world ? state.world.startIndex : state.exploreStartIndex;
  byId('hudStart').textContent = 'Start ' + (startIndex + 1);

  syncStairPanel();
  byId('addFloor').disabled = isExploring() || map.floors.length >= MAX_FLOORS;
}

export function initFloors() {
  byId('floorSelect').onchange = () => {
    if (isExploring()) return;
    endDrag();
    state.map.activeFloor = Number(byId('floorSelect').value);
    byId('floorLive').textContent = '';
    clearSelections();
    invalidateRaster();
    syncFloors();
    scheduleSave();
  };

  byId('addFloor').onclick = () => {
    if (isExploring() || state.map.floors.length >= MAX_FLOORS) return;
    rememberForUndo();
    addFloor(state.map);
    clearSelections();
    commitEdit();
    syncFloors();
    toast('Blank floor added. Connect it with the Stairs tool.');
  };
}
