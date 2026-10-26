"""Agent inference service: turns room state into guard actions with the pretrained models.

POST /act takes one room's state (see policy.Policies.act) and returns
{"actions": [[move, gait, gaze], ...]} for the explorers the agent drives. Room servers call
it every 0.5 s for each room with an agent in control. It keeps no room state, only caches
(plans, checkpoints, environments), so it scales horizontally.

Start-up loads and warms every plan and checkpoint in the background: /healthz answers at
once, /readyz once that is done. Decisions are serialised (the cached environments are
shared), and take a couple of milliseconds each.

Environment: PORT (8080), PLANS_DIR and MODELS_DIR (the repository's plans and
artifacts/final_models), GUARDRL_CACHE_DIR (line-of-sight caches).
"""
import json
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .policy import Policies

#: Largest request accepted: the field means of the biggest plan, base64-encoded, fit with room to spare.
MAX_REQUEST_BYTES = 4 << 20


def make_handler(policies, ready):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/healthz':
                self.reply(200, b'ok', 'text/plain')
            elif self.path == '/readyz':
                self.reply(200 if ready.is_set() else 503, b'ready' if ready.is_set() else b'loading', 'text/plain')
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path != '/act':
                self.send_error(404)
                return
            length = int(self.headers.get('Content-Length') or 0)
            if not 0 < length <= MAX_REQUEST_BYTES:
                self.reply(413, b'{"error": "request too large or empty"}')
                return
            try:
                actions = policies.act(json.loads(self.rfile.read(length)))
            except (KeyError, ValueError, TypeError) as error:
                self.reply(400, json.dumps({'error': str(error)}).encode())
                return
            self.reply(200, json.dumps({'actions': actions}).encode())

        def reply(self, status, body, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):     # keep probe and decision traffic out of the logs
            pass

    return Handler


def serve(port=8080, plans_dir=None, models_dir=None, preload=True):
    """Start serving in a background thread. Returns (server, ready event)."""
    policies, ready = Policies(plans_dir, models_dir), threading.Event()
    server = ThreadingHTTPServer(('', port), make_handler(policies, ready))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def load():
        if preload:
            policies.preload()
        ready.set()
        print('agent inference ready', flush=True)
    threading.Thread(target=load, daemon=True).start()
    return server, ready


def main():
    env = os.environ
    server, _ = serve(int(env.get('PORT', 8080)), env.get('PLANS_DIR'), env.get('MODELS_DIR'))
    print(f'agent inference on :{server.server_address[1]}', flush=True)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    server.shutdown()
    server.server_close()
    sys.exit(0)


if __name__ == '__main__':
    main()
