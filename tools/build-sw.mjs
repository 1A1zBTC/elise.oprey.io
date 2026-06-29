#!/usr/bin/env node
/* Regenerate sw.js's precache lists and bump the cache version.

   Why: the service worker only re-fetches precached files when sw.js itself is
   byte-different. So every deploy must (a) list every game in PAGES, (b) list
   shared assets in ASSETS, and (c) bump CACHE so clients re-install and drop the
   stale cache. Doing this by hand is the #1 maintenance footgun (forgotten game
   = no offline; forgotten bump = stale games forever).

   This script does targeted in-place edits of the three data regions only —
   it never touches the install/activate/fetch logic.

   Usage:
     node tools/build-sw.mjs           # rewrite sw.js (always bumps CACHE)
     node tools/build-sw.mjs --check   # report drift, exit 1 if PAGES/ASSETS differ, no write
*/
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = join(ROOT, 'sw.js');

// Shared assets precached for offline use (stable; edit here if assets change).
const ASSETS = [
  'manifest.webmanifest', 'pwa.js',
  'shared/game.css', 'shared/game.js',
  'fonts/fonts.css', 'fonts/nunito.woff2', 'fonts/pacifico.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png', 'icons/favicon.png',
  // Pet Vet (grindy-vet) loads its logic from an external classic script that
  // the page precache won't fetch on its own, so list it here.
  'grindy-vet/js/main.js'
];

// Every top-level directory containing an index.html is a game page.
function discoverPages() {
  const dirs = readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .filter(name => existsSync(join(ROOT, name, 'index.html')))
    .sort();
  return ['/'].concat(dirs.map(d => d + '/'));
}

// Wrap a quoted list at ~6 entries per line to match the existing formatting.
function fmtArray(items, perLine) {
  const lines = [];
  for (let i = 0; i < items.length; i += perLine) {
    lines.push('  ' + items.slice(i, i + perLine).map(s => `'${s}'`).join(', '));
  }
  return lines.join(',\n');
}

function replaceArray(src, name, body) {
  const re = new RegExp(`const ${name} = \\[[\\s\\S]*?\\];`);
  if (!re.test(src)) throw new Error(`Could not find "const ${name} = [...]" in sw.js`);
  return src.replace(re, `const ${name} = [\n${body}\n];`);
}

function currentArray(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) return [];
  return (m[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1));
}

const check = process.argv.includes('--check');
let src = readFileSync(SW, 'utf8');

const pages = discoverPages();
const drift =
  JSON.stringify(currentArray(src, 'PAGES')) !== JSON.stringify(pages) ||
  JSON.stringify(currentArray(src, 'ASSETS')) !== JSON.stringify(ASSETS);

if (check) {
  if (drift) {
    console.error('sw.js is out of date — run: node tools/build-sw.mjs');
    process.exit(1);
  }
  console.log('sw.js precache lists are up to date.');
  process.exit(0);
}

// Bump CACHE every run: a byte-different sw.js is what forces clients to
// re-install and refresh the precache, so we always advance the version.
const cacheM = src.match(/const CACHE = '(el-games-v)(\d+)';/);
if (!cacheM) throw new Error("Could not find CACHE = 'el-games-vN' in sw.js");
const nextN = parseInt(cacheM[2], 10) + 1;
src = src.replace(cacheM[0], `const CACHE = '${cacheM[1]}${nextN}';`);

src = replaceArray(src, 'PAGES', fmtArray(pages, 6));
src = replaceArray(src, 'ASSETS', fmtArray(ASSETS, 3));

writeFileSync(SW, src);
console.log(`sw.js updated: ${pages.length - 1} games, CACHE -> el-games-v${nextN}${drift ? ' (precache lists changed)' : ''}`);
