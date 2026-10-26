// Room snapshots arrive ten times a second. Drawing them as they come would make explorers
// jump, so the client draws the room a little in the past, blending the two snapshots on
// either side of that moment.

/** How far behind the newest snapshot the room is drawn, in milliseconds. */
export const RENDER_DELAY_MS = 150;

/** Snapshots kept; at ten a second this is well past RENDER_DELAY_MS. */
const KEEP = 8;

export class SnapshotBuffer {
  constructor(delayMs = RENDER_DELAY_MS) {
    this.delayMs = delayMs;
    this.entries = []; // { at, snapshot }, oldest first
  }

  push(snapshot, at) {
    this.entries.push({ at, snapshot });
    if (this.entries.length > KEEP) this.entries.shift();
  }

  get latest() {
    return this.entries.at(-1)?.snapshot ?? null;
  }

  /**
   * The explorers as they were `delayMs` before `now`: positions blended between the two
   * surrounding snapshots, everything else taken from the later one. An explorer who
   * changed floor, or appears in only one snapshot, is drawn where the later one has it.
   */
  explorersAt(now) {
    const { entries } = this, target = now - this.delayMs;
    if (!entries.length) return [];
    let after = entries.findIndex(entry => entry.at >= target);
    if (after === -1) return entries.at(-1).snapshot.explorers;
    if (after === 0) return entries[0].snapshot.explorers;
    const a = entries[after - 1], b = entries[after];
    const t = (target - a.at) / Math.max(1, b.at - a.at);
    const previous = new Map(a.snapshot.explorers.map(explorer => [explorer.id, explorer]));
    return b.snapshot.explorers.map(explorer => {
      const before = previous.get(explorer.id);
      if (!before || before.floor !== explorer.floor) return explorer;
      return { ...explorer, x: before.x + (explorer.x - before.x) * t, y: before.y + (explorer.y - before.y) * t };
    });
  }
}
