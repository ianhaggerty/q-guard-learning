"""Final evaluation of trained guards and the figures used in the report.

usage (module):
    from guardrl.report_figs import evaluate_model, figure_rollout
"""
import json
import os

import numpy as np
import torch
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Wedge
from PIL import Image

from .plan import load_plan
from .dqn import Agent
from .evaluate import rollout, agent_policy
from .viz import draw_plan, draw_trajectory, draw_starts, occupancy, risk_image, plan_rgb, GUARD_COLORS
from . import sim

GAIT_LABEL = ['walk', 'run', 'sprint']


def load_agent(path):
    sd = torch.load(path, weights_only=False)
    ag = Agent(head=sd['head'], noisy=sd['noisy'], n_nets=len(sd['nets']))
    ag.load_nets(sd)
    for n in ag.nets:
        n.set_noise(False)
        n.eval()
    return ag


def evaluate_model(model_path, plan_path, n_guards, seconds=1800, field_slices=1, net_of_guard=None, starts=None):
    ag = load_agent(model_path)
    plan = load_plan(plan_path, verbose=False)
    if net_of_guard is None:
        net_of_guard = [0] * n_guards if len(ag.nets) == 1 else list(range(n_guards))
    r = rollout(plan, agent_policy(ag, net_of_guard), n_guards, seconds=seconds, field_slices=field_slices,
                starts=starts)
    return plan, r


def save_metrics(r, path, extra=None):
    m = dict(r['metrics'])
    if extra:
        m.update(extra)
    json.dump(m, open(path, 'w'), indent=1)
    return m


def figure_rollout(plan, r, title, out_png, t_window=(600, 1800), w_level=None):
    """Trajectory per floor (last part of the roll-out), sum P over time, activity breakdown."""
    traj = r['traj'][:, 0]
    G = traj.shape[1]
    dt = r['dt']
    t0, t1 = int(t_window[0] / dt), int(t_window[1] / dt)
    F = plan.F
    fig = plt.figure(figsize=(4.8 * F + 6.5, 4.6))
    gs = fig.add_gridspec(2, F + 2, width_ratios=[plan.W / plan.H * 1.0] * F + [1.3, 1.0], height_ratios=[1, 1])
    for f in range(F):
        ax = fig.add_subplot(gs[:, f])
        draw_plan(ax, plan, f, title=f'{plan.name} - floor {f}' if F > 1 else plan.name)
        draw_starts(ax, plan, f)
        for g in range(G):
            draw_trajectory(ax, traj, plan, f, g, t0=t0, t1=t1)
    ax = fig.add_subplot(gs[0, F:])
    tt = np.arange(traj.shape[0]) * dt / 60
    ax.plot(tt, r['psum'][:, 0], color='k', lw=1)
    if F > 1:
        for f in range(F):
            ax.plot(tt, r['floor_sums'][:, 0, f], lw=0.8, ls='--', label=f'floor {f}')
        ax.legend(fontsize=7)
    ax.set_xlabel('time (min)', fontsize=8)
    ax.set_ylabel('expected unresolved events  ΣP', fontsize=8)
    ax.tick_params(labelsize=7)
    ax.axvspan(t_window[0] / 60, t_window[1] / 60, color='#eeeeee', zorder=-1)
    ax = fig.add_subplot(gs[1, F])
    m = r['metrics']
    names = ['sitting', 'standing', 'walking', 'running', 'sprinting', 'backward', 'blocked']
    act = r['act_secs'][0]
    for g in range(G):
        a = act[g, :14].copy()
        blk = act[g, 14]
        a[1] -= blk
        vals = [a[0], a[1], a[5] + a[8] + a[9], a[6] + a[10] + a[11], a[7] + a[12] + a[13], a[2] + a[3] + a[4], blk]
        vals = np.array(vals) / max(1e-9, sum(vals))
        left = 0
        for k, v in enumerate(vals):
            ax.barh(g, v, left=left, color=plt.cm.tab10(k), label=names[k] if g == 0 else None)
            left += v
    ax.set_yticks(range(G)); ax.set_yticklabels([f'guard {g + 1}' for g in range(G)], fontsize=7)
    ax.set_xlim(0, 1); ax.tick_params(labelsize=7)
    ax.legend(fontsize=6, ncol=2, loc='upper center', bbox_to_anchor=(0.5, -0.25))
    ax.set_title('time share by activity', fontsize=8)
    ax = fig.add_subplot(gs[1, F + 1], projection='polar')
    for g in range(G):
        fac = traj[:, g, 4].astype(int)
        h = np.bincount(fac, minlength=8) / len(fac)
        ang = np.arange(8) * np.pi / 4
        ax.bar(-ang + np.pi / 2 * 0, h, width=np.pi / 4 * 0.8 / G, bottom=0, alpha=0.6, color=GUARD_COLORS[g])
    ax.set_theta_zero_location('E'); ax.set_theta_direction(-1)
    ax.set_xticks(np.arange(8) * np.pi / 4)
    ax.set_xticklabels(['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'], fontsize=6)
    ax.set_yticks([]); ax.set_title('gaze direction', fontsize=8)
    txt = f"ΣP̄={m['mean_psum']:.3f}   team kcal/h={m['team_kcal_per_hour']:.0f}"
    if w_level is not None:
        txt += f"   cost={w_level * m['mean_psum'] + m['team_kcal_per_hour'] / 3600:.4f} kcal/s"
    fig.suptitle(f'{title}    {txt}', fontsize=9)
    plt.tight_layout()
    plt.subplots_adjust(top=0.88)
    plt.savefig(out_png, dpi=110)
    plt.close(fig)


