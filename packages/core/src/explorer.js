// One explorer in a World: a person or an agent with its own position, floor, facing,
// posture and energy. Explorers share the world's doors, events and probability
// field, and they pass through each other.
//
// An explorer reads its own floor's pixels, never map.activeFloor, so explorers on
// different floors do not disturb each other or the map.

import { MATERIAL } from './materials.js';
import { CHAIR_SIZE, EXPLORER_RADIUS, METRES_PER_PIXEL } from './scale.js';
import { circleHitsCell, circleOverlapsBox } from './geometry.js';
import { traceLine } from './raster.js';
import { doorDistance } from './doors.js';
import { connectsFloor, stairCrossingTarget, stairFlightDirection } from './stairs.js';
import { chairFront, isChairSpotClear } from './chairs.js';
import { EnergyTracker, movementActivity } from './energy.js';
import { FIELD_OF_VIEW, chanceOverTime, detectionChance } from './detection.js';
import { LOOK_OFFSETS, eccentricityDegrees, headingFromVector, headingVector } from './facing.js';

/** Collision substep length in pixels, short enough that an explorer cannot tunnel through walls. */
const MAX_SUBSTEP_PIXELS = 0.4;

/** Farthest an explorer may be from a chair's front standing position to sit. */
const SIT_REACH = 3.5;

const COS_HALF_FIELD_OF_VIEW = Math.cos(FIELD_OF_VIEW * Math.PI / 360);

export class Explorer {
  /** Created by World.addExplorer, which places it at numbered start `startIndex`. */
  constructor(world, id, startIndex) {
    this.world = world;
    this.map = world.map;
    this.id = id;
    this.startIndex = startIndex;
    this.start = startIndex === 0 ? this.map.spawn : this.map.starts[startIndex];
    this.radius = EXPLORER_RADIUS;
    this.position = { x: this.start.x, y: this.start.y };
    this.floorIndex = this.start.floor;

    this.energy = new EnergyTracker();
    this.gait = 'walk';
    this.look = 'forward';
    this.heading = 0; // direction of travel, an eight-direction index
    this.facing = 0; // direction of view: heading + the look offset
    this.sitting = false;
    this.seatedChair = null;
    this.seatExit = null;
    this.movement = { dx: 0, dy: 0 }; // direction World.advanceAll moves this explorer in

    this.distance = 0; // pixels travelled
    this.floorChanges = 0;
  }

  /** Try to move in direction (dx, dy) on every World.advanceAll; both zero to stay still. */
  setMovement(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Invalid movement direction.');
    this.movement = { dx, dy };
  }

  // -------------------------------------------------------------------------
  // Floors, doors and collision

  activateFloor(index) {
    this.floorIndex = index;
  }

  /** The doors of this explorer's floor, shared with every explorer on it. */
  get doors() {
    return this.world.floorDoors[this.floorIndex].doors;
  }

  get doorIds() {
    return this.world.floorDoors[this.floorIndex].ids;
  }

  /** The material at (x, y) on this explorer's floor, with open doors as floor and outside the map as opaque. */
  effectiveMaterial(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    const { width, height } = this.map, pixels = this.map.floors[this.floorIndex].pixels;
    if (x < 0 || y < 0 || x >= width || y >= height) return MATERIAL.OPAQUE;
    const i = y * width + x, material = pixels[i];
    return material === MATERIAL.DOOR && this.doors[this.doorIds[i]].open ? MATERIAL.FLOOR : material;
  }

