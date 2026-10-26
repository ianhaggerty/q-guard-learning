// The Set values tool: drag a cell-aligned rectangle, then apply or reset a pixel value.

import { assignValue, selectionRect, valueSummary } from '../../core/index.js';
import { state, isExploring } from '../state.js';
import { byId, toast } from '../dom.js';
import { commitEdit, rememberForUndo } from '../document.js';

export function syncValuePanel() {
  const selection = state.valueSelection;
  const usable = selection && selection.floor === state.map.activeFloor && !isExploring();
  byId('applyValue').disabled = !usable;
  byId('resetValue').disabled = !usable;
  if (!usable) {
    byId('valueSelection').textContent = 'No selection. Floor defaults to 1; mass and doors default to 0.';
    return;
  }
  const { count, min, max, custom } = valueSummary(state.map, selection);
  const range = min === max ? `Value ${min}` : `Mixed values ${min} to ${max}`;
  byId('valueSelection').textContent = `${selection.w} × ${selection.h} px · ${count} pixels selected · ${range} · ${custom} custom`;
}

export function beginValueSelection(pixel) {
  state.drag = { kind: 'value', start: pixel };
  state.valueSelection = selectionRect(state.map, pixel, pixel);
  syncValuePanel();
}

export function extendValueSelection(pixel) {
  state.valueSelection = selectionRect(state.map, state.drag.start, pixel);
  syncValuePanel();
}

/** When the selection holds a single value, offer it in the input for editing. */
export function finishValueSelection() {
  const { min, max } = valueSummary(state.map, state.valueSelection);
  if (min === max) byId('customValue').value = String(min);
  syncValuePanel();
}

/** Apply the typed value to the selection, or restore material defaults when `reset`. */
function applySelectionValue(reset = false) {
  if (isExploring() || !state.valueSelection) return;
  const text = byId('customValue').value.trim(), value = reset ? null : Number(text);
  if (!reset && (!text || !Number.isFinite(value))) {
    toast('Enter a finite numeric value.');
    return;
  }
  rememberForUndo();
  const count = assignValue(state.map, state.valueSelection, value);
  byId('valuesToggle').checked = true;
  commitEdit();
  syncValuePanel();
  toast(reset ? `Defaults restored for ${count} pixels.` : `Value ${value} applied to ${count} pixels.`);
}

export function initValues() {
  byId('applyValue').onclick = () => applySelectionValue();
  byId('resetValue').onclick = () => applySelectionValue(true);
  byId('customValue').onkeydown = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applySelectionValue();
  };
}
