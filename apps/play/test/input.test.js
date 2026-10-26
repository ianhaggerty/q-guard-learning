// Turning key presses into the input messages the room server expects.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Intent } from '../js/input.js';

test('held movement keys combine into one direction and report only real changes', () => {
  const intent = new Intent();
  assert.equal(intent.press('w'), 'input');
  assert.equal(intent.press('w'), null, 'key repeat');
  assert.equal(intent.press('ArrowRight'), 'input');
  assert.deepEqual(intent.move, [1, -1]);
  assert.equal(intent.press('s'), 'input');
  assert.deepEqual(intent.move, [1, 0], 'up and down cancel');
  assert.equal(intent.release('W'), 'input');
  assert.deepEqual(intent.move, [1, 1]);
  assert.equal(intent.release('q'), null);
  assert.equal(intent.releaseAll(), 'input');
  assert.deepEqual(intent.move, [0, 0]);
});

test('look, gait and sit keys', () => {
  const intent = new Intent();
  assert.equal(intent.press(','), 'input');
  assert.equal(intent.look, 'back');
  assert.equal(intent.press('b'), null, 'already looking back');
  assert.equal(intent.press('3'), 'input');
  assert.equal(intent.gait, 'sprint');
  assert.equal(intent.press('e'), 'sit');
  assert.equal(intent.press('z'), null);
  assert.deepEqual(intent.message(), { type: 'input', move: [0, 0], gait: 'sprint', look: 'back' });
});
