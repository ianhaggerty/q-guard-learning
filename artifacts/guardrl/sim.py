"""Batched, multi-guard numba port of the Pixel-Map-Lab Explore simulation.

Faithful to dist/js/core (world.js, energy.js, detection.js, probability.js,
stairs.js, chairs.js, doors.js):
  * movement in <=0.05 s slices, axis-separated sub-steps of <=0.4 px, circle body
    of radius 1.1 px colliding with non-floor pixels, closed doors and chairs;
  * gait / look / stair-direction -> activity -> speed and MET (energy.js);
  * eight headings, look offsets relative to travel, backward looks force backward walk;
  * chairs: sit when within 3.5 px of the chair front with a clear straight path;
  * doors open while a guard is within 5 px;
  * the deterministic probability field dm/dt = lambda - mu m, integrated exactly at a
    fixed pose (probability.js), P = 1 - exp(-m), sum P = expected unresolved events.

Extensions for several guards (not present in the single-explorer JS code):
  * detection hazards of different guards add (independent Poisson detections);
  * a pixel's detection reduction is credited to guards in proportion to their hazard;
  * a door is open while *any* guard on that floor is within 5 px (line of sight for a
    guard still uses its own-proximity door state, see plan.py);
  * a chair can hold one guard; guards do not collide with each other.

Nothing here edits the field-of-view or MET assumptions.
"""
import math
import numpy as np
import numba as nb

from .plan import (METRES_PER_PIXEL, EXPLORER_RADIUS, DOOR_TRIGGER_DISTANCE, EVENT_RATE, DETECTION_HALF_RANGE,
                   DETECTION_PEAK, FIELD_OF_VIEW, FLOOR, OPAQUE, TRANSPARENT, DOOR, door_distance)

MAX_SLICE = 0.05
MAX_SUBSTEP = 0.4
SIT_REACH = 3.5
BODY_MASS = 70.0
STANDING_MET = 1.3


def _scaled(ref_met, ref_speed, speed):
    return STANDING_MET + (ref_met - STANDING_MET) * (speed / ref_speed)


# activity index -> (name, MET, speed m/s); identical to energy.js ACTIVITIES
ACTIVITY_NAMES = ['sitting', 'standing', 'backward', 'stairsUpBackward', 'stairsDownBackward', 'walk', 'run', 'sprint',
                  'stairsUp', 'stairsDown', 'stairsUpRun', 'stairsDownRun', 'stairsUpSprint', 'stairsDownSprint']
ACT_MET = np.array([1.0, 1.3, 4.0, 6.8, 3.5, 3.8, 9.3, 23.0, 6.8, 3.5, 15.0, _scaled(3.5, 0.6, 1.0),
                    _scaled(15.0, 1.0, 1.5), _scaled(3.5, 0.6, 1.3)])
ACT_SPEED = np.array([0.0, 0.0, 0.8, 0.25, 0.3, 1.34112, 2.68224, 6.25856, 0.5, 0.6, 1.0, 1.0, 1.5, 1.3])
A_SIT, A_STAND, A_BACK, A_UPB, A_DNB, A_WALK, A_RUN, A_SPRINT, A_UP, A_DN, A_UPR, A_DNR, A_UPS, A_DNS = range(14)
GAIT_NAMES = ['walk', 'run', 'sprint']
LOOK_NAMES = ['forward', 'forward-right', 'right', 'back-right', 'back', 'back-left', 'left', 'forward-left']
DIR_NAMES = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']
DIR_DX = np.array([1, 1, 0, -1, -1, -1, 0, 1], np.float64)
DIR_DY = np.array([0, 1, 1, 1, 0, -1, -1, -1], np.float64)
MOVE_STAY, MOVE_SIT = 0, 9      # moves 1..8 = headings 0..7


