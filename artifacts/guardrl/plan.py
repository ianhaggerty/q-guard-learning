"""Loading Pixel-Map-Lab floor plans into flat numpy arrays for the numba simulator.

Everything here mirrors packages/core/src/*.js:
  * materials: 0 floor, 1 opaque, 2 transparent, 3 opaque door           (materials.js)
  * per-pixel values (event weights), defaulting to 1 on floor, else 0   (values.js)
  * doors = 4-connected groups of door pixels                             (doors.js)
  * candidates = every positive-weight pixel on every floor, ordered as
    floor * W * H + index (identical ordering to events.js)               (events.js)
  * an opaque candidate is "seen through its surface": its detection
    chance is the best chance among its edge-adjacent see-through
    neighbours (floor, transparent, open door)                            (world.js detectionAt)

The expensive part is line of sight.  world.js caches sight per explorer *pixel*
(Bresenham from floor(player) to the target pixel, endpoints excluded).  We
pre-compute the same boolean for every walkable pixel x every sight point once
per map and cache it on disk as packed bits.  Door state during the
pre-computation is the state the guard's own proximity would produce when
standing at the pixel centre (doors open within 5 px), which is exactly what
happens for a single explorer.
"""
from __future__ import annotations

import json
import hashlib
import os
from dataclasses import dataclass, field

import numpy as np
import numba as nb

GRID = 3
METRES_PER_PIXEL = 0.5 / GRID
EXPLORER_RADIUS = 1.1
DOOR_TRIGGER_DISTANCE = 5.0
EVENT_RATE = 50e-6 / 60.0          # arrivals per second for a value-1 pixel
DETECTION_HALF_RANGE = 10.0        # metres
DETECTION_PEAK = 0.9
FIELD_OF_VIEW = 200.0

FLOOR, OPAQUE, TRANSPARENT, DOOR = 0, 1, 2, 3

HERE = os.path.dirname(os.path.abspath(__file__))
# Overridable so containers can keep the cache on a volume instead of beside the package.
CACHE_DIR = os.environ.get('GUARDRL_CACHE_DIR') or os.path.join(os.path.dirname(HERE), 'cache')


@dataclass
class Plan:
    name: str
    path: str
    W: int
    H: int
    F: int
    mat: np.ndarray            # (F, H, W) uint8
    val: np.ndarray            # (F, H, W) float64
    chair_mask: np.ndarray     # (F, H, W) uint8  (pixels covered by a chair)
    chairs: np.ndarray         # (C, 4) int64: x, y, floor, rotation
    stairs: np.ndarray         # (S, 9) float64: type, x, y, length, width, rotation, lower, upper, landing
    door_id: np.ndarray        # (F, H, W) int32, -1 when not a door pixel
    door_floor: np.ndarray     # (D,) int32
    door_cells_ptr: np.ndarray  # (D+1,) int64 CSR into door_cells
    door_cells: np.ndarray     # (N, 2) int32  x, y
    door_bbox: np.ndarray      # (D, 4) int32 x0, y0, x1, y1 (inclusive)
    starts: list
    # events
    cand_floor: np.ndarray     # (J,) int32
    cand_x: np.ndarray         # (J,) int32
    cand_y: np.ndarray
    cand_w: np.ndarray         # (J,) float64 weight (pixel value)
    cand_sp_ptr: np.ndarray    # (J+1,) CSR into cand_sp (sight point ids, floor-local)
    cand_sp: np.ndarray
    # sight points per floor (floor-local ids)
    sp_floor_ptr: np.ndarray   # (F+1,) offsets into global sp arrays
    sp_x: np.ndarray
    sp_y: np.ndarray
    sp_req_door: np.ndarray    # door that must be open for this proxy, -1 otherwise
    # walkable pixels -> visibility rows
    walk_row: np.ndarray       # (F, H, W) int32 row index into vis[floor], -1 if not walkable
    vis: list = field(default_factory=list)   # per floor packed bit arrays (rows, ceil(nsp/8))
    vis_flat: np.ndarray = None  # concatenated
    vis_row_ptr: np.ndarray = None  # (F,) row offset of each floor in vis_flat
    vis_bytes: np.ndarray = None    # (F,) bytes per row for each floor (padded to max)
    block_mask: np.ndarray = None   # (F, Hb, Wb) walkable fraction etc (for observations)

    @property
    def Hb(self):
        return self.H // GRID

    @property
    def Wb(self):
        return self.W // GRID


def _door_groups(mat, F, H, W):
    door_id = -np.ones((F, H, W), np.int32)
    floors, cells, ptr, bbox = [], [], [0], []
    for f in range(F):
        for y in range(H):
            for x in range(W):
                if mat[f, y, x] != DOOR or door_id[f, y, x] != -1:
                    continue
                d = len(floors)
                stack = [(x, y)]
                door_id[f, y, x] = d
                group = []
                while stack:
                    cx, cy = stack.pop()
                    group.append((cx, cy))
                    for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                        if 0 <= nx < W and 0 <= ny < H and mat[f, ny, nx] == DOOR and door_id[f, ny, nx] == -1:
                            door_id[f, ny, nx] = d
                            stack.append((nx, ny))
                floors.append(f)
                cells.extend(group)
                ptr.append(len(cells))
                g = np.array(group)
                bbox.append([g[:, 0].min(), g[:, 1].min(), g[:, 0].max(), g[:, 1].max()])
    return (door_id, np.array(floors, np.int32), np.array(ptr, np.int64),
            np.array(cells, np.int32).reshape(-1, 2), np.array(bbox, np.int32).reshape(-1, 4))


