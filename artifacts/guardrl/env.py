"""Python wrapper around the numba kernels: a batch of E environments with G guards each."""
import math
import numpy as np

from .plan import Plan, EVENT_RATE, DETECTION_HALF_RANGE, GRID, FLOOR, OPAQUE, TRANSPARENT, DOOR
from . import sim


class GuardEnv:
    def __init__(self, plan: Plan, n_envs: int = 1, n_guards: int = 1, dt: float = 0.5, field_slices: int = 2,
                 rate: float = EVENT_RATE, half_range: float = DETECTION_HALF_RANGE, seed: int = 0):
        self.plan = plan
        self.E, self.G = n_envs, n_guards
        self.dt, self.field_slices = dt, field_slices
        self.rate, self.half_range = rate, half_range
        self.rng = np.random.default_rng(seed)
        p = plan
        self.J = len(p.cand_w)
        self.cand_floor_ptr = np.searchsorted(p.cand_floor, np.arange(p.F + 1)).astype(np.int64)
        self.max_sp = int(max(p.sp_floor_ptr[f + 1] - p.sp_floor_ptr[f] for f in range(p.F)))
        D = max(1, len(p.door_floor))
        E, G = self.E, self.G
        self.pos = np.zeros((E, G, 2))
        self.fl = np.zeros((E, G), np.int64)
        self.heading = np.zeros((E, G), np.int64)
        self.look = np.zeros((E, G), np.int64)
        self.facing = np.zeros((E, G), np.int64)
        self.gait = np.zeros((E, G), np.int64)
        self.sitting = np.zeros((E, G), np.bool_)
        self.seat = -np.ones((E, G), np.int64)
        self.seat_exit = np.zeros((E, G, 2))
        self.door_open = np.zeros((E, D), np.uint8)
        self.means = np.zeros((E, self.J))
        self.kcal = np.zeros((E, G))
        self.act_secs = np.zeros((E, G, len(sim.ACT_MET) + 1))   # +1: blocked-move seconds (subset of standing)
        self.credit = np.zeros((E, G))
        self.dist = np.zeros((E, G))
        self.psum = np.zeros(E)
        self.chance_buf = np.zeros((E, G, self.max_sp))
        self.mu_buf = np.zeros((E, G))
        self.can_sit = np.zeros((E, G), np.int64)
        self.time = np.zeros(E)
        self.chairs = p.chairs if len(p.chairs) else np.zeros((0, 4), np.int64)
        # static walkable start spots (pixel centres where a guard fits with all doors closed)
        self._spawn_cells = None
        self.door_floor = p.door_floor if len(p.door_floor) else np.zeros(0, np.int32)
        self.door_bbox = p.door_bbox if len(p.door_bbox) else np.zeros((0, 4), np.int32)
        self.door_cells = p.door_cells if len(p.door_cells) else np.zeros((0, 2), np.int32)

    # ----------------------------------------------------------------- reset helpers
    def spawn_cells(self):
        """All pixel centres (floor, x+.5, y+.5) where a guard can stand with doors closed, sampled
        on a 3-px lattice (block centres) to keep the list small."""
        if self._spawn_cells is None:
            p = self.plan
            closed = np.zeros(max(1, len(p.door_floor)), np.uint8)
            cells = []
            for f in range(p.F):
                for y in range(1, p.H, 3):
                    for x in range(1, p.W, 3):
                        if sim.can_stand(p.mat, p.door_id, closed, p.chair_mask, f, x + 0.5, y + 0.5):
                            cells.append((f, x + 0.5, y + 0.5))
            self._spawn_cells = np.array(cells)
        return self._spawn_cells

    def reset_env(self, e, starts=None, warm_field=None, random_pose=False, chair_start=0.0):
        """starts: list of G dicts {x, y, floor}; None -> random spawn cells.
        warm_field: None (clear map, as in the app) or max staleness in seconds for a random
        smooth 'time since last seen' field (a cold-start device)."""
        p = self.plan
        closed = np.zeros(self.door_open.shape[1], np.uint8)
        cells = self.spawn_cells()
        for g in range(self.G):
            if starts is not None:
                s = starts[g]
                f = int(s['floor'])
                x, y = sim.nearest_clear_spot(p.mat, p.door_id, closed, p.chair_mask, f, float(s['x']), float(s['y']))
            else:
                f, x, y = cells[self.rng.integers(len(cells))]
                f = int(f)
                x += self.rng.uniform(-1, 1)
                y += self.rng.uniform(-1, 1)
                if not sim.can_stand(p.mat, p.door_id, closed, p.chair_mask, f, x, y):
                    x, y = sim.nearest_clear_spot(p.mat, p.door_id, closed, p.chair_mask, f, x, y)
            if starts is None and chair_start > 0 and len(self.chairs) and self.rng.random() < chair_start:
                # exploring start next to a chair (cold-start device for learning to sit)
                c = int(self.rng.integers(len(self.chairs)))
                fx, fy = sim.chair_front(self.chairs, c)
                fx += self.rng.uniform(-1, 1); fy += self.rng.uniform(-1, 1)
                f = int(self.chairs[c, 2])
                if sim.can_stand(p.mat, p.door_id, closed, p.chair_mask, f, fx, fy):
                    x, y = fx, fy
                else:
                    f = int(self.fl[e, g]) if False else f
                    x, y = sim.nearest_clear_spot(p.mat, p.door_id, closed, p.chair_mask, f, fx, fy)
            self.pos[e, g] = (x, y)
            self.fl[e, g] = f
            self.heading[e, g] = self.rng.integers(8) if random_pose else 0
            self.look[e, g] = 0
            self.facing[e, g] = self.heading[e, g]
            self.gait[e, g] = 0
            self.sitting[e, g] = False
            self.seat[e, g] = -1
        self.door_open[e] = 0
        sim.update_doors(self.door_floor, p.door_cells_ptr, self.door_cells, self.door_bbox, self.door_open[e],
                         self.pos[e], self.fl[e], self.G)
        if warm_field:
            self.means[e] = self.warm_means(warm_field)
        else:
            self.means[e] = 0.0
        self.act_secs[e] = 0
        self.time[e] = 0
        self.psum[e] = sim.prob_sum(self.means[e])

    def warm_means(self, tmax):
        """Smooth random 'seconds since last seen' field (block resolution), times lambda."""
        p = self.plan
        hb, wb = p.Hb, p.Wb
        k = 8
        coarse = self.rng.uniform(0, 1, (p.F, hb // k + 2, wb // k + 2))
        # bilinear upsample
        ys = np.arange(hb) / k
        xs = np.arange(wb) / k
        y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
        fy = (ys - y0)[None, :, None]; fx = (xs - x0)[None, None, :]
        c00 = coarse[:, y0][:, :, x0]; c01 = coarse[:, y0][:, :, x0 + 1]
        c10 = coarse[:, y0 + 1][:, :, x0]; c11 = coarse[:, y0 + 1][:, :, x0 + 1]
        up = (c00 * (1 - fy) * (1 - fx) + c01 * (1 - fy) * fx + c10 * fy * (1 - fx) + c11 * fy * fx)
        scale = tmax * self.rng.uniform(0.3, 1.0)
        T = up[p.cand_floor, p.cand_y // 3, p.cand_x // 3] * scale
        return self.rate * p.cand_w * T

    # ----------------------------------------------------------------- stepping
    def step(self, actions, abs_gaze=False):
        """actions: int array (E, G, 3) = move (0 stay, 1-8 heading E..NE, 9 sit), gait, look.
        With abs_gaze the third entry is an absolute gaze direction (0 E ... 7 NE) instead."""
        p = self.plan
        actions = np.ascontiguousarray(actions, dtype=np.int64)
        sim.step_batch(actions, self.dt, self.field_slices, self.G, abs_gaze,
                       p.mat, p.door_id, p.chair_mask, self.chairs, p.stairs, self.door_floor, p.door_cells_ptr,
                       self.door_cells, self.door_bbox,
                       p.cand_w, self.cand_floor_ptr, p.cand_sp_ptr, p.cand_sp, p.walk_row, p.vis_flat,
                       p.vis_row_ptr, p.sp_floor_ptr, p.sp_x, p.sp_y, self.rate, self.half_range,
                       self.pos, self.fl, self.heading, self.look, self.facing, self.gait, self.sitting, self.seat,
                       self.seat_exit, self.door_open, self.means,
                       self.kcal, self.act_secs, self.credit, self.dist, self.psum, self.chance_buf, self.mu_buf, p.F)
        self.time += self.dt
        return self.kcal.copy(), self.credit.copy(), self.psum.copy()

    def update_can_sit(self):
        p = self.plan
        sim.can_sit_batch(self.G, p.mat, p.door_id, p.chair_mask, self.chairs, self.pos, self.fl, self.sitting,
                          self.seat, self.door_open, self.can_sit)
        return self.can_sit

    def update_masks(self):
        p = self.plan
        if not hasattr(self, 'mask'):
            self.mask = np.zeros((self.E, self.G, 10), np.uint8)
        sim.move_mask_batch(self.G, p.mat, p.door_id, p.chair_mask, self.chairs, p.stairs, self.pos, self.fl,
                            self.sitting, self.seat, self.door_open, self.mask)
        self.can_sit[:] = self.mask[..., 9]
        return self.mask

    def block_risk(self, out=None):
        p = self.plan
        if out is None:
            out = np.zeros((self.E, p.F, p.Hb, p.Wb))
        sim.block_risk_batch(self.means, p.cand_floor, p.cand_x, p.cand_y, out)
        return out

    def snapshot(self, e=0):
        return dict(pos=self.pos[e].copy(), fl=self.fl[e].copy(), heading=self.heading[e].copy(),
                    look=self.look[e].copy(), facing=self.facing[e].copy(), gait=self.gait[e].copy(),
                    sitting=self.sitting[e].copy())
