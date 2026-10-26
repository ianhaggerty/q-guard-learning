# Pixel Map Lab

A raster map editor and exploration game, with Q-learning guard agents trained on the same
maps. This repository is being extended into a multiplayer service where people and trained
agents patrol one map together, and people fine-tune agents from their own play.

## Layout

| Path | Contents |
|---|---|
| `packages/core/` | `@pixel-map-lab/core`: the simulation (maps, movement, detection, events). No DOM; shared by the browser client and the game servers. |
| `apps/web/` | The browser client: editor and Explore mode. Imports the core as `@pixel-map-lab/core` through an import map. |
| `apps/play/` | The multiplayer client: a lobby for starting or joining a room on one of the seven plans, and the live room view, with each player's own agent and a heatmap cheat. |
| `services/room-server/` | Authoritative multiplayer rooms on the shared core (Node, WebSockets at `/rooms`). A room is destroyed when its last human leaves. |
| `services/api/` | Accounts, lobby, plans, agents and fine-tuning jobs (Node). Probes only so far. |
| `services/agent-inference/` | Guard-agent decisions for players who hand their explorer to their agent, and live fine-tuning of each player's agent from their play (Python, guardrl). |
| `services/trainer/` | Fine-tuning job entry point: `guardrl.train` sized to the container's CPU allowance. |
| `artifacts/` | Research bundle: the `guardrl` numba simulator and DQN learner, trained models, plans, training configs. See `artifacts/README.md`. |
| `deploy/docker/` | Container images, all built from the repository root. |
| `deploy/k8s/` | Kustomize base plus `dev` (kind) and `prod` overlays; job templates in `jobs/`. |
| `scripts/serve.js` | Development server for the client. |

## Develop

```bash
npm install          # links the workspaces (the room server's one dependency is ws)
npm start            # room server, agent service, editor at http://127.0.0.1:8941/, multiplayer at /play/
npm test             # every workspace's tests
npm run test:agents  # the agent service's Python tests
npm run build:web    # static editor in apps/web/build/ (build:play for apps/play/build/)
npm run bench -w packages/core   # simulation cost per room tick
```

Every browser tab that opens `/play/` is a session with its own id; closing the tab ends
it. Each player has their own agent per map, starting from the guard agent trained on that
map (the checkpoints in `artifacts/final_models`). "Let your agent drive" hands it the
explorer; while driving by hand, "Fine-tune while I play" teaches it from the player's
play, and "Copies me" sets how closely it follows them rather than its training. An agent
left driving keeps playing after its player leaves the room, until they return or close
the tab, which also discards their fine-tuned agents. "Show heatmap" reveals where
unspotted events are likely to be. The agent service needs Python with numpy, numba and
torch (`PYTHON`, default `python3`); without it, or with `AGENTS=off`, rooms still work. The dev server passes `/rooms` WebSocket connections through to the room server, as
the production ingress does.

Python services install the simulator as a package: `pip install ./artifacts`.

## Containers and Kubernetes

```bash
docker build -f deploy/docker/web.Dockerfile -t pml/web .
docker build -f deploy/docker/node-service.Dockerfile --build-arg SERVICE=api -t pml/api .
docker build -f deploy/docker/node-service.Dockerfile --build-arg SERVICE=room-server -t pml/room-server .
docker build -f deploy/docker/guardrl.Dockerfile --target agent-inference -t pml/agent-inference .
docker build -f deploy/docker/guardrl.Dockerfile --target trainer -t pml/trainer .

kubectl apply -k deploy/k8s/overlays/dev     # after tagging the images :dev and `kind load`-ing them
```

The web image serves the editor at `/` and the multiplayer client at `/play/`. The room
server runs as a single replica until rooms can be routed to the pod that holds them
(phase 5). The guardrl images compile every numba kernel at build time (`python -m guardrl.warmup`), so
pods start without the JIT delay. Production expects three node pools, selected by the
`pixel-map-lab/pool` label: `realtime` for room servers, `general` for the web, API and
inference, and `batch` (spot) for training jobs.
