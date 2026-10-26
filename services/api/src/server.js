// API service: will own accounts, the lobby, plans, agents and fine-tuning jobs (phases 2-5).
// Stateless (state lives in Postgres, Redis and object storage), so it scales horizontally.
// For now it only exposes the Kubernetes probes.

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 8080;

const server = createServer((request, response) => {
  if (request.url === '/healthz' || request.url === '/readyz') {
    response.writeHead(200).end('ok');
  } else {
    response.writeHead(404).end('Not found');
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));

server.listen(PORT, () => console.log(`API on :${PORT}`));
