// The plans rooms are created from.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlans } from '../src/plans.js';

test('the seven shipped plans load in number order with their names', () => {
  const plans = loadPlans();
  assert.deepEqual(plans.map(plan => plan.id), ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(plans.map(plan => plan.name).slice(0, 2), ['Simple Corridor', 'Simple Centre']);
  assert.equal(plans[0].saved.format, 'pixel-map-lab');
});

test('files that are not numbered plans are ignored, and a broken plan stops start-up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plans-'));
  writeFileSync(join(dir, 'index.json'), '{}');
  assert.throws(() => loadPlans(dir), /No numbered plans/);
  writeFileSync(join(dir, '1. Broken.json'), JSON.stringify({ format: 'pixel-map-lab', version: 2 }));
  assert.throws(() => loadPlans(dir));
});
