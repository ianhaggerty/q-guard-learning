"""Observation encoder (fixed size, map independent -> enables transfer between plans).

For guard g in environment e:
  local  (C_L=9, 25, 25): north-up egocentric crop of the guard's floor at 3x3-block
         resolution, centred on the guard's block (12.5 m x 12.5 m):
           0 opaque fraction, 1 transparent fraction, 2 door fraction, 3 chair,
           4 stair walkway, 5 event value (log), 6 risk = log1p(sum P / ref),
           7 other guards, 8 outside the canvas
  global (C_G=10, 16, 16): whole canvas pooled to 16x16 cells:
           for [own floor, other floor]: risk, walls, value, other guards  (8)
           + own position, + stair walkway on own floor                     (2)
  vector (N_V=40): heading(8) look(8) gait(3) sitting can_sit frac_x frac_y floor/F
           multi-floor flag, x/W, y/H, total risk (log), other-floor risk (log), 3 spare,
           absolute facing(8)

risk reference: one 3x3 block of value-1 floor left unseen for T_REF seconds.
"""
import math
import numpy as np

from .plan import GRID, OPAQUE, TRANSPARENT, DOOR, FLOOR, EVENT_RATE

L = 25
R = L // 2
GG = 16
C_L, C_G, N_V = 9, 10, 40
T_REF = 60.0


