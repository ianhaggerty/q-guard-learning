// An Explore-mode session: an explorer moving through a map. The world owns what does
// not belong to the explorer — the door states, the clock, and the event and probability
// models — and advances everything together. The Explorer owns its position, floor,
// facing, posture and energy.
//
// The world's own explorer API (`world.player`, `world.advance(dt, dx, dy)`,
// `world.setLook` ...) acts on its primary explorer.
//
// Exploring never changes saved map data: open doors stay encoded as door pixels, and
// the map's active floor is left to the caller.

import { METRES_PER_PIXEL } from './scale.js';
import { ensureMap } from './map.js';
import { DOOR_TRIGGER_DISTANCE, doorDistance, groupDoors } from './doors.js';
import { ACTIVITIES } from './energy.js';
import { DETECTION_HALF_RANGE } from './detection.js';
import { EventSimulation } from './events.js';
import { ProbabilityField } from './probability.js';
import { Explorer } from './explorer.js';

/** Longest simulated slice; movement, energy and events are integrated in slices this short. */
const MAX_SLICE_SECONDS = 0.05;

export class World {
  /**
   * options.startIndex: which numbered start to begin from (default Start 1)
   * options.random:     random number source for the event simulation
   */
  constructor(map, options = {}) {
    this.map = ensureMap(map);
    this.floorDoors = this.map.floors.map(floor => groupDoors({ width: this.map.width, height: this.map.height, pixels: floor.pixels }));
    this.detectionHalfRange = DETECTION_HALF_RANGE;
    this.paused = false;
    this.time = 0;

    const startIndex = options.startIndex ?? 0;
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= this.map.starts.length) {
      throw new Error('Choose an existing numbered start.');
    }
    this.explorers = [new Explorer(this, 1, startIndex)];
    this.primary.moveToNearestClearSpot();

