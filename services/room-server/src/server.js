// Room server: hosts authoritative multiplayer rooms on the shared core. Browsers connect
// a WebSocket to /rooms (one per tab: that connection is the session) and talk to the
// Lobby; HTTP serves only the Kubernetes probes. A browser signed in through the API sends
// its login cookie with the WebSocket handshake, which makes the session a signed-in
// player's; without one it is a guest's.
//
// One clock ticks every room in whole 0.05 s steps. On SIGTERM the server drains: it
// stops taking new rooms and joins (readiness fails), lets live rooms play on until their
// humans leave, and exits once no room is left (or Kubernetes' grace period runs out).
//
// Environment: PORT (8080), PLANS_DIR (the repository's plans), MAX_ROOMS (100),
// MAX_HUMANS_PER_ROOM (8), AGENT_URL (the agent inference service; without it there is no
// autopilot), DATABASE_URL (to recognise signed-in players; without it everyone is a guest),
// AGENT_OFFLINE_SECONDS (3600: how long signed-in players' agents play on with no tab open).

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Accounts, userFromCookies } from '@pixel-map-lab/accounts';
import { loadPlans } from './plans.js';
import { Lobby } from './lobby.js';
import { agentClient } from './agents.js';
import { TICK_SECONDS } from './room.js';

/** Largest message a client may send; inputs are a few dozen bytes. */
const MAX_MESSAGE_BYTES = 4096;

/** Messages a session may send per second, sustained, and in a burst. */
const MESSAGES_PER_SECOND = 30, MESSAGE_BURST = 60;

/** How often connections are pinged; one that has not answered the previous ping is closed. */
const HEARTBEAT_MS = 15_000;

/** Most ticks run back to back after a stall; anything older is dropped rather than replayed. */
const MAX_CATCH_UP_TICKS = 5;

/**
 * Start a room server. Resolves to { port, lobby, draining(), close() } once listening.
 * options: port (0 picks a free one), plansDir, maxRooms, maxHumansPerRoom, agents (an
 * agent service client, or null), accounts (to recognise signed-in players, or null),
 * offlineSeconds, tickMs (wall-clock milliseconds per tick; tests run faster than real time).
 */
export function startServer({
  port = 8080, plansDir, maxRooms, maxHumansPerRoom, agents = null, accounts = null, offlineSeconds, tickMs = TICK_SECONDS * 1000,
} = {}) {
  const lobby = new Lobby({ plans: loadPlans(plansDir), maxRooms, maxHumansPerRoom, agents, offlineSeconds });

  const server = createServer((request, response) => {
    if (request.url === '/healthz') response.writeHead(200).end('ok');
    else if (request.url === '/readyz') response.writeHead(lobby.draining ? 503 : 200).end(lobby.draining ? 'draining' : 'ready');
    else response.writeHead(404).end('Not found');
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://localhost').pathname !== '/rooms') {
      socket.destroy();
      return;
    }
    // Who is it? A login cookie that does not check out (or a database hiccup) makes a guest.
    userFromCookies(accounts, request.headers.cookie)
      .catch(() => null)
      .then(user => sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, user)));
  });

  sockets.on('connection', (ws, user) => {
    const session = lobby.connect(ws, user);
    let tokens = MESSAGE_BURST, refilled = performance.now();
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, isBinary) => {
      const now = performance.now();
      tokens = Math.min(MESSAGE_BURST, tokens + (now - refilled) / 1000 * MESSAGES_PER_SECOND);
      refilled = now;
      if (--tokens < 0) {
        ws.close(1008, 'Too many messages');
        return;
      }
      let message;
      try {
        message = isBinary ? null : JSON.parse(data.toString());
      } catch {
        message = null;
      }
      lobby.handle(session, message);
    });
    ws.on('close', () => lobby.disconnect(session));
  });

  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  // A fixed-step clock: real time is paid out in whole ticks.
  let last = performance.now(), owed = 0;
  const clock = setInterval(() => {
    const now = performance.now();
    owed += now - last;
    last = now;
    let ticks = 0;
    while (owed >= tickMs && ticks < MAX_CATCH_UP_TICKS) {
      lobby.tick();
      owed -= tickMs;
      ticks++;
    }
    if (owed >= tickMs) owed = 0;
  }, tickMs / 2);

  const close = () => new Promise(resolve => {
    clearInterval(clock);
    clearInterval(heartbeat);
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    server.close(() => resolve());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve({
      port: server.address().port,
      lobby,
      close,
      /** Stop taking new rooms and joins; resolves once no room is left. */
      draining: () => {
        lobby.draining = true;
        return new Promise(done => {
          const check = setInterval(() => {
            if (lobby.rooms.size) return;
            clearInterval(check);
            done();
          }, 250);
        });
      },
    }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const room = await startServer({
    port: Number(env.PORT) || 8080,
    plansDir: env.PLANS_DIR || undefined,
    maxRooms: Number(env.MAX_ROOMS) || undefined,
    maxHumansPerRoom: Number(env.MAX_HUMANS_PER_ROOM) || undefined,
    agents: env.AGENT_URL ? agentClient(env.AGENT_URL) : null,
    accounts: env.DATABASE_URL ? new Accounts(env.DATABASE_URL) : null,
    offlineSeconds: Number(env.AGENT_OFFLINE_SECONDS) || undefined,
  });
  console.log(`Room server on :${room.port} (${room.lobby.plans.size} plans, autopilot ${env.AGENT_URL ? 'via ' + env.AGENT_URL : 'off'})`);
  process.on('SIGTERM', async () => {
    console.log('Draining: no new rooms; waiting for live rooms to empty.');
    await room.draining();
    await room.close();
    process.exit(0);
  });
}
