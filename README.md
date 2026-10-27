# Pixel Map Lab

A raster map editor and exploration game, with Q-learning guard agents trained on the same
maps, extended into a multiplayer service where people and trained agents patrol one map
together, and people fine-tune their own agents from their play.

## Layout

| Path | Contents |
|---|---|
| `packages/core/` | `@pixel-map-lab/core`: the simulation (maps, movement, detection, events). No DOM; shared by the browser client and the game servers. |
| `packages/accounts/` | `@pixel-map-lab/accounts`: users and login sessions, shared by the API and the room server. |
| `apps/web/` | The browser client: editor and Explore mode. Imports the core as `@pixel-map-lab/core` through an import map. |
| `apps/play/` | The multiplayer client: sign-in, a lobby for starting or joining a room on one of the seven plans, and the live room view, with each player's own agent and a heatmap cheat. |
| `services/api/` | Sign-in with GitHub (OAuth), accounts, and the database migrations (Node). |
| `services/room-server/` | Authoritative multiplayer rooms on the shared core (Node, WebSockets at `/rooms`). A room closes when nobody, person or agent, is left in it. |
| `services/agent-inference/` | Guard-agent decisions for players who hand their explorer to their agent, and live fine-tuning of each player's agent from their play (Python, guardrl). |
| `services/trainer/` | Training workers: reward-driven fine-tuning of players' agents from the queue (`python -m trainer.worker`), and whole guardrl training runs (`python -m trainer`). |
| `services/model-store/` | Python package for players' kept agents: records and the training queue in Postgres, weights and demonstrations in object storage, the training schedule. |
| `artifacts/` | Research bundle: the `guardrl` numba simulator and DQN learner, trained models, plans, training configs. See `artifacts/README.md`. |
| `deploy/db/migrations/` | The Postgres schema. |
| `deploy/docker/` | Container images, all built from the repository root; `deploy/compose/dev.yml` runs Postgres locally. |
| `deploy/k8s/` | Kustomize base plus `dev` (kind) and `prod` overlays; job templates in `jobs/`. |
| `scripts/` | `npm start` (everything for development), the development server, the Python test runner. |

## Develop

```bash
npm install          # links the workspaces (third-party: ws, pg)
npm start            # editor at http://127.0.0.1:8941/, multiplayer at /play/ (everyone a guest)
npm test             # every workspace's tests
npm run build:web    # static editor in apps/web/build/ (build:play for apps/play/build/)
npm run bench -w packages/core   # simulation cost per room tick
```

`npm start` runs the development server, the room server and the agent service. The agent
service needs Python with numpy, numba and torch (`PYTHON`, default the repository's `.venv`
if there is one, else `python3`); without it, or with `AGENTS=off`, rooms still work.

### With accounts, kept agents and training

```bash
python3 -m venv --system-site-packages .venv && .venv/bin/pip install "psycopg[binary]==3.2.3" boto3==1.35.54
docker compose -f deploy/compose/dev.yml up -d          # Postgres on 127.0.0.1:5433
export DATABASE_URL=postgres://pml:pml-dev@127.0.0.1:5433/pml
npm run db:migrate
npm start                                               # now also the API and a trainer worker
TEST_DATABASE_URL=$DATABASE_URL npm run test:python     # the Python suites, with their database tests
```

Development sign-in (any name) is on; set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (an
OAuth app with callback `http://127.0.0.1:8941/api/auth/github/callback`) for GitHub.
Kept agents and demonstrations go to `.dev-data/objects` unless `OBJECT_STORE_URL` says
otherwise.

## How play works

Every browser tab that opens `/play/` is a session. A guest is one tab: their agents stop
and their fine-tuned agents are discarded when it closes. A signed-in player is the same
player in every tab, and their agents are kept.

Each player has their own agent per map, starting from the guard agent trained on that map
(the checkpoints in `artifacts/final_models`). "Let your agent drive" hands it the
explorer. While driving by hand, "Fine-tune while I play" teaches it: each 0.5 s of play is
a demonstration, learned from live within seconds, and "Copies me" sets how closely it
follows the player rather than its training. For signed-in players the demonstrations are
saved, and the trainer periodically consolidates them with reward-driven learning in the
simulator (about a minute per job; at most once per map every 10 minutes while teaching),
publishing a new version only if it does not play more than 5 % worse, unless the player
asked mostly to be copied. The measurements behind these choices are in
`services/trainer/trainer/finetune.py` and `services/model-store/model_store/schedule.py`.

An agent left driving keeps playing after its player leaves the room: a guest's until they
come back or close the tab, a signed-in player's for up to an hour after their last tab
closes. "Show heatmap" reveals where unspotted events are likely to be.

## Containers and Kubernetes

```bash
docker build -f deploy/docker/web.Dockerfile -t pml/web .
docker build -f deploy/docker/node-service.Dockerfile --build-arg SERVICE=api -t pml/api .
docker build -f deploy/docker/node-service.Dockerfile --build-arg SERVICE=room-server -t pml/room-server .
docker build -f deploy/docker/guardrl.Dockerfile --target agent-inference -t pml/agent-inference .
docker build -f deploy/docker/guardrl.Dockerfile --target trainer -t pml/trainer .

kubectl apply -k deploy/k8s/overlays/dev     # after tagging the images :dev and `kind load`-ing them
kubectl create -n pml-dev -f deploy/k8s/jobs/migrate-job.yaml
```

The web image serves the editor at `/` and the multiplayer client at `/play/`. The room
server and the agent service each run as a single replica until players and rooms can be
routed to the pod that holds them. Trainer workers are stateless and scale out: KEDA runs
one per due job, from zero to 20. The guardrl images compile every numba kernel and build
the plans' sight caches at build time, so pods start without the delay. Production expects
three node pools, selected by the `pixel-map-lab/pool` label: `realtime` for room servers,
`general` for the web, API and inference, and `batch` (spot) for trainer workers, plus a
managed Postgres, S3 and the `pml-secrets` Secret described in
`deploy/k8s/base/kustomization.yaml`.
