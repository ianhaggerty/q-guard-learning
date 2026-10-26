"""Cross-check the numba simulator against the JavaScript core (run with bun/node).

For several plans, random persistent action sequences (plus scripted chair / stair tests)
are replayed in both implementations, with one guard and with teams of two or three;
positions, floors, energy, the probability sum and each guard's detection credit are
compared step by step.  Writes validation/validation_results.json.

Teams can differ slightly by design: the JS core lets a guard see through a door another
guard holds open, while this simulator's precomputed sight keeps such doors closed."""
import json, os, subprocess, sys, shutil
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guardrl.plan import load_plan, plan_paths
from guardrl.env import GuardEnv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.environ.get('CORE_DIR', os.path.join(os.path.dirname(ROOT), 'packages', 'core', 'src'))
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


def run_case(plan_path, actions, starts=None, dt=0.5, tag=''):
    """actions: one [move, gait, look] per step for a single guard, or, with one start per guard
    in `starts`, one list of such triples per step."""
    G = len(starts) if starts else 1
    steps = actions if isinstance(actions[0][0], list) else [[a] for a in actions]
    spec = {'dt': dt, 'actions': steps}
    if starts:
        spec['starts'] = starts
    tmp_in, tmp_out = '/tmp/_val_in.json', '/tmp/_val_out.json'
    json.dump(spec, open(tmp_in, 'w'))
    subprocess.run([RUNTIME, os.path.join(ROOT, 'validation', 'js_rollout.mjs'), CORE, plan_path, tmp_in, tmp_out], check=True)
    js = json.load(open(tmp_out))
    plan = load_plan(plan_path, verbose=False)
    env = GuardEnv(plan, 1, G, dt=dt, field_slices=1)
    env.reset_env(0, starts=starts or [plan.starts[0]])
    py = []
    kc, cr = np.zeros(G), np.zeros(G)
    for a in steps:
        k, c, ps = env.step(np.array([a]))
        kc += k[0]
        cr += c[0]
        py.append(dict(psum=ps[0], guards=[dict(x=env.pos[0, g, 0], y=env.pos[0, g, 1], floor=int(env.fl[0, g]), kcal=kc[g],
                                                credit=cr[g], sitting=bool(env.sitting[0, g]), facing=int(env.facing[0, g]))
                                           for g in range(G)]))
    pairs = [(a, b) for sj, sp in zip(js, py) for a, b in zip(sj['guards'], sp['guards'])]
    dpos = max(abs(a['x'] - b['x']) + abs(a['y'] - b['y']) for a, b in pairs)
    dfl = sum(a['floor'] != b['floor'] for a, b in pairs)
    dsit = sum(a['sitting'] != b['sitting'] for a, b in pairs)
    dfac = sum(a['facing'] != b['facing'] for a, b in pairs)
    rk = max(abs(a['kcal'] - b['kcal']) / max(1e-9, a['kcal']) for a, b in pairs)
    rp = max(abs(a['psum'] - b['psum']) / max(1e-12, a['psum']) for a, b in zip(js, py) if a['psum'] > 0)
    final_credit = [(a['credit'], b['credit']) for a, b in zip(js[-1]['guards'], py[-1]['guards'])]
    rc = max(abs(a - b) / max(1e-12, a, b) for a, b in final_credit)
    res = dict(plan=os.path.basename(plan_path), case=tag, guards=G, steps=len(steps), max_pos_err_px=dpos, floor_mismatch=dfl,
               sit_mismatch=dsit, facing_mismatch=dfac, max_rel_kcal_err=rk, max_rel_psum_err=rp, final_rel_credit_err=rc,
               final_js=dict(kcal=js[-1]['kcal'], psum=js[-1]['psum'], floor=js[-1]['floor'], credit=[a for a, _ in final_credit]),
               final_py=dict(kcal=py[-1]['guards'][0]['kcal'], psum=py[-1]['psum'], floor=py[-1]['guards'][0]['floor'],
                             credit=[b for _, b in final_credit]),
               sits=sum(g['sitting'] for s in py for g in s['guards']),
               floor_changes=sum(py[i]['guards'][g]['floor'] != py[i - 1]['guards'][g]['floor'] for i in range(1, len(py)) for g in range(G)))
    print(json.dumps(res))
    return res


