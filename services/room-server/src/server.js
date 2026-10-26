// Room server: will host authoritative multiplayer rooms on the shared core (phase 2).
// For now it only exposes the probes Kubernetes needs and drains on SIGTERM, which is the
// lifecycle a stateful game server must follow: stop taking new rooms, let live rooms end,
// then exit before terminationGracePeriodSeconds runs out.

import { createServer } from 'node:http';
import { MATERIAL } from '@pixel-map-lab/core';

const PORT = Number(process.env.PORT) || 8080;

let draining = false;

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200).end('ok');
  } else if (request.url === '/readyz') {
    response.writeHead(draining ? 503 : 200).end(draining ? 'draining' : 'ready');
  } else {
    response.writeHead(404).end('Not found');
  }
});

process.on('SIGTERM', () => {
  draining = true;
  server.close(() => process.exit(0));
});

server.listen(PORT, () => console.log(`Room server on :${PORT} (core materials: ${Object.keys(MATERIAL).length})`));
