"""Deep Q-learning agents: branching dueling double DQN (BDQ) and flat dueling double DQN,
with n-step returns, optional NoisyNets, optional prioritised replay, temporally-extended
epsilon-greedy ("ez-greedy", Dabney et al. 2021) and optional demonstration (DQfD-style
large-margin) loss for cold starts.
"""
import copy
import math
import numpy as np
import torch
import torch.nn.functional as Fn

from .models import QNet, BRANCHES, N_FLAT, flat_index, unflat
from .obs import C_L, C_G, N_V, L, GG


class Replay:
    def __init__(self, cap, seed=0):
        self.cap = cap
        self.loc = np.zeros((cap, C_L, L, L), np.float16)
        self.glo = np.zeros((cap, C_G, GG, GG), np.float16)
        self.vec = np.zeros((cap, N_V), np.float32)
        self.nloc = np.zeros((cap, C_L, L, L), np.float16)
        self.nglo = np.zeros((cap, C_G, GG, GG), np.float16)
        self.nvec = np.zeros((cap, N_V), np.float32)
        self.act = np.zeros((cap, 3), np.int64)
        self.ret = np.zeros(cap, np.float32)
        self.disc = np.zeros(cap, np.float32)
        self.ncan = np.zeros((cap, 10), np.bool_)     # valid moves at s'
        self.demo = np.zeros(cap, np.bool_)
        self.net = np.zeros(cap, np.int64)
        self.prio = np.zeros(cap, np.float64)
        self.n = 0
        self.i = 0
        self.rng = np.random.default_rng(seed)
        self.max_prio = 1.0

    def add(self, s, a, ret, disc, s2, ncan, net=0, demo=False):
        i = self.i
        self.loc[i], self.glo[i], self.vec[i] = s
        self.nloc[i], self.nglo[i], self.nvec[i] = s2
        self.act[i] = a
        self.ret[i] = ret
        self.disc[i] = disc
        self.ncan[i] = ncan
        self.demo[i] = demo
        self.net[i] = net
        self.prio[i] = self.max_prio
        self.i = (i + 1) % self.cap
        self.n = min(self.n + 1, self.cap)

    def sample(self, b, prioritized=False, alpha=0.6, beta=0.4, net=None):
        n = self.n
        if net is not None:
            pool = np.nonzero(self.net[:n] == net)[0]
        else:
            pool = None
        if prioritized:
            p = self.prio[:n] ** alpha if pool is None else self.prio[pool] ** alpha
            p = p / p.sum()
            k = self.rng.choice(len(p), b, p=p)
            idx = k if pool is None else pool[k]
            w = (len(p) * p[k]) ** (-beta)
            w = w / w.max()
        else:
            idx = self.rng.integers(0, n, b) if pool is None else pool[self.rng.integers(0, len(pool), b)]
            w = np.ones(b)
        return idx, w

    def update_prio(self, idx, td):
        pr = np.abs(td) + 1e-3
        self.prio[idx] = pr
        self.max_prio = max(self.max_prio, float(pr.max()))


class NStep:
    """Per-stream n-step return accumulator."""

    def __init__(self, n, gamma):
        self.n, self.gamma = n, gamma
        self.buf = []

    def push(self, s, a, r):
        self.buf.append((s, a, r))

    def pop_ready(self, s_next, ncan, flush=False):
        out = []
        while self.buf and (len(self.buf) >= self.n or flush):
            ret, g = 0.0, 1.0
            for (_, _, r) in self.buf[:self.n]:
                ret += g * r
                g *= self.gamma
            s, a, _ = self.buf[0]
            out.append((s, a, ret, g, s_next, ncan))
            self.buf.pop(0)
            if not flush:
                break
        return out


