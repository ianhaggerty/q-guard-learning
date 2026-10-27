"""Agent inference service: turns room state into guard actions with the pretrained models.

POST /act takes one room's state (see policy.Policies.act) and returns
{"actions": [[move, gait, gaze], ...]} for the explorers the agent drives. Room servers call
it every 0.5 s for each room with an agent in control.

Players' own agents (see tuning.py) are taught and managed with
  POST /demonstrate  one moment of a player's play -> {"demos", "updates", "blend", "version"}
  POST /flush        {"player", "plan"}: they stopped teaching (save, maybe queue training)
  POST /status       {"player", "plan"} -> how far their agent is taught and trained
  POST /reset        {"player", "plan"}: back to the pretrained agent on that plan
  POST /forget       {"player"}: the player has gone; drop their live agents
and trained live by a background thread. With DATABASE_URL and OBJECT_STORE_URL set,
logged-in players' ("user:<id>") demonstrations and agents are kept, trained further by the
trainer service, and followed as new versions are published (see persistence.py). Live
models are held in this process, so every request for a player must reach the same replica.

Start-up loads and warms every plan and checkpoint in the background: /healthz answers at
once, /readyz once that is done. Decisions are serialised (the cached environments are
shared), and take a couple of milliseconds each.

Environment: PORT (8080), PLANS_DIR and MODELS_DIR (the repository's plans and
artifacts/final_models), GUARDRL_CACHE_DIR (line-of-sight caches), MAX_TUNED_MODELS (32
live players' agents at once), DATABASE_URL and OBJECT_STORE_URL (keeping users' agents),
DATABASE_CONNECTIONS (4: the most this process opens; a request that finds storage
unreachable or every connection busy gets 503).
"""
import json
import os
import signal
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from model_store import Unavailable

from .persistence import Persistence
from .policy import Policies

#: Largest request accepted: the field means of the biggest plan, base64-encoded, fit with room to spare.
MAX_REQUEST_BYTES = 4 << 20


def make_handler(policies, ready):
    routes = {
        '/act': lambda body: {'actions': policies.act(body)},
        '/demonstrate': policies.demonstrate,
        '/flush': lambda body: (policies.flush(str(body['player']), str(body['plan'])), {})[1],
        '/status': lambda body: policies.status(str(body['player']), str(body['plan'])),
        '/reset': lambda body: (policies.reset(str(body['player']), str(body['plan'])), {})[1],
        '/forget': lambda body: (policies.forget(str(body['player'])), {})[1],
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/healthz':
                self.reply(200, b'ok', 'text/plain')
            elif self.path == '/readyz':
                self.reply(200 if ready.is_set() else 503, b'ready' if ready.is_set() else b'loading', 'text/plain')
            else:
                self.send_error(404)

        def do_POST(self):
            length = int(self.headers.get('Content-Length') or 0)
            if not 0 < length <= MAX_REQUEST_BYTES:
                self.reply(413, b'{"error": "request too large or empty"}')
                return
            try:
                body = json.loads(self.rfile.read(length))
                handler = routes.get(self.path)
                if handler is None:
                    self.send_error(404)
                    return
                result = handler(body)
            except (KeyError, ValueError, TypeError) as error:
                self.reply(400, json.dumps({'error': str(error)}).encode())
                return
            except Unavailable as error:
                self.reply(503, json.dumps({'error': f'storage unavailable: {error}'}).encode())
                return
            except Exception:
                traceback.print_exc()
                self.reply(500, b'{"error": "internal error"}')
                return
            self.reply(200, json.dumps(result).encode())

        def reply(self, status, body, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):     # keep probe and decision traffic out of the logs
            pass

    return Handler


def persistence_from_env():
    """Keeping users' agents, if DATABASE_URL and OBJECT_STORE_URL are set."""
    if not (os.environ.get('DATABASE_URL') and os.environ.get('OBJECT_STORE_URL')):
        return None
    from model_store.objects import open_objects
    from model_store.store import Store
    store = Store(os.environ['DATABASE_URL'], int(os.environ.get('DATABASE_CONNECTIONS', 4)), wait_seconds=1)
    return Persistence(store, open_objects())


def serve(port=8080, plans_dir=None, models_dir=None, preload=True, persistence=None):
    """Start serving, and training players' agents, in background threads. Returns (server, ready event)."""
    policies = Policies(plans_dir, models_dir, persistence, int(os.environ.get('MAX_TUNED_MODELS', 32)))
    ready = threading.Event()
    policies.start()
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
    persistence = persistence_from_env()
    server, _ = serve(int(env.get('PORT', 8080)), env.get('PLANS_DIR'), env.get('MODELS_DIR'), persistence=persistence)
    print(f'agent inference on :{server.server_address[1]} (users\' agents {"kept" if persistence else "not kept"})', flush=True)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    server.shutdown()
    server.server_close()
    sys.exit(0)


if __name__ == '__main__':
    main()