@nb.njit(cache=True, inline='always')
def movement_activity(gait, look, stair_dir):
    backward = look >= 3 and look <= 5
    if stair_dir == 0:
        if backward:
            return A_BACK
        return A_WALK + gait
    if stair_dir == 1:      # up
        if backward:
            return A_UPB
        return (A_UP, A_UPR, A_UPS)[gait]
    if backward:
        return A_DNB
    return (A_DN, A_DNR, A_DNS)[gait]


# --------------------------------------------------------------------------------------
# geometry

@nb.njit(cache=True, inline='always')
def blocked_cell(mat, door_id, door_open, chair_mask, f, x, y):
    H = mat.shape[1]
    W = mat.shape[2]
    if x < 0 or y < 0 or x >= W or y >= H:
        return True
    m = mat[f, y, x]
    if m == FLOOR:
        return chair_mask[f, y, x] != 0
    if m == DOOR:
        return door_open[door_id[f, y, x]] == 0
    return True


@nb.njit(cache=True)
def can_stand(mat, door_id, door_open, chair_mask, f, cx, cy):
    r = EXPLORER_RADIUS
    for y in range(int(math.floor(cy - r)), int(math.floor(cy + r)) + 1):
        for x in range(int(math.floor(cx - r)), int(math.floor(cx + r)) + 1):
            nx = max(x, min(cx, x + 1.0))
            ny = max(y, min(cy, y + 1.0))
            if (cx - nx) ** 2 + (cy - ny) ** 2 < r * r:
                if blocked_cell(mat, door_id, door_open, chair_mask, f, x, y):
                    return False
    return True


@nb.njit(cache=True, inline='always')
def world_to_stair(st, x, y):
    dx = x - st[1]
    dy = y - st[2]
    L = st[3]
    Wd = st[4]
    rot = st[5]
    if rot == 90:
        return dy, Wd - dx
    if rot == 180:
        return L - dx, Wd - dy
    if rot == 270:
        return L - dy, dx
    return dx, dy


@nb.njit(cache=True, inline='always')
def flight_length(st):
    if st[0] == 0:
        return st[3] / 2
    return st[3] - st[8]


@nb.njit(cache=True)
def stair_crossing_target(st, floor, fx, fy, tx, ty, radius):
    au, av = world_to_stair(st, fx, fy)
    bu, bv = world_to_stair(st, tx, ty)
    if st[0] == 0:          # straight: line u = L/2, along v in [0, width]
        at = st[3] / 2; lo = 0.0; hi = st[4]
        before = au - at; after = bu - at; a_al = av; b_al = bv
    else:                   # return: line v = width/2, along u in [flight, L]
        at = st[4] / 2; lo = flight_length(st); hi = st[3]
        before = av - at; after = bv - at; a_al = au; b_al = bu
    rising = floor == int(st[6])
    if rising:
        crosses = before <= 0 and after > 0
    else:
        crosses = before >= 0 and after < 0
    if not crosses:
        return -1
    t = -before / (after - before)
    pos = a_al + (b_al - a_al) * t
    if pos < lo + radius or pos > hi - radius:
        return -1
    return int(st[7]) if rising else int(st[6])


@nb.njit(cache=True)
def stair_flight_direction(st, floor, end_floor, fx, fy, tx, ty):
    """0 level, 1 up, 2 down (stairs.js stairFlightDirection)."""
    au, av = world_to_stair(st, fx, fy)
    bu, bv = world_to_stair(st, tx, ty)
    u = (au + bu) / 2
    v = (av + bv) / 2
    du = bu - au
    L = st[3]
    Wd = st[4]
    if not (u >= 0 and u < L and v >= 0 and v < Wd) or abs(du) < 1e-8:
        return 0
    lower = int(st[6])
    if st[0] == 0:
        other = (au >= L / 2) if floor == lower else (au < L / 2)
        if floor == end_floor and other:
            return 0
        return 1 if du > 0 else 2
    if u >= flight_length(st):
        return 0
    lane_edge = (Wd - 3) / 2
    if floor == lower and v < lane_edge:
        return 1 if du > 0 else 2
    if floor == int(st[7]) and v >= lane_edge + 3:
        return 1 if du < 0 else 2
    return 0


