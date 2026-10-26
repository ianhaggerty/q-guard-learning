// One running instance of a map: a World with an explorer per human, advanced in whole
// 0.05 s ticks, so every tick is the same unit of work and the simulation stays
// deterministic for the inputs it is given. Inputs only take effect at the next tick.
//
// The room is authoritative: clients send what they want to do (a direction, a gait, a
// look, a request to sit or stand) and render the snapshots the room sends back.

import { LOOK_OFFSETS, World, alignGrid, decodeMap } from '@pixel-map-lab/core';

/** Simulated seconds per tick. */
export const TICK_SECONDS = 0.05;

/** A snapshot goes to the room's members every this many ticks (ten a second). */
export const SNAPSHOT_EVERY = 2;

const GAITS = new Set(['walk', 'run', 'sprint']);
const STEPS = new Set([-1, 0, 1]);

/** A client's input message as { dx, dy, gait, look }, or null when anything in it is invalid. */
export function parseInput(message) {
  const move = message.move;
  if (!Array.isArray(move) || move.length !== 2 || !STEPS.has(move[0]) || !STEPS.has(move[1])) return null;
  if (!GAITS.has(message.gait) || typeof message.look !== 'string' || !Object.hasOwn(LOOK_OFFSETS, message.look)) return null;
  return { dx: move[0], dy: move[1], gait: message.gait, look: message.look };
}

/** Round to `digits` decimals, to keep snapshots short. */
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

export class Room {
  constructor(id, plan, { maxHumans = 8 } = {}) {
    this.id = id;
    this.plan = plan;
    this.maxHumans = maxHumans;
    this.createdAt = Date.now();
    this.world = new World(alignGrid(decodeMap(plan.saved)), { empty: true });
    this.members = new Map(); // session → { explorer, input, sit }
    this.joins = 0;
    this.tick = 0;
  }

  get humans() {
    return this.members.size;
  }

  get full() {
    return this.members.size >= this.maxHumans;
  }

  /** Add an explorer for `session`, cycling through the map's numbered starts. Returns it. */
  addMember(session) {
    const startIndex = this.joins++ % this.world.map.starts.length;
    const explorer = this.world.addExplorer({ startIndex, id: session.id });
    this.members.set(session, { explorer, input: null, sit: false });
    return explorer;
  }

  removeMember(session) {
    const member = this.members.get(session);
    if (!member) return;
    this.world.removeExplorer(member.explorer);
    this.members.delete(session);
  }

  /** Keep the latest valid input; it is applied at the next tick. */
  setInput(session, input) {
    const member = this.members.get(session);
    if (member) member.input = input;
  }

  /** Ask to sit down, or stand up if already sitting, at the next tick. */
  requestSit(session) {
    const member = this.members.get(session);
    if (member) member.sit = true;
  }

  /** Apply pending inputs and advance the world by one tick. */
  step() {
    for (const member of this.members.values()) {
      const { explorer, input } = member;
      if (input) {
        explorer.setGait(input.gait);
        explorer.setLook(input.look);
        explorer.setMovement(input.dx, input.dy);
        member.input = null;
      }
      if (member.sit) {
        explorer.setSitting(!explorer.sitting);
        member.sit = false;
      }
    }
    this.world.advanceAll(TICK_SECONDS);
    this.tick++;
  }

  /** Everything a client needs to draw the room: explorers, open doors, score and recent spots. */
  snapshot() {
    const { world } = this;
    return {
      type: 'state',
      tick: this.tick,
      time: round(world.time, 2),
      psum: round(world.probabilities.sum, 5),
      spotted: world.events.resolved,
      explorers: [...this.members.entries()].map(([session, { explorer }]) => ({
        id: explorer.id,
        name: session.name,
        x: round(explorer.position.x, 3),
        y: round(explorer.position.y, 3),
        floor: explorer.floorIndex,
        heading: explorer.heading,
        facing: explorer.facing,
        gait: explorer.gait,
        look: explorer.look,
        sitting: explorer.sitting,
        credit: Number(explorer.credit.toPrecision(6)),
        kcal: round(explorer.energy.kcal, 3),
      })),
      // For each floor, the indices of its open doors (in groupDoors order).
      doors: world.floorDoors.map(({ doors }) => doors.flatMap((door, index) => (door.open ? [index] : []))),
      // Events spotted in the last couple of seconds, for a brief highlight.
      spots: world.events.resolvedFx.map(event => ({ x: event.x, y: event.y, floor: event.floor })),
    };
  }
}
