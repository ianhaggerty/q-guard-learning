// Sessions and rooms. A session is one browser tab's connection: it gets a fresh unique
// id when it connects and ends when the connection closes. A session is in the lobby or
// in one room. Anyone in the lobby can create a room from one of the plans or join an
// existing room; when the last human leaves a room, the room is destroyed.
//
// Messages are JSON objects with a `type`. From clients:
//   { type: 'create', plan }      create a room from a plan id and join it
//   { type: 'join', room }        join an existing room
//   { type: 'leave' }             go back to the lobby
//   { type: 'input', move: [dx, dy], gait, look }   what this explorer wants to do
//   { type: 'sit' }               sit down, or stand up
//   { type: 'heatmap', on }       receive the room's probability field (a cheat)
// To clients:
//   { type: 'welcome', session: { id, name }, plans, rooms }
//   { type: 'rooms', rooms }      the room list changed (sent to sessions in the lobby)
//   { type: 'joined', room, plan, map }   now in `room`; `map` is the plan file to draw
//   { type: 'state', ... }        a room snapshot (see Room.snapshot)
//   { type: 'heat', ... }         the probability field, for sessions that asked (see Room.heat)
//   { type: 'left' }              back in the lobby
//   { type: 'error', message }

import { randomBytes, randomUUID } from 'node:crypto';
import { HEAT_EVERY, Room, SNAPSHOT_EVERY, parseInput } from './room.js';

/** A client whose unsent data passes this is too slow to keep up; it skips snapshots until it catches up. */
const MAX_BUFFERED_BYTES = 1 << 20;

export class Lobby {
  /**
   * plans:            from loadPlans
   * maxRooms:         rooms this server will hold at once
   * maxHumansPerRoom: explorers per room
   */
  constructor({ plans, maxRooms = 100, maxHumansPerRoom = 8 }) {
    this.plans = new Map(plans.map(plan => [plan.id, plan]));
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
    const session = { id, name: `Guest ${id.slice(0, 4)}`, socket, room: null, heatmap: false };
    this.sessions.add(session);
    send(session, {
      type: 'welcome',
      session: { id, name: session.name },
      plans: [...this.plans.values()].map(({ id: planId, name }) => ({ id: planId, name })),
      rooms: this.roomList(),
    });
    return session;
  }

  /** The tab closed or the connection dropped: the session ends and leaves its room. */
  disconnect(session) {
    this.leaveRoom(session);
    this.sessions.delete(session);
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
      case 'heatmap':
        session.heatmap = Boolean(message.on);
        if (session.heatmap && session.room) send(session, session.room.heat());
        return;
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
    if (room.full) return send(session, { type: 'error', message: 'That room is full.' });
    this.enter(session, room);
  }

  enter(session, room) {
    this.leaveRoom(session);
    room.addMember(session);
    session.room = room;
    send(session, { type: 'joined', room: { id: room.id, plan: room.plan.id, planName: room.plan.name }, map: room.plan.saved });
    send(session, room.snapshot());
    this.broadcastRooms();
  }

  /** Take `session` out of its room, destroying the room if it is now empty. Returns whether it was in one. */
  leaveRoom(session) {
    const room = session.room;
    if (!room) return false;
    room.removeMember(session);
    session.room = null;
    if (!room.humans) this.rooms.delete(room.id);
    this.broadcastRooms();
    return true;
  }

  roomList() {
    return [...this.rooms.values()].map(room => ({
      id: room.id, plan: room.plan.id, planName: room.plan.name,
      humans: room.humans, maxHumans: room.maxHumans, createdAt: room.createdAt,
    }));
  }

  /** Tell every session in the lobby about the current rooms. */
  broadcastRooms() {
    const message = JSON.stringify({ type: 'rooms', rooms: this.roomList() });
    for (const session of this.sessions) if (!session.room) sendRaw(session, message);
  }

  // -------------------------------------------------------------------------
  // Time

  /** Advance every room by one tick, and send snapshots and heatmaps when due. */
  tick() {
    for (const room of this.rooms.values()) {
      room.step();
      if (room.tick % SNAPSHOT_EVERY === 0) this.broadcast(room, JSON.stringify(room.snapshot()), () => true);
      if (room.tick % HEAT_EVERY === 0) {
        const watching = session => session.heatmap;
        if ([...room.members.keys()].some(watching)) this.broadcast(room, JSON.stringify(room.heat()), watching);
      }
    }
  }

  /** Send `text` to the room's members that `wanted` picks, skipping clients too far behind. */
  broadcast(room, text, wanted) {
    for (const session of room.members.keys()) {
      if (wanted(session) && session.socket.bufferedAmount <= MAX_BUFFERED_BYTES) sendRaw(session, text);
    }
  }
}

function send(session, message) {
  sendRaw(session, JSON.stringify(message));
}

function sendRaw(session, text) {
  if (session.socket.readyState === 1) session.socket.send(text); // 1: open
}