@nb.njit(cache=True)
def stair_direction(stairs, fx, fy, tx, ty, floor, end_floor):
    for k in range(stairs.shape[0]):
        st = stairs[k]
        if int(st[6]) != floor and int(st[7]) != floor:
            continue
        d = stair_flight_direction(st, floor, end_floor, fx, fy, tx, ty)
        if d != 0:
            return d
    return 0


@nb.njit(cache=True)
def try_move(mat, door_id, door_open, chair_mask, stairs, pos, fl, g, x, y):
    """Move guard g to (x, y) if it fits, changing floor across a stair line. Returns moved."""
    f = fl[g]
    for k in range(stairs.shape[0]):
        st = stairs[k]
        if int(st[6]) != f and int(st[7]) != f:
            continue
        dest = stair_crossing_target(st, f, pos[g, 0], pos[g, 1], x, y, EXPLORER_RADIUS)
        if dest < 0:
            continue
        if can_stand(mat, door_id, door_open, chair_mask, dest, x, y):
            fl[g] = dest
            pos[g, 0] = x
            pos[g, 1] = y
            return True
        return False
    if not can_stand(mat, door_id, door_open, chair_mask, f, x, y):
        return False
    pos[g, 0] = x
    pos[g, 1] = y
    return True


@nb.njit(cache=True)
def update_doors(door_floor, door_ptr, door_cells, door_bbox, door_open, pos, fl, G):
    D = door_floor.shape[0]
    for d in range(D):
        near = False
        for g in range(G):
            if fl[g] != door_floor[d]:
                continue
            px = pos[g, 0]; py = pos[g, 1]
            ddx = max(door_bbox[d, 0] - px, 0.0, px - door_bbox[d, 2] - 1.0)
            ddy = max(door_bbox[d, 1] - py, 0.0, py - door_bbox[d, 3] - 1.0)
            if math.sqrt(ddx * ddx + ddy * ddy) > DOOR_TRIGGER_DISTANCE + 1e-9:
                continue
            if door_distance(door_ptr, door_cells, d, px, py) <= DOOR_TRIGGER_DISTANCE:
                near = True
                break
        door_open[d] = 1 if near else 0


@nb.njit(cache=True, inline='always')
def chair_front(chairs, c):
    rot = chairs[c, 3]
    dx = 0.0; dy = 0.0
    if rot == 0:
        dx = 1.0
    elif rot == 90:
        dy = 1.0
    elif rot == 180:
        dx = -1.0
    else:
        dy = -1.0
    dist = 1.5 + EXPLORER_RADIUS + 0.1
    return chairs[c, 0] + 1.5 + dx * dist, chairs[c, 1] + 1.5 + dy * dist


@nb.njit(cache=True)
def nearby_chair(mat, door_id, door_open, chair_mask, chairs, pos, fl, seat, g, G):
    best = 1e18
    found = -1
    for c in range(chairs.shape[0]):
        if chairs[c, 2] != fl[g]:
            continue
        occupied = False
        for h in range(G):
            if h != g and seat[h] == c:
                occupied = True
        if occupied:
            continue
        fx, fy = chair_front(chairs, c)
        dist = math.hypot(pos[g, 0] - fx, pos[g, 1] - fy)
        if dist > SIT_REACH or dist >= best:
            continue
        if not can_stand(mat, door_id, door_open, chair_mask, fl[g], fx, fy):
            continue
        samples = max(1, int(math.ceil(dist / 0.25)))
        clear = True
        for i in range(samples + 1):
            x = pos[g, 0] + (fx - pos[g, 0]) * i / samples
            y = pos[g, 1] + (fy - pos[g, 1]) * i / samples
            if not can_stand(mat, door_id, door_open, chair_mask, fl[g], x, y):
                clear = False
                break
        if not clear:
            continue
        found = c
        best = dist
    return found


