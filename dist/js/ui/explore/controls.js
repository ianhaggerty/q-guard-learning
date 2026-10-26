// Explore input: held movement keys, the on-screen direction pad, and the Explore
// settings (gait, look direction, sitting, pause, detection range and event rate).
// Input only records directions; time advances in the animation frame loop.

import { DETECTION_HALF_RANGE, EVENT_RATE } from '../../core/index.js';
import { state, isExploring } from '../state.js';
import { byId, focusCanvas, toast } from '../dom.js';
import { syncExplorePanels } from './panels.js';

const MOVEMENT_KEYS = {
  w: 'up', arrowup: 'up',
  s: 'down', arrowdown: 'down',
  a: 'left', arrowleft: 'left',
  d: 'right', arrowright: 'right',
};

const heldKeys = new Set();
/** Touch-pad buttons being held, such as 'up' or 'up-left'. */
const touchDirections = new Set();

export function isMovementKey(key) {
  return Object.hasOwn(MOVEMENT_KEYS, key);
}

export function pressKey(key) {
  heldKeys.add(key);
}

export function releaseKey(key) {
  heldKeys.delete(key);
}

export function clearMovementInput() {
  heldKeys.clear();
  touchDirections.clear();
}

/** Forget all held input and restart the frame clock, so no time passes while away. */
export function resetInput() {
  clearMovementInput();
  state.spaceHeld = false;
  state.lastFrameTime = performance.now();
}

/** The requested direction of travel as [dx, dy], each -1, 0 or 1. */
export function movementVector() {
  const held = direction => [...heldKeys].some(key => MOVEMENT_KEYS[key] === direction)
    || [...touchDirections].some(pad => pad.split('-').includes(direction));
  return [+held('right') - +held('left'), +held('down') - +held('up')];
}

// The event-rate input counts millionths (10⁻⁶) of an arrival per minute; the simulation
// works in arrivals per second.
const toRatePerSecond = millionthsPerMinute => millionthsPerMinute / 1e6 / 60;
const toRateInput = ratePerSecond => Number((ratePerSecond * 60 * 1e6).toPrecision(12));

/** The event rate entered in the Explore panel, in arrivals per second per value-1 pixel. */
export function eventRateFromInput() {
  return toRatePerSecond(Number(byId('eventRate').value));
}

/** Run an Explore setting change, then hand keyboard focus back to the map. */
function exploreSetting(change) {
  return () => {
    if (!state.world || !isExploring()) return;
    resetInput();
    change(state.world);
    focusCanvas();
  };
}

export const toggleSitting = exploreSetting(world => {
  if (!world.setSitting(!world.sitting)) toast('Approach the clear front of a chair to sit.');
  syncExplorePanels();
});

/** Keyboard look shortcuts: update the Look selector to match. */
export function lookFromKeyboard(look) {
  byId('lookSelect').value = look;
  state.world.setLook(look);
  syncExplorePanels();
}

export function initExploreControls() {
  for (const button of document.querySelectorAll('[data-direction]')) {
    const direction = button.dataset.direction;
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      touchDirections.add(direction);
      button.setPointerCapture(event.pointerId);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, () => touchDirections.delete(direction));
    }
  }

  byId('gaitSelect').onchange = exploreSetting(world => {
    world.setGait(byId('gaitSelect').value);
    world.setLook(byId('lookSelect').value);
  });
  byId('lookSelect').onchange = exploreSetting(world => {
    world.setLook(byId('lookSelect').value);
    syncExplorePanels();
  });
  byId('sitToggle').onclick = toggleSitting;
  byId('pauseEnergy').onclick = exploreSetting(world => {
    world.paused = !world.paused;
    syncExplorePanels();
  });

  byId('detectionRange').onchange = () => {
    const metres = Number(byId('detectionRange').value);
    if (!Number.isFinite(metres) || metres <= 0) {
      byId('detectionRange').value = state.world?.detectionHalfRange || DETECTION_HALF_RANGE;
      toast('Enter a positive distance in metres.');
      return;
    }
    if (state.world) state.world.setDetectionHalfRange(metres);
  };

  byId('eventRate').onchange = () => {
    const millionthsPerMinute = Number(byId('eventRate').value);
    if (!Number.isFinite(millionthsPerMinute) || millionthsPerMinute < 0) {
      byId('eventRate').value = toRateInput(state.world ? state.world.events.rate : EVENT_RATE);
      toast('Enter a rate of zero or more.');
      return;
    }
    if (state.world) state.world.events.setRate(toRatePerSecond(millionthsPerMinute));
  };
}
