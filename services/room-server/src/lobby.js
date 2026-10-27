// Players, sessions and rooms.
//
// A session is one browser tab's connection: it gets a fresh unique id when it connects and
// ends when the connection closes. Every session belongs to a player:
//   * a signed-in user ("user:<id>"), shared by all of that user's tabs; their agents and
//     fine-tuned models are kept (the agent service saves and trains them), and agents they
//     leave playing carry on for up to `offlineSeconds` (an hour) after their last tab closes;
//   * a guest ("guest:<session id>"), one per tab; when the tab closes their agents stop and
//     their fine-tuned models are discarded.
// A session is in the lobby or in one room. Anyone in the lobby can create a room from one
// of the plans or join an existing room. A player has one explorer per room: joining from a
// second tab moves control there and sends the first tab back to the lobby.
//
// Each player has their own agent for each map. A player who leaves a room while their
// agent drives leaves it playing there; rejoining that room hands them back their explorer,
// and joining another room on the same map withdraws it (one agent per map per player). A
// room is destroyed when nobody, person or agent, is left in it.
//
// Messages are JSON objects with a `type`. From clients:
//   { type: 'create', plan }      create a room from a plan id and join it
//   { type: 'join', room }        join an existing room
//   { type: 'leave' }             go back to the lobby
//   { type: 'input', move: [dx, dy], gait, look }   what this explorer wants to do
//   { type: 'sit' }               sit down, or stand up
//   { type: 'autopilot', on }     hand the explorer to the player's agent, or take it back
//   { type: 'heatmap', on }       receive the room's probability field (a cheat)
//   { type: 'tuning', on }        while playing by hand, teach this map's agent
//   { type: 'blend', value }      0 = the agent plays to score ... 1 = it copies the player
//   { type: 'resetAgent' }        discard this map's fine-tuned agent
// To clients:
//   { type: 'welcome', session, player: { id, name, signedIn }, plans, rooms, autopilot }
//   { type: 'rooms', rooms }      the room list changed (sent to sessions in the lobby)
//   { type: 'agents', agents, offlineSeconds }   rooms where this player's agents play on without them
//   { type: 'joined', room, map, you }   now in `room`; `map` is the plan file to draw;
//                                 `you`: { autopilot, tuning, agent } (agent: teaching status)
//   { type: 'tuning', plan, demos, updates, version?, trained?, job? }   how far their agent has got
//   { type: 'state', ... }        a room snapshot (see Room.snapshot)
//   { type: 'heat', ... }         the probability field, for sessions that asked (see Room.heat)
//   { type: 'left', reason? }     back in the lobby
//   { type: 'error', message }

import { randomBytes, randomUUID } from 'node:crypto';
import { DECISION_EVERY, HEAT_EVERY, Room, SNAPSHOT_EVERY, parseInput } from './room.js';

/** A client whose unsent data passes this is too slow to keep up; it skips snapshots until it catches up. */
const MAX_BUFFERED_BYTES = 1 << 20;

/** Teaching status for a map nobody has taught yet. */
const UNTAUGHT = { demos: 0, updates: 0 };

/** How long a signed-in player's agents play on after their last tab closes. */
export const AGENT_OFFLINE_SECONDS = 3600;

export class Lobby {
  /**
   * plans:            from loadPlans
   * maxRooms:         rooms this server will hold at once
   * maxHumansPerRoom: explorers per room
   * agents:           the agent service client (see agents.js), or null for no autopilot
   * offlineSeconds:   how long signed-in players' agents play on with no tab open
   */
  constructor({ plans, maxRooms = 100, maxHumansPerRoom = 8, agents = null, offlineSeconds = AGENT_OFFLINE_SECONDS }) {
    this.plans = new Map(plans.map(plan => [plan.id, plan]));
    this.agents = agents;
    this.maxRooms = maxRooms;
    this.maxHumansPerRoom = maxHumansPerRoom;
    this.offlineSeconds = offlineSeconds;
    this.sessions = new Set();
    this.players = new Map(); // player id → player
    this.rooms = new Map();
    this.draining = false; // set on shutdown: no new rooms or joins
  }

  // -------------------------------------------------------------------------
  // Players and sessions

