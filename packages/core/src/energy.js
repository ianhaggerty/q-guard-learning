// Energy use of a fixed 70 kg explorer: kcal = MET × 70 × seconds / 3600 (gross, including
// resting energy). METs are from the 2024 Adult Compendium of Physical Activities
// (pacompendium.com) unless marked `modelled`. Speeds are metres per second.

import { METRES_PER_PIXEL } from './scale.js';
import { isBackwardLook } from './facing.js';

export const BODY_MASS_KG = 70;

const STANDING_MET = 1.3;

/**
 * A modelled MET for moving at `speed`: the energy above standing scales linearly with
 * speed from a published reference activity.
 */
function scaledMet(referenceMet, referenceSpeed, speed) {
  return STANDING_MET + (referenceMet - STANDING_MET) * (speed / referenceSpeed);
}

export const ACTIVITIES = Object.freeze({
  sitting: { label: 'Sitting', met: 1, speed: 0 },
  standing: { label: 'Standing', met: STANDING_MET, speed: 0 },
  // Backward walking: the Compendium lists 6 MET at 3.5 mph; this slower pace is estimated.
  backward: { label: 'Backward walking', met: 4, speed: 0.8, modelled: true },
  stairsUpBackward: { label: 'Stairs up · Backward', met: 6.8, speed: 0.25, modelled: true },
  stairsDownBackward: { label: 'Stairs down · Backward', met: 3.5, speed: 0.3, modelled: true },
  walk: { label: 'Walking', met: 3.8, speed: 1.34112 }, // 3 mph
  run: { label: 'Running', met: 9.3, speed: 2.68224 }, // 6 mph
  sprint: { label: 'Sprinting (proxy)', met: 23, speed: 6.25856 }, // 14 mph running, not an anaerobic model
  stairsUp: { label: 'Stairs up · Walk', met: 6.8, speed: 0.5 },
  stairsDown: { label: 'Stairs down · Walk', met: 3.5, speed: 0.6 },
  stairsUpRun: { label: 'Stairs up · Run', met: 15, speed: 1 },
  stairsDownRun: { label: 'Stairs down · Run', met: scaledMet(3.5, 0.6, 1), speed: 1, modelled: true },
  stairsUpSprint: { label: 'Stairs up · Sprint', met: scaledMet(15, 1, 1.5), speed: 1.5, modelled: true },
  stairsDownSprint: { label: 'Stairs down · Sprint', met: scaledMet(3.5, 0.6, 1.3), speed: 1.3, modelled: true },
});

const GAIT_SUFFIX = { walk: '', run: 'Run', sprint: 'Sprint' };

/**
 * The activity for a moving explorer. Looking back or diagonally back forces backward
 * walking whatever the selected gait; `stairDirection` is 'up', 'down' or null for
 * level movement.
 */
export function movementActivity(gait, look, stairDirection) {
  const backward = isBackwardLook(look);
  if (!stairDirection) return backward ? 'backward' : gait;
  const stairs = stairDirection === 'up' ? 'stairsUp' : 'stairsDown';
  return stairs + (backward ? 'Backward' : GAIT_SUFFIX[gait]);
}

export function kcalPerMinute(met) {
  return met * BODY_MASS_KG / 60;
}

/** Running totals of time, energy and distance, overall and per activity. */
export class EnergyTracker {
  constructor() {
    this.seconds = 0;
    this.kcal = 0;
    this.metres = 0;
    this.activity = 'standing';
    this.byActivity = Object.fromEntries(Object.keys(ACTIVITIES).map(key => [key, { seconds: 0, kcal: 0, metres: 0 }]));
  }

  /** Add `seconds` of `activity` covering `pixels` of map distance. */
  record(activity, seconds, pixels = 0) {
    const valid = ACTIVITIES[activity] && Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(pixels) && pixels >= 0;
    if (!valid) throw new Error('Invalid activity interval.');
    if (!seconds) return;
    const kcal = ACTIVITIES[activity].met * BODY_MASS_KG * seconds / 3600;
    const metres = pixels * METRES_PER_PIXEL;
    const row = this.byActivity[activity];
    row.seconds += seconds;
    row.kcal += kcal;
    row.metres += metres;
    this.seconds += seconds;
    this.kcal += kcal;
    this.metres += metres;
    this.activity = activity;
  }
}
