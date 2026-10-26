// Sampled events. Every pixel on every floor is an independent Poisson process with
// intensity `rate × max(0, pixel value)`. Events stay active until an explorer spots
// them; spotting is itself a Poisson process whose hazard is the sum of every explorer's
// detection hazard at the event. Spots are not credited to anyone: explorers are scored
// on the deterministic probability field instead (see probability.js).
//
// Both clocks are integrated exactly rather than per frame: each waiting time is an
// exponential "budget" of cumulative intensity that elapsed exposure uses up, so the
// results do not depend on how time is sliced.

import { valueAt } from './values.js';
import { hazardFromChance } from './detection.js';

/** Default arrival rate per second for a value-1 pixel: 0.00005 (50 × 10⁻⁶) arrivals per minute. */
export const EVENT_RATE = 50e-6 / 60;

/** How long a resolved event's highlight is shown, in seconds. */
const RESOLUTION_EFFECT_SECONDS = 1.8;

/** Number of resolved events kept for the recent-events feed. */
const RECENT_LIMIT = 5;

export class EventSimulation {
  constructor(map, random = Math.random) {
    this.map = map;
    this.random = random;
    this.rate = EVENT_RATE;
    this.elapsed = 0;
    this.active = [];
    this.resolvedFx = [];
    this.recent = [];
    this.spawned = 0;
    this.resolved = 0;

    // Every positive-weight pixel, encoded as floor × (width × height) + pixel index,
    // with running weight totals for sampling arrival locations by binary search.
    this.candidates = [];
    this.cumulative = [];
    this.totalWeight = 0;
    this.floorWeights = map.floors.map(() => 0);
    const floorSize = map.width * map.height;
    for (let floor = 0; floor < map.floors.length; floor++) {
      for (let i = 0; i < floorSize; i++) {
        const weight = Math.max(0, valueAt(map, i % map.width, Math.floor(i / map.width), floor));
        if (!weight) continue;
        this.totalWeight += weight;
        this.floorWeights[floor] += weight;
        this.candidates.push(floor * floorSize + i);
        this.cumulative.push(this.totalWeight);
      }
    }

    this.birthBudget = this.exponential();
  }

  /** A sample from the unit exponential distribution. */
  exponential() {
    return -Math.log(Math.max(1e-12, Math.min(1 - 1e-12, this.random())));
  }

  /** Weight of the candidate at position `j` in the candidate list. */
  weightAt(j) {
    return this.cumulative[j] - (j ? this.cumulative[j - 1] : 0);
  }

  /** Set the arrival rate per second for a value-1 pixel. Zero stops new arrivals. */
  setRate(rate) {
    if (!Number.isFinite(rate) || rate < 0) throw new Error('Event rate must be zero or positive.');
    this.rate = rate;
  }

  /** Create one event at a pixel chosen in proportion to its weight. */
  spawn() {
    if (!this.candidates.length) return null;
    const target = this.random() * this.totalWeight;
    let lo = 0, hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (target < this.cumulative[mid]) hi = mid;
      else lo = mid + 1;
    }
    const floorSize = this.map.width * this.map.height, encoded = this.candidates[lo], i = encoded % floorSize;
    const event = {
      id: ++this.spawned,
      x: i % this.map.width + 0.5,
      y: Math.floor(i / this.map.width) + 0.5,
      floor: Math.floor(encoded / floorSize),
      born: this.elapsed,
      detectionBudget: this.exponential(),
    };
    this.active.push(event);
    return event;
  }

  /** Expose every active event to the explorers' views for `seconds`, resolving spotted ones. */
  expose(seconds, world) {
    if (!seconds) return;
    const survivors = [];
    for (const event of this.active) {
      let hazard = 0;
      for (const explorer of world.explorers) {
        if (explorer.floorIndex === event.floor) hazard += hazardFromChance(explorer.detectionAt(event.x, event.y));
      }
      const exposure = hazard * seconds;
      if (hazard > 0 && event.detectionBudget <= exposure) {
        const resolvedAt = this.elapsed + event.detectionBudget / hazard;
        const result = { ...event, resolvedAt, wait: resolvedAt - event.born };
        this.resolved++;
        this.resolvedFx.push(result);
        this.recent.unshift(result);
        this.recent.length = Math.min(RECENT_LIMIT, this.recent.length);
      } else {
        event.detectionBudget -= exposure;
        survivors.push(event);
      }
    }
    this.active = survivors;
    this.elapsed += seconds;
    this.resolvedFx = this.resolvedFx.filter(event => this.elapsed - event.resolvedAt < RESOLUTION_EFFECT_SECONDS);
  }

  /** Advance by `seconds`, splitting the interval at each arrival. */
  advance(seconds, world) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid event interval.');
    let remaining = seconds;
    while (remaining > 1e-12) {
      const arrivalRate = this.rate * this.totalWeight;
      const untilArrival = arrivalRate > 0 ? this.birthBudget / arrivalRate : Infinity;
      const span = Math.min(remaining, untilArrival);
      this.expose(span, world);
      remaining -= span;
      if (untilArrival <= span) {
        this.spawn();
        this.birthBudget = this.exponential();
      } else if (arrivalRate > 0) {
        this.birthBudget -= arrivalRate * span;
      }
    }
  }
}