  /** The player for a signed-in user, or a new guest for a session. */
  playerFor(user, sessionId) {
    const id = user ? `user:${user.id}` : `guest:${sessionId}`;
    let player = this.players.get(id);
    if (!player) {
      player = {
        id, name: user ? user.login : `Guest ${sessionId.slice(0, 4)}`, user,
        sessions: new Set(),
        agents: new Map(), // plan id → room where this player's agent plays on without them
        taught: new Map(), // plan id → teaching status
        blend: 0.5,
        teachFailing: false,
        offline: null, // the timer that stops their agents once they have been away too long
      };
      this.players.set(id, player);
    }
    return player;
  }

  /**
   * A new session for `socket` (anything with send(string) and readyState/bufferedAmount),
   * for the signed-in `user` (null for a guest).
   */
  connect(socket, user = null) {
    const id = randomUUID();
    const player = this.playerFor(user, id);
    clearTimeout(player.offline);
    player.offline = null;
    const session = { id, socket, player, room: null, heatmap: false };
    player.sessions.add(session);
    this.sessions.add(session);
    send(session, {
      type: 'welcome',
      session: { id },
      player: { id: player.id, name: player.name, signedIn: Boolean(user) },
      plans: [...this.plans.values()].map(({ id: planId, name }) => ({ id: planId, name })),
      rooms: this.roomList(),
      autopilot: Boolean(this.agents),
    });
    this.sendAgents(player);
    return session;
  }

  /**
   * The tab closed or the connection dropped. A guest's agents stop with it; a signed-in
   * player's agents play on, until `offlineSeconds` after their last tab closes.
   */
  disconnect(session) {
    const { player } = session;
    this.leaveRoom(session, { keepAgent: Boolean(player.user) });
    player.sessions.delete(session);
    this.sessions.delete(session);
    if (!player.sessions.size) {
      if (player.user && player.agents.size) {
        player.offline = setTimeout(() => this.retire(player), this.offlineSeconds * 1000);
        player.offline.unref?.();
      } else {
        this.retire(player);
      }
    }
    this.broadcastRooms();
  }

  /** The player has gone for good: their agents stop, and the agent service lets go of their models. */
  retire(player) {
    if (player.sessions.size) return;
    for (const room of player.agents.values()) this.removeFrom(room, player);
    player.agents.clear();
    this.players.delete(player.id);
    this.broadcastRooms();
    this.agents?.forget(player.id).catch(() => {});
  }

