// Sessions and rooms. A session is one browser tab's connection: it gets a fresh unique
// id when it connects and ends when the connection closes. A session is in the lobby or
// in one room. Anyone in the lobby can create a room from one of the plans or join an
// existing room.
//
// Each player has their own agent for each map. A player who leaves a room while their
// agent drives leaves it playing there; rejoining that room hands them back their explorer,
// and joining another room on the same map withdraws it (one agent per map per player).
// When a tab closes, all of its agents stop and its fine-tuned models are discarded. A room
// is destroyed when nobody, person or agent, is left in it.
//
// Messages are JSON objects with a `type`. From clients:
//   { type: 'create', plan }      create a room from a plan id and join it
//   { type: 'join', room }        join an existing room
//   { type: 'leave' }             go back to the lobby
//   { type: 'input', move: [dx, dy], gait, look }   what this explorer wants to do
//   { type: 'sit' }               sit down, or stand up
//   { type: 'autopilot', on }     hand the explorer to a pretrained agent, or take it back
//   { type: 'heatmap', on }       receive the room's probability field (a cheat)
//   { type: 'tuning', on }        while playing by hand, teach this map's agent
//   { type: 'blend', value }      0 = the agent stays as pretrained ... 1 = it copies the player
//   { type: 'resetAgent' }        discard this map's fine-tuned agent
// To clients:
//   { type: 'welcome', session: { id, name }, plans, rooms, autopilot }   autopilot: whether it is available
//   { type: 'rooms', rooms }      the room list changed (sent to sessions in the lobby)
//   { type: 'agents', agents }    rooms where this player's agents play on without them
//   { type: 'joined', room, map, you }   now in `room`; `map` is the plan file to draw;
//                                 `you`: { autopilot, tuning, agent } (agent: teaching status)
//   { type: 'tuning', plan, demos, updates }   how far this player's agent has been taught
//   { type: 'state', ... }        a room snapshot (see Room.snapshot)
//   { type: 'heat', ... }         the probability field, for sessions that asked (see Room.heat)
//   { type: 'left' }              back in the lobby
//   { type: 'error', message }

import { randomBytes, randomUUID } from 'node:crypto';
import { DECISION_EVERY, HEAT_EVERY, Room, SNAPSHOT_EVERY, parseInput } from './room.js';

/** A client whose unsent data passes this is too slow to keep up; it skips snapshots until it catches up. */
const MAX_BUFFERED_BYTES = 1 << 20;

/** Teaching status for a map nobody has taught yet. */
const UNTAUGHT = { demos: 0, updates: 0 };

export class Lobby {
  /**
   * plans:            from loadPlans
   * maxRooms:         rooms this server will hold at once
   * maxHumansPerRoom: explorers per room
   * agents:           the agent service client (see agents.js), or null for no autopilot
   */
  constructor({ plans, maxRooms = 100, maxHumansPerRoom = 8, agents = null }) {
    this.plans = new Map(plans.map(plan => [plan.id, plan]));
    this.agents = agents;
    this.maxRooms = maxRooms;
    this.maxHumansPerRoom = maxHumansPerRoom;
    this.sessions = new Set();
    this.rooms = new Map();
    this.draining = false; // set on shutdown: no new rooms or joins
  }

  // -------------------------------------------------------------------------
  // Sessions

  /** A new session for `socket` (anything with send(string) and readyState/bufferedAmount). */
  connect(socket) {
    const id = randomUUID();
    const session = {
      id, name: `Guest ${id.slice(0, 4)}`, socket, room: null, heatmap: false,
      agents: new Map(), // plan id → room where this player's agent plays on without them
      taught: new Map(), // plan id → teaching status
      blend: 0.5,
      teachFailing: false,
    };
    this.sessions.add(session);
    send(session, {
      type: 'welcome',
      session: { id, name: session.name },
      plans: [...this.plans.values()].map(({ id: planId, name }) => ({ id: planId, name })),
      rooms: this.roomList(),
      autopilot: Boolean(this.agents),
    });
    return session;
  }

  /** The tab closed or the connection dropped: the session ends, and every agent of theirs with it. */
  disconnect(session) {
    this.leaveRoom(session, { keepAgent: false });
    for (const room of session.agents.values()) this.removeFrom(room, session);
    session.agents.clear();
    this.sessions.delete(session);
    this.broadcastRooms();
    this.agents?.forget(session.id).catch(() => {});
  }

