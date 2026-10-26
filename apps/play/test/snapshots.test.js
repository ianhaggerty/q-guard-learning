// Drawing the room slightly in the past, blended between snapshots.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer } from '../js/snapshots.js';

const snapshot = explorers => ({ type: 'state', explorers });
const explorer = (id, x, y, floor = 0) => ({ id, x, y, floor, facing: 0 });

test('positions are blended between the snapshots either side of the render time', () => {
  const buffer = new SnapshotBuffer(100);
  buffer.push(snapshot([explorer('a', 0, 0)]), 1000);
  buffer.push(snapshot([explorer('a', 10, 20)]), 1100);
  const [a] = buffer.explorersAt(1150); // render time 1050: halfway
  assert.deepEqual([a.x, a.y], [5, 10]);
});

test('before the first snapshot or after the last, the nearest snapshot is drawn as is', () => {
  const buffer = new SnapshotBuffer(100);
  assert.deepEqual(buffer.explorersAt(0), []);
  buffer.push(snapshot([explorer('a', 1, 1)]), 1000);
  buffer.push(snapshot([explorer('a', 3, 3)]), 1100);
  assert.equal(buffer.explorersAt(1000)[0].x, 1);
  assert.equal(buffer.explorersAt(5000)[0].x, 3);
  assert.equal(buffer.latest.explorers[0].x, 3);
});

test('explorers who just joined or changed floor are not blended', () => {
  const buffer = new SnapshotBuffer(100);
  buffer.push(snapshot([explorer('a', 0, 0)]), 1000);
  buffer.push(snapshot([explorer('a', 10, 0, 1), explorer('b', 4, 4)]), 1100);
  const [a, b] = buffer.explorersAt(1150);
  assert.deepEqual([a.x, a.floor], [10, 1]);
  assert.deepEqual([b.x, b.y], [4, 4]);
});

test('only the most recent snapshots are kept', () => {
  const buffer = new SnapshotBuffer(100);
  for (let k = 0; k < 20; k++) buffer.push(snapshot([explorer('a', k, 0)]), 1000 + 100 * k);
  assert.ok(buffer.entries.length <= 8);
  assert.equal(buffer.latest.explorers[0].x, 19);
});
