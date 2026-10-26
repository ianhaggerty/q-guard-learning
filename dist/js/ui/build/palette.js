// The sidebar's material and tool pickers.

import { state } from '../state.js';
import { byId, setPressed, toast } from '../dom.js';
import { syncStartPanel } from './starts.js';
import { syncChairPanel } from './chairs.js';
import { syncValuePanel } from './values.js';

export function selectMaterial(material) {
  state.material = material;
  for (const button of document.querySelectorAll('[data-material]')) {
    const selected = Number(button.dataset.material) === material;
    button.classList.toggle('selected', selected);
    setPressed(button, selected);
  }
  if (state.tool === 'erase') selectTool('brush');
}

/** Select a tool and show the options panel that belongs to it, if any. */
export function selectTool(tool) {
  state.tool = tool;
  byId('startOptions').hidden = tool !== 'starts';
  syncStartPanel();
  byId('chairOptions').hidden = tool !== 'chair';
  syncChairPanel();
  byId('valueOptions').hidden = tool !== 'value';
  syncValuePanel();
  byId('stairOptions').hidden = tool !== 'stairs';
  if (tool === 'stairs' && state.map.floors.length < 2) toast('Add another building floor, then place a stair.');
  for (const button of document.querySelectorAll('[data-tool]')) {
    const selected = button.dataset.tool === tool;
    button.classList.toggle('active', selected);
    setPressed(button, selected);
  }
}

export function initPalette() {
  for (const button of document.querySelectorAll('[data-material]')) {
    button.onclick = () => selectMaterial(Number(button.dataset.material));
  }
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.onclick = () => selectTool(button.dataset.tool);
  }
}
