// An Explore-mode session: one explorer moving through a map. It owns the explorer's
// position, floor, facing and posture, the door states, and the energy, event and
// probability models, all advanced together by `advance`.
//
// Exploring never changes saved map data: open doors stay encoded as door pixels, and
// the map's active floor is left to the caller. The explorer reads its own floor's
// pixels, so a view of another floor does not affect it.

import { MATERIAL } from './materials.js';
import { CHAIR_SIZE, EXPLORER_RADIUS, METRES_PER_PIXEL } from './scale.js';
import { circleHitsCell, circleOverlapsBox } from './geometry.js';
import { traceLine } from './raster.js';
import { ensureMap } from './map.js';
import { DOOR_TRIGGER_DISTANCE, doorDistance, groupDoors } from './doors.js';
import { connectsFloor, stairCrossingTarget, stairFlightDirection } from './stairs.js';
import { chairFront, isChairSpotClear } from './chairs.js';
import { ACTIVITIES, EnergyTracker, movementActivity } from './energy.js';
import { DETECTION_HALF_RANGE, FIELD_OF_VIEW, chanceOverTime, detectionChance } from './detection.js';
import { LOOK_OFFSETS, eccentricityDegrees, headingFromVector, headingVector } from './facing.js';
import { EventSimulation } from './events.js';
import { ProbabilityField } from './probability.js';

/** Longest simulated slice; movement, energy and events are integrated in slices this short. */
const MAX_SLICE_SECONDS = 0.05;

/** Collision substep length in pixels, short enough that the explorer cannot tunnel through walls. */
const MAX_SUBSTEP_PIXELS = 0.4;

/** Farthest the explorer may be from a chair's front standing position to sit. */
const SIT_REACH = 3.5;

const COS_HALF_FIELD_OF_VIEW = Math.cos(FIELD_OF_VIEW * Math.PI / 360);

export class World {
  /**
   * options.startIndex: which numbered start to begin from (default Start 1)
   * options.random:     random number source for the event simulation
   */
  constructor(map, options = {}) {
    this.energy = new EnergyTracker();
    this.gait = 'walk';
    this.look = 'forward';
    this.detectionHalfRange = DETECTION_HALF_RANGE;
    this.heading = 0; // direction of travel, an eight-direction index
    this.facing = 0; // direction of view: heading + the look offset
    this.sitting = false;
    this.seatedChair = null;
    this.seatExit = null;
    this.paused = false;

    this.map = ensureMap(map);
    this.floorDoors = this.map.floors.map(floor => groupDoors({ width: this.map.width, height: this.map.height, pixels: floor.pixels }));

    this.startIndex = options.startIndex ?? 0;
    if (!Number.isInteger(this.startIndex) || this.startIndex < 0 || this.startIndex >= this.map.starts.length) {
      throw new Error('Choose an existing numbered start.');
    }
    this.start = this.startIndex === 0 ? this.map.spawn : this.map.starts[this.startIndex];
    this.radius = EXPLORER_RADIUS;
    this.player = { x: this.start.x, y: this.start.y };

    this.time = 0;
    this.distance = 0; // pixels travelled
    this.floorChanges = 0;

    this.activateFloor(this.start.floor);
    this.moveToNearestClearSpot();
    this.events = new EventSimulation(this.map, options.random || Math.random);
    this.probabilities = new ProbabilityField(this.events);
  }

  // -------------------------------------------------------------------------
  // Floors, doors and collision

  activateFloor(index) {
    this.floorIndex = index;
    this.doors = this.floorDoors[index].doors;
    this.doorIds = this.floorDoors[index].ids;
  }

  /** The material at (x, y) on the current floor, with open doors as floor and outside the map as opaque. */
  effectiveMaterial(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    const { width, height } = this.map, pixels = this.map.floors[this.floorIndex].pixels;
    if (x < 0 || y < 0 || x >= width || y >= height) return MATERIAL.OPAQUE;
    const i = y * width + x, material = pixels[i];
    return material === MATERIAL.DOOR && this.doors[this.doorIds[i]].open ? MATERIAL.FLOOR : material;
  }

