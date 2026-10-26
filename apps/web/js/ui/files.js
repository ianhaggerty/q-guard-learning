// New blank maps, JSON/PNG export and import, and the Export and Help dialogs.

import {
  GRID, MAX_MAP_SIZE, MIN_MAP_SIZE, World, createBlankMap, decodeMap, encodeMap, materialsFromRGBA, normalizeMap, toRGBA,
} from '@pixel-map-lab/core';
import { state, isExploring } from './state.js';
import { byId, toast } from './dom.js';
import { loadMap } from './document.js';
import { setMode } from './explore/session.js';
import { resetInput } from './explore/controls.js';

const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
/** Larger images are scaled down to fit within this many pixels. */
const MAX_IMPORT_PIXELS = 512;
const MIN_BLANK_SIZE = 18;

function startBlankMap() {
  const width = Number(byId('mapWidth').value), height = Number(byId('mapHeight').value);
  const valid = [width, height].every(n => Number.isInteger(n) && n >= MIN_BLANK_SIZE && n <= MAX_MAP_SIZE && n % GRID === 0);
  if (!valid) {
    toast('Use multiples of 3 between 18 and 513 pixels.');
    return;
  }
  if (!confirm('Start a blank map? You can undo this change.')) return;
  loadMap(createBlankMap(width, height));
  toast('A blank canvas. Make it yours.');
}

// ---------------------------------------------------------------------------
// Export

function fileBaseName() {
  return state.map.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pixel-map';
}

function download(blob, name) {
  const link = document.createElement('a'), url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportJSON() {
  download(new Blob([JSON.stringify(encodeMap(state.map))], { type: 'application/json' }), fileBaseName() + '.json');
  toast('Exported every floor, stair and pixel.');
}

/** The active floor's materials at one image pixel per map pixel. */
function exportPNG() {
  const { map } = state, canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const context = canvas.getContext('2d'), image = context.createImageData(map.width, map.height);
  image.data.set(toRGBA(map));
  context.putImageData(image, 0, 0);
  canvas.toBlob(blob => {
    if (blob) download(blob, `${fileBaseName()}-floor-${map.activeFloor + 1}.png`);
  }, 'image/png');
  toast('Exported this floor. Use JSON to keep the whole building and stair links.');
}

// ---------------------------------------------------------------------------
// Import

async function importFile(file) {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('Choose a map smaller than 12 MB.');
  if (file.name.toLowerCase().endsWith('.json')) {
    loadMap(decodeMap(JSON.parse(await file.text())));
    toast('Map imported.');
    return;
  }
  await importImage(file);
}

/** A palette PNG becomes a single-floor map; other colours snap to the nearest material after confirmation. */
async function importImage(file) {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width, height = bitmap.height;
  if (width < MIN_MAP_SIZE || height < MIN_MAP_SIZE) throw new Error('Use an image at least 16 × 16 pixels.');
  if (width > MAX_IMPORT_PIXELS || height > MAX_IMPORT_PIXELS) {
    if (!confirm(`This image is ${width} × ${height}. Resize it to fit within 512 × 512 pixels?`)) {
      bitmap.close();
      return;
    }
    const factor = MAX_IMPORT_PIXELS / Math.max(width, height);
    width = Math.max(MIN_MAP_SIZE, Math.round(width * factor));
    height = Math.max(MIN_MAP_SIZE, Math.round(height * factor));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = false;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const { pixels, unknownColors } = materialsFromRGBA(context.getImageData(0, 0, width, height).data);
  const convert = `${unknownColors.toLocaleString()} pixels use other colors. Convert them to the closest of the four material colors?`;
  if (unknownColors && !confirm(convert)) return;

  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 70);
  const map = normalizeMap({ width, height, pixels, spawn: { x: width / 2, y: height / 2 }, name });
  // Start where the explorer fits, if there is room anywhere.
  const probe = new World(map);
  if (probe.canStand(probe.player.x, probe.player.y)) map.spawn = { ...probe.player, floor: probe.floorIndex };
  loadMap(map);
  toast('Pixel image imported. Set a start point, then explore.');
}

// ---------------------------------------------------------------------------

export function initFiles() {
  byId('newMap').onclick = startBlankMap;
  byId('blankPreset').onclick = () => {
    if (isExploring()) setMode('build');
    startBlankMap();
  };

  byId('exportBtn').onclick = () => byId('exportDialog').showModal();
  byId('helpBtn').onclick = () => byId('helpDialog').showModal();
  for (const dialog of document.querySelectorAll('dialog')) {
    // Clicking the backdrop (outside the dialog box) closes it.
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (outside) dialog.close();
    });
    dialog.addEventListener('close', resetInput);
  }

  byId('downloadJSON').onclick = exportJSON;
  byId('downloadPNG').onclick = exportPNG;
  byId('importBtn').onclick = () => byId('importFile').click();
  byId('importFile').onchange = async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      await importFile(file);
    } catch (error) {
      toast(error.message || 'Could not import that map.');
    }
  };
}
