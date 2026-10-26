// Plans are ordinary map files in apps/web/plans/. plans/index.json names the one that
// opens when there is no autosave.

import { alignGrid, decodeMap } from '@pixel-map-lab/core';

const PLANS_FOLDER = new URL('../../plans/', import.meta.url);

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
  return response.json();
}

/** The plan named as the default in plans/index.json. */
export async function loadDefaultPlan() {
  const manifest = await fetchJSON(new URL('index.json', PLANS_FOLDER));
  const plan = await fetchJSON(new URL(encodeURIComponent(manifest.default), PLANS_FOLDER));
  return alignGrid(decodeMap(plan));
}
