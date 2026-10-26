"""Cross-check the numba simulator against the original JavaScript core (run with bun/node).

For several plans, random persistent action sequences (plus scripted chair / stair tests)
are replayed in both implementations; positions, floors, energy and the probability sum
are compared step by step.  Writes validation/validation_results.json."""
import json, os, subprocess, sys, shutil
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guardrl.plan import load_plan, plan_paths
from guardrl.env import GuardEnv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.environ.get('CORE_DIR', os.path.join(ROOT, 'js_core'))
RUNTIME = shutil.which('node') or shutil.which('bun')


def random_actions(rng, n, chair_bias=False):
    acts = []
    mv, gait, look = rng.integers(0, 9), 0, 0
    for t in range(n):
        if rng.random() < 0.15:
            mv = int(rng.integers(0, 10 if chair_bias else 9))
        if rng.random() < 0.1:
            gait = int(rng.integers(0, 3))
        if rng.random() < 0.15:
            look = int(rng.integers(0, 8))
        acts.append([int(mv), int(gait), int(look)])
    return acts


def run_case(plan_path, actions, start=None, dt=0.5, tag=''):
    spec = {'dt': dt, 'actions': actions}
    if start:
        spec['start'] = start
    tmp_in, tmp_out = '/tmp/_val_in.json', '/tmp/_val_out.json'
    json.dump(spec, open(tmp_in, 'w'))
    subprocess.run([RUNTIME, os.path.join(ROOT, 'validation', 'js_rollout.mjs'), CORE, plan_path, tmp_in, tmp_out], check=True)
    js = json.load(open(tmp_out))
    plan = load_plan(plan_path, verbose=False)
    env = GuardEnv(plan, 1, 1, dt=dt, field_slices=1)
    s = start or plan.starts[0]
    env.reset_env(0, starts=[s])
    py = []
    kc = 0.0
    for a in actions:
        k, c, ps = env.step(np.array([[a]]))
        kc += k[0, 0]
        py.append(dict(x=env.pos[0, 0, 0], y=env.pos[0, 0, 1], floor=int(env.fl[0, 0]), kcal=kc, psum=ps[0],
                       sitting=bool(env.sitting[0, 0]), facing=int(env.facing[0, 0])))
    dpos = max(abs(a['x'] - b['x']) + abs(a['y'] - b['y']) for a, b in zip(js, py))
    dfl = sum(a['floor'] != b['floor'] for a, b in zip(js, py))
    dsit = sum(a['sitting'] != b['sitting'] for a, b in zip(js, py))
    dfac = sum(a['facing'] != b['facing'] for a, b in zip(js, py))
    rk = max(abs(a['kcal'] - b['kcal']) / max(1e-9, a['kcal']) for a, b in zip(js, py))
    rp = max(abs(a['psum'] - b['psum']) / max(1e-12, a['psum']) for a, b in zip(js, py) if a['psum'] > 0)
    res = dict(plan=os.path.basename(plan_path), case=tag, steps=len(actions), max_pos_err_px=dpos, floor_mismatch=dfl,
               sit_mismatch=dsit, facing_mismatch=dfac, max_rel_kcal_err=rk, max_rel_psum_err=rp,
               final_js=dict(kcal=js[-1]['kcal'], psum=js[-1]['psum'], floor=js[-1]['floor']),
               final_py=dict(kcal=py[-1]['kcal'], psum=py[-1]['psum'], floor=py[-1]['floor']),
               sits=sum(b['sitting'] for b in py), floor_changes=sum(py[i]['floor'] != py[i - 1]['floor'] for i in range(1, len(py))))
    print(json.dumps(res))
    return res


if __name__ == '__main__':
    rng = np.random.default_rng(1)
    results = []
    for p in plan_paths():
        results.append(run_case(p, random_actions(rng, 240), tag='random persistent walk'))
    plans = {os.path.basename(p)[:1]: p for p in plan_paths()}
    # chair test: start at the front of the corridor chair, sit, look around, stand up, walk
    acts = [[9, 0, 0]] * 4 + [[0, 0, 2]] * 4 + [[5, 0, 0]] * 10 + [[1, 1, 0]] * 4 + [[9, 0, 6]] * 6
    results.append(run_case(plans['1'], acts, start={'x': 93.0, 'y': 10.5, 'floor': 0}, tag='chair sit/stand'))
    # stairs test (courtyard straight stair: lower 0 -> upper 1 heading east, then back)
    acts = [[1, 0, 0]] * 16 + [[0, 0, 0]] * 2 + [[5, 1, 0]] * 12 + [[1, 2, 4]] * 6 + [[1, 0, 0]] * 10
    results.append(run_case(plans['6'], acts, start={'x': 72.5, 'y': 61.5, 'floor': 0}, tag='straight stair up/down'))
    # return stair (153,96) 27x21 rotation 0: lower lane v<9 -> y 96..105
    acts = [[1, 0, 0]] * 40 + [[3, 0, 0]] * 10 + [[5, 0, 0]] * 30 + [[1, 1, 0]] * 30 + [[7, 0, 0]] * 10 + [[5, 2, 0]] * 30
    results.append(run_case(plans['6'], acts, start={'x': 150.5, 'y': 100.5, 'floor': 0}, tag='return stair up/down'))
    for k in range(3):
        results.append(run_case(plans['7'], random_actions(rng, 300, chair_bias=True), tag=f'alcatraz random {k}'))
    json.dump(results, open(os.path.join(ROOT, 'validation', 'validation_results.json'), 'w'), indent=1)
