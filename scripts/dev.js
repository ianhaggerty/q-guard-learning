// `npm start`: everything for local development.
//   * dev server on :8941 (both clients; passes /rooms and /api through)
//   * room server on :8942
//   * agent inference service on :8943 (needs Python with numpy, numba and torch)
// With DATABASE_URL set (see deploy/compose/dev.yml), also:
//   * the API on :8944, with GitHub sign-in if GITHUB_CLIENT_ID/SECRET are set and
//     development sign-in (DEV_LOGIN, on by default here)
//   * a trainer worker, and kept agents (OBJECT_STORE_URL, default .dev-data/objects)
// Without it everyone plays as a guest, as before. PYTHON picks the interpreter (default:
// the repository's .venv if there is one, else python3); AGENTS=off skips the Python
// services. Ctrl+C stops everything.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const env = process.env;
const ports = { serve: '8941', rooms: env.ROOMS_PORT || '8942', agents: env.AGENTS_PORT || '8943', api: env.API_PORT || '8944' };
const repo = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const withAgents = env.AGENTS !== 'off';
const database = env.DATABASE_URL;
const python = env.PYTHON || (existsSync(repo('.venv/bin/python')) ? repo('.venv/bin/python') : 'python3');
const pythonPath = ['artifacts', 'services/model-store', 'services/agent-inference', 'services/trainer'].map(repo).concat(env.PYTHONPATH || []).filter(Boolean).join(':');
const stored = database ? { DATABASE_URL: database, OBJECT_STORE_URL: env.OBJECT_STORE_URL || `file://${repo('.dev-data/objects')}` } : {};

const start = (command, args, extra = {}) => spawn(command, args, { stdio: 'inherit', env: { ...env, ...extra } });

const essential = [
  start(process.execPath, [repo('services/room-server/src/server.js')], {
    PORT: ports.rooms,
    ...(withAgents ? { AGENT_URL: `http://127.0.0.1:${ports.agents}` } : {}),
    ...(database ? { DATABASE_URL: database } : {}),
  }),
  start(process.execPath, [repo('scripts/serve.js')], {
    ROOMS_URL: `http://127.0.0.1:${ports.rooms}`, API_URL: `http://127.0.0.1:${ports.api}`,
  }),
];
if (database) {
  essential.push(start(process.execPath, [repo('services/api/src/server.js')], {
    PORT: ports.api, DATABASE_URL: database, PUBLIC_URL: `http://127.0.0.1:${ports.serve}`, DEV_LOGIN: env.DEV_LOGIN ?? '1',
  }));
}
const optional = [];
if (withAgents) {
  optional.push(start(python, ['-m', 'agent_inference.server'], { PORT: ports.agents, PYTHONPATH: pythonPath, ...stored }));
  if (database) optional.push(start(python, ['-m', 'trainer.worker'], { PYTHONPATH: pythonPath, CPU_LIMIT: env.CPU_LIMIT || '2', ...stored }));
}

const stop = () => {
  for (const child of [...essential, ...optional]) child.kill('SIGTERM');
};
for (const child of essential) child.on('exit', code => {
  stop();
  process.exitCode ||= code ?? 0;
});
for (const child of optional) {
  child.on('error', () => console.warn(`Could not start ${python}; the autopilot and training are unavailable.`));
  child.on('exit', code => {
    if (code) console.warn(`A Python service stopped (exit ${code}); the autopilot or training may be unavailable.`);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