  /** Handle one parsed message from `session`. */
  handle(session, message) {
    switch (message?.type) {
      case 'create': return this.create(session, message.plan);
      case 'join': return this.join(session, message.room);
      case 'leave':
        if (this.leaveRoom(session)) send(session, { type: 'left' });
        return;
      case 'input': {
        const input = parseInput(message);
        if (input) session.room?.setInput(session, input);
        else send(session, { type: 'error', message: 'That input is not valid.' });
        return;
      }
      case 'sit': return session.room?.requestSit(session);
      case 'autopilot':
        if (!this.agents) return send(session, { type: 'error', message: 'The autopilot is not available on this server.' });
        return session.room?.setAutopilot(session, Boolean(message.on));
      case 'heatmap':
        session.heatmap = Boolean(message.on);
        if (session.heatmap && session.room) send(session, session.room.heat());
        return;
      case 'tuning':
        if (!this.agents) return send(session, { type: 'error', message: 'Fine-tuning is not available on this server.' });
        return session.room?.setTuning(session, Boolean(message.on));
      case 'blend':
        if (!Number.isFinite(message.value)) return send(session, { type: 'error', message: 'The blend must be a number from 0 to 1.' });
        session.blend = Math.min(1, Math.max(0, message.value));
        return;
      case 'resetAgent': return this.resetAgent(session);
      default: return send(session, { type: 'error', message: 'Unknown message.' });
    }
  }

  // -------------------------------------------------------------------------
  // Rooms

  create(session, planId) {
    if (this.draining) return send(session, { type: 'error', message: 'This server is shutting down; try again shortly.' });
    const plan = typeof planId === 'string' && this.plans.get(planId);
    if (!plan) return send(session, { type: 'error', message: 'Choose one of the listed maps.' });
    if (this.rooms.size >= this.maxRooms) return send(session, { type: 'error', message: 'No room is free right now; join an existing one.' });
    const room = new Room(randomBytes(4).toString('hex'), plan, { maxHumans: this.maxHumansPerRoom });
    this.rooms.set(room.id, room);
    this.enter(session, room);
  }

  join(session, roomId) {
    if (this.draining) return send(session, { type: 'error', message: 'This server is shutting down; try again shortly.' });
    const room = typeof roomId === 'string' && this.rooms.get(roomId);
    if (!room) return send(session, { type: 'error', message: 'That room has closed.' });
    if (room === session.room) return;
    if (room.full && !room.members.has(session)) return send(session, { type: 'error', message: 'That room is full.' });
    this.enter(session, room);
  }

  enter(session, room) {
    this.leaveRoom(session);
    // One agent per map per player: an agent of theirs playing elsewhere on this map stops.
    const elsewhere = session.agents.get(room.plan.id);
    if (elsewhere && elsewhere !== room) this.removeFrom(elsewhere, session);
    session.agents.delete(room.plan.id);
    room.addMember(session);
    session.room = room;
    const member = room.members.get(session);
    send(session, {
      type: 'joined',
      room: { id: room.id, plan: room.plan.id, planName: room.plan.name },
      map: room.plan.saved,
      you: { autopilot: member.autopilot, tuning: member.tuning, agent: session.taught.get(room.plan.id) ?? UNTAUGHT },
    });
    send(session, room.snapshot());
    this.broadcastRooms();
    this.sendAgents(session);
  }

  /**
   * Take `session` out of its room. If their agent is driving, it plays on without them
   * (unless keepAgent is false). Returns whether they were in a room.
   */
  leaveRoom(session, { keepAgent = true } = {}) {
    const room = session.room;
    if (!room) return false;
    session.room = null;
    if (keepAgent && room.members.get(session)?.autopilot) {
      room.detachMember(session);
      session.agents.set(room.plan.id, room);
      this.sendAgents(session);
    } else {
      this.removeFrom(room, session);
    }
    this.broadcastRooms();
    return true;
  }

  /** Remove the session's explorer from `room`, destroying the room if nobody is left. */
  removeFrom(room, session) {
    room.removeMember(session);
    if (!room.members.size) this.rooms.delete(room.id);
  }

