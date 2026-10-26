// The deterministic counterpart of the sampled events. For every positive-weight pixel
// it tracks m, the expected number of unresolved events, from an initially clear map:
//
//   dm/dt = λ − μ m,   λ = rate × pixel weight,   μ = detection hazard at the pixel
//
// integrated exactly over each interval at a fixed pose. The pixel's chance of holding
// at least one unresolved event is P = 1 − e^(−m), and `sum` adds P over every pixel of
// every floor: the expected number of occupied pixels. The model never looks at the
// sampled events, so a sampled detection does not reset it.

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
    this.hazards = new Float64Array(count);
    this.floorSums = new Float64Array(this.map.floors.length);
    this.sum = 0;
    this.elapsed = 0;
    // Hazards are recomputed only when something that affects them changes. Line of
    // sight is cached separately and only depends on the explorer's pixel.
    this.poseKey = null;
    this.sightKey = null;
    this.sightCache = new Uint8Array(count);
  }

  advance(seconds, world) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid probability interval.');
    if (!seconds) return;
    const doorStates = world.doors.map(door => +door.open);
    const poseKey = [world.player.x, world.player.y, world.floorIndex, world.facing, world.detectionHalfRange, ...doorStates].join(':');
    if (poseKey !== this.poseKey) {
      this.poseKey = poseKey;
      this.updateHazards(world, doorStates);
    }
    this.integrate(seconds);
  }

  /** Recompute each candidate pixel's detection hazard for the current pose. */
  updateHazards(world, doorStates) {
    const sightKey = [Math.floor(world.player.x), Math.floor(world.player.y), world.floorIndex, ...doorStates].join(':');
    if (sightKey !== this.sightKey) {
      this.sightKey = sightKey;
      this.sightCache.fill(SIGHT_UNKNOWN);
    }
    const { candidates } = this.events, width = this.map.width, floorSize = width * this.map.height;
    const heading = headingVector(world.facing);
    for (let j = 0; j < candidates.length; j++) {
      const floor = Math.floor(candidates[j] / floorSize), i = candidates[j] % floorSize;
      let chance = 0;
      if (floor === world.floorIndex && world.map.pixels[i] === MATERIAL.OPAQUE) {
        // Wall surfaces are seen through their neighbours; World handles that rule.
        chance = world.detectionAt(i % width + 0.5, Math.floor(i / width) + 0.5);
      } else if (floor === world.floorIndex) {
        const x = i % width + 0.5, y = Math.floor(i / width) + 0.5;
        const dx = x - world.player.x, dy = y - world.player.y, distance = Math.hypot(dx, dy);
        const eccentricity = distance ? eccentricityDegrees(dx, dy, heading) : 0;
        chance = detectionChance(distance * METRES_PER_PIXEL, eccentricity, world.detectionHalfRange);
        if (chance > 0) {
          if (this.sightCache[j] === SIGHT_UNKNOWN) this.sightCache[j] = world.visibleTo(x, y) ? SIGHT_VISIBLE : SIGHT_HIDDEN;
          if (this.sightCache[j] === SIGHT_HIDDEN) chance = 0;
        }
      }
      this.hazards[j] = hazardFromChance(chance);
    }
  }

  integrate(seconds) {
    const { candidates, rate } = this.events, floorSize = this.map.width * this.map.height;
    this.sum = 0;
    this.floorSums.fill(0);
    for (let j = 0; j < candidates.length; j++) {
      this.means[j] = integrateMean(this.means[j], rate * this.events.weightAt(j), this.hazards[j], seconds);
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