def team_actions(rng, n, G, chair_bias=False):
    """Independent random persistent action sequences for G guards, as one list of triples per step."""
    return [list(step) for step in zip(*(random_actions(rng, n, chair_bias) for _ in range(G)))]


if __name__ == '__main__':
    rng = np.random.default_rng(1)
    results = []
    for p in plan_paths():
        results.append(run_case(p, random_actions(rng, 240), tag='random persistent walk'))
    plans = {os.path.basename(p)[:1]: p for p in plan_paths()}
    # chair test: start at the front of the corridor chair, sit, look around, stand up, walk
    acts = [[9, 0, 0]] * 4 + [[0, 0, 2]] * 4 + [[5, 0, 0]] * 10 + [[1, 1, 0]] * 4 + [[9, 0, 6]] * 6
    results.append(run_case(plans['1'], acts, starts=[{'x': 93.0, 'y': 10.5, 'floor': 0}], tag='chair sit/stand'))
    # stairs test (courtyard straight stair: lower 0 -> upper 1 heading east, then back)
    acts = [[1, 0, 0]] * 16 + [[0, 0, 0]] * 2 + [[5, 1, 0]] * 12 + [[1, 2, 4]] * 6 + [[1, 0, 0]] * 10
    results.append(run_case(plans['6'], acts, starts=[{'x': 72.5, 'y': 61.5, 'floor': 0}], tag='straight stair up/down'))
    # return stair (153,96) 27x21 rotation 0: lower lane v<9 -> y 96..105
    acts = [[1, 0, 0]] * 40 + [[3, 0, 0]] * 10 + [[5, 0, 0]] * 30 + [[1, 1, 0]] * 30 + [[7, 0, 0]] * 10 + [[5, 2, 0]] * 30
    results.append(run_case(plans['6'], acts, starts=[{'x': 150.5, 'y': 100.5, 'floor': 0}], tag='return stair up/down'))
    for k in range(3):
        results.append(run_case(plans['7'], random_actions(rng, 300, chair_bias=True), tag=f'alcatraz random {k}'))
    # several guards: shared doors, additive hazards, hazard-proportional credit, one guard per chair
    for p in plan_paths():
        starts = load_plan(p, verbose=False).starts
        team = [starts[g % len(starts)] for g in range(2)]
        results.append(run_case(p, team_actions(rng, 240, 2, chair_bias=True), starts=team, tag='two guards random'))
    chair = {'x': 93.0, 'y': 10.5, 'floor': 0}
    acts = [[[9, 0, 0], [9, 0, 2]]] * 4 + [[[0, 0, 2], [5, 0, 0]]] * 6 + [[[5, 0, 0], [9, 0, 0]]] * 6
    results.append(run_case(plans['1'], acts, starts=[chair, chair], tag='two guards, one chair'))
    # one guard climbs the courtyard's straight stair and comes back while the other patrols below
    climb = [[1, 0, 0]] * 16 + [[0, 0, 0]] * 2 + [[5, 1, 0]] * 12 + [[1, 2, 4]] * 6 + [[1, 0, 0]] * 10
    below = [[3, 0, 0]] * 12 + [[7, 1, 2]] * 12 + [[1, 0, 6]] * 22
    starts = [{'x': 72.5, 'y': 61.5, 'floor': 0}, {'x': 60.5, 'y': 70.5, 'floor': 0}]
    results.append(run_case(plans['6'], [list(step) for step in zip(climb, below)], starts=starts, tag='two guards, two floors'))
    alcatraz = load_plan(plans['7'], verbose=False).starts
    for k in range(2):
        team = [alcatraz[g % len(alcatraz)] for g in range(3)]
        results.append(run_case(plans['7'], team_actions(rng, 300, 3, chair_bias=True), starts=team, tag=f'alcatraz three guards {k}'))
    json.dump(results, open(os.path.join(ROOT, 'validation', 'validation_results.json'), 'w'), indent=1)