class ObsEncoder:
    def __init__(self, env):
        self.env = env
        p = env.plan
        self.p = p
        F, Hb, Wb = p.F, p.Hb, p.Wb
        self.F, self.Hb, self.Wb = F, Hb, Wb
        m = p.mat.reshape(F, Hb, 3, Wb, 3)
        stat = np.zeros((F, 6, Hb, Wb), np.float32)
        stat[:, 0] = (m == OPAQUE).mean(axis=(2, 4))
        stat[:, 1] = (m == TRANSPARENT).mean(axis=(2, 4))
        stat[:, 2] = (m == DOOR).mean(axis=(2, 4))
        stat[:, 3] = p.chair_mask.reshape(F, Hb, 3, Wb, 3).mean(axis=(2, 4))
        stair = np.zeros((F, p.H, p.W), np.float32)
        for st in p.stairs:
            typ, x, y, ln, wd, rot = st[:6]
            w, h = (wd, ln) if int(rot) % 180 else (ln, wd)
            for f in (int(st[6]), int(st[7])):
                stair[f, int(y):int(y + h), int(x):int(x + w)] = 1
        stat[:, 4] = stair.reshape(F, Hb, 3, Wb, 3).mean(axis=(2, 4))
        stat[:, 5] = np.log1p(p.val.reshape(F, Hb, 3, Wb, 3).mean(axis=(2, 4))) / np.log1p(100.0)
        self.stat = stat
        # padded static local maps: channels 0-5 + outside(8)
        pad = np.zeros((F, 7, Hb + 2 * R, Wb + 2 * R), np.float32)
        pad[:, 6] = 1.0
        pad[:, :6, R:R + Hb, R:R + Wb] = stat
        pad[:, 6, R:R + Hb, R:R + Wb] = 0.0
        self.stat_pad = pad
        # global pooling
        k = max(1, math.ceil(max(Hb, Wb) / GG))
        self.k = k
        self.gH, self.gW = GG * k, GG * k
        gstat = np.zeros((F, 3, GG, GG), np.float32)
        tmp = np.zeros((F, 3, self.gH, self.gW), np.float32)
        tmp[:, 0, :Hb, :Wb] = stat[:, 0] + stat[:, 1]
        tmp[:, 1, :Hb, :Wb] = stat[:, 5]
        tmp[:, 2, :Hb, :Wb] = stat[:, 4]
        gstat = tmp.reshape(F, 3, GG, k, GG, k).mean(axis=(3, 5))
        self.gstat = gstat
        self.ref_block = 9 * EVENT_RATE * T_REF       # sum P of an unseen value-1 block after T_REF
        self.n_valued = float((p.cand_w > 0).sum())
        self.risk = np.zeros((env.E, F, Hb, Wb))
        self.lam_total = env.rate * p.cand_w.sum()

    def encode(self):
        env, p = self.env, self.p
        E, G, F, Hb, Wb, k = env.E, env.G, self.F, self.Hb, self.Wb, self.k
        env.block_risk(self.risk)
        risk = np.log1p(self.risk / self.ref_block).astype(np.float32)        # (E, F, Hb, Wb)
        mask = env.update_masks()
        can_sit = mask[..., 9]
        N = E * G
        loc = np.zeros((N, C_L, L, L), np.float32)
        glo = np.zeros((N, C_G, GG, GG), np.float32)
        vec = np.zeros((N, N_V), np.float32)
        # pooled risk per env/floor
        rp = np.zeros((E, F, self.gH, self.gW), np.float32)
        rp[:, :, :Hb, :Wb] = self.risk / self.ref_block
        rpool = np.log1p(rp.reshape(E, F, GG, k, GG, k).mean(axis=(3, 5)))
        bx = np.clip((env.pos[..., 0] // GRID).astype(int), 0, Wb - 1)
        by = np.clip((env.pos[..., 1] // GRID).astype(int), 0, Hb - 1)
        tot = np.log1p(env.psum / max(1e-12, self.lam_total * T_REF))
        for e in range(E):
            for g in range(G):
                i = e * G + g
                f = int(env.fl[e, g])
                x0, y0 = bx[e, g], by[e, g]
                sp = self.stat_pad[f, :, y0:y0 + L, x0:x0 + L]
                loc[i, 0:6] = sp[0:6]
                loc[i, 8] = sp[6]
                # risk crop
                ys0, ys1 = max(0, y0 - R), min(Hb, y0 + R + 1)
                xs0, xs1 = max(0, x0 - R), min(Wb, x0 + R + 1)
                loc[i, 6, ys0 - (y0 - R):ys1 - (y0 - R), xs0 - (x0 - R):xs1 - (x0 - R)] = risk[e, f, ys0:ys1, xs0:xs1]
                of = (f + 1) % F if F > 1 else -1
                glo[i, 0] = rpool[e, f]
                glo[i, 1] = self.gstat[f, 0]
                glo[i, 2] = self.gstat[f, 1]
                if of >= 0:
                    glo[i, 4] = rpool[e, of]
                    glo[i, 5] = self.gstat[of, 0]
                    glo[i, 6] = self.gstat[of, 1]
                glo[i, 9] = self.gstat[f, 2]
                glo[i, 8, min(GG - 1, y0 // k), min(GG - 1, x0 // k)] = 1.0
                for h in range(G):
                    if h == g:
                        continue
                    hx, hy = bx[e, h], by[e, h]
                    if env.fl[e, h] == f:
                        lx, ly = hx - x0 + R, hy - y0 + R
                        if 0 <= lx < L and 0 <= ly < L:
                            loc[i, 7, ly, lx] = 1.0
                        glo[i, 3, min(GG - 1, hy // k), min(GG - 1, hx // k)] += 1.0
                    else:
                        glo[i, 7, min(GG - 1, hy // k), min(GG - 1, hx // k)] += 1.0
                v = vec[i]
                v[env.heading[e, g]] = 1
                v[8 + env.look[e, g]] = 1
                v[16 + env.gait[e, g]] = 1
                v[19] = float(env.sitting[e, g])
                v[20] = float(can_sit[e, g])
                v[21] = (env.pos[e, g, 0] % GRID) / GRID
                v[22] = (env.pos[e, g, 1] % GRID) / GRID
                v[23] = f / max(1, F - 1)
                v[24] = float(F > 1)
                v[25] = env.pos[e, g, 0] / p.W
                v[26] = env.pos[e, g, 1] / p.H
                v[27] = tot[e]
                if of >= 0:
                    v[28] = rpool[e, of].mean()
                v[32 + env.facing[e, g]] = 1
        return loc, glo, vec, mask.reshape(N, 10).astype(bool)
