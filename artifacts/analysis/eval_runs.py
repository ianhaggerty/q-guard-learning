"""Exact (field_slices=1, i.e. the JS 0.05 s integration) 30-minute evaluation of trained runs.

usage: python analysis/eval_runs.py <run_dir> <plan.json> <n_guards> [--ckpt best.pt] [--tag name]
Writes results/<tag>/metrics.json, rollout.npz and figures."""
import argparse, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numba
from guardrl.report_figs import evaluate_model, figure_rollout, figure_occupancy, make_gif
from guardrl.evaluate import rollout

ap = argparse.ArgumentParser()
ap.add_argument('run'); ap.add_argument('plan'); ap.add_argument('guards', type=int)
ap.add_argument('--ckpt', default='best.pt'); ap.add_argument('--tag', default=None)
ap.add_argument('--seconds', type=float, default=1800); ap.add_argument('--gif', action='store_true')
ap.add_argument('--w', type=float, default=0.3); ap.add_argument('--threads', type=int, default=2)
ap.add_argument('--title', default=None)
a = ap.parse_args()
numba.set_num_threads(a.threads)
import torch; torch.set_num_threads(a.threads)
tag = a.tag or os.path.basename(a.run.rstrip('/'))
out = os.path.join('results', tag); os.makedirs(out, exist_ok=True)
snap = (600, 780, 2.0) if a.gif else None
from guardrl.report_figs import load_agent
from guardrl.plan import load_plan
from guardrl.evaluate import agent_policy
ag = load_agent(os.path.join(a.run, a.ckpt))
plan = load_plan(a.plan, verbose=False)
nog = [0] * a.guards if len(ag.nets) == 1 else list(range(a.guards))
r = rollout(plan, agent_policy(ag, nog), a.guards, seconds=a.seconds, field_slices=1, snap=snap)
m = dict(r['metrics']); m['cost'] = a.w * m['mean_psum'] + m['team_kcal_per_hour'] / 3600
m['run'] = a.run; m['ckpt'] = a.ckpt; m['plan'] = a.plan; m['guards'] = a.guards
# per-guard kcal and detection credit
m['kcal_per_hour_by_guard'] = (r['kcal'][:, 0].sum(0) / (a.seconds) * 3600).tolist()
m['detected_by_guard'] = r['credit'][:, 0].sum(0).tolist()
json.dump(m, open(os.path.join(out, 'metrics.json'), 'w'), indent=1)
np.savez_compressed(os.path.join(out, 'rollout.npz'), traj=r['traj'][:, 0], psum=r['psum'][:, 0], kcal=r['kcal'][:, 0],
                    credit=r['credit'][:, 0], floor_sums=r['floor_sums'][:, 0], act_secs=r['act_secs'][0])
figure_rollout(plan, r, a.title or tag, os.path.join(out, 'rollout.png'), w_level=a.w)
figure_occupancy(plan, r, os.path.join(out, 'occupancy.png'), title=a.title or tag)
if a.gif:
    make_gif(plan, r, os.path.join(out, 'patrol.gif'))
print(json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items() if k not in ('frac',)}), m['frac'])