@nb.njit(cache=True)
def door_distance(cells_ptr, cells, d, x, y):
    best = 1e18
    for k in range(cells_ptr[d], cells_ptr[d + 1]):
        cx = cells[k, 0]
        cy = cells[k, 1]
        dx = max(cx - x, 0.0, x - cx - 1.0)
        dy = max(cy - y, 0.0, y - cy - 1.0)
        dd = np.sqrt(dx * dx + dy * dy)
        if dd < best:
            best = dd
    return best


@nb.njit(parallel=True, cache=True)
def _visibility_floor(f, mat, door_id, door_floor, door_ptr, door_cells, door_bbox,
                      rows_x, rows_y, sp_x, sp_y, sp_req, nbytes):
    """Packed-bit line of sight from every walkable pixel (rows) to every sight point."""
    R = rows_x.shape[0]
    S = sp_x.shape[0]
    H = mat.shape[1]
    W = mat.shape[2]
    D = door_floor.shape[0]
    out = np.zeros((R, nbytes), np.uint8)
    for r in nb.prange(R):
        gx = rows_x[r]
        gy = rows_y[r]
        px = gx + 0.5
        py = gy + 0.5
        # door open states induced by standing at this pixel centre
        open_ = np.zeros(max(D, 1), np.uint8)
        for d in range(D):
            if door_floor[d] != f:
                continue
            # cheap bbox rejection
            bx0 = door_bbox[d, 0]; by0 = door_bbox[d, 1]; bx1 = door_bbox[d, 2]; by1 = door_bbox[d, 3]
            ddx = max(bx0 - px, 0.0, px - bx1 - 1.0)
            ddy = max(by0 - py, 0.0, py - by1 - 1.0)
            if np.sqrt(ddx * ddx + ddy * ddy) > DOOR_TRIGGER_DISTANCE + 1e-9:
                continue
            if door_distance(door_ptr, door_cells, d, px, py) <= DOOR_TRIGGER_DISTANCE:
                open_[d] = 1
        for s in range(S):
            req = sp_req[s]
            if req >= 0 and open_[req] == 0:
                continue
            tx = sp_x[s]
            ty = sp_y[s]
            # Bresenham from (gx, gy) to (tx, ty), endpoints never block
            x = gx
            y = gy
            dx = abs(tx - x)
            stepx = 1 if x < tx else -1
            dy = -abs(ty - y)
            stepy = 1 if y < ty else -1
            err = dx + dy
            ok = True
            while True:
                if not ((x == gx and y == gy) or (x == tx and y == ty)):
                    m = mat[f, y, x]
                    if m == OPAQUE:
                        ok = False
                        break
                    if m == DOOR and open_[door_id[f, y, x]] == 0:
                        ok = False
                        break
                if x == tx and y == ty:
                    break
                e2 = err * 2
                if e2 >= dy:
                    err += dy
                    x += stepx
                if e2 <= dx:
                    err += dx
                    y += stepy
            if ok:
                out[r, s >> 3] |= np.uint8(1 << (s & 7))
    return out


