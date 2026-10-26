// Keyboard shortcuts for both modes, and housekeeping when the page loses focus.

import { state, isExploring } from './state.js';
import { saveNow } from './autosave.js';
import { redo, undo } from './document.js';
import { selectMaterial, selectTool } from './build/palette.js';
import { isMovementKey, lookFromKeyboard, pressKey, releaseKey, resetInput, toggleSitting } from './explore/controls.js';

const MATERIAL_KEYS = { 1: 0, 2: 1, 3: 2, 4: 3 };
const TOOL_KEYS = { b: 'brush', l: 'line', r: 'rect', f: 'fill', e: 'erase', s: 'starts', t: 'stairs', v: 'value', c: 'chair' };
/** Look keys are laid out like the eight directions around K; F, Q, X and B also work. */
const LOOK_KEYS = {
  u: 'forward-left', i: 'forward', o: 'forward-right',
  j: 'left', l: 'right',
  m: 'back-left', ',': 'back', '.': 'back-right',
  f: 'forward', q: 'left', x: 'right', b: 'back',
};

function onKeyDown(event) {
  if (event.target.matches('input, textarea, select') || document.querySelector('dialog[open]')) return;
  const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
  if (command && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (command && key === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (command || event.altKey) return;
  if (key === ' ') {
    state.spaceHeld = true;
    event.preventDefault();
  }
  if (isExploring()) onExploreKey(event, key);
  else if (Object.hasOwn(MATERIAL_KEYS, key)) selectMaterial(MATERIAL_KEYS[key]);
  else if (Object.hasOwn(TOOL_KEYS, key)) selectTool(TOOL_KEYS[key]);
}

function onExploreKey(event, key) {
  if (Object.hasOwn(LOOK_KEYS, key)) {
    event.preventDefault();
    if (!event.repeat) lookFromKeyboard(LOOK_KEYS[key]);
  } else if (key === 'e') {
    event.preventDefault();
    if (!event.repeat) toggleSitting();
  } else if (isMovementKey(key)) {
    event.preventDefault();
    pressKey(key);
  }
}

export function initKeyboard() {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', event => {
    releaseKey(event.key.toLowerCase());
    if (event.key === ' ') state.spaceHeld = false;
  });
  // Held keys would otherwise stay "down" while focus is elsewhere.
  window.addEventListener('blur', resetInput);
  document.addEventListener('visibilitychange', resetInput);
  window.addEventListener('pagehide', saveNow);
}