# --------------------------------------------------------------------------------------
# detection / probability field

@nb.njit(cache=True)
def guard_chances(f, x, y, facing, walk_row, vis_flat, vis_row_ptr, sp_lo, sp_x, sp_y, nsp, half_range, out):
    """1-second detection chance of every sight point of floor f (out[:nsp])."""
    row = walk_row[f, int(math.floor(y)), int(math.floor(x))]
    for s in range(nsp):
        out[s] = 0.0
    if row < 0:
        return
    r = vis_row_ptr[f] + row
    ang = facing * math.pi / 4
    hx = math.cos(ang)
    hy = math.sin(ang)
    for s in range(nsp):
        if (vis_flat[r, s >> 3] >> (s & 7)) & 1 == 0:
            continue
        dx = sp_x[sp_lo + s] + 0.5 - x
        dy = sp_y[sp_lo + s] + 0.5 - y
        dist = math.sqrt(dx * dx + dy * dy)
        if dist > 0:
            ecc = abs(math.atan2(dy * hx - dx * hy, dx * hx + dy * hy)) * 180.0 / math.pi
        else:
            ecc = 0.0
        af = 1.0 - ecc / (FIELD_OF_VIEW / 2)
        if af <= 0:
            continue
        out[s] = DETECTION_PEAK * af / (1.0 + dist * METRES_PER_PIXEL / half_range)


@nb.njit(cache=True)
def field_integrate(e, tau, G, pos, fl, facing, means, rate, cand_w, cand_floor_ptr, cand_sp_ptr, cand_sp,
                    walk_row, vis_flat, vis_row_ptr, sp_floor_ptr, sp_x, sp_y, half_range,
                    chance_buf, mu_buf, credit, F, own_hazard_out):
    """Integrate dm/dt = lambda - mu m over tau with hazards at the current poses.

    credit[g] += sum_j (mu_gj / mu_j) * (P_j(no detection) - P_j(actual)).
    own_hazard_out[g, j] (optional, shape (G, J) or (0, 0)) receives guard g's hazard.
    """
    J = means.shape[0]
    # hazards per guard over its floor's candidates
    for g in range(G):
        f = fl[g]
        sp_lo = sp_floor_ptr[f]
        nsp = sp_floor_ptr[f + 1] - sp_lo
        guard_chances(f, pos[g, 0], pos[g, 1], facing[g], walk_row, vis_flat, vis_row_ptr, sp_lo, sp_x, sp_y,
                      nsp, half_range, chance_buf[g])
    for f in range(F):
        j0 = cand_floor_ptr[f]
        j1 = cand_floor_ptr[f + 1]
        any_g = False
        for g in range(G):
            if fl[g] == f:
                any_g = True
        if not any_g:
            for j in range(j0, j1):
                means[j] += rate * cand_w[j] * tau
            continue
        for j in range(j0, j1):
            lam = rate * cand_w[j]
            mu = 0.0
            for g in range(G):
                mg = 0.0
                if fl[g] == f:
                    best = 0.0
                    for k in range(cand_sp_ptr[j], cand_sp_ptr[j + 1]):
                        c = chance_buf[g, cand_sp[k]]
                        if c > best:
                            best = c
                    if best > 0:
                        mg = -math.log1p(-best)
                mu_buf[g] = mg
                mu += mg
            m0 = means[j]
            if mu <= 0:
                means[j] = m0 + lam * tau
                continue
            loss = -math.expm1(-mu * tau)
            m1 = m0 * (1 - loss) + lam * loss / mu
            means[j] = m1
            dP = math.exp(-m1) - math.exp(-(m0 + lam * tau))
            if dP > 0:
                for g in range(G):
                    if mu_buf[g] > 0:
                        credit[g] += dP * mu_buf[g] / mu
            if own_hazard_out.shape[0] > 0:
                for g in range(G):
                    own_hazard_out[g, j] = mu_buf[g]


