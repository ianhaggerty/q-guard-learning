"""Exact 30-min evaluation of the tabular Q-learning runs and of the hand-written baselines."""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numba
numba.set_num_threads(1)
from guardrl.plan import load_plan, plan_paths
from guardrl.tabular import tabular_policy
from guardrl.evaluate import rollout, stand_policy, spin_policy, random_policy, heuristic_policy
from guardrl.report_figs import figure_rollout

def save(tag, plan, r, w=0.3, title=None):
    out = os.path.join('results', tag); os.makedirs(out, exist_ok=True)
    m = dict(r['metrics']); m['cost'] = w * m['mean_psum'] + m['team_kcal_per_hour'] / 3600
    json.dump(m, open(os.path.join(out, 'metrics.json'), 'w'), indent=1)
    np.savez_compressed(os.path.join(out, 'rollout.npz'), traj=r['traj'][:, 0], psum=r['psum'][:, 0], kcal=r['kcal'][:, 0])
    figure_rollout(plan, r, title or tag, os.path.join(out, 'rollout.png'), w_level=w)
    print(tag, round(m['mean_psum'], 4), round(m['team_kcal_per_hour'], 1), round(m['cost'], 4))

if __name__ == '__main__':
    what = sys.argv[1]
    if what == 'tabular':
        plan = load_plan('plans/2. Simple Centre.json', verbose=False)
        for run, feat in [('T1_m2_tab', False), ('T2_m2_tabF', True)]:
            z = np.load(f'runs/{run}/q.npz'); Q = [z[k] for k in z.files]
            r = rollout(plan, tabular_policy(Q, plan, False, feat), 1, seconds=1800, field_slices=1)
            save('var_' + run, plan, r)
    else:
        G = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        for p in plan_paths():
            plan = load_plan(p, verbose=False)
            if G > len(plan.starts):
                continue
            for name, pol in [('stand', stand_policy()), ('spin', spin_policy()), ('heuristic', heuristic_policy({}))]:
                r = rollout(plan, pol, G, seconds=1800, field_slices=1)
                save(f'base_{name}_m{plan.name[0]}_g{G}', plan, r, title=f'{plan.name} - {name} baseline ({G} guard{"s" if G > 1 else ""})')