def figure_occupancy(plan, r, out_png, title=''):
    traj = r['traj'][:, 0]
    G = traj.shape[1]
    F = plan.F
    fig, axs = plt.subplots(1, F * G, figsize=(4.2 * F * G, 4))
    axs = np.atleast_1d(axs)
    k = 0
    for g in range(G):
        for f in range(F):
            ax = axs[k]; k += 1
            ax.imshow(plan_rgb(plan, f), interpolation='nearest')
            occ = occupancy(traj, plan, g, f)
            occ = occ / max(1, occ.sum()) * 100
            big = np.kron(occ, np.ones((3, 3)))
            ax.imshow(np.ma.masked_where(big <= 0, big), cmap='magma_r', alpha=0.85, interpolation='nearest',
                      vmin=0, vmax=max(1e-3, np.percentile(occ[occ > 0], 98)) if (occ > 0).any() else 1)
            ax.set_xticks([]); ax.set_yticks([])
            ax.set_title(f'guard {g + 1}' + (f' floor {f}' if F > 1 else ''), fontsize=8)
    fig.suptitle(f'{title} time share per 0.5 m block (%)', fontsize=9)
    plt.tight_layout(); plt.savefig(out_png, dpi=100); plt.close(fig)


def make_gif(plan, r, out_gif, t0=600, t1=780, every=2.0, scale=3):
    """Animated GIF: probability field (red = stale) with guards and their 200° field of view."""
    traj = r['traj'][:, 0]
    dt = r['dt']
    frames = []
    # replay the field from the logged trajectory is expensive; instead re-run a short exact roll-out
    # is unnecessary: we draw P from the stored cumulative 'means' snapshots if present
    snaps = r.get('means_snaps')
    for k, t in enumerate(np.arange(t0, t1, every)):
        i = int(t / dt)
        fig, axs = plt.subplots(1, plan.F, figsize=(4 * plan.F * plan.W / max(plan.W, plan.H) + 0.5, 4))
        axs = np.atleast_1d(axs)
        for f in range(plan.F):
            ax = axs[f]
            ax.imshow(plan_rgb(plan, f), interpolation='nearest')
            if snaps is not None:
                idx = min(len(snaps) - 1, int((t - snaps['t0']) / snaps['every']))
                img = risk_image(plan, snaps['means'][idx], f)
                ax.imshow(np.ma.masked_where(img <= 0, img), cmap='Reds', alpha=0.6, vmin=0,
                          vmax=snaps['vmax'], interpolation='nearest')
            for g in range(traj.shape[1]):
                if traj[i, g, 2] != f:
                    continue
                x, y, fac = traj[i, g, 0] - 0.5, traj[i, g, 1] - 0.5, traj[i, g, 4]
                ang = fac * 45
                ax.add_patch(Wedge((x, y), 25, ang - 100, ang + 100, color=GUARD_COLORS[g], alpha=0.15))
                ax.plot(x, y, 'o', color=GUARD_COLORS[g], ms=5 if traj[i, g, 6] == 0 else 8, mec='k')
            ax.set_xticks([]); ax.set_yticks([])
        fig.suptitle(f'{plan.name}  t = {t / 60:5.1f} min   ΣP = {r["psum"][i, 0]:.3f}', fontsize=9)
        fig.canvas.draw()
        frames.append(Image.fromarray(np.asarray(fig.canvas.buffer_rgba())[..., :3]))
        plt.close(fig)
    frames[0].save(out_gif, save_all=True, append_images=frames[1:], duration=120, loop=0)