@nb.njit(cache=True)
def prob_sum(means):
    s = 0.0
    for j in range(means.shape[0]):
        s += -math.expm1(-means[j])
    return s


# --------------------------------------------------------------------------------------
# one decision step for one environment

@nb.njit(cache=True)
def step_env(e, actions, dt, field_slices, G, abs_gaze,
             mat, door_id, chair_mask, chairs, stairs, door_floor, door_ptr, door_cells, door_bbox,
             cand_w, cand_floor_ptr, cand_sp_ptr, cand_sp, walk_row, vis_flat, vis_row_ptr, sp_floor_ptr, sp_x,
             sp_y, rate, half_range,
             pos, fl, heading, look, facing, gait, sitting, seat, seat_exit, door_open, means,
             kcal_out, act_secs, credit_out, dist_out, chance_buf, mu_buf, F):
    """actions[g] = (move 0..9, gait 0..2, look 0..7). Writes kcal/credit/distance for this step."""
    moving = np.zeros(G, np.bool_)
    dxs = np.zeros(G)
    dys = np.zeros(G)
    for g in range(G):
        kcal_out[g] = 0.0
        credit_out[g] = 0.0
        dist_out[g] = 0.0
        mv = actions[g, 0]
        gait[g] = actions[g, 1]
        look[g] = actions[g, 2]
        facing[g] = (heading[g] + look[g]) % 8
        if mv == 9:     # sit (no-op if no free chair in reach)
            if not sitting[g]:
                c = nearby_chair(mat, door_id, door_open, chair_mask, chairs, pos, fl, seat, g, G)
                if c >= 0:
                    seat_exit[g, 0] = pos[g, 0]
                    seat_exit[g, 1] = pos[g, 1]
                    seat[g] = c
                    pos[g, 0] = chairs[c, 0] + 1.5
                    pos[g, 1] = chairs[c, 1] + 1.5
                    sitting[g] = True
                    heading[g] = chairs[c, 3] // 45
                    facing[g] = (heading[g] + look[g]) % 8
        elif mv >= 1:
            ok = True
            if sitting[g]:
                c = seat[g]
                fx, fy = chair_front(chairs, c)
                if can_stand(mat, door_id, door_open, chair_mask, fl[g], fx, fy):
                    pos[g, 0] = fx; pos[g, 1] = fy
                elif can_stand(mat, door_id, door_open, chair_mask, fl[g], seat_exit[g, 0], seat_exit[g, 1]):
                    pos[g, 0] = seat_exit[g, 0]; pos[g, 1] = seat_exit[g, 1]
                else:
                    ok = False
                if ok:
                    sitting[g] = False
                    seat[g] = -1
            if ok:
                h = mv - 1
                moving[g] = True
                L = math.sqrt(DIR_DX[h] ** 2 + DIR_DY[h] ** 2)
                dxs[g] = DIR_DX[h] / L
                dys[g] = DIR_DY[h] / L
                heading[g] = h
                facing[g] = (h + look[g]) % 8
        if abs_gaze:
            # actions[g, 2] is an absolute gaze direction: convert to the look offset relative to
            # the (new) direction of travel, exactly as a player would set it in the app
            look[g] = (actions[g, 2] - heading[g]) % 8
            facing[g] = actions[g, 2]
    any_moving = False
    for g in range(G):
        if moving[g]:
            any_moving = True
    n_slices = int(round(dt / MAX_SLICE))
    if n_slices < 1:
        n_slices = 1
    slice_t = dt / n_slices
    acc = 0.0
    since = 0
    for si in range(n_slices):
        update_doors(door_floor, door_ptr, door_cells, door_bbox, door_open, pos, fl, G)
        for g in range(G):
            if not moving[g]:
                a = A_SIT if sitting[g] else A_STAND
                act_secs[g, a] += slice_t
                kcal_out[g] += ACT_MET[a] * BODY_MASS * slice_t / 3600.0
                continue
            fx0 = pos[g, 0]; fy0 = pos[g, 1]
            sd = stair_direction(stairs, fx0, fy0, fx0 + dxs[g] * 0.01, fy0 + dys[g] * 0.01, fl[g], fl[g])
            a = movement_activity(gait[g], look[g], sd)
            speed = ACT_SPEED[a] / METRES_PER_PIXEL
            amount = speed * slice_t
            nsub = max(1, int(math.ceil(amount / MAX_SUBSTEP)))
            for k in range(nsub):
                sx = pos[g, 0]; sy = pos[g, 1]; sf = fl[g]
                try_move(mat, door_id, door_open, chair_mask, stairs, pos, fl, g, sx + dxs[g] * amount / nsub, sy)
                try_move(mat, door_id, door_open, chair_mask, stairs, pos, fl, g, pos[g, 0], pos[g, 1] + dys[g] * amount / nsub)
                d = math.hypot(pos[g, 0] - sx, pos[g, 1] - sy)
                dist_out[g] += d
                if d > 1e-8:
                    a2 = movement_activity(gait[g], look[g], stair_direction(stairs, sx, sy, pos[g, 0], pos[g, 1], sf, fl[g]))
                else:
                    a2 = A_STAND
                    act_secs[g, 14] += slice_t / nsub      # bookkeeping only: a blocked attempt (charged as standing)
                act_secs[g, a2] += slice_t / nsub
                kcal_out[g] += ACT_MET[a2] * BODY_MASS * (slice_t / nsub) / 3600.0
        update_doors(door_floor, door_ptr, door_cells, door_bbox, door_open, pos, fl, G)
        acc += slice_t
        since += 1
        last = si == n_slices - 1
        if any_moving and (since >= field_slices or last):
            field_integrate(e, acc, G, pos, fl, facing, means, rate, cand_w, cand_floor_ptr, cand_sp_ptr, cand_sp,
                            walk_row, vis_flat, vis_row_ptr, sp_floor_ptr, sp_x, sp_y, half_range,
                            chance_buf, mu_buf, credit_out, F, np.zeros((0, 0)))
            acc = 0.0
            since = 0
    if not any_moving:
        field_integrate(e, dt, G, pos, fl, facing, means, rate, cand_w, cand_floor_ptr, cand_sp_ptr, cand_sp,
                        walk_row, vis_flat, vis_row_ptr, sp_floor_ptr, sp_x, sp_y, half_range,
                        chance_buf, mu_buf, credit_out, F, np.zeros((0, 0)))