class Agent:
    def __init__(self, head='branch', noisy=False, n_nets=1, lr=1e-4, gamma=0.99, nstep=3, batch=128,
                 target_tau=0.005, prioritized=False, double=True, device='cpu', seed=0, demo_margin=0.8,
                 demo_weight=1.0):
        torch.manual_seed(seed)
        self.head, self.noisy = head, noisy
        self.nets = [QNet(head, noisy) for _ in range(n_nets)]
        self.targets = [copy.deepcopy(n) for n in self.nets]
        for t in self.targets:
            for p_ in t.parameters():
                p_.requires_grad_(False)
        self.opts = [torch.optim.Adam(n.parameters(), lr=lr, eps=1.5e-4) for n in self.nets]
        self.gamma, self.nstep, self.batch = gamma, nstep, batch
        self.tau = target_tau
        self.prioritized = prioritized
        self.double = double
        self.rng = np.random.default_rng(seed)
        self.demo_margin, self.demo_weight = demo_margin, demo_weight
        self.updates = 0
        # ez-greedy state per stream
        self.opt_left = None
        self.opt_act = None

    # ------------------------------------------------------------------ acting
    @staticmethod
    def _t(loc, glo, vec):
        return (torch.from_numpy(np.asarray(loc, np.float32)), torch.from_numpy(np.asarray(glo, np.float32)),
                torch.from_numpy(np.asarray(vec, np.float32)))

    def greedy(self, loc, glo, vec, can_sit, net_ids):
        N = loc.shape[0]
        acts = np.zeros((N, 3), np.int64)
        with torch.no_grad():
            for k, net in enumerate(self.nets):
                sel = np.nonzero(net_ids == k)[0]
                if len(sel) == 0:
                    continue
                if self.noisy:
                    net.reset_noise()
                q = net(*self._t(loc[sel], glo[sel], vec[sel]))
                if self.head == 'branch':
                    qm = q[0].numpy().copy()
                    qm[~can_sit[sel]] = -1e9
                    acts[sel, 0] = qm.argmax(1)
                    acts[sel, 1] = q[1].numpy().argmax(1)
                    acts[sel, 2] = q[2].numpy().argmax(1)
                else:
                    qf = q.numpy().reshape(-1, *BRANCHES).copy()
                    qf[~can_sit[sel]] = -1e9
                    qf = qf.reshape(len(sel), -1)
                    m, g, l = unflat(qf.argmax(1))
                    acts[sel, 0], acts[sel, 1], acts[sel, 2] = m, g, l
        return acts

    def random_action(self, can_sit, heading):
        """Exploratory joint action: uniform move, gait biased to walking, gaze biased to the
        direction of travel (returned as an absolute gaze direction)."""
        valid = np.nonzero(can_sit)[0]          # can_sit is the (10,) move mask
        mv = int(valid[self.rng.integers(len(valid))])
        gait = int(self.rng.choice(3, p=[0.6, 0.3, 0.1]))
        look = int(self.rng.choice(8, p=[0.4, 0.12, 0.08, 0.04, 0.04, 0.04, 0.08, 0.2]))
        h = mv - 1 if 1 <= mv <= 8 else int(heading)
        return [mv, gait, (h + look) % 8]

    def act(self, loc, glo, vec, can_sit, eps, net_ids, ez=True, ez_mu=2.0, ez_max=16, heading=None):
        N = loc.shape[0]
        acts = self.greedy(loc, glo, vec, can_sit, net_ids)
        if self.opt_left is None or len(self.opt_left) != N:
            self.opt_left = np.zeros(N, np.int64)
            self.opt_act = np.zeros((N, 3), np.int64)
        for i in range(N):
            if self.opt_left[i] > 0:
                a = self.opt_act[i].copy()
                if not can_sit[i][a[0]]:
                    a[0] = 0
                acts[i] = a
                self.opt_left[i] -= 1
            elif self.rng.random() < eps:
                a = self.random_action(can_sit[i], 0 if heading is None else heading[i])
                acts[i] = a
                if ez:
                    dur = int(min(ez_max, self.rng.zipf(ez_mu)))
                    self.opt_left[i] = dur - 1
                    self.opt_act[i] = a
        return acts

    # ------------------------------------------------------------------ learning
    def _q_taken(self, q, a):
        if self.head == 'branch':
            return torch.stack([q[d].gather(1, a[:, d:d + 1]).squeeze(1) for d in range(3)], dim=1)   # (B, 3)
        idx = flat_index(a[:, 0], a[:, 1], a[:, 2])
        return q.gather(1, idx[:, None]).squeeze(1)[:, None]                                     # (B, 1)

    def _target(self, k, nloc, nglo, nvec, ncan):
        net, tgt = self.nets[k], self.targets[k]
        with torch.no_grad():
            if self.noisy:
                tgt.reset_noise()
            qt = tgt(nloc, nglo, nvec)
            qo = net(nloc, nglo, nvec) if self.double else qt
            mask = ~ncan                                 # (B, 10) invalid moves
            if self.head == 'branch':
                vals = []
                for d in range(3):
                    qod = qo[d].clone()
                    if d == 0:
                        qod[mask] = -1e9
                    a = qod.argmax(1, keepdim=True)
                    vals.append(qt[d].gather(1, a).squeeze(1))
                return torch.stack(vals, 1).mean(1)
            qof = qo.clone().view(-1, *BRANCHES)
            qof[mask] = -1e9
            a = qof.view(qo.shape[0], -1).argmax(1, keepdim=True)
            return qt.gather(1, a).squeeze(1)

    def update(self, rb: Replay, k=0, beta=0.4, rb_demo: Replay = None, demo_frac=0.0):
        """One gradient step.  With rb_demo, a fraction demo_frac of the batch is drawn from a permanent
        demonstration buffer (DQfD keeps demonstrations for the whole run)."""
        net, opt = self.nets[k], self.opts[k]
        nd = int(round(self.batch * demo_frac)) if (rb_demo is not None and rb_demo.n > 0) else 0
        if rb.n == 0:
            nd = self.batch
        parts = []
        if self.batch - nd > 0:
            idx, w = rb.sample(self.batch - nd, self.prioritized, beta=beta, net=k if len(self.nets) > 1 else None)
            parts.append((rb, idx, w))
        if nd > 0:
            idd = rb_demo.rng.integers(0, rb_demo.n, nd)
            parts.append((rb_demo, idd, np.ones(nd)))

        def cat(name, f32=False):
            arr = np.concatenate([getattr(b, name)[i] for b, i, _ in parts])
            return torch.from_numpy(arr.astype(np.float32) if f32 else arr)
        loc, glo, vec = cat('loc', True), cat('glo', True), cat('vec')
        nloc, nglo, nvec = cat('nloc', True), cat('nglo', True), cat('nvec')
        a, ret, disc, ncan, demo = cat('act'), cat('ret'), cat('disc'), cat('ncan'), cat('demo')
        wt = torch.from_numpy(np.concatenate([w for _, _, w in parts]).astype(np.float32))
        idx = parts[0][1] if parts[0][0] is rb else None
        y = ret + disc * self._target(k, nloc, nglo, nvec, ncan)
        if self.noisy:
            net.reset_noise()
        q = net(loc, glo, vec)
        qa = self._q_taken(q, a)
        td = qa - y[:, None]
        loss = (Fn.smooth_l1_loss(qa, y[:, None].expand_as(qa), reduction='none').mean(1) * wt).mean()
        if demo.any() and self.demo_weight > 0:
            # DQfD large-margin loss: max_a [Q(s,a) + l(a_E, a)] - Q(s, a_E) on demonstration samples
            if self.head == 'branch':
                ml = 0
                for d in range(3):
                    marg = torch.full_like(q[d], self.demo_margin)
                    marg.scatter_(1, a[:, d:d + 1], 0.0)
                    ml = ml + ((q[d] + marg).max(1).values - q[d].gather(1, a[:, d:d + 1]).squeeze(1))
                ml = ml / 3
            else:
                marg = torch.full_like(q, self.demo_margin)
                ai = flat_index(a[:, 0], a[:, 1], a[:, 2])[:, None]
                marg.scatter_(1, ai, 0.0)
                ml = (q + marg).max(1).values - q.gather(1, ai).squeeze(1)
            loss = loss + self.demo_weight * (ml * demo.float()).sum() / demo.float().sum().clamp(min=1)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 10.0)
        opt.step()
        with torch.no_grad():
            for p_, pt in zip(net.parameters(), self.targets[k].parameters()):
                pt.mul_(1 - self.tau).add_(p_, alpha=self.tau)
        if self.prioritized and idx is not None:
            rb.update_prio(idx, td.detach().abs().mean(1).numpy()[:len(idx)])
        self.updates += 1
        return float(loss.item()), float(qa.mean().item())

    # ------------------------------------------------------------------ io
    def state_dict(self):
        return {'head': self.head, 'noisy': self.noisy, 'nets': [n.state_dict() for n in self.nets]}

    def load_nets(self, sd, mapping=None):
        """Load network weights; mapping[k] = index of the source network for net k (replication)."""
        src = sd['nets']
        for k, net in enumerate(self.nets):
            j = mapping[k] if mapping is not None else min(k, len(src) - 1)
            if j is None or j < 0:          # keep this network naive (random initialisation)
                continue
            net.load_state_dict(src[j])
            self.targets[k].load_state_dict(src[j])
