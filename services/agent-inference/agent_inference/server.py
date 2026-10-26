"""Agent inference service: will turn room snapshots into guard actions (phase 3).

Every 0.5 s each room server will send the compact state of its rooms; this service encodes
observations with guardrl and batches every agent through its model.  It is stateless apart
from caches (static plan tensors, recently used models), so it scales horizontally; routing a
room consistently to one replica keeps those caches warm.

For now it only exposes the Kubernetes probes.  Numba kernels were compiled into the image
at build time (python -m guardrl.warmup), so start-up does not pay the JIT cost.
"""
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/healthz', '/readyz'):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_error(404)

    def log_message(self, format, *args):     # keep probe traffic out of the logs
        pass


def main():
    server = ThreadingHTTPServer(('', int(os.environ.get('PORT', 8080))), Handler)
    # shutdown() would deadlock here (it waits for serve_forever on this same thread); exiting
    # unwinds serve_forever instead.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(f'agent inference on :{server.server_address[1]}', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