  /** Handle one parsed message from `session`. */
  handle(session, message) {
    const { player, room } = session;
    switch (message?.type) {
      case 'create': return this.create(session, message.plan);
      case 'join': return this.join(session, message.room);
      case 'leave':
        if (this.leaveRoom(session)) send(session, { type: 'left' });
        return;
      case 'input': {
        const input = parseInput(message);
        if (input) room?.setInput(player, input);
        else send(session, { type: 'error', message: 'That input is not valid.' });
        return;
      }
      case 'sit': return room?.requestSit(player);
      case 'autopilot':
        if (!this.agents) return send(session, { type: 'error', message: 'The autopilot is not available on this server.' });
        if (!room) return;
        if (message.on) this.stopTeaching(room, player);
        return room.setAutopilot(player, Boolean(message.on));
      case 'heatmap':
        session.heatmap = Boolean(message.on);
        if (session.heatmap && room) send(session, room.heat());
        return;
      case 'tuning':
        if (!this.agents) return send(session, { type: 'error', message: 'Fine-tuning is not available on this server.' });
        if (!room) return;
        if (message.on) return void room.setTuning(player, true);
        return this.stopTeaching(room, player);
      case 'blend':
        if (!Number.isFinite(message.value)) return send(session, { type: 'error', message: 'The blend must be a number from 0 to 1.' });
        player.blend = Math.min(1, Math.max(0, message.value));
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
    if (room.full && !room.members.has(session.player)) return send(session, { type: 'error', message: 'That room is full.' });
    this.enter(session, room);
  }

  enter(session, room) {
    const { player } = session;
    this.leaveRoom(session);
    // One agent per map per player: an agent of theirs playing elsewhere on this map stops.
    const elsewhere = player.agents.get(room.plan.id);
    if (elsewhere && elsewhere !== room) this.removeFrom(elsewhere, player);
    player.agents.delete(room.plan.id);
    // One explorer per player: another tab of theirs in this room hands over control.
    const previous = room.members.get(player)?.session;
    if (previous && previous !== session) {
      previous.room = null;
      send(previous, { type: 'left', reason: 'You took control of this explorer in another tab.' });
    }
    room.addMember(player, session);
    session.room = room;
    const member = room.members.get(player);
    send(session, {
      type: 'joined',
      room: { id: room.id, plan: room.plan.id, planName: room.plan.name },
      map: room.plan.saved,
      you: { autopilot: member.autopilot, tuning: member.tuning, agent: player.taught.get(room.plan.id) ?? UNTAUGHT },
    });
    send(session, room.snapshot());
    this.broadcastRooms();
    this.sendAgents(player);
    this.refreshStatus(player, room.plan.id);
  }

  /**
   * Take `session` out of its room. If the player's agent is driving, it plays on without
   * them (unless keepAgent is false). Returns whether they were in a room.
   */
  leaveRoom(session, { keepAgent = true } = {}) {
    const { room, player } = session;
    if (!room) return false;
    session.room = null;
    if (room.members.get(player)?.session !== session) return true; // another tab took over
    this.stopTeaching(room, player);
    if (keepAgent && room.members.get(player)?.autopilot) {
      room.detachMember(player);
      player.agents.set(room.plan.id, room);
      this.sendAgents(player);
    } else {
      this.removeFrom(room, player);
    }
    this.broadcastRooms();
    return true;
  }

  /** Remove the player's explorer from `room`, destroying the room if nobody is left. */
  removeFrom(room, player) {
    room.removeMember(player);
    if (!room.members.size) this.rooms.delete(room.id);
  }

  roomList() {
    return [...this.rooms.values()].map(room => ({
      id: room.id, plan: room.plan.id, planName: room.plan.name,
      humans: room.humans, agents: room.agents, explorers: room.members.size, maxHumans: room.maxHumans,
      createdAt: room.createdAt,
    }));
  }

  /** Tell a player's tabs where their agents are playing without them. */
  sendAgents(player) {
    const message = {
      type: 'agents',
      agents: [...player.agents].map(([plan, room]) => ({ plan, planName: room.plan.name, room: room.id })),
      offlineSeconds: player.user ? this.offlineSeconds : 0,
    };
    for (const session of player.sessions) send(session, message);
  }

  // -------------------------------------------------------------------------
  // Teaching

  /** The player stopped teaching in `room`: the agent service saves what it has and may queue training. */
  stopTeaching(room, player) {
    if (room.setTuning(player, false) && this.agents) this.agents.flush(player.id, room.plan.id).catch(() => {});
  }

  /** Ask the agent service how far the player's agent for a plan has got, and tell their tabs. */
  refreshStatus(player, plan) {
    if (!this.agents) return;
    this.agents.status(player.id, plan).then(status => this.tellTaught(player, plan, status)).catch(() => {});
  }

  tellTaught(player, plan, status) {
    const taught = { demos: status.demos, updates: status.updates };
    for (const field of ['version', 'trained', 'job']) if (status[field] !== undefined) taught[field] = status[field];
    player.taught.set(plan, taught);
    for (const session of player.sessions) if (session.room?.plan.id === plan) send(session, { type: 'tuning', plan, ...taught });
  }

  /** Discard the player's fine-tuned agent for the map of the room they are in. */
  resetAgent(session) {
    const { room, player } = session;
    if (!room || !this.agents) return;
    player.taught.delete(room.plan.id);
    this.agents.reset(player.id, room.plan.id).catch(() => {});
    this.tellTaught(player, room.plan.id, UNTAUGHT);
  }

  /** Send the room's due demonstrations to the agent service and tell each player how far it has got. */
  teach(room) {
    for (const { player, demo } of room.takeLessons()) {
      Promise.resolve()
        .then(() => this.agents.demonstrate({ ...demo, blend: player.blend }))
        .then(status => {
          player.teachFailing = false;
          this.tellTaught(player, demo.plan, status);
        })
        .catch(() => {
          if (player.teachFailing) return;
          player.teachFailing = true;
          for (const session of player.sessions) send(session, { type: 'error', message: 'Your agent cannot learn right now; it will keep trying.' });
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
        for (const member of room.members.values()) {
          if (member.autopilot && member.session) send(member.session, { type: 'error', message: 'The autopilot cannot decide right now; it will keep trying.' });
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
