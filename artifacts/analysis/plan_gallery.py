import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from guardrl.plan import load_plan, plan_paths
from guardrl.viz import draw_plan, draw_starts
paths = plan_paths()
panels = []
for p in paths:
    pl = load_plan(p, verbose=False)
    for f in range(pl.F):
        panels.append((pl, f))
fig, axs = plt.subplots(2, 4, figsize=(16, 8))
for ax in axs.flat: ax.axis('off')
for ax, (pl, f) in zip(axs.flat, panels):
    draw_plan(ax, pl, f, title=f"{pl.name}" + (f" - floor {f}" if pl.F > 1 else '') + f"  ({pl.W/6:.1f} m x {pl.H/6:.1f} m)")
    draw_starts(ax, pl, f)
plt.tight_layout(); os.makedirs('figures', exist_ok=True); plt.savefig('figures/plans.png', dpi=110)
