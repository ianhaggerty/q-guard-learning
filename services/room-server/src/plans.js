// The maps rooms can be created from: the hand-made plans shipped with the web client
// ("1. Simple Corridor.json" ... "7. Alcatraz.json"). Each is validated once at start-up
// with the core's own decoder, so a room can never be created from a broken file.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMap } from '@pixel-map-lab/core';

/** Where the plans live in the repository; containers set PLANS_DIR instead. */
export const DEFAULT_PLANS_DIR = fileURLToPath(new URL('../../../apps/web/plans/', import.meta.url));

/** A numbered plan file name: "3. Two Chair Square.json" → id "3", name "Two Chair Square". */
const PLAN_FILE = /^(\d+)\.\s*(.+)\.json$/;

/**
 * The numbered plans in `dir`, in number order: [{ id, name, saved }], where `saved` is the
 * file's parsed JSON, sent to clients as is and decoded afresh for every room.
 */
export function loadPlans(dir = DEFAULT_PLANS_DIR) {
  const plans = [];
  for (const file of readdirSync(dir)) {
    const match = PLAN_FILE.exec(file);
    if (!match) continue;
    const saved = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    decodeMap(saved);
    plans.push({ id: match[1], name: match[2], saved });
  }
  if (!plans.length) throw new Error(`No numbered plans found in ${dir}.`);
  return plans.sort((a, b) => Number(a.id) - Number(b.id));
}
