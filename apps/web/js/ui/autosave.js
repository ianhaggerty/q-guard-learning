// Autosave to localStorage. The map is saved in the JSON file format shortly after each
// change, and immediately when the page is hidden.

import { alignGrid, decodeMap, encodeMap } from '@pixel-map-lab/core';
import { state } from './state.js';
import { byId } from './dom.js';

const STORAGE_KEY = 'pixel-map-lab-v1';
const SAVE_DELAY_MS = 180;
let saveTimer = null;

/** The autosaved map, or null when there is none. Throws when a saved map cannot be read. */
export function readAutosave() {
  const json = localStorage.getItem(STORAGE_KEY);
  return json ? alignGrid(decodeMap(JSON.parse(json))) : null;
}

export function scheduleSave() {
  clearTimeout(saveTimer);
  byId('saveStatus').textContent = 'Saving…';
  saveTimer = setTimeout(() => {
    try {
      writeToStorage();
      byId('saveStatus').textContent = 'Saved on this device';
    } catch {
      byId('saveStatus').textContent = 'Storage full · export to keep map';
    }
  }, SAVE_DELAY_MS);
}

/** Save right away, as the page goes away. Errors are ignored: there is no one left to tell. */
export function saveNow() {
  clearTimeout(saveTimer);
  try {
    writeToStorage();
  } catch {
    // Storage is full or unavailable.
  }
}

function writeToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(encodeMap(state.map)));
}
