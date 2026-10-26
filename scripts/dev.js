// `npm start`: the room server on :8942 and the dev server on :8941, which serves both
// clients and passes /rooms through to the room server. Ctrl+C stops both.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOMS_PORT = process.env.ROOMS_PORT || '8942';
const run = (script, env = {}) => spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
  stdio: 'inherit',
  env: { ...process.env, ...env },
});

const children = [
  run('../services/room-server/src/server.js', { PORT: ROOMS_PORT }),
  run('./serve.js', { ROOMS_URL: `http://127.0.0.1:${ROOMS_PORT}` }),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
};
for (const child of children) child.on('exit', code => {
  stop();
  process.exitCode ||= code ?? 0;
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
