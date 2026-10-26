// One running instance of a map: a World with an explorer per human, advanced in whole
// 0.05 s ticks, so every tick is the same unit of work and the simulation stays
// deterministic for the inputs it is given. Inputs only take effect at the next tick.
//
// The room is authoritative: clients send what they want to do (a direction, a gait, a
// look, a request to sit or stand) and render the snapshots the room sends back.
//
// A player can hand their explorer to the autopilot: a pretrained guard agent. Every 0.5 s
// (the agents' decision interval in training) the room describes itself in the agent
// service's terms -- every explorer's pose and the probability field -- and applies the
// actions that come back, translated from the training action space (move, gait, absolute
// gaze) into the same controls a person uses.
//
// The agent that drives is the player's own: while they play by hand with fine-tuning on,
// each 0.5 s of their play becomes a demonstration (the room as it was at the start of the
// interval, and what they did, in the agent's action space) for the agent service to learn
// from. A player who leaves while their agent drives leaves it playing; the room lasts while
// anyone, person or agent, is in it.

import { GRID, LOOK_OFFSETS, World, alignGrid, decodeMap } from '@pixel-map-lab/core';

/** Simulated seconds per tick. */
export const TICK_SECONDS = 0.05;

/** A snapshot goes to the room's members every this many ticks (ten a second). */
export const SNAPSHOT_EVERY = 2;

/** Agents decide every this many ticks: 0.5 s, as in training. */
export const DECISION_EVERY = 10;

/** Heatmaps go to the players who asked for them every this many ticks (twice a second). */
export const HEAT_EVERY = 10;

/**
 * Heatmap scale: a block's colour is log(1 + ΣP / reference), where the reference is a 3 × 3
 * block of value-1 floor left unseen for a minute (the agents' risk reference), and a block
 * unseen for HEAT_FULL_SECONDS is drawn at full strength.
 */
const HEAT_REFERENCE_SECONDS = 60, HEAT_FULL_SECONDS = 600;

const GAITS = new Set(['walk', 'run', 'sprint']);
const STEPS = new Set([-1, 0, 1]);

