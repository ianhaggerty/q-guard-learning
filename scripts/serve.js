// Static file server for local development (`npm start` runs it with the room server):
// the editor at http://127.0.0.1:8941/ and the multiplayer client at /play/.
//
// The app loads about 40 ES modules and stylesheets in parallel. Python's http.server
// accepts only a handful of pending connections and resets the rest, which can leave
// the page half-loaded; Node's server does not have that limit.
//
// The pages are apps/web/ and apps/play/, except their js/core/, which is served from
// packages/core/src/ so the browser runs the same core as the tests and the game servers
// (`npm run build:web` and `build:play` produce the same layout as static folders).
//
// WebSocket connections to /rooms are passed through to the room server (ROOMS_URL,
// default http://127.0.0.1:8942), so the play client always connects to its own origin,
// as it does behind the production ingress.

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** URL prefixes and the folders they map to; the first matching prefix wins. */
const CORE = fileURLToPath(new URL('../packages/core/src/', import.meta.url));
const MOUNTS = [
  ['/play/js/core/', CORE],
  ['/play/', fileURLToPath(new URL('../apps/play/', import.meta.url))],
  ['/js/core/', CORE],
  ['/', fileURLToPath(new URL('../apps/web/', import.meta.url))],
];
const PORT = Number(process.env.PORT) || 8941;
const ROOMS = new URL(process.env.ROOMS_URL || 'http://127.0.0.1:8942');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** The file a request path maps to, or null when the path is malformed or leaves its mount. */
function resolveFile(requestUrl) {
  let path;
  try {
    path = decodeURIComponent(requestUrl.split('?')[0]);
  } catch {
    return null;
  }
  const mount = MOUNTS.find(([prefix]) => path.startsWith(prefix));
  if (!mount) return null;
  const [prefix, root] = mount;
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const relative = path.slice(prefix.length);
  const file = normalize(join(root, relative === '' || relative.endsWith('/') ? relative + 'index.html' : relative));
  return file.startsWith(rootPrefix) ? file : null;
}

const server = createServer(async (request, response) => {
  const file = resolveFile(request.url);
  if (!file) {
    response.writeHead(400).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

// Pass WebSocket upgrades for /rooms straight through to the room server.
server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url, 'http://localhost').pathname !== '/rooms') {
    socket.destroy();
    return;
  }
  const upstream = connect(Number(ROOMS.port) || 80, ROOMS.hostname, () => {
    const headers = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`Pixel Map Lab: http://127.0.0.1:${PORT}/ · play at /play/`));
