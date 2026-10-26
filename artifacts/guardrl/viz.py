"""Plotting helpers (matplotlib)."""
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import to_rgb

from .plan import FLOOR, OPAQUE, TRANSPARENT, DOOR
from . import sim

COLORS = np.array([to_rgb(c) for c in ['#F6F3E9', '#263D36', '#78C6C0', '#DDA457']])
GUARD_COLORS = ['#d62728', '#1f77b4', '#9467bd', '#ff7f0e']


def plan_rgb(plan, f, show_values=True):
    img = COLORS[plan.mat[f]].copy()
    if show_values:
        v = plan.val[f]
        hi = v > 1
        if hi.any():
            t = np.clip(np.log1p(v) / np.log1p(100), 0, 1)[..., None]
            red = np.array(to_rgb('#c0392b'))
            img = np.where(hi[..., None], img * (1 - 0.75 * t) + red * 0.75 * t, img)
        zero = (v <= 0) & (plan.mat[f] == FLOOR)
        img[zero] = img[zero] * 0.75 + 0.25 * np.array([0.6, 0.6, 0.6])
    for x, y, cf, rot in plan.chairs:
        if cf == f:
            img[y:y + 3, x:x + 3] = to_rgb('#8e44ad')
    return img


def draw_plan(ax, plan, f=0, show_values=True, title=None):
    ax.imshow(plan_rgb(plan, f, show_values), interpolation='nearest')
    for st in plan.stairs:
        typ, x, y, ln, wd, rot = st[:6]
        w, h = (wd, ln) if int(rot) % 180 else (ln, wd)
        if f in (int(st[6]), int(st[7])):
            ax.add_patch(plt.Rectangle((x - 0.5, y - 0.5), w, h, fill=False, ec='#e67e22', lw=1.2, ls='--'))
    for x, y, cf, rot in plan.chairs:
        if cf == f:
            dx, dy = {0: (1, 0), 90: (0, 1), 180: (-1, 0), 270: (0, -1)}[int(rot)]
            ax.annotate('', xy=(x + 1 + dx * 3, y + 1 + dy * 3), xytext=(x + 1, y + 1),
                        arrowprops=dict(arrowstyle='->', color='#8e44ad', lw=1))
    ax.set_xticks([]); ax.set_yticks([])
    if title:
        ax.set_title(title, fontsize=8)


def draw_starts(ax, plan, f=0):
    for k, s in enumerate(plan.starts):
        if s['floor'] == f:
            ax.plot(s['x'] - 0.5, s['y'] - 0.5, marker='*', color='k', ms=7)
            ax.text(s['x'] + 1, s['y'] - 2, str(k + 1), fontsize=6)


def draw_trajectory(ax, traj, plan, f=0, g=0, t0=0, t1=None, color=None, lw=0.8, gait_colors=True, mark_sit=True,
                    alpha=0.9):
    """traj (T, G, 8) from evaluate.rollout (env index already selected)."""
    t1 = traj.shape[0] if t1 is None else t1
    x, y, fl = traj[t0:t1, g, 0] - 0.5, traj[t0:t1, g, 1] - 0.5, traj[t0:t1, g, 2]
    gait, sit, look = traj[t0:t1, g, 5], traj[t0:t1, g, 6], traj[t0:t1, g, 7]
    col = color or GUARD_COLORS[g % 4]
    for i in range(1, len(x)):
        if fl[i] != f or fl[i - 1] != f:
            continue
        c = col
        w = lw
        if gait_colors:
            back = 3 <= look[i] <= 5
            if back:
                c, w = '#7f8c8d', lw
            elif gait[i] == 1:
                w = lw * 2.2
            elif gait[i] == 2:
                w = lw * 3.5
        ax.plot(x[i - 1:i + 1], y[i - 1:i + 1], color=c, lw=w, alpha=alpha, solid_capstyle='round')
    # final position (guards that stop moving are otherwise invisible)
    if len(x) and fl[-1] == f:
        ax.plot(x[-1], y[-1], 'o', color=col, ms=6, mec='k', mew=0.6, zorder=6)
    # dwell points: where the guard stayed put for >= 20 s
    st = (np.abs(np.diff(x)) + np.abs(np.diff(y)) < 1e-6) if len(x) > 1 else np.zeros(0, bool)
    if st.any():
        run = 0
        for i, v in enumerate(st):
            run = run + 1 if v else 0
            if run == 40 and fl[i] == f:
                ax.plot(x[i], y[i], 's', color=col, ms=4, alpha=0.7, zorder=5)
    if mark_sit:
        s = (sit > 0) & (fl == f)
        if s.any():
            ax.scatter(x[s], y[s], s=30, facecolors='none', edgecolors=col, lw=1.2, zorder=5)


def occupancy(traj, plan, g=None, f=0):
    H, W = plan.H, plan.W
    occ = np.zeros((plan.Hb, plan.Wb))
    G = traj.shape[1]
    for gg in (range(G) if g is None else [g]):
        sel = traj[:, gg, 2] == f
        bx = np.clip((traj[sel, gg, 0] // 3).astype(int), 0, plan.Wb - 1)
        by = np.clip((traj[sel, gg, 1] // 3).astype(int), 0, plan.Hb - 1)
        np.add.at(occ, (by, bx), 1)
    return occ


def risk_image(plan, means, f=0):
    img = np.zeros((plan.H, plan.W))
    sel = plan.cand_floor == f
    img[plan.cand_y[sel], plan.cand_x[sel]] = -np.expm1(-means[sel])
    return img