    this.events = new EventSimulation(this.map, options.random || Math.random);
    this.probabilities = new ProbabilityField(this.events);
  }

  /** The explorer the single-explorer API below acts on. */
  get primary() {
    return this.explorers[0];
  }

  // -------------------------------------------------------------------------
  // Doors

  /** Open doors near the explorer and close all others, on every floor. Returns whether any changed. */
  updateDoors() {
    let changed = false;
    const explorer = this.primary;
    this.floorDoors.forEach(({ doors }, floor) => {
      for (const door of doors) {
        const near = explorer.floorIndex === floor
          && doorDistance(door, this.map.width, explorer.position.x, explorer.position.y) <= DOOR_TRIGGER_DISTANCE;
        if (door.open === near) continue;
        door.open = near;
        changed = true;
      }
    });
    return changed;
  }

  // -------------------------------------------------------------------------
  // Time

  /**
   * Advance the whole simulation by `dt` seconds while the explorer tries to move in
   * direction (dx, dy) (both zero to stay still). Time is integrated in slices of at
   * most MAX_SLICE_SECONDS; energy is charged per substep for the activity actually
   * performed. Returns whether the floor or any door changed.
   */
  advance(dt, dx = 0, dy = 0) {
    if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error('Invalid simulation interval.');
    }
    if (this.paused || !dt) return false;
    const explorer = this.primary, length = Math.hypot(dx, dy);
    let moving = length > 0;
    if (moving && explorer.sitting && !explorer.setSitting(false)) moving = false;
    if (moving) explorer.orient(dx, dy);

    let remaining = dt, changed = false;
    while (remaining > 1e-9) {
      const slice = Math.min(remaining, MAX_SLICE_SECONDS);
      remaining -= slice;
      if (!moving) {
        changed = this.step(slice, 0, 0) || changed;
        explorer.energy.record(explorer.sitting ? 'sitting' : 'standing', slice);
        this.events.advance(slice, this);
        continue;
      }
      // Choose the speed from what a tiny step in the travel direction would be.
      const from = { ...explorer.position };
      const probe = { x: from.x + dx / length * 0.01, y: from.y + dy / length * 0.01 };
      const speed = ACTIVITIES[explorer.activityFor(explorer.stairDirection(from, probe))].speed / METRES_PER_PIXEL;
      const recordSegment = (start, floor, seconds, distance) => {
        // A blocked attempt counts as standing.
        const activity = distance > 1e-8
          ? explorer.activityFor(explorer.stairDirection(start, explorer.position, floor, explorer.floorIndex))
          : 'standing';
        explorer.energy.record(activity, seconds, distance);
      };
      changed = this.step(slice, dx, dy, speed, recordSegment) || changed;
      this.events.advance(slice, this);
      this.probabilities.advance(slice, this);
    }
    // Standing still keeps the pose fixed, so the probability field takes one exact step.
    if (!moving) this.probabilities.advance(dt, this);
    return changed;
  }

  /**
   * Low-level step of at most MAX_SLICE_SECONDS: the explorer moves in direction (dx, dy)
   * at `speed` pixels per second, with doors updated before and after. Returns whether
   * the floor or any door changed.
   */
  step(dt, dx, dy, speed = 24, onSegment = null) {
    dt = Math.max(0, Math.min(dt, MAX_SLICE_SECONDS));
    this.time += dt;
    let changed = this.updateDoors();
    const explorer = this.primary, startFloor = explorer.floorIndex;
    explorer.move(dt, dx, dy, speed, onSegment);
    changed = this.updateDoors() || changed;
    return startFloor !== explorer.floorIndex || changed;
  }

  setDetectionHalfRange(metres) {
    if (!Number.isFinite(metres) || metres <= 0) throw new Error('Detection half-distance must be positive.');
    this.detectionHalfRange = metres;
  }

  // -------------------------------------------------------------------------
  // Single-explorer API: the primary explorer's state and actions

  get player() { return this.primary.position; }
  set player(position) { this.primary.position = position; }
  get heading() { return this.primary.heading; }
  set heading(heading) { this.primary.heading = heading; }
  get facing() { return this.primary.facing; }
  get look() { return this.primary.look; }
  get gait() { return this.primary.gait; }
  get sitting() { return this.primary.sitting; }
  get seatedChair() { return this.primary.seatedChair; }
  get seatExit() { return this.primary.seatExit; }
  get energy() { return this.primary.energy; }
  get distance() { return this.primary.distance; }
  get floorChanges() { return this.primary.floorChanges; }
  get floorIndex() { return this.primary.floorIndex; }
  get radius() { return this.primary.radius; }
  get start() { return this.primary.start; }
  get startIndex() { return this.primary.startIndex; }
  get doors() { return this.primary.doors; }
  get doorIds() { return this.primary.doorIds; }

  activateFloor(index) { this.primary.activateFloor(index); }
  effectiveMaterial(x, y) { return this.primary.effectiveMaterial(x, y); }
  canStand(x, y) { return this.primary.canStand(x, y); }
  moveToNearestClearSpot() { return this.primary.moveToNearestClearSpot(); }
  doorDistance(door, x, y) { return this.primary.doorDistance(door, x, y); }
  tryMove(x, y) { return this.primary.tryMove(x, y); }
  stairDirection(from, to, floor, endFloor) { return this.primary.stairDirection(from, to, floor, endFloor); }
  activityFor(stairDirection) { return this.primary.activityFor(stairDirection); }
  setGait(gait) { this.primary.setGait(gait); }
  setLook(look) { this.primary.setLook(look); }
  orient(dx, dy) { this.primary.orient(dx, dy); }
  inFieldOfView(x, y) { return this.primary.inFieldOfView(x, y); }
  blocksSight(x, y) { return this.primary.blocksSight(x, y); }
  visibleTo(x, y) { return this.primary.visibleTo(x, y); }
  pointDetectionChance(x, y) { return this.primary.pointDetectionChance(x, y); }
  detectionAt(x, y, seconds) { return this.primary.detectionAt(x, y, seconds); }
  nearbyChair() { return this.primary.nearbyChair(); }
  pathIsClear(target, distance) { return this.primary.pathIsClear(target, distance); }
  setSitting(sitting) { return this.primary.setSitting(sitting); }
}
