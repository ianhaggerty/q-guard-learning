// The four pixel materials. Every floor stores one material value per pixel.
//
//   value  material          movement            sight
//   0      floor             allowed             allowed
//   1      opaque mass       blocked             blocked
//   2      transparent mass  blocked             allowed
//   3      opaque door       allowed while open  allowed while open

export const MATERIAL = Object.freeze({ FLOOR: 0, OPAQUE: 1, TRANSPARENT: 2, DOOR: 3 });

/** Material names written to saved JSON, indexed by material value. */
export const MATERIAL_NAMES = Object.freeze(['floor', 'opaque', 'transparent', 'opaque-door']);

/** Display and PNG colours, indexed by material value. */
export const COLORS = Object.freeze(['#F6F3E9', '#263D36', '#78C6C0', '#DDA457']);

/** COLORS as [r, g, b] triples. */
export const RGB = Object.freeze(COLORS.map(hexToRgb));

/** Floor, opaque and transparent colours used by the first version of the editor. */
const LEGACY_RGB = [[255, 255, 255], [32, 40, 48], [0, 188, 212]];

function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

/** RGBA image data of the active floor, using exactly the four material colours. */
export function toRGBA(map) {
  const { pixels } = map;
  const data = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    data.set(RGB[pixels[i]], i * 4);
    data[i * 4 + 3] = 255;
  }
  return data;
}

/**
 * Convert RGBA image data back to materials. Mostly transparent pixels become floor,
 * current and legacy palette colours map exactly, and any other colour snaps to the
 * nearest material colour. Returns the materials and how many pixels needed snapping.
 */
export function materialsFromRGBA(rgba) {
  const pixels = new Uint8Array(rgba.length / 4);
  let unknownColors = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (rgba[i * 4 + 3] < 128) {
      pixels[i] = MATERIAL.FLOOR;
      continue;
    }
    const rgb = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    const exact = RGB.findIndex(color => sameColor(color, rgb));
    const legacy = LEGACY_RGB.findIndex(color => sameColor(color, rgb));
    if (exact >= 0) pixels[i] = exact;
    else if (legacy >= 0) pixels[i] = legacy;
    else {
      unknownColors++;
      pixels[i] = nearestMaterial(rgb);
    }
  }
  return { pixels, unknownColors };
}

function sameColor(a, b) {
  return a.every((channel, i) => channel === b[i]);
}

function nearestMaterial(rgb) {
  let best = Infinity, chosen = 0;
  RGB.forEach((color, material) => {
    const distance = color.reduce((sum, channel, i) => sum + (channel - rgb[i]) ** 2, 0);
    if (distance < best) {
      best = distance;
      chosen = material;
    }
  });
  return chosen;
}
