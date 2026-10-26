"""Cold-start floor plans: a hand-designed curriculum (C01-C07) and procedurally generated
plans (R00-R..) used for multi-plan pre-training (domain randomisation).

Each plan is written as a raw spec and then passed through maps/build_plan.mjs, which uses
the editor's own core to rasterise stairs and validate chairs / starts, so every file opens
in Pixel Map Lab.  usage: python maps/generate_curriculum.py [n_random]
"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CORE = os.path.join(os.path.dirname(ROOT), 'packages', 'core', 'src')
RUNTIME = shutil.which('node') or shutil.which('bun')
FLOOR, OPAQUE, TRANSPARENT, DOOR = 0, 1, 2, 3


class Canvas:
    def __init__(self, w, h, floors=1, name='plan'):
        assert w % 3 == 0 and h % 3 == 0
        self.w, self.h, self.name = w, h, name
        self.px = np.zeros((floors, h, w), np.uint8)
        self.val = [dict() for _ in range(floors)]
        self.chairs, self.stairs, self.starts = [], [], []

    def rect(self, x, y, w, h, m, f=0):
        self.px[f, max(0, y):y + h, max(0, x):x + w] = m

    def border(self, f=0, t=3, m=OPAQUE):
        self.rect(0, 0, self.w, t, m, f); self.rect(0, self.h - t, self.w, t, m, f)
        self.rect(0, 0, t, self.h, m, f); self.rect(self.w - t, 0, t, self.h, m, f)

    def value(self, x, y, w, h, v, f=0):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.val[f][str(yy * self.w + xx)] = v

    def chair(self, x, y, rot, f=0):
        self.chairs.append({'id': f'C{len(self.chairs)}{x}{y}', 'x': x, 'y': y, 'floor': f, 'rotation': rot})

    def start(self, x, y, f=0):
        self.starts.append({'x': x + 0.5, 'y': y + 0.5, 'floor': f})

    def spec(self):
        return {'width': self.w, 'height': self.h, 'name': self.name,
                'floors': [{'name': f'Floor {i + 1}', 'pixels': self.px[i].reshape(-1).tolist(),
                            'valueOverrides': self.val[i]} for i in range(self.px.shape[0])],
                'chairs': self.chairs, 'stairs': self.stairs, 'starts': self.starts}


def build(c: Canvas, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join('/tmp', f'_spec_{os.getpid()}.json')
    json.dump(c.spec(), open(tmp, 'w'))
    out = os.path.join(out_dir, c.name + '.json')
    r = subprocess.run([RUNTIME, os.path.join(HERE, 'build_plan.mjs'), CORE, tmp, out], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout, r.stderr)
        return None
    print(r.stdout.strip(), r.stderr.strip())
    return out


def hand_curriculum(out_dir):
    paths = []
    c = Canvas(48, 48, name='C01 Open Room'); c.border(); c.start(23, 23); paths.append(build(c, out_dir))
    c = Canvas(96, 24, name='C02 Long Hall'); c.border(); c.chair(87, 9, 180); c.start(47, 11); paths.append(build(c, out_dir))
    c = Canvas(72, 72, name='C03 Ring'); c.border(); c.rect(21, 21, 30, 30, OPAQUE); c.start(10, 35); c.start(61, 35); paths.append(build(c, out_dir))
    c = Canvas(90, 48, name='C04 Two Rooms'); c.border(); c.rect(45, 0, 3, 48, OPAQUE); c.rect(45, 18, 3, 6, DOOR)
    c.rect(45, 33, 3, 6, TRANSPARENT); c.chair(3, 21, 0); c.start(20, 23); c.start(68, 23); paths.append(build(c, out_dir))
    c = Canvas(90, 39, name='C05 Cell Row'); c.border()
    for k in range(4):
        x0 = 3 + k * 21
        c.rect(x0 + 18, 0, 3, 21, OPAQUE)
        c.rect(x0, 18, 21, 3, OPAQUE); c.rect(x0 + 6, 18, 6, 3, DOOR)
        c.rect(x0 + 3, 6, 3, 3, TRANSPARENT); c.value(x0 + 3, 6, 3, 3, 30)
    c.chair(84, 27, 180); c.start(10, 29); c.start(70, 29); paths.append(build(c, out_dir))
    c = Canvas(96, 96, name='C06 Gallery'); c.border(); c.rect(45, 0, 3, 96, OPAQUE); c.rect(0, 45, 96, 3, OPAQUE)
    c.rect(45, 18, 3, 9, FLOOR); c.rect(45, 69, 3, 9, FLOOR); c.rect(18, 45, 9, 3, FLOOR); c.rect(69, 45, 9, 3, FLOOR)
    for (x, y) in ((18, 18), (66, 66)):
        c.rect(x, y, 9, 3, TRANSPARENT); c.value(x, y, 9, 3, 20)
    c.chair(3, 3, 0); c.start(30, 30); c.start(66, 30); paths.append(build(c, out_dir))
    c = Canvas(78, 48, floors=2, name='C07 Two Storey')
    for f in range(2):
        c.border(f)
    c.stairs.append({'id': 'S1', 'type': 'straight', 'x': 21, 'y': 18, 'length': 36, 'width': 9, 'rotation': 0, 'lower': 0, 'upper': 1})
    c.rect(66, 30, 6, 6, TRANSPARENT, 1); c.value(66, 30, 6, 6, 20, 1)
    c.start(9, 9, 0); c.start(66, 9, 1); paths.append(build(c, out_dir))
    return [p for p in paths if p]


def bsp_rooms(rng, x, y, w, h, depth, rooms, min_size=27):
    if depth == 0 or (w < 2 * min_size and h < 2 * min_size):
        rooms.append((x, y, w, h))
        return [], rooms
    walls = []
    vertical = w > h if abs(w - h) > 9 else rng.random() < 0.5
    if vertical and w >= 2 * min_size:
        cut = x + 3 * rng.integers(min_size // 3, (w - min_size) // 3 + 1)
        walls.append(('v', cut, y, h))
        bsp_rooms(rng, x, y, cut - x, h, depth - 1, rooms)
        bsp_rooms(rng, cut + 3, y, x + w - cut - 3, h, depth - 1, rooms)
    elif h >= 2 * min_size:
        cut = y + 3 * rng.integers(min_size // 3, (h - min_size) // 3 + 1)
        walls.append(('h', cut, x, w))
        bsp_rooms(rng, x, y, w, cut - y, depth - 1, rooms)
        bsp_rooms(rng, x, cut + 3, w, y + h - cut - 3, depth - 1, rooms)
    else:
        rooms.append((x, y, w, h))
    return walls, rooms


def random_plan(rng, k, out_dir):
    W = 3 * int(rng.integers(20, 51))
    H = 3 * int(rng.integers(12, 43))
    floors = 2 if (rng.random() < 0.25 and W >= 78 and H >= 45) else 1
    c = Canvas(W, H, floors, name=f'R{k:02d} Random')
    for f in range(floors):
        c.border(f)
        rooms = []
        # recursive split into rooms, each partition wall gets 1-2 openings (gap, door or window)
        stack = [(3, 3, W - 6, H - 6, int(rng.integers(1, 4)))]
        while stack:
            x, y, w, h, d = stack.pop()
            if d == 0 or (w < 54 and h < 54):
                rooms.append((x, y, w, h)); continue
            if (w >= h and w >= 54) or h < 54:
                cut = x + 3 * int(rng.integers(9, (w - 27) // 3 + 1))
                c.rect(cut, y, 3, h, OPAQUE, f)
                for _ in range(int(rng.integers(1, 3))):
                    oy = y + 3 * int(rng.integers(0, max(1, (h - 9) // 3)))
                    m = rng.choice([FLOOR, FLOOR, DOOR, TRANSPARENT])
                    c.rect(cut, oy, 3, 9 if m == FLOOR else 6, m, f)
                    if m == TRANSPARENT:
                        oy2 = y + 3 * int(rng.integers(0, max(1, (h - 9) // 3)))
                        c.rect(cut, oy2, 3, 9, FLOOR, f)
                stack += [(x, y, cut - x, h, d - 1), (cut + 3, y, x + w - cut - 3, h, d - 1)]
            else:
                cut = y + 3 * int(rng.integers(9, (h - 27) // 3 + 1))
                c.rect(x, cut, w, 3, OPAQUE, f)
                for _ in range(int(rng.integers(1, 3))):
                    ox = x + 3 * int(rng.integers(0, max(1, (w - 9) // 3)))
                    m = rng.choice([FLOOR, FLOOR, DOOR, TRANSPARENT])
                    c.rect(ox, cut, 9 if m == FLOOR else 6, 3, m, f)
                    if m == TRANSPARENT:
                        ox2 = x + 3 * int(rng.integers(0, max(1, (w - 9) // 3)))
                        c.rect(ox2, cut, 9, 3, FLOOR, f)
                stack += [(x, y, w, cut - y, d - 1), (x, cut + 3, w, y + h - cut - 3, d - 1)]
        # furniture: pillars, display cases with value, beds (opaque with value)
        for (x, y, w, h) in rooms:
            for _ in range(int(rng.integers(0, 3))):
                ow, oh = 3 * int(rng.integers(1, 4)), 3 * int(rng.integers(1, 3))
                if w - ow - 12 < 3 or h - oh - 12 < 3:
                    continue
                ox = x + 6 + 3 * int(rng.integers(0, (w - ow - 12) // 3 + 1))
                oy = y + 6 + 3 * int(rng.integers(0, (h - oh - 12) // 3 + 1))
                m = rng.choice([OPAQUE, TRANSPARENT])
                c.rect(ox, oy, ow, oh, m, f)
                if rng.random() < 0.5:
                    c.value(ox, oy, ow, oh, float(rng.choice([10, 20, 30, 50])), f)
            if rng.random() < 0.15:
                c.value(x, y, w, h, 0.0, f)          # an unimportant room
        # chairs against a wall, facing into the room
        for _ in range(int(rng.integers(0, 3))):
            x, y, w, h = rooms[int(rng.integers(len(rooms)))]
            side = int(rng.integers(4))
            if side == 0:
                c.chair(x, y + 3 * int(rng.integers(1, max(2, h // 3 - 1))), 0, f)
            elif side == 1:
                c.chair(x + w - 3, y + 3 * int(rng.integers(1, max(2, h // 3 - 1))), 180, f)
            elif side == 2:
                c.chair(x + 3 * int(rng.integers(1, max(2, w // 3 - 1))), y, 90, f)
            else:
                c.chair(x + 3 * int(rng.integers(1, max(2, w // 3 - 1))), y + h - 3, 270, f)
    if floors == 2:
        sx, sy = 3 * int(rng.integers(3, (W - 45) // 3)), 3 * int(rng.integers(3, (H - 15) // 3))
        for f in range(2):
            c.rect(sx - 12, sy - 6, 63, 21, FLOOR, f)
        c.stairs.append({'id': 'S1', 'type': 'straight', 'x': sx, 'y': sy, 'length': 36, 'width': 9,
                         'rotation': 0, 'lower': 0, 'upper': 1})
    # starts: 1-3 random clear spots
    for _ in range(3):
        for _try in range(200):
            f = int(rng.integers(floors))
            x, y = 3 * int(rng.integers(2, W // 3 - 2)) + 1, 3 * int(rng.integers(2, H // 3 - 2)) + 1
            if (c.px[f, y - 3:y + 4, x - 3:x + 4] == FLOOR).all():
                c.start(x, y, f)
                break
    return build(c, out_dir)


if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 24
    out = os.path.join(ROOT, 'plans_curriculum')
    hand_curriculum(out)
    rng = np.random.default_rng(7)
    for k in range(n):
        random_plan(rng, k, out)
