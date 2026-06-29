#!/usr/bin/env node
/* Headless smoke test: load every game + the launcher and assert there are no
   console errors and (for games) window.EL is defined. Catches broken helper
   aliases, CSS that throws, and games that fail to boot.

   Uses the gstack `browse` binary. If it isn't installed, the test SKIPS
   (exit 0) rather than failing, so it's safe to run anywhere.

   The static file server runs in a worker thread: the main thread drives
   `browse` with blocking execFileSync calls, which would otherwise starve an
   in-process server's event loop.

   Run:  node tools/smoke.mjs
*/
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Locate the browse binary (project copy first, then the user install).
const BROWSE = [
  join(ROOT, '.claude/skills/gstack/browse/dist/browse'),
  join(homedir(), '.claude/skills/gstack/browse/dist/browse')
].find(p => existsSync(p));
if (!BROWSE) { console.log('SKIP: gstack browse binary not found — skipping smoke test.'); process.exit(0); }

// ---- static server in a worker thread (own event loop) -----------------
const SERVER_SRC = `
  const { createServer } = require('node:http');
  const { readFile } = require('node:fs/promises');
  const { extname, join, normalize } = require('node:path');
  const { parentPort, workerData } = require('node:worker_threads');
  const ROOT = workerData.root;
  const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
    '.json':'application/json', '.webmanifest':'application/manifest+json',
    '.woff2':'font/woff2', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  server.listen(0, () => parentPort.postMessage(server.address().port));
`;
const worker = new Worker(SERVER_SRC, { eval: true, workerData: { root: ROOT } });
const port = await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
});
const base = `http://localhost:${port}`;

// ---- discover games ----------------------------------------------------
const entries = await readdir(ROOT, { withFileTypes: true });
const games = entries
  .filter(e => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(ROOT, e.name, 'index.html')))
  .map(e => e.name).sort();

const B = (...args) => execFileSync(BROWSE, args, { encoding: 'utf8' });
const tok = String(process.pid); // unique-ish cache-bust per run
const errorLines = log => log.split('\n').filter(l => /\]\s*\[(error|warning)\]/i.test(l) && !/ERR_FILE_NOT_FOUND/i.test(l));

let failures = 0;
try {
  // Start the daemon, drop any prior service worker / caches so we test disk state.
  B('goto', base + '/');
  B('js', "if(navigator.serviceWorker){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});});} if(window.caches){caches.keys().then(function(k){k.forEach(function(c){caches.delete(c);});});} 'ok'");

  for (const g of games) {
    // Only games that link the shared script are expected to expose window.EL;
    // unmigrated games (e.g. grindy-vet) just need a clean console.
    const usesShared = (await readFile(join(ROOT, g, 'index.html'), 'utf8')).includes('/shared/game.js');
    B('console', '--clear');
    B('goto', `${base}/${g}/index.html?smoke=${tok}`);
    try { B('wait', '--load'); } catch { /* load may have already fired */ }
    const el = B('js', 'typeof window.EL').trim();
    const errs = errorLines(B('console', '--errors'));
    const elBad = usesShared && el !== 'object';
    if (elBad || errs.length) {
      failures++;
      console.error(`FAIL ${g}:${elBad ? ` EL=${el} (links /shared/game.js but EL missing)` : ''}${errs.length ? ' | ' + errs.map(s => s.trim()).join(' ; ') : ''}`);
    } else {
      console.log(`ok   ${g}${usesShared ? '' : ' (no shared assets — console only)'}`);
    }
  }

  // Launcher: no game.js, so just assert it boots with all game cards present.
  B('console', '--clear');
  B('goto', `${base}/index.html?smoke=${tok}`);
  try { B('wait', '--load'); } catch {}
  const cards = parseInt(B('js', 'document.querySelectorAll(".game-card").length').trim(), 10) || 0;
  const lErrs = errorLines(B('console', '--errors'));
  if (cards !== games.length || lErrs.length) {
    failures++;
    console.error(`FAIL launcher: ${cards} cards (expected ${games.length})${lErrs.length ? ' | ' + lErrs.map(s => s.trim()).join(' ; ') : ''}`);
  } else {
    console.log(`ok   launcher (${cards} cards)`);
  }
} finally {
  await worker.terminate();
}

console.log(`\nSmoke: ${games.length + 1} pages checked, ${failures} failed`);
process.exit(failures ? 1 : 0);
