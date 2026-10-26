// Static file server for local development: `npm start`, then open http://127.0.0.1:8941/.
//
// The app loads about 40 ES modules and stylesheets in parallel. Python's http.server
// accepts only a handful of pending connections and resets the rest, which can leave
// the page half-loaded; Node's server does not have that limit.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const ROOT_PREFIX = ROOT.endsWith(sep) ? ROOT : ROOT + sep;
const PORT = Number(process.env.PORT) || 8941;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** The file a request path maps to, or null when the path is malformed or leaves dist/. */
function resolveFile(requestUrl) {
  let path;
  try {
    path = decodeURIComponent(requestUrl.split('?')[0]);
  } catch {
    return null;
  }
  const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
  return file.startsWith(ROOT_PREFIX) ? file : null;
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
