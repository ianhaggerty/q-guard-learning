// Low-level operations on row-major pixel arrays (one byte per pixel).

/** Fill a w × h rectangle with `value`, clipped to the array bounds. */
export function fillRect(pixels, width, height, x, y, w, h, value) {
  for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
    for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) pixels[row * width + col] = value;
  }
}

/** Indices of the edge-adjacent (4-connected) neighbours of a pixel. */
export function neighbours(index, width, height) {
  const x = index % width, y = Math.floor(index / width), result = [];
  if (x > 0) result.push(index - 1);
  if (x < width - 1) result.push(index + 1);
  if (y > 0) result.push(index - width);
  if (y < height - 1) result.push(index + width);
  return result;
}

/** Replace the 4-connected region of identical pixels around (x, y) with `value`. */
export function floodFill(pixels, width, height, x, y, value) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const start = y * width + x, target = pixels[start];
  if (target === value) return;
  pixels[start] = value;
  const stack = [start];
  while (stack.length) {
    for (const next of neighbours(stack.pop(), width, height)) {
      if (pixels[next] !== target) continue;
      pixels[next] = value;
      stack.push(next);
    }
  }
}

/**
 * Visit every pixel on the Bresenham line from a to b, both endpoints included.
 * Returning `false` from `visit` stops the walk early; traceLine then returns false.
 */
export function traceLine(a, b, visit) {
  let x = a.x, y = a.y;
  const dx = Math.abs(b.x - x), stepX = x < b.x ? 1 : -1;
  const dy = -Math.abs(b.y - y), stepY = y < b.y ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    if (visit(x, y) === false) return false;
    if (x === b.x && y === b.y) return true;
    const doubled = error * 2;
    if (doubled >= dy) {
      error += dy;
      x += stepX;
    }
    if (doubled <= dx) {
      error += dx;
      y += stepY;
    }
  }
}