  roomList() {
    return [...this.rooms.values()].map(room => ({
      id: room.id, plan: room.plan.id, planName: room.plan.name,
      humans: room.humans, agents: room.agents, explorers: room.members.size, maxHumans: room.maxHumans,
      createdAt: room.createdAt,
    }));
  }

  /** Tell a player where their agents are playing without them. */
  sendAgents(session) {
    send(session, {
      type: 'agents',
      agents: [...session.agents].map(([plan, room]) => ({ plan, planName: room.plan.name, room: room.id })),
    });
  }

  // -------------------------------------------------------------------------
  // Teaching

  /** Discard the player's fine-tuned agent for the map of the room they are in. */
  resetAgent(session) {
    const room = session.room;
    if (!room || !this.agents) return;
    session.taught.delete(room.plan.id);
    this.agents.reset(session.id, room.plan.id).catch(() => {});
    send(session, { type: 'tuning', plan: room.plan.id, ...UNTAUGHT });
  }

  /** Send the room's due demonstrations to the agent service and tell each player how far it has got. */
  teach(room) {
    for (const { session, demo } of room.takeLessons()) {
      Promise.resolve()
        .then(() => this.agents.demonstrate({ ...demo, blend: session.blend }))
        .then(status => {
          session.teachFailing = false;
          if (!this.sessions.has(session)) return;
          const taught = { demos: status.demos, updates: status.updates };
          session.taught.set(demo.plan, taught);
          send(session, { type: 'tuning', plan: demo.plan, ...taught });
        })
        .catch(() => {
          if (session.teachFailing) return;
          session.teachFailing = true;
          send(session, { type: 'error', message: 'Your agent cannot learn right now; it will keep trying.' });
        });
    }
  }

  /** Tell every session in the lobby about the current rooms. */
  broadcastRooms() {
    const message = JSON.stringify({ type: 'rooms', rooms: this.roomList() });
    for (const session of this.sessions) if (!session.room) sendRaw(session, message);
  }

  // -------------------------------------------------------------------------
  // Time

  /** Advance every room by one tick; send snapshots and heatmaps, and ask for agent decisions, when due. */
  tick() {
    for (const room of this.rooms.values()) {
      room.step();
      if (room.tick % DECISION_EVERY === 0) {
        this.decide(room);
        if (this.agents) this.teach(room);
      }
      if (room.tick % SNAPSHOT_EVERY === 0) this.broadcast(room, JSON.stringify(room.snapshot()), () => true);
      if (room.tick % HEAT_EVERY === 0) {
        const watching = session => session.heatmap;
        if (room.present.some(watching)) this.broadcast(room, JSON.stringify(room.heat()), watching);
      }
    }
  }

  /** Send `text` to the people in the room that `wanted` picks, skipping clients too far behind. */
  broadcast(room, text, wanted) {
    for (const session of room.present) {
      if (wanted(session) && session.socket.bufferedAmount <= MAX_BUFFERED_BYTES) sendRaw(session, text);
    }
  }

  /**
   * Ask the agent service to decide for the room's autopilot explorers. One request per room
   * is in flight at a time; the answer is applied at the room's next tick. If the service
   * cannot answer, the autopilot explorers stop, and their players hear about it once until
   * a decision succeeds again.
   */
  decide(room) {
    if (!this.agents || room.deciding) return;
    const request = room.agentRequest();
    if (!request) return;
    room.deciding = true;
    const { ids, ...body } = request;
    Promise.resolve()
      .then(() => this.agents.act(body))
      .then(actions => {
        room.applyActions(ids, actions);
        room.agentFailing = false;
      })
      .catch(() => {
        room.haltAutopilots();
        if (room.agentFailing) return;
        room.agentFailing = true;
        for (const [session, member] of room.members) {
          if (member.autopilot && member.present) send(session, { type: 'error', message: 'The autopilot cannot decide right now; it will keep trying.' });
        }
      })
      .finally(() => { room.deciding = false; });
  }
}

function send(session, message) {
  sendRaw(session, JSON.stringify(message));
}

function sendRaw(session, text) {
  if (session.socket.readyState === 1) session.socket.send(text); // 1: open
}
