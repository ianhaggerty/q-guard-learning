# Pixel Map Lab

A raster map editor and exploration game, with Q-learning guard agents trained on the same
maps. This repository is being extended into a multiplayer service where people and trained
agents patrol one map together, and people fine-tune agents from their own play.

## Layout

| Path | Contents |
|---|---|
| `packages/core/` | `@pixel-map-lab/core`: the simulation (maps, movement, detection, events). No DOM; shared by the browser client and the game servers. |
| `apps/web/` | The browser client: editor and Explore mode. Imports the core as `@pixel-map-lab/core` through an import map. |
| `services/room-server/` | Authoritative multiplayer rooms on the shared core (Node). Probes only so far. |
| `services/api/` | Accounts, lobby, plans, agents and fine-tuning jobs (Node). Probes only so far. |
| `services/agent-inference/` | Serves guard-agent actions to room servers (Python, guardrl). Probes only so far. |
| `services/trainer/` | Fine-tuning job entry point: `guardrl.train` sized to the container's CPU allowance. |
| `artifacts/` | Research bundle: the `guardrl` numba simulator and DQN learner, trained models, plans, training configs. See `artifacts/README.md`. |
| `deploy/docker/` | Container images, all built from the repository root. |
| `deploy/k8s/` | Kustomize base plus `dev` (kind) and `prod` overlays; job templates in `jobs/`. |
| `scripts/serve.js` | Development server for the client. |

## Develop

```bash
npm install          # links the workspaces; there are no third-party dependencies
npm start            # client at http://127.0.0.1:8941/ (serves packages/core at js/core/)
npm test             # core and plan tests
npm run build:web    # static site in apps/web/build/
```

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

The guardrl images compile every numba kernel at build time (`python -m guardrl.warmup`), so
pods start without the JIT delay. Production expects three node pools, selected by the
`pixel-map-lab/pool` label: `realtime` for room servers, `general` for the web, API and
inference, and `batch` (spot) for training jobs.
