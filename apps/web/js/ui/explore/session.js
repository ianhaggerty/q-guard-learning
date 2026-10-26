// Switching between Build and Explore, and running the Explore session each frame.

import { DETECTION_HALF_RANGE, METRES_PER_PIXEL, World } from '@pixel-map-lab/core';
import { state, invalidateRaster, isExploring } from '../state.js';
import { byId, focusCanvas, setText, toast } from '../dom.js';
import { canvas } from '../viewport.js';
import { syncHistoryButtons } from '../document.js';
import { endDrag } from '../build/pointer.js';
import { syncFloors } from '../build/floors.js';
import { syncChairPanel } from '../build/chairs.js';
import { syncStartPanel } from '../build/starts.js';
import { syncValuePanel } from '../build/values.js';
import { clearMovementInput, eventRateFromInput, movementVector } from './controls.js';
import { syncExplorePanels } from './panels.js';

/** Controls that edit the map, disabled while exploring. */
const BUILD_CONTROLS = [
  '.sidebar button', '.sidebar input', '#addFloor', '#stairOptions select', '#removeStair',
  '#valueOptions input', '#valueOptions button', '#chairOptions select', '#removeChair',
].join(',');

/** Panels shown only while exploring. */
const EXPLORE_PANELS = ['exploreHud', 'touchPad', 'exploreOptions', 'energyPanel', 'eventPanel'];

/** Floor the arrival notice was last shown for; -1 suppresses the notice for the starting floor. */
let announcedFloor = -1;

/** A new Explore session from the chosen start, using the current Explore settings. */
function createWorld() {
  const world = new World(state.map, { startIndex: state.exploreStartIndex });
  world.setDetectionHalfRange(Number(byId('detectionRange').value) || DETECTION_HALF_RANGE);
  world.events.setRate(eventRateFromInput());
  world.setGait(byId('gaitSelect').value);
  world.setLook(byId('lookSelect').value);
  return world;
}

export function setMode(mode) {
  if (mode === state.mode) return;
  if (mode === 'explore' && !startSession()) return;
  state.mode = mode;
  invalidateRaster();
  announcedFloor = -1;
  if (mode === 'build') byId('floorLive').textContent = '';
  syncModeControls();
  focusCanvas();
  if (mode === 'explore') toast('Walk with WASD or arrow keys. Nearby doors open automatically.');
}

/** Create the session. Fails (with a message) when the explorer has nowhere to stand. */
function startSession() {
  endDrag();
  state.world = createWorld();
  syncFloors();
  if (!state.world.canStand(state.world.player.x, state.world.player.y)) {
    toast('Draw a floor area at least 3 × 3 pixels before exploring.');
    return false;
  }
  state.world.updateDoors();
  clearMovementInput();
  return true;
}

/** Start the session over from the chosen start, with fresh totals and events. */
function restartSession() {
  state.world = createWorld();
  state.world.updateDoors();
  syncFloors();
  syncExplorePanels();
  announcedFloor = -1;
  invalidateRaster();
  focusCanvas();
}

function syncModeControls() {
  const exploring = isExploring();
  for (const [id, active] of [['buildMode', !exploring], ['exploreMode', exploring]]) {
    byId(id).classList.toggle('active', active);
    byId(id).setAttribute('aria-pressed', active);
  }
  byId('modeLabel').textContent = exploring ? 'EXPLORE MODE' : 'BUILD MODE';
  for (const id of EXPLORE_PANELS) byId(id).hidden = !exploring;
  byId('brushCursor').hidden = true;
  byId('modeHint').textContent = exploring ? 'WASD / arrows to move · Doors open nearby' : 'Drag to draw · Space + drag to pan';
  canvas.style.cursor = exploring ? 'default' : 'crosshair';

  for (const control of document.querySelectorAll(BUILD_CONTROLS)) control.disabled = exploring;
  byId('floorSelect').disabled = exploring;
  byId('startOptions').hidden = exploring || state.tool !== 'starts';
  byId('stairOptions').hidden = exploring || state.tool !== 'stairs';
  byId('valueOptions').hidden = exploring || state.tool !== 'value';
  byId('chairOptions').hidden = exploring || state.tool !== 'chair';
  // Restore the enabled state of controls that depend on the current selection.
  syncFloors();
  syncStartPanel();
  syncValuePanel();
  syncChairPanel();
  syncHistoryButtons();
}

/** Advance the session by one frame's worth of time and refresh what it shows. */
export function tickExplore(seconds) {
  const { world } = state;
  const [dx, dy] = movementVector();
  if (world.advance(seconds, dx, dy)) invalidateRaster();
  if (announcedFloor !== world.floorIndex) {
    const previous = announcedFloor;
    announcedFloor = world.floorIndex;
    syncFloors();
    invalidateRaster();
    if (previous !== -1) {
      const name = state.map.floors[world.floorIndex].name;
      byId('floorLive').textContent = 'Arrived: ' + name;
      toast('Now on ' + name);
    }
  }
  setText('hudDistance', (world.distance * METRES_PER_PIXEL).toFixed(1));
  syncExplorePanels();
  setText('hudOpenDoors', world.doors.filter(door => door.open).length);
}

export function initModeSwitch() {
  byId('buildMode').onclick = () => setMode('build');
  byId('exploreMode').onclick = () => setMode('explore');
  byId('restartGame').onclick = restartSession;
}
