// The Explore readouts: facing, posture, energy table, event counts and the probability sum.

import { ACTIVITIES, DIRECTIONS, FIELD_OF_VIEW, isBackwardLook, kcalPerMinute } from '@pixel-map-lab/core';
import { state } from '../state.js';
import { byId, setPressed, setText } from '../dom.js';

const formatMet = met => Number(met.toFixed(2));

/** mm:ss */
function formatClock(seconds) {
  const whole = Math.floor(seconds + 1e-6), minutes = Math.floor(whole / 60);
  return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** One table row per activity, with cells updated by syncEnergy. */
function buildEnergyTable() {
  for (const [key, activity] of Object.entries(ACTIVITIES)) {
    const row = document.createElement('tr');
    const met = formatMet(activity.met) + (activity.modelled ? ' *' : '');
    const speed = activity.speed ? Number(activity.speed.toFixed(2)) : '—';
    row.innerHTML = `<th scope="row">${activity.label}</th><td>${met}</td><td>${speed}</td>`
      + `<td id="time-${key}">00:00</td><td id="kcal-${key}">0.0000</td>`;
    byId('energyRows').append(row);
  }
}

export function syncExplorePanels() {
  if (!state.world) return;
  syncEventPanel();
  syncFacing();
  syncEnergy();
  syncPosture();
}

function syncFacing() {
  const { world } = state, direction = DIRECTIONS[world.facing], backward = isBackwardLook(world.look);
  byId('hudFacing').textContent = `${direction} · ${world.look}${backward ? ' · backward walk' : ''}`;
  setText('facingStatus', `Facing ${direction} · Looking ${world.look}${backward ? ' · backward walk only' : ''} · ${FIELD_OF_VIEW}° view`);
}

function syncEnergy() {
  const { world } = state, { energy } = world, activity = ACTIVITIES[energy.activity];
  byId('hudCalories').textContent = energy.kcal.toFixed(3);
  byId('totalCalories').textContent = energy.kcal.toFixed(3);
  byId('energyTime').textContent = formatClock(energy.seconds);
  byId('energyActivity').textContent = world.paused
    ? 'Paused'
    : `${activity.label} · ${formatMet(activity.met)} MET${activity.modelled ? ' (modelled)' : ''}`;
  byId('energyRate').textContent = (world.paused ? 0 : kcalPerMinute(activity.met)).toFixed(2);
  for (const [key, totals] of Object.entries(energy.byActivity)) {
    byId('time-' + key).textContent = formatClock(totals.seconds);
    byId('kcal-' + key).textContent = totals.kcal.toFixed(4);
  }
}

function syncPosture() {
  const { world } = state, nearbyChair = world.sitting ? null : world.nearbyChair();
  const sitToggle = byId('sitToggle');
  sitToggle.disabled = !world.sitting && !nearbyChair;
  sitToggle.textContent = world.sitting ? 'Stand up' : 'Sit down';
  setPressed(sitToggle, world.sitting);
  let message = 'Approach the front of a chair to sit · E';
  if (world.sitting) message = 'Seated · 1 MET · E to stand';
  else if (nearbyChair) message = 'Chair nearby · E to sit';
  setText('chairStatus', message);
  byId('pauseEnergy').textContent = world.paused ? 'Resume' : 'Pause';
  setPressed(byId('pauseEnergy'), world.paused);
}

function syncEventPanel() {
  const { world, map } = state, field = world.probabilities, events = world.events;
  setText('probabilitySum', field.sum.toFixed(3));
  setText('probabilityHere', field.floorSums[world.floorIndex].toFixed(3));
  setText('probabilityFloors', map.floors.map((floor, i) => `${floor.name}: ${field.floorSums[i].toFixed(3)}`).join(' · '));

  setText('eventActive', events.active.length);
  setText('eventResolved', events.resolved);
  setText('eventSpawned', events.spawned);
  setText('eventHere', events.active.filter(event => event.floor === world.floorIndex).length);
  setText('eventExpected', (events.rate * events.totalWeight * 60).toFixed(1));
  byId('hudEvents').textContent = `ΣP ${field.sum.toFixed(2)} · ◆ ${events.active.length} · ✓ ${events.resolved}`;

  const recent = events.recent
    .map(event => `✓ Event ${event.id} · ${map.floors[event.floor].name} · spotted after ${event.wait.toFixed(1)} s`)
    .join('  |  ');
  setText('eventRecent', recent || 'Waiting for the first event. Explore or sit and watch.');
}

export function initExplorePanels() {
  buildEnergyTable();
}
