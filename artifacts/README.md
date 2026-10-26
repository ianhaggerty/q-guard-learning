# Q-learning guards for Pixel Map Lab

Trained guard policies, training and inference code, and floor plans.
Commands below run from `guard_qlearning`.

## Contents

| Path | Contents |
|---|---|
| `final_models/` | 14 neural checkpoints named `m<plan>_g<guards>.pt`. |
| `final_models/manifest.json` | Model-to-plan, guard count, and training-config index. Paths are relative to `guard_qlearning`. |
| `runs/<name>/config.json` | Original training parameters, without training logs or performance results. |
| `runs/T1_m2_tab/q.npz`, `runs/T2_m2_tabF/q.npz` | Tabular policies without and with field features. |
| `configs/` | Curriculum pretraining configurations. |
| `scripts_extra/run_all.sh` | Training recipes and their initialization dependencies. |
| `guardrl/` | Simulator, environment, observations, models, training, inference, and visualization code. |
| `analysis/eval_runs.py`, `analysis/eval_tabular.py` | Run neural and tabular policies; generate new local evaluation output. |
| `plans/` | Seven hand-made maps, also available in the app's `../apps/web/plans/`. |
| `plans_curriculum/` | 31 curriculum maps and their index. |
| `maps/` | Curriculum map generator and JavaScript map builder. |
| `validation/` | Simulator cross-check tools; they run the app's JavaScript core in `../packages/core/src/` (override with `CORE_DIR`). |

## Setup

```bash
pip install numpy numba torch matplotlib pillow
```

Node.js is required for map generation and JavaScript cross-checks.
The line-of-sight cache in `cache/` is rebuilt automatically.

`guardrl` is also an installable package (`pip install ./artifacts` from the repository
root, add `[viz]` for the figure code); the agent-inference and trainer services install it
this way.

## Run a saved model

```bash
python analysis/eval_runs.py final_models "plans/7. Alcatraz.json" 3 --ckpt m7_g3.pt --tag my_eval
```

This runs a 30-minute simulated evaluation and writes local output to
`results/my_eval/`. Add `--gif` to generate a patrol animation.
Use `final_models/manifest.json` to choose the matching map and guard count.

For inference from Python:

```python
from guardrl.report_figs import load_agent
from guardrl.plan import load_plan
from guardrl.evaluate import agent_policy, rollout

agent = load_agent("final_models/m7_g3.pt")
plan = load_plan("plans/7. Alcatraz.json", verbose=False)
mapping = [0, 0, 0] if len(agent.nets) == 1 else [0, 1, 2]
result = rollout(plan, agent_policy(agent, mapping), 3, seconds=60, field_slices=1)
```

Run the saved tabular policies with:

```bash
python analysis/eval_tabular.py tabular
```

## Train

```bash
python -m guardrl.train --set "plan=plans/2. Simple Centre.json" w_level=0.3 w_level_start=3.0 out=runs/demo
```

To use an original configuration, for example:

```bash
python -m guardrl.train --config runs/P1_m4_scratch/config.json --set out=runs/my_training
```

Curriculum pretraining:

```bash
python -m guardrl.train --config configs/gen_bdq.json --set out=runs/gen_bdq
```

The curriculum maps are already supplied. To regenerate them:

```bash
python maps/generate_curriculum.py 24
```

Some original recipes require intermediate checkpoints such as
`runs/gen_bdq/best.pt` or `runs/init_m7_g2.pt`. Those intermediate neural
checkpoints are not bundled. Train the predecessor first or explicitly set
`init` to a compatible supplied checkpoint; using a different initialization
does not reproduce the original training history. The final checkpoints can
be run directly without these intermediate files.

Training uses 0.5-second decisions, with movement, gait, and gaze action
branches. The default reduction reward credits detection reduction per guard
and subtracts energy expenditure. See `guardrl/train.py` for defaults and
`scripts_extra/run_all.sh` for scratch training, transfer, demonstrations,
reward schedules, and multi-guard recipes.

Generated evaluation output, logs, caches, and report artifacts are excluded
by the root `.gitignore`. Supplied checkpoints, training configurations, and
maps are retained.
