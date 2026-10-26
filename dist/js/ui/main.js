// Entry point: load the starting map, wire up every control and start the frame loop.

import { alignGrid, createBlankMap } from '../core/index.js';
import { state, isExploring } from './state.js';
import { byId, toast } from './dom.js';
import { readAutosave } from './autosave.js';
import { loadDefaultPlan } from './plans.js';
import { syncHistoryButtons, syncMapControls } from './document.js';
import { initViewport } from './viewport.js';
import { initKeyboard } from './keyboard.js';
import { initFiles } from './files.js';
import { initPalette } from './build/palette.js';
import { initSettings } from './build/settings.js';
import { initPointer } from './build/pointer.js';
import { initFloors } from './build/floors.js';
import { initStarts } from './build/starts.js';
import { initStairs } from './build/stairs.js';
import { initChairs } from './build/chairs.js';
import { initValues } from './build/values.js';
import { initModeSwitch, tickExplore } from './explore/session.js';
import { initExploreControls } from './explore/controls.js';
import { initExplorePanels } from './explore/panels.js';
import { renderFrame } from './render/renderer.js';

/** Longest frame step; longer gaps (a stalled tab) are not caught up. */
const MAX_FRAME_SECONDS = 0.25;

function frame(now) {
  const seconds = Math.max(0, Math.min((now - state.lastFrameTime) / 1000, MAX_FRAME_SECONDS));
  state.lastFrameTime = now;
  // Explore time stands still while a dialog is open or the tab is hidden.
  if (isExploring() && !document.querySelector('dialog[open]') && !document.hidden) tickExplore(seconds);
  renderFrame();
  requestAnimationFrame(frame);
}

/** The map to open: the autosave, else the default plan, else a blank canvas. */
async function loadStartingMap() {
  let restoreFailed = false;
  try {
    const saved = readAutosave();
    if (saved) return saved;
  } catch {
    restoreFailed = true;
  }
  try {
    const plan = await loadDefaultPlan();
    if (restoreFailed) toast('The saved map could not be restored. The default plan is ready.');
    return plan;
  } catch {
    toast('The default plan could not be loaded. Starting with a blank canvas.');
    return alignGrid(createBlankMap(Number(byId('mapWidth').value), Number(byId('mapHeight').value)));
  }
}

state.map = await loadStartingMap();
initViewport();
initPointer();
initKeyboard();
initPalette();
initSettings();
initFloors();
initStarts();
initStairs();
initChairs();
initValues();
initModeSwitch();
initExploreControls();
initExplorePanels();
initFiles();
syncMapControls();
syncHistoryButtons();
requestAnimationFrame(frame);