  /** Whether the explorer's body fits at (x, y) on the current floor. */
  canStand(x, y) {
    if (circleHitsCell(x, y, this.radius, (cellX, cellY) => this.effectiveMaterial(cellX, cellY) !== MATERIAL.FLOOR)) {
      return false;
    }
    for (const chair of this.map.chairs || []) {
      if (chair.floor !== this.floorIndex) continue;
      if (circleOverlapsBox(x, y, this.radius, chair.x, chair.y, CHAIR_SIZE, CHAIR_SIZE)) return false;
    }
    return true;
  }

  /** If the start is blocked, move to the closest pixel centre where the explorer fits. */
  moveToNearestClearSpot() {
    if (this.canStand(this.player.x, this.player.y)) return true;
    const { width, height } = this.map;
    let best = null, bestDistance = Infinity;
    for (let y = 2; y < height - 2; y++) {
      for (let x = 2; x < width - 2; x++) {
        if (!this.canStand(x + 0.5, y + 0.5)) continue;
        const distance = (x - this.start.x) ** 2 + (y - this.start.y) ** 2;
        if (distance < bestDistance) {
          best = { x: x + 0.5, y: y + 0.5 };
          bestDistance = distance;
        }
      }
    }
    if (!best) return false;
    this.player = best;
    return true;
  }

  doorDistance(door, x, y) {
    return doorDistance(door, this.map.width, x, y);
  }

  /** Open doors near the explorer and close all others, on every floor. Returns whether any changed. */
  updateDoors() {
    let changed = false;
    this.floorDoors.forEach(({ doors }, floor) => {
      for (const door of doors) {
        const near = floor === this.floorIndex && this.doorDistance(door, this.player.x, this.player.y) <= DOOR_TRIGGER_DISTANCE;
        if (door.open === near) continue;
        door.open = near;
        changed = true;
      }
    });
    return changed;
  }

  // -------------------------------------------------------------------------
  // Movement

  /**
   * Move the explorer to (x, y) if it fits. Crossing a stair's floor-change line moves
   * the explorer to the other floor, checking for room on the destination floor first.
   */
  tryMove(x, y) {
    for (const stair of this.map.stairs) {
      if (!connectsFloor(stair, this.floorIndex)) continue;
      const destination = stairCrossingTarget(stair, this.floorIndex, this.player, { x, y }, this.radius);
      if (destination === null) continue;
      const origin = this.floorIndex;
      this.activateFloor(destination);
      if (this.canStand(x, y)) {
        this.player.x = x;
        this.player.y = y;
        this.floorChanges++;
        return true;
      }
      this.activateFloor(origin);
      return false;
    }
    if (!this.canStand(x, y)) return false;
    this.player.x = x;
    this.player.y = y;
    return true;
  }

  /**
   * Low-level movement step of at most MAX_SLICE_SECONDS in direction (dx, dy) at
   * `speed` pixels per second. Each axis is moved separately in short substeps so the
   * explorer slides along walls. `onSegment(start, floor, seconds, distance)` is
   * called after every substep. Returns whether the floor or any door changed.
   */
  step(dt, dx, dy, speed = 24, onSegment = null) {
    dt = Math.max(0, Math.min(dt, MAX_SLICE_SECONDS));
    this.time += dt;
    let changed = this.updateDoors();
    const startFloor = this.floorIndex;
    const length = Math.hypot(dx, dy);
    if (length) {
      dx /= length;
      dy /= length;
      const amount = speed * dt, substeps = Math.max(1, Math.ceil(amount / MAX_SUBSTEP_PIXELS));
      for (let i = 0; i < substeps; i++) {
        const start = { x: this.player.x, y: this.player.y }, floor = this.floorIndex;
        this.tryMove(start.x + dx * amount / substeps, start.y);
        this.tryMove(this.player.x, this.player.y + dy * amount / substeps);
        const distance = Math.hypot(this.player.x - start.x, this.player.y - start.y);
        this.distance += distance;
        if (onSegment) onSegment(start, floor, dt / substeps, distance);
      }
    }
    changed = this.updateDoors() || changed;
    return startFloor !== this.floorIndex || changed;
  }

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
    const length = Math.hypot(dx, dy);
    let moving = length > 0;
    if (moving && this.sitting && !this.setSitting(false)) moving = false;
    if (moving) this.orient(dx, dy);

