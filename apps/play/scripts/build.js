// Assembles the deployable static site in apps/play/build/: the page, styles and modules from
// apps/play/, plus packages/core/src/ at js/core/ where the import map expects it.
// The web container image serves it at /play/.

import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const APP = new URL('../', import.meta.url);
const CORE = new URL('../../../packages/core/src/', import.meta.url);
const OUT = new URL('build/', APP);
const PAGE_ENTRIES = ['index.html', 'css', 'js'];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT);
for (const entry of PAGE_ENTRIES) await cp(new URL(entry, APP), new URL(entry, OUT), { recursive: true });
await cp(CORE, new URL('js/core/', OUT), { recursive: true });
console.log(`Built ${fileURLToPath(OUT)}`);