/** The training action space: gait and look by index, and moves 1-8 as headings E, SE, ... NE. */
const GAIT_NAMES = ['walk', 'run', 'sprint'];
const LOOK_NAMES = Object.keys(LOOK_OFFSETS).sort((a, b) => LOOK_OFFSETS[a] - LOOK_OFFSETS[b]);
const MOVES = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const SIT = 9;

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
    // session → { explorer, present, input, sit, autopilot, action, tuning, trace, lesson }
    this.members = new Map();
    this.joins = 0;
    this.tick = 0;
  }

  /** People in the room now. */
  get humans() {
    return [...this.members.values()].filter(member => member.present).length;
  }

  /** Explorers driven by an agent, whether their player is here or not. */
  get agents() {
    return [...this.members.values()].filter(member => member.autopilot).length;
  }

  /** Every explorer takes a place, including agents whose players have left. */
  get full() {
    return this.members.size >= this.maxHumans;
  }

  /** The sessions present in the room. */
  get present() {
    return [...this.members].filter(([, member]) => member.present).map(([session]) => session);
  }

  /**
   * Add an explorer for `session`, cycling through the map's numbered starts, or bring the
   * player back to the explorer their agent has been driving. Returns the explorer.
   */
  addMember(session) {
    const existing = this.members.get(session);
    if (existing) {
      existing.present = true;
      return existing.explorer;
    }
    const startIndex = this.joins++ % this.world.map.starts.length;
    const explorer = this.world.addExplorer({ startIndex, id: session.id });
    this.members.set(session, {
      explorer, present: true, input: null, sit: false, autopilot: false, action: null, tuning: false, trace: [], lesson: null,
    });
    return explorer;
  }

  removeMember(session) {
    const member = this.members.get(session);
    if (!member) return;
    this.world.removeExplorer(member.explorer);
    this.members.delete(session);
  }

  /** The player leaves but their agent plays on. */
  detachMember(session) {
    const member = this.members.get(session);
    if (!member) return;
    member.present = false;
    member.input = null;
    member.sit = false;
    this.setTuning(session, false);
  }

  /** Keep the latest valid input; it is applied at the next tick. Ignored while the autopilot drives. */
  setInput(session, input) {
    const member = this.members.get(session);
    if (member && !member.autopilot) member.input = input;
  }

  /** Ask to sit down, or stand up if already sitting, at the next tick. Ignored while the autopilot drives. */
  requestSit(session) {
    const member = this.members.get(session);
    if (member && !member.autopilot) member.sit = true;
  }

  /** Hand the explorer to the autopilot, or take it back (the explorer then stops until told otherwise). */
  setAutopilot(session, on) {
    const member = this.members.get(session);
    if (!member || member.autopilot === on) return;
    member.autopilot = on;
    member.action = null;
    member.input = null;
    member.trace = [];
    member.lesson = null;
    if (!on) member.explorer.setMovement(0, 0);
  }

  /** Turn fine-tuning on or off: while on, the player's manual play teaches their agent. */
  setTuning(session, on) {
    const member = this.members.get(session);
    if (!member) return;
    member.tuning = on;
    member.trace = [];
    member.lesson = null;
  }

  get hasAutopilot() {
    return [...this.members.values()].some(member => member.autopilot);
  }

  /** Stop every autopilot-driven explorer, for when no decision can be had. */
  haltAutopilots() {
    for (const member of this.members.values()) if (member.autopilot) member.explorer.setMovement(0, 0);
  }

  /** The room in the agent service's terms: every explorer's pose, and the field means. */
  agentState() {
    const chairs = this.world.map.chairs;
    const means = new Float32Array(this.world.probabilities.means);
    return {
      plan: this.plan.id,
      explorers: [...this.members.values()].map(({ explorer }) => ({
        x: explorer.position.x,
        y: explorer.position.y,
        floor: explorer.floorIndex,
        heading: explorer.heading,
        look: LOOK_OFFSETS[explorer.look],
        gait: GAIT_NAMES.indexOf(explorer.gait),
        sitting: explorer.sitting,
        seat: explorer.sitting ? chairs.findIndex(chair => chair.id === explorer.seatedChair) : -1,
      })),
      means: Buffer.from(means.buffer).toString('base64'),
    };
  }

  /**
   * The agent service request for this room (see services/agent-inference), or null when
   * nobody is on autopilot: the room's state, which explorers to drive and whose agents
   * they are. `ids` names the driven explorers, for applyActions.
   */
  agentRequest() {
    const entries = [...this.members];
    const driven = entries.flatMap(([, member], index) => (member.autopilot ? [index] : []));
    if (!driven.length) return null;
    return {
      ...this.agentState(),
      ids: driven.map(index => entries[index][1].explorer.id),
      agents: driven,
      owners: driven.map(index => entries[index][0].id),
    };
  }

  /**
   * The demonstrations due at this decision boundary: for each player teaching by hand, the
   * room as it was at the start of the last 0.5 s and what they did over it. Each comes with
   * its session: [{ session, demo: { plan, player, agent, explorers, means, action } }].
   * The boundary also starts the next lesson for everyone teaching.
   */
  takeLessons() {
    const lessons = [];
    let state = null;
    [...this.members].forEach(([session, member], index) => {
      if (!member.tuning || member.autopilot || !member.present) return;
      if (member.lesson && member.trace.length) {
        const action = summarise(member.trace, member.lesson.sitting);
        lessons.push({ session, demo: { ...member.lesson.state, player: session.id, agent: member.lesson.agent, action } });
      }
      state ??= this.agentState();
      member.lesson = { state, agent: index, sitting: member.explorer.sitting };
      member.trace = [];
    });
    return lessons;
  }

  /** Queue the agent's actions (one per id from agentRequest) for the next tick. */
  applyActions(ids, actions) {
    ids.forEach((id, k) => {
      const member = [...this.members.values()].find(m => m.explorer.id === id);
      if (member?.autopilot && Array.isArray(actions[k])) member.action = actions[k];
    });
  }

  /** Apply pending inputs and agent actions, and advance the world by one tick. */
  step() {
    for (const member of this.members.values()) {
      const { explorer, input } = member;
      if (member.action) {
        driveWith(explorer, member.action);
        member.action = null;
      }
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
    for (const member of this.members.values()) {
      if (!member.tuning || member.autopilot || !member.present || !member.lesson) continue;
      const { explorer } = member, { dx, dy } = explorer.movement;
      const move = dx || dy ? MOVES.findIndex(([x, y]) => x === Math.sign(dx) && y === Math.sign(dy)) + 1 : 0;
      member.trace.push([move, GAIT_NAMES.indexOf(explorer.gait), explorer.facing, explorer.sitting]);
    }
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
        autopilot: this.members.get(session).autopilot,
        away: !this.members.get(session).present,
      })),
      // For each floor, the indices of its open doors (in groupDoors order).
      doors: world.floorDoors.map(({ doors }) => doors.flatMap((door, index) => (door.open ? [index] : []))),
      // Events spotted in the last couple of seconds, for a brief highlight.
      spots: world.events.resolvedFx.map(event => ({ x: event.x, y: event.y, floor: event.floor })),
    };
  }

  /**
   * The probability field per floor in GRID × GRID blocks, one byte a block (base64), for
   * players who chose to see it. Width and height are in blocks.
   */
  heat() {
    const { map, probabilities: field, events } = this.world;
    const width = Math.ceil(map.width / GRID), height = Math.ceil(map.height / GRID);
    const sums = map.floors.map(() => new Float64Array(width * height));
    for (let floor = 0; floor < map.floors.length; floor++) {
      for (let j = field.floorStart[floor]; j < field.floorStart[floor + 1]; j++) {
        const block = Math.floor(field.candidateY[j] / GRID) * width + Math.floor(field.candidateX[j] / GRID);
        sums[floor][block] += -Math.expm1(-field.means[j]);
      }
    }
    const reference = events.rate * GRID * GRID * HEAT_REFERENCE_SECONDS;
    const full = Math.log1p(HEAT_FULL_SECONDS / HEAT_REFERENCE_SECONDS);
    const floors = sums.map(blocks => {
      const bytes = Uint8Array.from(blocks, sum => Math.round(255 * Math.min(1, Math.log1p(sum / reference) / full)));
      return Buffer.from(bytes).toString('base64');
    });
    return { type: 'heat', block: GRID, width, height, floors };
  }
}

