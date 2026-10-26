// Brush size and the map name (the sidebar's settings section).

import { GRID } from '@pixel-map-lab/core';
import { state } from '../state.js';
import { byId } from '../dom.js';
import { scheduleSave } from '../autosave.js';
import { rememberForUndo, syncMapControls } from '../document.js';

export function initSettings() {
  byId('settingsToggle').onclick = () => {
    const open = document.querySelector('.sidebar').classList.toggle('settings-open');
    byId('settingsToggle').setAttribute('aria-expanded', open);
  };

  byId('brushSize').oninput = event => {
    // Brushes paint whole grid cells, so sizes go up in steps of one cell.
    state.brushSize = Math.max(GRID, Math.round(Number(event.target.value) / GRID) * GRID);
    event.target.value = state.brushSize;
    byId('brushValue').textContent = state.brushSize + ' px';
  };

  byId('mapName').addEventListener('change', () => {
    rememberForUndo();
    state.map.name = byId('mapName').value.trim() || 'Untitled map';
    syncMapControls();
    scheduleSave();
  });
}
