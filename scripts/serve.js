// Static file server for local development: `npm start`, then open http://127.0.0.1:8941/.
//
// The app loads about 40 ES modules and stylesheets in parallel. Python's http.server
// accepts only a handful of pending connections and resets the rest, which can leave
// the page half-loaded; Node's server does not have that limit.
//
// The page is dist/, except js/core/, which is served from packages/core/src/ so the
// browser runs the same core as the tests and the game servers.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** URL prefixes and the folders they map to; the first matching prefix wins. */
const MOUNTS = [
  ['/js/core/', fileURLToPath(new URL('../packages/core/src/', import.meta.url))],
  ['/', fileURLToPath(new URL('../dist/', import.meta.url))],
];
const PORT = Number(process.env.PORT) || 8941;
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

createServer(async (request, response) => {
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
}).listen(PORT, '127.0.0.1', () => console.log(`Pixel Map Lab: http://127.0.0.1:${PORT}/`));