  /** Whether this explorer's body fits at (x, y) on its floor. Other explorers never block it. */
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
    if (this.canStand(this.position.x, this.position.y)) return true;
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
    this.position = best;
    return true;
  }

  doorDistance(door, x, y) {
    return doorDistance(door, this.map.width, x, y);
  }

  // -------------------------------------------------------------------------
  // Movement

  /**
   * Move to (x, y) if it fits. Crossing a stair's floor-change line moves the explorer
   * to the other floor, checking for room on the destination floor first.
   */
  tryMove(x, y) {
    for (const stair of this.map.stairs) {
      if (!connectsFloor(stair, this.floorIndex)) continue;
      const destination = stairCrossingTarget(stair, this.floorIndex, this.position, { x, y }, this.radius);
      if (destination === null) continue;
      const origin = this.floorIndex;
      this.activateFloor(destination);
      if (this.canStand(x, y)) {
        this.position.x = x;
        this.position.y = y;
        this.floorChanges++;
        return true;
      }
      this.activateFloor(origin);
      return false;
    }
    if (!this.canStand(x, y)) return false;
    this.position.x = x;
    this.position.y = y;
    return true;
  }

  /**
   * Move for `dt` seconds in direction (dx, dy) at `speed` pixels per second. Each axis is
   * moved separately in short substeps so the explorer slides along walls.
   * `onSegment(start, floor, seconds, distance)` is called after every substep. Doors and
   * time are the world's business (World.step and World.advanceAll).
   */
  move(dt, dx, dy, speed, onSegment = null) {
    const length = Math.hypot(dx, dy);
    if (!length) return;
    dx /= length;
    dy /= length;
    const amount = speed * dt, substeps = Math.max(1, Math.ceil(amount / MAX_SUBSTEP_PIXELS));
    for (let i = 0; i < substeps; i++) {
      const start = { x: this.position.x, y: this.position.y }, floor = this.floorIndex;
      this.tryMove(start.x + dx * amount / substeps, start.y);
      this.tryMove(this.position.x, this.position.y + dy * amount / substeps);
      const distance = Math.hypot(this.position.x - start.x, this.position.y - start.y);
      this.distance += distance;
      if (onSegment) onSegment(start, floor, dt / substeps, distance);
    }
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
    const dx = x - this.position.x, dy = y - this.position.y, distance = Math.hypot(dx, dy);
    if (distance < 1e-9) return true;
    const heading = headingVector(this.facing);
    return (dx * heading.x + dy * heading.y) / distance >= COS_HALF_FIELD_OF_VIEW - 1e-10;
  }

  /** Opaque pixels and closed doors block sight. A door any explorer holds open does not. */
  blocksSight(x, y) {
    const material = this.effectiveMaterial(x, y);
    return material === MATERIAL.OPAQUE || material === MATERIAL.DOOR;
  }

  /** In the field of view with no opaque pixel or closed door between the explorer and (x, y). */
  visibleTo(x, y) {
    if (!this.inFieldOfView(x, y)) return false;
    const from = { x: Math.floor(this.position.x), y: Math.floor(this.position.y) };
    const to = { x: Math.floor(x), y: Math.floor(y) };
    return traceLine(from, to, (cellX, cellY) => {
      const isEndpoint = (cellX === from.x && cellY === from.y) || (cellX === to.x && cellY === to.y);
      return isEndpoint || !this.blocksSight(cellX, cellY);
    });
  }

  /** One-second detection probability for a point, taking sight lines into account. */
  pointDetectionChance(x, y) {
    if (!this.visibleTo(x, y)) return 0;
    const dx = x - this.position.x, dy = y - this.position.y, distance = Math.hypot(dx, dy);
    const eccentricity = distance ? eccentricityDegrees(dx, dy, headingVector(this.facing)) : 0;
    return detectionChance(distance * METRES_PER_PIXEL, eccentricity, this.world.detectionHalfRange);
  }

  /**
   * Probability that this explorer detects an event at (x, y) on its floor within `seconds`.
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

  /** Whether another explorer is sitting on `chair`. */
  chairTaken(chair) {
    return this.world.explorers.some(other => other !== this && other.sitting && other.seatedChair === chair.id);
  }

  /** The closest free chair on this floor whose front can be reached in a straight line. */
  nearbyChair() {
    let nearest = null, best = Infinity;
    for (const chair of this.map.chairs || []) {
      if (chair.floor !== this.floorIndex || !isChairSpotClear(this.map, chair) || this.chairTaken(chair)) continue;
      const front = chairFront(chair, this.radius);
      const distance = Math.hypot(this.position.x - front.x, this.position.y - front.y);
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
      const x = this.position.x + (target.x - this.position.x) * i / samples;
      const y = this.position.y + (target.y - this.position.y) * i / samples;
      if (!this.canStand(x, y)) return false;
    }
    return true;
  }

  /**
   * Sit on the nearby free chair, or stand up at its front (or where the explorer was
   * before sitting). Returns false when there is no chair to sit on or no clear spot to stand.
   */
  setSitting(sitting) {
    if (sitting) {
      if (this.sitting) return true;
      const chair = this.nearbyChair();
      if (!chair) return false;
      this.seatExit = { ...this.position };
      this.seatedChair = chair.id;
      this.position = { x: chair.x + CHAIR_SIZE / 2, y: chair.y + CHAIR_SIZE / 2 };
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
      this.position = { ...exit };
    }
    this.sitting = false;
    this.seatedChair = null;
    this.seatExit = null;
    this.energy.activity = 'standing';
    return true;
  }
}