/** The most frequent value in a list. */
function mode(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

/**
 * What a player did over one decision interval, as an agent action [move, gait, gaze]: sitting
 * down at any point is move 9, otherwise the most frequent direction (0 for standing still);
 * the most frequent gait and facing (the absolute gaze). Each trace entry is
 * [move, gait, facing, sitting] for one tick.
 */
export function summarise(trace, wasSitting) {
  let sat = false, before = wasSitting;
  for (const [, , , sitting] of trace) {
    if (sitting && !before) sat = true;
    before = sitting;
  }
  return [sat ? SIT : mode(trace.map(entry => entry[0])), mode(trace.map(entry => entry[1])), mode(trace.map(entry => entry[2]))];
}

/** Steer an explorer with an agent action [move, gait, gaze], as guardrl's simulator applies it. */
function driveWith(explorer, [move, gait, gaze]) {
  explorer.setGait(GAIT_NAMES[gait] ?? 'walk');
  let heading = explorer.heading;
  if (move === SIT) {
    explorer.setMovement(0, 0);
    if (!explorer.sitting) explorer.setSitting(true);
    heading = explorer.heading;
  } else if (move >= 1 && move <= 8) {
    explorer.setMovement(...MOVES[move - 1]);
    heading = move - 1;
  } else {
    explorer.setMovement(0, 0);
  }
  // The agent picks an absolute gaze; the explorer looks relative to its direction of travel.
  explorer.setLook(LOOK_NAMES[(((gaze - heading) % 8) + 8) % 8]);
}
