// The deterministic counterpart of the sampled events. For every positive-weight pixel
// it tracks m, the expected number of unresolved events, from an initially clear map:
//
//   dm/dt = λ − μ m,   λ = rate × pixel weight,   μ = detection hazard at the pixel
//
// integrated exactly over each interval at a fixed pose. The pixel's chance of holding
// at least one unresolved event is P = 1 − e^(−m), and `sum` adds P over every pixel of
// every floor: the expected number of occupied pixels. The model never looks at the
// sampled events, so a sampled detection does not reset it.
//
// With several explorers, μ is the sum of their hazards, and each explorer is credited
// with its hazard's share of the reduction in P that detection achieves.

import { METRES_PER_PIXEL } from './scale.js';
import { MATERIAL } from './materials.js';
import { detectionChance, hazardFromChance } from './detection.js';
import { eccentricityDegrees, headingVector } from './facing.js';

/** The closed-form solution of dm/dt = λ − μm over `seconds`, without input checks. */
function integrateMean(mean, arrivalRate, detectionRate, seconds) {
  if (!detectionRate) return mean + arrivalRate * seconds;
  const loss = -Math.expm1(-detectionRate * seconds);
  return mean * (1 - loss) + arrivalRate * loss / detectionRate;
}

export function updateUnresolvedMean(mean, arrivalRate, detectionRate, seconds) {
  if ([mean, arrivalRate, detectionRate, seconds].some(n => !Number.isFinite(n) || n < 0)) {
    throw new Error('Probability model inputs must be finite and nonnegative.');
  }
  return integrateMean(mean, arrivalRate, detectionRate, seconds);
}

const SIGHT_UNKNOWN = 0, SIGHT_VISIBLE = 1, SIGHT_HIDDEN = 2;

export class ProbabilityField {
  constructor(events) {
    this.events = events;
    this.map = events.map;
    const count = events.candidates.length;
    this.means = new Float64Array(count);
    this.hazards = new Float64Array(count); // every explorer's hazard added together
    this.floorSums = new Float64Array(this.map.floors.length);
    this.sum = 0;
    this.elapsed = 0;
    // Each explorer's own hazards, recomputed only when something that affects them
    // changes. Line of sight is cached separately and only depends on the explorer's pixel.
    this.views = new Map();
  }

  advance(seconds, world) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid probability interval.');
    if (!seconds) return;
    let changed = false;
    for (const explorer of this.views.keys()) {
      if (world.explorers.includes(explorer)) continue;
      this.views.delete(explorer);
      changed = true;
    }
    for (const explorer of world.explorers) changed = this.updateView(explorer, world) || changed;
    if (changed) this.combineHazards(world.explorers);
    this.integrate(seconds, world.explorers);
  }

  /** Bring an explorer's hazards up to date with its pose. Returns whether they were recomputed. */
  updateView(explorer, world) {
    let view = this.views.get(explorer);
    if (!view) {
      const count = this.events.candidates.length;
      view = { poseKey: null, sightKey: null, sightCache: new Uint8Array(count), hazards: new Float64Array(count) };
      this.views.set(explorer, view);
    }
    const doorStates = explorer.doors.map(door => +door.open);
    const { position, floorIndex, facing } = explorer;
    const poseKey = [position.x, position.y, floorIndex, facing, world.detectionHalfRange, ...doorStates].join(':');
    if (poseKey === view.poseKey) return false;
    view.poseKey = poseKey;
    this.updateHazards(view, explorer, world, doorStates);
    return true;
  }

  /** Recompute each candidate pixel's detection hazard for one explorer's current pose. */
  updateHazards(view, explorer, world, doorStates) {
    const { position, floorIndex } = explorer;
    const sightKey = [Math.floor(position.x), Math.floor(position.y), floorIndex, ...doorStates].join(':');
    if (sightKey !== view.sightKey) {
      view.sightKey = sightKey;
      view.sightCache.fill(SIGHT_UNKNOWN);
    }
    const { candidates } = this.events, width = this.map.width, floorSize = width * this.map.height;
    const pixels = this.map.floors[floorIndex].pixels, heading = headingVector(explorer.facing);
    for (let j = 0; j < candidates.length; j++) {
      const floor = Math.floor(candidates[j] / floorSize), i = candidates[j] % floorSize;
      let chance = 0;
      if (floor === floorIndex && pixels[i] === MATERIAL.OPAQUE) {
        // Wall surfaces are seen through their neighbours; Explorer handles that rule.
        chance = explorer.detectionAt(i % width + 0.5, Math.floor(i / width) + 0.5);
      } else if (floor === floorIndex) {
        const x = i % width + 0.5, y = Math.floor(i / width) + 0.5;
        const dx = x - position.x, dy = y - position.y, distance = Math.hypot(dx, dy);
        const eccentricity = distance ? eccentricityDegrees(dx, dy, heading) : 0;
        chance = detectionChance(distance * METRES_PER_PIXEL, eccentricity, world.detectionHalfRange);
        if (chance > 0) {
          if (view.sightCache[j] === SIGHT_UNKNOWN) view.sightCache[j] = explorer.visibleTo(x, y) ? SIGHT_VISIBLE : SIGHT_HIDDEN;
          if (view.sightCache[j] === SIGHT_HIDDEN) chance = 0;
        }
      }
      view.hazards[j] = hazardFromChance(chance);
    }
  }

  /** Detections by different explorers are independent Poisson processes, so hazards add. */
  combineHazards(explorers) {
    this.hazards.fill(0);
    for (const explorer of explorers) {
      const own = this.views.get(explorer).hazards;
      for (let j = 0; j < this.hazards.length; j++) this.hazards[j] += own[j];
    }
  }

  /**
   * Integrate every pixel over `seconds` at the current hazards and credit `explorers`
   * with the detection reduction: for each pixel, its occupancy had nobody been looking
   * minus its actual occupancy, shared in proportion to each explorer's hazard there.
   * This is the reward the guard agents are trained on (artifacts/guardrl/sim.py).
   */
  integrate(seconds, explorers = []) {
    const { candidates, rate } = this.events, floorSize = this.map.width * this.map.height;
    const views = explorers.map(explorer => this.views.get(explorer));
    this.sum = 0;
    this.floorSums.fill(0);
    for (let j = 0; j < candidates.length; j++) {
      const mean = this.means[j], arrivalRate = rate * this.events.weightAt(j), hazard = this.hazards[j];
      this.means[j] = integrateMean(mean, arrivalRate, hazard, seconds);
      if (hazard > 0) {
        const reduction = Math.exp(-this.means[j]) - Math.exp(-(mean + arrivalRate * seconds));
        if (reduction > 0) {
          for (let k = 0; k < explorers.length; k++) {
            const own = views[k].hazards[j];
            if (own > 0) explorers[k].credit += reduction * own / hazard;
          }
        }
      }
      const occupied = -Math.expm1(-this.means[j]);
      this.sum += occupied;
      this.floorSums[Math.floor(candidates[j] / floorSize)] += occupied;
    }
    this.elapsed += seconds;
  }

  /** Probability that pixel (x, y) on `floor` holds at least one unresolved event. */
  probabilityAt(x, y, floor = this.map.activeFloor) {
    const { width, height } = this.map;
    const valid = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < width && y < height
      && Number.isInteger(floor) && floor >= 0 && floor < this.map.floors.length;
    if (!valid) return 0;
    const target = floor * width * height + Math.floor(y) * width + Math.floor(x);
    const candidates = this.events.candidates;
    let lo = 0, hi = candidates.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[mid] === target) return -Math.expm1(-this.means[mid]);
      if (candidates[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return 0;
  }
}
