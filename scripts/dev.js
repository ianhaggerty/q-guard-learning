// `npm start`: the room server on :8942, the agent inference service on :8943 and the dev
// server on :8941, which serves both clients and passes /rooms through to the room server.
// Ctrl+C stops everything.
//
// The agent service needs Python with numpy, numba and torch (PYTHON, default python3).
// Without it, or with AGENTS=off, rooms still work; the autopilot just cannot decide.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOMS_PORT = process.env.ROOMS_PORT || '8942';
const AGENTS_PORT = process.env.AGENTS_PORT || '8943';
const withAgents = process.env.AGENTS !== 'off';
const repo = path => fileURLToPath(new URL(`../${path}`, import.meta.url));

const start = (command, args, env = {}) => spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });

const essential = [
  start(process.execPath, [repo('services/room-server/src/server.js')], {
    PORT: ROOMS_PORT,
    ...(withAgents ? { AGENT_URL: `http://127.0.0.1:${AGENTS_PORT}` } : {}),
  }),
  start(process.execPath, [repo('scripts/serve.js')], { ROOMS_URL: `http://127.0.0.1:${ROOMS_PORT}` }),
];
const optional = withAgents ? [
  start(process.env.PYTHON || 'python3', ['-m', 'agent_inference.server'], {
    PORT: AGENTS_PORT,
    PYTHONPATH: [repo('artifacts'), repo('services/agent-inference'), process.env.PYTHONPATH].filter(Boolean).join(':'),
  }),
] : [];

const stop = () => {
  for (const child of [...essential, ...optional]) child.kill('SIGTERM');
};
for (const child of essential) child.on('exit', code => {
  stop();
  process.exitCode ||= code ?? 0;
});
for (const child of optional) {
  child.on('error', () => console.warn('Agent service not started (is Python installed?); the autopilot is unavailable.'));
  child.on('exit', code => {
    if (code) console.warn(`Agent service stopped (exit ${code}); the autopilot is unavailable.`);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
