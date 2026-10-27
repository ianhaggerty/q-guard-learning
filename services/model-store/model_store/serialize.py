"""Bytes for models and demonstrations, and back.

Models are Agent.state_dict()s saved with torch.save and loaded with weights_only=True, so
a stored model cannot run code. Demonstrations are compressed .npz archives of arrays over
the demonstrations of one chunk (see DEMO_FIELDS)."""
import io

import numpy as np
import torch

#: Arrays in a demonstration chunk, one row per 0.5 s of a player's play: the observation
#: (loc, glo, vec), valid moves (mask), action [move, gait, gaze], the interval's detection
#: credit and energy (kcal), and episode/step, which link each row to the next.
DEMO_FIELDS = ('loc', 'glo', 'vec', 'mask', 'act', 'credit', 'kcal', 'episode', 'step')


def model_bytes(state_dict):
    buffer = io.BytesIO()
    torch.save(state_dict, buffer)
    return buffer.getvalue()


def load_model(data):
    return torch.load(io.BytesIO(data), map_location='cpu', weights_only=True)


def demos_bytes(demos):
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **{field: np.asarray(demos[field]) for field in DEMO_FIELDS})
    return buffer.getvalue()


def load_demos(data):
    with np.load(io.BytesIO(data)) as archive:
        return {field: archive[field] for field in DEMO_FIELDS}


def concat_demos(chunks):
    """One set of demonstrations from several chunks (empty arrays for none)."""
    if not chunks:
        return empty_demos()
    return {field: np.concatenate([chunk[field] for chunk in chunks]) for field in DEMO_FIELDS}


def empty_demos():
    from guardrl.obs import C_G, C_L, GG, L, N_V
    shapes = {'loc': (0, C_L, L, L), 'glo': (0, C_G, GG, GG), 'vec': (0, N_V), 'mask': (0, 10), 'act': (0, 3)}
    dtypes = {'loc': np.float16, 'glo': np.float16, 'vec': np.float32, 'mask': bool, 'act': np.int64,
              'credit': np.float32, 'kcal': np.float32, 'episode': np.int64, 'step': np.int64}
    return {field: np.zeros(shapes.get(field, (0,)), dtypes[field]) for field in DEMO_FIELDS}