def load_plan(path: str, use_cache: bool = True, verbose: bool = True) -> Plan:
    with open(path) as fh:
        d = json.load(fh)
    W, H = d['width'], d['height']
    floors = d['floors']
    F = len(floors)
    mat = np.zeros((F, H, W), np.uint8)
    val = np.zeros((F, H, W), np.float64)
    for f, fl in enumerate(floors):
        px = np.array(fl['pixels'], np.uint8)
        mat[f] = px.reshape(H, W)
        v = np.where(px == FLOOR, 1.0, 0.0)
        if 'values' in fl and fl['values'] is not None:
            v = np.array(fl['values'], np.float64)
        else:
            for k, value in (fl.get('valueOverrides') or {}).items():
                v[int(k)] = float(value)
        val[f] = v.reshape(H, W)
    chairs = np.array([[c['x'], c['y'], c['floor'], c['rotation']] for c in d.get('chairs', [])], np.int64).reshape(-1, 4)
    chair_mask = np.zeros((F, H, W), np.uint8)
    for x, y, f, _ in chairs:
        chair_mask[f, y:y + 3, x:x + 3] = 1
    st = []
    for s in d.get('stairs', []):
        st.append([0 if s['type'] == 'straight' else 1, s['x'], s['y'], s['length'], s['width'], s['rotation'],
                   s['lower'], s['upper'], s.get('landingDepth', 8)])
    stairs = np.array(st, np.float64).reshape(-1, 9)
    door_id, door_floor, door_ptr, door_cells, door_bbox = _door_groups(mat, F, H, W)
    starts = d.get('starts') or [d['spawn']]
    starts = [{'x': float(s['x']), 'y': float(s['y']), 'floor': int(s.get('floor', 0))} for s in starts]

    # --- candidates (positive weight pixels), ordering identical to events.js
    cf, cx, cy, cw = [], [], [], []
    for f in range(F):
        ys, xs = np.nonzero(val[f] > 0)
        order = np.argsort(ys * W + xs, kind='stable')
        cf.append(np.full(len(xs), f)); cx.append(xs[order]); cy.append(ys[order]); cw.append(val[f][ys[order], xs[order]])
    cand_floor = np.concatenate(cf).astype(np.int32)
    cand_x = np.concatenate(cx).astype(np.int32)
    cand_y = np.concatenate(cy).astype(np.int32)
    cand_w = np.concatenate(cw).astype(np.float64)

    # --- sight points per floor
    sp_lists = [dict() for _ in range(F)]   # (x, y, req) -> local id
    cand_sp_ptr = [0]
    cand_sp = []
    for j in range(len(cand_x)):
        f, x, y = cand_floor[j], cand_x[j], cand_y[j]
        pts = []
        if mat[f, y, x] == OPAQUE:
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if not (0 <= nx < W and 0 <= ny < H):
                    continue
                m = mat[f, ny, nx]
                if m in (FLOOR, TRANSPARENT):
                    pts.append((nx, ny, -1))
                elif m == DOOR:
                    pts.append((nx, ny, int(door_id[f, ny, nx])))
        else:
            pts.append((x, y, -1))
        for p in pts:
            if p not in sp_lists[f]:
                sp_lists[f][p] = len(sp_lists[f])
            cand_sp.append(sp_lists[f][p])
        cand_sp_ptr.append(len(cand_sp))
    sp_floor_ptr = [0]
    spx, spy, spr = [], [], []
    for f in range(F):
        items = sorted(sp_lists[f].items(), key=lambda kv: kv[1])
        for (x, y, r), _ in items:
            spx.append(x); spy.append(y); spr.append(r)
        sp_floor_ptr.append(len(spx))

    walk_row = -np.ones((F, H, W), np.int32)
    rows = []
    for f in range(F):
        ys, xs = np.nonzero((mat[f] == FLOOR) | (mat[f] == DOOR))
        walk_row[f, ys, xs] = np.arange(len(xs))
        rows.append((xs.astype(np.int32), ys.astype(np.int32)))

    plan = Plan(name=os.path.basename(path).replace('.json', ''), path=path, W=W, H=H, F=F, mat=mat, val=val,
                chair_mask=chair_mask, chairs=chairs, stairs=stairs, door_id=door_id, door_floor=door_floor,
                door_cells_ptr=door_ptr, door_cells=door_cells, door_bbox=door_bbox, starts=starts,
                cand_floor=cand_floor, cand_x=cand_x, cand_y=cand_y, cand_w=cand_w,
                cand_sp_ptr=np.array(cand_sp_ptr, np.int64), cand_sp=np.array(cand_sp, np.int32),
                sp_floor_ptr=np.array(sp_floor_ptr, np.int64), sp_x=np.array(spx, np.int32),
                sp_y=np.array(spy, np.int32), sp_req_door=np.array(spr, np.int32), walk_row=walk_row)

    # --- visibility (cached)
    key = hashlib.md5(open(path, 'rb').read() + b'v3').hexdigest()[:16]
    os.makedirs(CACHE_DIR, exist_ok=True)
    vis = []
    for f in range(F):
        a, b = sp_floor_ptr[f], sp_floor_ptr[f + 1]
        nbytes = max(1, (b - a + 7) // 8)
        cpath = os.path.join(CACHE_DIR, f'vis_{key}_f{f}.npy')
        if use_cache and os.path.exists(cpath):
            v = np.load(cpath)
        else:
            import time
            t0 = time.time()
            v = _visibility_floor(f, mat, door_id, door_floor, door_ptr, door_cells, door_bbox,
                                  rows[f][0], rows[f][1], plan.sp_x[a:b], plan.sp_y[a:b], plan.sp_req_door[a:b], nbytes)
            if verbose:
                print(f'  visibility {plan.name} floor {f}: {v.shape} in {time.time() - t0:.1f}s')
            np.save(cpath, v)
        vis.append(v)
    plan.vis = vis
    maxb = max(v.shape[1] for v in vis)
    plan.vis_bytes = np.array([v.shape[1] for v in vis], np.int64)
    plan.vis_row_ptr = np.zeros(F, np.int64)
    flat = []
    off = 0
    for f, v in enumerate(vis):
        plan.vis_row_ptr[f] = off
        pad = np.zeros((v.shape[0], maxb), np.uint8)
        pad[:, :v.shape[1]] = v
        flat.append(pad)
        off += v.shape[0]
    plan.vis_flat = np.concatenate(flat, axis=0)
    return plan


def plan_paths(directory=None):
    directory = directory or os.path.join(os.path.dirname(HERE), 'plans')
    return sorted(os.path.join(directory, f) for f in os.listdir(directory) if f.endswith('.json') and f[0].isdigit())
