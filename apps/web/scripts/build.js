// Assembles the deployable static site in apps/web/build/: the page, styles, UI modules and
// plans from apps/web/, plus packages/core/src/ at js/core/ where the import map expects it.
// The output is a plain folder for any static host (the web container image serves it).

import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const WEB = new URL('../', import.meta.url);
const CORE = new URL('../../../packages/core/src/', import.meta.url);
const OUT = new URL('build/', WEB);
const PAGE_ENTRIES = ['index.html', 'css', 'js', 'plans'];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT);
for (const entry of PAGE_ENTRIES) await cp(new URL(entry, WEB), new URL(entry, OUT), { recursive: true });
await cp(CORE, new URL('js/core/', OUT), { recursive: true });
console.log(`Built ${fileURLToPath(OUT)}`);