@nb.njit(parallel=True, cache=True)
def step_batch(actions, dt, field_slices, G, abs_gaze,
               mat, door_id, chair_mask, chairs, stairs, door_floor, door_ptr, door_cells, door_bbox,
               cand_w, cand_floor_ptr, cand_sp_ptr, cand_sp, walk_row, vis_flat, vis_row_ptr, sp_floor_ptr, sp_x,
               sp_y, rate, half_range,
               pos, fl, heading, look, facing, gait, sitting, seat, seat_exit, door_open, means,
               kcal_out, act_secs, credit_out, dist_out, psum_out, chance_buf, mu_buf, F):
    E = pos.shape[0]
    for e in nb.prange(E):
        step_env(e, actions[e], dt, field_slices, G, abs_gaze,
                 mat, door_id, chair_mask, chairs, stairs, door_floor, door_ptr, door_cells, door_bbox,
                 cand_w, cand_floor_ptr, cand_sp_ptr, cand_sp, walk_row, vis_flat, vis_row_ptr, sp_floor_ptr, sp_x,
                 sp_y, rate, half_range,
                 pos[e], fl[e], heading[e], look[e], facing[e], gait[e], sitting[e], seat[e], seat_exit[e],
                 door_open[e], means[e], kcal_out[e], act_secs[e], credit_out[e], dist_out[e], chance_buf[e],
                 mu_buf[e], F)
        psum_out[e] = prob_sum(means[e])


