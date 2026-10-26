"""Q-networks.  A shared encoder (local CNN + global CNN + vector MLP) feeds either
  * a branching dueling head (BDQ, Tavakoli et al. 2018): Q_d(s, a_d) = V(s) + A_d(s, a_d) - mean A_d
    for the three action branches  move(10: stay, 8 headings, sit) | gait(3) | look(8); or
  * a flat dueling head over the 240 joint actions (move x gait x look).
Optional NoisyNet linear layers (Fortunato et al. 2018) for parameter-space exploration.
"""
import math
import torch
import torch.nn as nn
import torch.nn.functional as Fn

from .obs import C_L, C_G, N_V, L, GG

BRANCHES = (10, 3, 8)
N_FLAT = BRANCHES[0] * BRANCHES[1] * BRANCHES[2]


class NoisyLinear(nn.Module):
    def __init__(self, n_in, n_out, sigma0=0.5):
        super().__init__()
        self.n_in, self.n_out = n_in, n_out
        self.w_mu = nn.Parameter(torch.empty(n_out, n_in))
        self.w_sigma = nn.Parameter(torch.empty(n_out, n_in))
        self.b_mu = nn.Parameter(torch.empty(n_out))
        self.b_sigma = nn.Parameter(torch.empty(n_out))
        bound = 1 / math.sqrt(n_in)
        nn.init.uniform_(self.w_mu, -bound, bound)
        nn.init.uniform_(self.b_mu, -bound, bound)
        nn.init.constant_(self.w_sigma, sigma0 / math.sqrt(n_in))
        nn.init.constant_(self.b_sigma, sigma0 / math.sqrt(n_in))
        self.register_buffer('eps_in', torch.zeros(n_in))
        self.register_buffer('eps_out', torch.zeros(n_out))
        self.noise_on = True

    @staticmethod
    def _f(x):
        return x.sign() * x.abs().sqrt()

    def reset_noise(self):
        self.eps_in.copy_(self._f(torch.randn(self.n_in)))
        self.eps_out.copy_(self._f(torch.randn(self.n_out)))

    def forward(self, x):
        if self.noise_on:
            w = self.w_mu + self.w_sigma * torch.outer(self.eps_out, self.eps_in)
            b = self.b_mu + self.b_sigma * self.eps_out
            return Fn.linear(x, w, b)
        return Fn.linear(x, self.w_mu, self.b_mu)


class Encoder(nn.Module):
    def __init__(self, width=256):
        super().__init__()
        self.loc = nn.Sequential(
            nn.Conv2d(C_L, 32, 3, stride=2, padding=1), nn.ReLU(),     # 13x13
            nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.ReLU(),      # 7x7
            nn.Conv2d(64, 64, 3, stride=1, padding=1), nn.ReLU(),      # 7x7
            nn.Flatten(), nn.Linear(64 * 7 * 7, width), nn.ReLU())
        self.glo = nn.Sequential(
            nn.Conv2d(C_G, 32, 3, stride=2, padding=1), nn.ReLU(),     # 8x8
            nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.ReLU(),      # 4x4
            nn.Flatten(), nn.Linear(64 * 4 * 4, 128), nn.ReLU())
        self.vec = nn.Sequential(nn.Linear(N_V, 64), nn.ReLU())
        self.out_dim = width + 128 + 64

    def forward(self, loc, glo, vec):
        return torch.cat([self.loc(loc), self.glo(glo), self.vec(vec)], dim=1)


class QNet(nn.Module):
    def __init__(self, head='branch', noisy=False, width=256):
        super().__init__()
        self.head_type = head
        self.enc = Encoder(width)
        Lin = NoisyLinear if noisy else nn.Linear
        d = self.enc.out_dim
        self.noisy = noisy
        self.v = nn.Sequential(nn.Linear(d, 256), nn.ReLU(), Lin(256, 1))
        if head == 'branch':
            self.adv = nn.ModuleList([nn.Sequential(nn.Linear(d, 256), nn.ReLU(), Lin(256, n)) for n in BRANCHES])
        else:
            self.adv = nn.Sequential(nn.Linear(d, 512), nn.ReLU(), Lin(512, N_FLAT))

    def reset_noise(self):
        for m in self.modules():
            if isinstance(m, NoisyLinear):
                m.reset_noise()

    def set_noise(self, on):
        for m in self.modules():
            if isinstance(m, NoisyLinear):
                m.noise_on = on

    def forward(self, loc, glo, vec):
        h = self.enc(loc, glo, vec)
        v = self.v(h)
        if self.head_type == 'branch':
            out = []
            for a in self.adv:
                adv = a(h)
                out.append(v + adv - adv.mean(dim=1, keepdim=True))
            return out          # list of (B, n_d)
        adv = self.adv(h)
        return v + adv - adv.mean(dim=1, keepdim=True)   # (B, 240)


def flat_index(move, gait, look):
    return (move * BRANCHES[1] + gait) * BRANCHES[2] + look


def unflat(idx):
    look = idx % BRANCHES[2]
    gait = (idx // BRANCHES[2]) % BRANCHES[1]
    move = idx // (BRANCHES[1] * BRANCHES[2])
    return move, gait, look
