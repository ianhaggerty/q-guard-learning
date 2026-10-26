// Map scale and sizes shared by several modules. Units are map pixels unless noted.

/** Edit cell size: materials, brushes, stairs and chairs all snap to 3 × 3 pixel blocks. */
export const GRID = 3;

/** One grid block is half a metre across, so one pixel is 1/6 m. */
export const METRES_PER_PIXEL = 0.5 / GRID;

/** Explorer body radius. Passages must be at least 3 px wide. */
export const EXPLORER_RADIUS = 1.1;

/** Thickness of the transparent rails generated around stairs (matches the layouts' 3 px walls). */
export const WALL_THICKNESS = 3;

/** A chair occupies one grid block: 0.5 × 0.5 m. */
export const CHAIR_SIZE = GRID;