    let remaining = dt, changed = false;
    while (remaining > 1e-9) {
      const slice = Math.min(remaining, MAX_SLICE_SECONDS);
      remaining -= slice;
      if (!moving) {
        changed = this.step(slice, 0, 0) || changed;
        this.energy.record(this.sitting ? 'sitting' : 'standing', slice);
        this.events.advance(slice, this);
        continue;
      }
      // Choose the speed from what a tiny step in the travel direction would be.
      const from = { ...this.player };
      const probe = { x: from.x + dx / length * 0.01, y: from.y + dy / length * 0.01 };
      const speed = ACTIVITIES[this.activityFor(this.stairDirection(from, probe))].speed / METRES_PER_PIXEL;
      const recordSegment = (start, floor, seconds, distance) => {
        // A blocked attempt counts as standing.
        const activity = distance > 1e-8 ? this.activityFor(this.stairDirection(start, this.player, floor, this.floorIndex)) : 'standing';
        this.energy.record(activity, seconds, distance);
      };
      changed = this.step(slice, dx, dy, speed, recordSegment) || changed;
      this.events.advance(slice, this);
      this.probabilities.advance(slice, this);
    }
    // Standing still keeps the pose fixed, so the probability field takes one exact step.
    if (!moving) this.probabilities.advance(dt, this);
    return changed;
  }

  /** 'up', 'down' or null for a movement segment that starts on `floor` and ends on `endFloor`. */
  stairDirection(from, to, floor = this.floorIndex, endFloor = floor) {
    for (const stair of this.map.stairs) {
      if (!connectsFloor(stair, floor)) continue;
      const direction = stairFlightDirection(stair, floor, endFloor, from, to);
      if (direction) return direction;
    }
    return null;
  }

  activityFor(stairDirection) {
    return movementActivity(this.gait, this.look, stairDirection);
  }

  setGait(gait) {
    if (!['walk', 'run', 'sprint'].includes(gait)) throw new Error('Choose walking, running or sprinting.');
    this.gait = gait;
  }

  // -------------------------------------------------------------------------
  // Facing and sight

  setLook(look) {
    if (!Object.hasOwn(LOOK_OFFSETS, look)) throw new Error('Choose one of the eight look directions.');
    this.look = look;
    this.facing = (this.heading + LOOK_OFFSETS[look]) % 8;
  }

  /** Turn to travel in direction (dx, dy), keeping the look offset. */
  orient(dx, dy) {
    if (!dx && !dy) return;
    this.heading = headingFromVector(dx, dy);
    this.facing = (this.heading + LOOK_OFFSETS[this.look]) % 8;
  }

  inFieldOfView(x, y) {
    const dx = x - this.player.x, dy = y - this.player.y, distance = Math.hypot(dx, dy);
    if (distance < 1e-9) return true;
    const heading = headingVector(this.facing);
    return (dx * heading.x + dy * heading.y) / distance >= COS_HALF_FIELD_OF_VIEW - 1e-10;
  }

  blocksSight(x, y) {
    const material = this.effectiveMaterial(x, y);
    return material === MATERIAL.OPAQUE || material === MATERIAL.DOOR;
  }

  /** In the field of view with no opaque pixel or closed door between the explorer and (x, y). */
  visibleTo(x, y) {
    if (!this.inFieldOfView(x, y)) return false;
    const from = { x: Math.floor(this.player.x), y: Math.floor(this.player.y) };
    const to = { x: Math.floor(x), y: Math.floor(y) };
    return traceLine(from, to, (cellX, cellY) => {
      const isEndpoint = (cellX === from.x && cellY === from.y) || (cellX === to.x && cellY === to.y);
      return isEndpoint || !this.blocksSight(cellX, cellY);
    });
  }

  setDetectionHalfRange(metres) {
    if (!Number.isFinite(metres) || metres <= 0) throw new Error('Detection half-distance must be positive.');
    this.detectionHalfRange = metres;
  }

  /** One-second detection probability for a point, taking sight lines into account. */
  pointDetectionChance(x, y) {
    if (!this.visibleTo(x, y)) return 0;
    const dx = x - this.player.x, dy = y - this.player.y, distance = Math.hypot(dx, dy);
    const eccentricity = distance ? eccentricityDegrees(dx, dy, headingVector(this.facing)) : 0;
    return detectionChance(distance * METRES_PER_PIXEL, eccentricity, this.detectionHalfRange);
  }

  /**
   * Probability of detecting an event at (x, y) on the current floor within `seconds`.
   * An opaque pixel is seen through its surface: it takes the best chance among its
   * edge-adjacent see-through neighbours (floor, transparent mass, open doors).
   */
  detectionAt(x, y, seconds = 1) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(seconds) || seconds < 0) {
      throw new Error('Invalid detection query.');
    }
    const cellX = Math.floor(x), cellY = Math.floor(y), { width, height } = this.map;
    if (!seconds || cellX < 0 || cellY < 0 || cellX >= width || cellY >= height) return 0;
    let chance = 0;
    if (this.map.floors[this.floorIndex].pixels[cellY * width + cellX] === MATERIAL.OPAQUE) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = cellX + dx, ny = cellY + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const material = this.effectiveMaterial(nx, ny);
        if (material === MATERIAL.FLOOR || material === MATERIAL.TRANSPARENT) {
          chance = Math.max(chance, this.pointDetectionChance(nx + 0.5, ny + 0.5));
        }
      }
    } else {
      chance = this.pointDetectionChance(x, y);
    }
    return chanceOverTime(chance, seconds);
  }

  // -------------------------------------------------------------------------
  // Sitting

  /** The closest usable chair on this floor whose front can be reached in a straight line. */
  nearbyChair() {
    let nearest = null, best = Infinity;
    for (const chair of this.map.chairs || []) {
      if (chair.floor !== this.floorIndex || !isChairSpotClear(this.map, chair)) continue;
      const front = chairFront(chair, this.radius);
      const distance = Math.hypot(this.player.x - front.x, this.player.y - front.y);
      if (distance > SIT_REACH || distance >= best || !this.canStand(front.x, front.y)) continue;
      if (!this.pathIsClear(front, distance)) continue;
      nearest = chair;
      best = distance;
    }
    return nearest;
  }

  /** Whether the explorer could walk straight from its position to `target`. */
  pathIsClear(target, distance) {
    const samples = Math.max(1, Math.ceil(distance / 0.25));
    for (let i = 0; i <= samples; i++) {
      const x = this.player.x + (target.x - this.player.x) * i / samples;
      const y = this.player.y + (target.y - this.player.y) * i / samples;
      if (!this.canStand(x, y)) return false;
    }
    return true;
  }

  /**
   * Sit on the nearby chair, or stand up at its front (or where the explorer was before
   * sitting). Returns false when there is no chair to sit on or no clear spot to stand.
   */
  setSitting(sitting) {
    if (sitting) {
      if (this.sitting) return true;
      const chair = this.nearbyChair();
      if (!chair) return false;
      this.seatExit = { ...this.player };
      this.seatedChair = chair.id;
      this.player = { x: chair.x + CHAIR_SIZE / 2, y: chair.y + CHAIR_SIZE / 2 };
      this.sitting = true;
      this.heading = chair.rotation / 45;
      this.setLook(this.look);
      this.energy.activity = 'sitting';
      return true;
    }
    if (this.sitting) {
      const chair = this.map.chairs.find(c => c.id === this.seatedChair && c.floor === this.floorIndex);
      const front = chair ? chairFront(chair, this.radius) : null;
      let exit = null;
      if (front && this.canStand(front.x, front.y)) exit = front;
      else if (this.seatExit && this.canStand(this.seatExit.x, this.seatExit.y)) exit = this.seatExit;
      if (!exit) return false;
      this.player = { ...exit };
    }
    this.sitting = false;
    this.seatedChair = null;
    this.seatExit = null;
    this.energy.activity = 'standing';
    return true;
  }
}