@nb.njit(parallel=True, cache=True)
def can_sit_batch(G, mat, door_id, chair_mask, chairs, pos, fl, sitting, seat, door_open, out):
    E = pos.shape[0]
    for e in nb.prange(E):
        for g in range(G):
            if sitting[e, g]:
                out[e, g] = 1
            elif chairs.shape[0] == 0:
                out[e, g] = 0
            else:
                c = nearby_chair(mat, door_id, door_open[e], chair_mask, chairs, pos[e], fl[e], seat[e], g, G)
                out[e, g] = 1 if c >= 0 else 0


@nb.njit(parallel=True, cache=True)
def move_mask_batch(G, mat, door_id, chair_mask, chairs, stairs, pos, fl, sitting, seat, door_open, out):
    """out[e, g, m] = 1 if move m is meaningful: stay always; a heading only if one sub-step
    (0.4 px, with wall sliding) actually displaces the guard -- a person does not walk into a
    wall; sit only when a free chair is in reach (or already seated)."""
    E = pos.shape[0]
    for e in nb.prange(E):
        tmp = np.zeros((1, 2))
        tfl = np.zeros(1, np.int64)
        for g in range(G):
            out[e, g, 0] = 1
            for h in range(8):
                if sitting[e, g]:
                    out[e, g, 1 + h] = 1
                    continue
                tmp[0, 0] = pos[e, g, 0]; tmp[0, 1] = pos[e, g, 1]; tfl[0] = fl[e, g]
                L = math.sqrt(DIR_DX[h] ** 2 + DIR_DY[h] ** 2)
                dx = DIR_DX[h] / L * MAX_SUBSTEP
                dy = DIR_DY[h] / L * MAX_SUBSTEP
                try_move(mat, door_id, door_open[e], chair_mask, stairs, tmp, tfl, 0, tmp[0, 0] + dx, tmp[0, 1])
                try_move(mat, door_id, door_open[e], chair_mask, stairs, tmp, tfl, 0, tmp[0, 0], tmp[0, 1] + dy)
                moved = abs(tmp[0, 0] - pos[e, g, 0]) + abs(tmp[0, 1] - pos[e, g, 1]) > 1e-6
                out[e, g, 1 + h] = 1 if moved else 0
            if sitting[e, g]:
                out[e, g, 9] = 1
            elif chairs.shape[0] == 0:
                out[e, g, 9] = 0
            else:
                c = nearby_chair(mat, door_id, door_open[e], chair_mask, chairs, pos[e], fl[e], seat[e], g, G)
                out[e, g, 9] = 1 if c >= 0 else 0


@nb.njit(cache=True)
def nearest_clear_spot(mat, door_id, door_open, chair_mask, f, sx, sy):
    """world.js moveToNearestClearSpot."""
    if can_stand(mat, door_id, door_open, chair_mask, f, sx, sy):
        return sx, sy
    H = mat.shape[1]; W = mat.shape[2]
    best = 1e18; bx = sx; by = sy
    for y in range(2, H - 2):
        for x in range(2, W - 2):
            if not can_stand(mat, door_id, door_open, chair_mask, f, x + 0.5, y + 0.5):
                continue
            d = (x - sx) ** 2 + (y - sy) ** 2
            if d < best:
                best = d; bx = x + 0.5; by = y + 0.5
    return bx, by


@nb.njit(parallel=True, cache=True)
def block_risk_batch(means, cand_floor, cand_x, cand_y, out):
    """out[e, f, by, bx] = sum of P over the candidates in each 3x3 block."""
    E = means.shape[0]
    J = means.shape[1]
    for e in nb.prange(E):
        out[e].fill(0.0)
        for j in range(J):
            out[e, cand_floor[j], cand_y[j] // 3, cand_x[j] // 3] += -math.expm1(-means[e, j])
