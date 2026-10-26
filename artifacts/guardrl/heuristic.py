"""Block-level navigation graph (built by probing the real movement physics) and a
hand-written 'greedy staleness chaser' guard used as a baseline and as a demonstrator
for DQfD-style cold starts."""
import math
import numpy as np
import numba as nb

from .plan import GRID
from . import sim


def build_block_graph(plan):
    """Nodes: (floor, bx, by) whose centre can hold a guard (doors open).  Edges: a straight
    walk from one block centre to a neighbouring block centre succeeds (stairs may change floor)."""
    p = plan
    F, Hb, Wb = p.F, p.Hb, p.Wb
    D = max(1, len(p.door_floor))
    opened = np.ones(D, np.uint8)
    node = -np.ones((F, Hb, Wb), np.int64)
    coords = []
    for f in range(F):
        for by in range(Hb):
            for bx in range(Wb):
                if sim.can_stand(p.mat, p.door_id, opened, p.chair_mask, f, bx * 3 + 1.5, by * 3 + 1.5):
                    node[f, by, bx] = len(coords)
                    coords.append((f, bx, by))
    coords = np.array(coords, np.int64)
    stairs = p.stairs
    nbrs = [[] for _ in range(len(coords))]
    for n, (f, bx, by) in enumerate(coords):
        for h in range(8):
            dx, dy = int(sim.DIR_DX[h]), int(sim.DIR_DY[h])
            pos = np.array([[bx * 3 + 1.5, by * 3 + 1.5]])
            fl = np.array([f], np.int64)
            tx, ty = (bx + dx) * 3 + 1.5, (by + dy) * 3 + 1.5
            steps = 12
            ok = True
            for k in range(steps):
                x0, y0 = pos[0, 0], pos[0, 1]
                nx = bx * 3 + 1.5 + (tx - bx * 3 - 1.5) * (k + 1) / steps
                ny = by * 3 + 1.5 + (ty - by * 3 - 1.5) * (k + 1) / steps
                if not sim.try_move(p.mat, p.door_id, opened, p.chair_mask, stairs, pos, fl, 0, nx, ny):
                    ok = False
                    break
            if not ok:
                continue
            nf = fl[0]
            nbx, nby = int(pos[0, 0] // 3), int(pos[0, 1] // 3)
            if 0 <= nbx < Wb and 0 <= nby < Hb and node[nf, nby, nbx] >= 0 and node[nf, nby, nbx] != n:
                nbrs[n].append((node[nf, nby, nbx], h))
        # a stair crossing can also be reached by a short walk inside the block
    ptr = np.zeros(len(coords) + 1, np.int64)
    for n in range(len(coords)):
        ptr[n + 1] = ptr[n] + len(nbrs[n])
    adj = np.zeros(ptr[-1], np.int64)
    adir = np.zeros(ptr[-1], np.int64)
    for n in range(len(coords)):
        for k, (m, h) in enumerate(nbrs[n]):
            adj[ptr[n] + k] = m
            adir[ptr[n] + k] = h
    return dict(node=node, coords=coords, ptr=ptr, adj=adj, adir=adir)


@nb.njit(cache=True)
def bfs(ptr, adj, src, dist, parent):
    dist.fill(-1)
    parent.fill(-1)
    q = np.empty(dist.shape[0], np.int64)
    h = 0
    t = 0
    q[t] = src
    t += 1
    dist[src] = 0
    while h < t:
        u = q[h]
        h += 1
        for k in range(ptr[u], ptr[u + 1]):
            v = adj[k]
            if dist[v] < 0:
                dist[v] = dist[u] + 1
                parent[v] = u
                q[t] = v
                t += 1


@nb.njit(parallel=True, cache=True)
def node_block_visibility(coords, Hb, Wb, F, walk_row, vis_flat, vis_row_ptr, cand_floor, cand_x, cand_y, cand_sp_ptr,
                          cand_sp, half_range_px):
    """V[n, f*Hb*Wb + block] = distance-weighted fraction of the block's candidates visible from node n's
    centre (any facing).  Used by the greedy patroller to score look-out points."""
    N = coords.shape[0]
    nb_ = F * Hb * Wb
    V = np.zeros((N, nb_), np.float32)
    cnt = np.zeros(nb_, np.float32)
    for j in range(cand_floor.shape[0]):
        cnt[(cand_floor[j] * Hb + cand_y[j] // 3) * Wb + cand_x[j] // 3] += 1
    for n in nb.prange(N):
        f = coords[n, 0]
        px = coords[n, 1] * 3 + 1
        py = coords[n, 2] * 3 + 1
        row = walk_row[f, py, px]
        if row < 0:
            continue
        r = vis_row_ptr[f] + row
        for j in range(cand_floor.shape[0]):
            if cand_floor[j] != f:
                continue
            seen = False
            for k in range(cand_sp_ptr[j], cand_sp_ptr[j + 1]):
                s = cand_sp[k]
                if (vis_flat[r, s >> 3] >> (s & 7)) & 1:
                    seen = True
                    break
            if seen:
                d = math.hypot(cand_x[j] - px, cand_y[j] - py)
                b = (f * Hb + cand_y[j] // 3) * Wb + cand_x[j] // 3
                V[n, b] += 1.0 / (1.0 + d / half_range_px) / cnt[b]
    return V


def box_blur(a, r):
    """Sum over a (2r+1)^2 box, per floor (a: F, H, W)."""
    F, H, W = a.shape
    c = np.zeros((F, H + 1, W + 1))
    c[:, 1:, 1:] = a.cumsum(1).cumsum(2)
    y0 = np.clip(np.arange(H) - r, 0, H); y1 = np.clip(np.arange(H) + r + 1, 0, H)
    x0 = np.clip(np.arange(W) - r, 0, W); x1 = np.clip(np.arange(W) + r + 1, 0, W)
    return (c[:, y1][:, :, x1] - c[:, y0][:, :, x1] - c[:, y1][:, :, x0] + c[:, y0][:, :, x0])


class GreedyPatroller:
    """Walk (look forward) towards the block maximising blurred risk / (path length + d0);
    keep the target until reached.  Several guards avoid targets closer to a colleague."""

    def __init__(self, env, graph=None, radius=5, d0=15.0, gait=0, min_dist=5, lookahead=3):
        self.env = env
        self.g = graph or build_block_graph(env.plan)
        self.radius, self.d0, self.gait = radius, d0, gait
        self.min_dist, self.lookahead = min_dist, lookahead
        n = len(self.g['coords'])
        self.dist = np.zeros(n, np.int64)
        self.parent = np.zeros(n, np.int64)
        self.target = -np.ones((env.E, env.G), np.int64)
        self.risk = None
        self.opened = np.ones(max(1, len(env.plan.door_floor)), np.uint8)
        p = env.plan
        if 'V' not in self.g:
            self.g['V'] = node_block_visibility(self.g['coords'], p.Hb, p.Wb, p.F, p.walk_row, p.vis_flat, p.vis_row_ptr,
                                                p.cand_floor, p.cand_x, p.cand_y, p.cand_sp_ptr, p.cand_sp, 60.0)

    def node_of(self, e, g):
        env = self.env
        f = env.fl[e, g]
        bx = int(env.pos[e, g, 0] // 3); by = int(env.pos[e, g, 1] // 3)
        n = self.g['node'][f, by, bx]
        if n < 0:      # off-grid (e.g. seated / squeezed): nearest node on the floor
            c = self.g['coords']
            sel = np.nonzero(c[:, 0] == f)[0]
            d = (c[sel, 1] - bx) ** 2 + (c[sel, 2] - by) ** 2
            n = sel[np.argmin(d)]
        return n

    def _probe(self, e, g, h, tx, ty, step=4.0):
        env, p = self.env, self.env.plan
        pos = env.pos[e, g:g + 1].copy()
        fl = env.fl[e, g:g + 1].copy()
        n = 10
        dx, dy = sim.DIR_DX[h], sim.DIR_DY[h]
        ln = math.hypot(dx, dy)
        dx, dy = dx / ln * step / n, dy / ln * step / n
        for k in range(n):
            sim.try_move(p.mat, p.door_id, self.opened, p.chair_mask, p.stairs, pos, fl, 0, pos[0, 0] + dx, pos[0, 1])
            sim.try_move(p.mat, p.door_id, self.opened, p.chair_mask, p.stairs, pos, fl, 0, pos[0, 0], pos[0, 1] + dy)
        return math.hypot(tx - pos[0, 0], ty - pos[0, 1])

    def actions(self):
        env = self.env
        risk = env.block_risk()
        acts = np.zeros((env.E, env.G, 3), np.int64)
        c = self.g['coords']
        for e in range(env.E):
            node_score = self.g['V'] @ risk[e].reshape(-1).astype(np.float32)
            dists = []
            for g in range(env.G):
                src = self.node_of(e, g)
                bfs(self.g['ptr'], self.g['adj'], src, self.dist, self.parent)
                dists.append((src, self.dist.copy(), self.parent.copy()))
            for g in range(env.G):
                src, dist, parent = dists[g]
                t = self.target[e, g]
                reached = t < 0 or dist[t] <= 1 or dist[t] < 0
                if not reached and node_score[t] < 0.3 * node_score.max():
                    reached = True
                if reached:
                    ok = dist >= self.min_dist
                    if not ok.any():
                        ok = dist >= 0
                    s = np.where(ok, node_score / (dist + self.d0), -1)
                    for h in range(env.G):     # leave targets that a colleague is nearer to
                        if h != g:
                            dh = dists[h][1]
                            s = np.where((dh >= 0) & (dh < dist), s * 0.2, s)
                    s[src] = -1
                    t = int(np.argmax(s))
                    self.target[e, g] = t
                # next node on the path
                v = t
                if dist[v] < 0:
                    acts[e, g] = (0, 0, 0)
                    continue
                path = [v]
                while parent[v] != src and parent[v] >= 0:
                    v = parent[v]
                    path.append(v)
                path = path[::-1]          # first node after src ... target
                v = path[0]
                # look ahead along the path while the floor does not change
                for w in path[1:self.lookahead]:
                    if c[w][0] != env.fl[e, g]:
                        break
                    v = w
                # choose the heading whose simulated move (with wall sliding) gets closest to a
                # look-ahead point on the path; fall back to nearer path nodes if no progress
                best_h = -1
                cand_nodes = path[:self.lookahead][::-1]
                for w in cand_nodes:
                    f, bx, by = c[w]
                    tx, ty = bx * 3 + 1.5, by * 3 + 1.5
                    if f != env.fl[e, g]:
                        for k in range(self.g['ptr'][src], self.g['ptr'][src + 1]):
                            if self.g['adj'][k] == w:
                                hh = self.g['adir'][k]
                                tx = env.pos[e, g, 0] + 6 * sim.DIR_DX[hh]
                                ty = env.pos[e, g, 1] + 6 * sim.DIR_DY[hh]
                    d0 = math.hypot(tx - env.pos[e, g, 0], ty - env.pos[e, g, 1])
                    bd, bh = d0 - 0.75, -1
                    for hh in range(8):
                        dd = self._probe(e, g, hh, tx, ty)
                        if dd < bd:
                            bd, bh = dd, hh
                    if bh >= 0:
                        best_h = bh
                        break
                if best_h < 0:
                    self.target[e, g] = -1
                    acts[e, g] = (0, 0, 0)
                else:
                    acts[e, g] = (best_h + 1, self.gait, 0)
        return acts
