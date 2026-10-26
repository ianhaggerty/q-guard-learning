// An Explore-mode session: one or more explorers moving through a map. The world owns
// what explorers share — the door states, the clock, and the event and probability
// models — and advances everything together. Each Explorer owns its own position, floor,
// facing, posture, energy and score.
//
// Rules for several explorers (the same as the Python training simulator's):
//   * a door is open while any explorer on its floor is near it, and it is open for
//     everyone, sight included;
//   * explorers do not collide with each other;
//   * a chair holds one explorer;
//   * detection hazards of different explorers add, and the probability field's detection
//     reduction is credited to explorers in proportion to their hazards.
// The Python simulator differs in one respect: it precomputes sight with only the doors
// near the viewer open, so it cannot see through a door another guard holds open.
//
// Most single-explorer sessions use the World's own explorer API (`world.player`,
// `world.advance(dt, dx, dy)`, `world.setLook` ...), which acts on the primary explorer.
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
   * options.startIndex: which numbered start the primary explorer begins from (default Start 1)
   * options.empty:      start with no explorers; add them with addExplorer
   * options.random:     random number source for the event simulation
   * options.sightCacheBytes: memory for line of sight shared by the explorers (see sight.js)
   */
  constructor(map, options = {}) {
    this.map = ensureMap(map);
    this.floorDoors = this.map.floors.map(floor => groupDoors({ width: this.map.width, height: this.map.height, pixels: floor.pixels }));
    this.detectionHalfRange = DETECTION_HALF_RANGE;
    this.paused = false;
    this.time = 0;

    this.explorers = [];
    this.nextExplorerId = 1;
    if (!options.empty) this.addExplorer({ startIndex: options.startIndex ?? 0 });

    this.events = new EventSimulation(this.map, options.random || Math.random);
    this.probabilities = new ProbabilityField(this.events, { sightCacheBytes: options.sightCacheBytes });
  }

  // -------------------------------------------------------------------------
  // Explorers

  /**
   * Add an explorer at numbered start `startIndex` (moved to the nearest clear spot if the
   * start is blocked). `id` defaults to the next unused number. Returns the Explorer.
   */
  addExplorer({ startIndex = 0, id = this.nextExplorerId } = {}) {
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= this.map.starts.length) {
      throw new Error('Choose an existing numbered start.');
    }
    if (this.explorers.some(explorer => explorer.id === id)) throw new Error('Each explorer needs its own id.');
    if (Number.isInteger(id) && id >= this.nextExplorerId) this.nextExplorerId = id + 1;
    const explorer = new Explorer(this, id, startIndex);
    explorer.moveToNearestClearSpot();
    this.explorers.push(explorer);
    return explorer;
  }

  /** Remove an explorer; its chair is freed and its doors close on the next advance. Returns whether it was here. */
  removeExplorer(explorer) {
    const index = this.explorers.indexOf(explorer);
    if (index === -1) return false;
    this.explorers.splice(index, 1);
    return true;
  }

  /** The first explorer, which the single-explorer API below acts on. */
  get primary() {
    return this.explorers[0];
  }

  // -------------------------------------------------------------------------
  // Doors

  /** Open every door with an explorer on its floor nearby and close all others. Returns whether any changed. */
  updateDoors() {
    let changed = false;
    this.floorDoors.forEach(({ doors }, floor) => {
      for (const door of doors) {
        const near = this.explorers.some(explorer => explorer.floorIndex === floor
          && doorDistance(door, this.map.width, explorer.position.x, explorer.position.y) <= DOOR_TRIGGER_DISTANCE);
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
   * Advance the whole simulation by `dt` seconds, moving each explorer in its
   * `movement` direction (see Explorer.setMovement). Time is integrated in slices of at
   * most MAX_SLICE_SECONDS; within a slice the doors update, every explorer moves, the
   * doors update again, and then events and the probability field advance. Energy is
   * charged per substep for the activity actually performed. Returns whether any
   * explorer's floor or any door changed.
   *
   * Explorers move in the order they were added, which matters only through doors.
   * Calling this with whole slices (dt = 0.05 s) makes every call the same unit of work,
   * so worlds given the same inputs stay identical.
   */
  advanceAll(dt) {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('Invalid simulation interval.');
    if (this.paused || !dt) return false;
    const plans = this.explorers.map(explorer => planMovement(explorer));
    const anyMoving = plans.some(plan => plan.moving);

    let remaining = dt, changed = false;
    while (remaining > 1e-9) {
      const slice = Math.min(remaining, MAX_SLICE_SECONDS);
      remaining -= slice;
      this.time += slice;
      changed = this.updateDoors() || changed;
      for (const plan of plans) changed = moveFor(plan, slice) || changed;
      changed = this.updateDoors() || changed;
      this.events.advance(slice, this);
      if (anyMoving) this.probabilities.advance(slice, this);
    }
    // With every pose fixed, the probability field takes one exact step.
    if (!anyMoving) this.probabilities.advance(dt, this);
    return changed;
  }

  /**
   * Advance by `dt` seconds while the primary explorer tries to move in direction (dx, dy)
   * (both zero to stay still). Other explorers keep their own movement.
   */
  advance(dt, dx = 0, dy = 0) {
    if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error('Invalid simulation interval.');
    }
    this.primary?.setMovement(dx, dy);
    return this.advanceAll(dt);
  }

  /**
   * Low-level step of at most MAX_SLICE_SECONDS: the primary explorer moves in direction
   * (dx, dy) at `speed` pixels per second, with doors updated before and after. Events,
   * energy and the probability field do not advance. Returns whether the floor or any
   * door changed.
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

/** An explorer's movement for one advance: it stands up first if it is sitting and wants to move. */
function planMovement(explorer) {
  const { dx, dy } = explorer.movement, length = Math.hypot(dx, dy);
  let moving = length > 0;
  if (moving && explorer.sitting && !explorer.setSitting(false)) moving = false;
  if (moving) explorer.orient(dx, dy);
  return { explorer, moving, dx, dy, length };
}

/** Move a planned explorer for one slice, charging energy per substep. Returns whether its floor changed. */
function moveFor({ explorer, moving, dx, dy, length }, slice) {
  if (!moving) {
    explorer.energy.record(explorer.sitting ? 'sitting' : 'standing', slice);
    return false;
  }
  // Choose the speed from what a tiny step in the travel direction would be.
  const from = { ...explorer.position }, startFloor = explorer.floorIndex;
  const probe = { x: from.x + dx / length * 0.01, y: from.y + dy / length * 0.01 };
  const speed = ACTIVITIES[explorer.activityFor(explorer.stairDirection(from, probe))].speed / METRES_PER_PIXEL;
  explorer.move(slice, dx, dy, speed, (start, floor, seconds, distance) => {
    // A blocked attempt counts as standing.
    const activity = distance > 1e-8
      ? explorer.activityFor(explorer.stairDirection(start, explorer.position, floor, explorer.floorIndex))
      : 'standing';
    explorer.energy.record(activity, seconds, distance);
  });
  return explorer.floorIndex !== startFloor;
}
