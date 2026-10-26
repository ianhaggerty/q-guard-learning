// Keyboard input for a room, with the same keys as Explore mode: WASD or arrows to move,
// the keys around K to look (F, Q, X and B too), E to sit or stand, and 1-3 for walk,
// run and sprint. The room server only needs to hear about changes.

export const MOVEMENT_KEYS = {
  w: [0, -1], arrowup: [0, -1],
  s: [0, 1], arrowdown: [0, 1],
  a: [-1, 0], arrowleft: [-1, 0],
  d: [1, 0], arrowright: [1, 0],
};

export const LOOK_KEYS = {
  u: 'forward-left', i: 'forward', o: 'forward-right',
  j: 'left', l: 'right',
  m: 'back-left', ',': 'back', '.': 'back-right',
  f: 'forward', q: 'left', x: 'right', b: 'back',
};

export const GAIT_KEYS = { 1: 'walk', 2: 'run', 3: 'sprint' };

/** What the explorer wants to do: { move: [dx, dy], gait, look }, updated from key events. */
export class Intent {
  constructor() {
    this.held = new Set();
    this.gait = 'walk';
    this.look = 'forward';
  }

  /** The direction of travel from the held keys, each component -1, 0 or 1. */
  get move() {
    let dx = 0, dy = 0;
    for (const key of this.held) {
      dx += MOVEMENT_KEYS[key][0];
      dy += MOVEMENT_KEYS[key][1];
    }
    return [Math.sign(dx), Math.sign(dy)];
  }

  /** The message describing this intent. */
  message() {
    return { type: 'input', move: this.move, gait: this.gait, look: this.look };
  }

  /** Apply a key press. Returns 'input' if the intent changed, 'sit' for the sit key, else null. */
  press(key) {
    key = key.toLowerCase();
    if (Object.hasOwn(MOVEMENT_KEYS, key)) {
      if (this.held.has(key)) return null;
      this.held.add(key);
      return 'input';
    }
    if (Object.hasOwn(LOOK_KEYS, key)) return this.set('look', LOOK_KEYS[key]);
    if (Object.hasOwn(GAIT_KEYS, key)) return this.set('gait', GAIT_KEYS[key]);
    return key === 'e' ? 'sit' : null;
  }

  /** Apply a key release. Returns 'input' if the intent changed, else null. */
  release(key) {
    return this.held.delete(key.toLowerCase()) ? 'input' : null;
  }

  /** Let go of every key (the window lost focus). Returns 'input' if the intent changed. */
  releaseAll() {
    if (!this.held.size) return null;
    this.held.clear();
    return 'input';
  }

  set(field, value) {
    if (this[field] === value) return null;
    this[field] = value;
    return 'input';
  }
}
