#!/usr/bin/env node
/* Dependency-free tests for the shared assets.

   1. Unit-tests the pure EL.* helpers in shared/game.js (all 23 games depend on
      them, so a regression here breaks many games at once).
   2. Then runs tools/smoke.mjs (headless per-game load check) if available.

   Run:  node tools/test.mjs            (unit tests + smoke)
         node tools/test.mjs --no-smoke (unit tests only)
*/
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- tiny test harness -------------------------------------------------
let pass = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else fails.push(name); }
function eq(name, a, b) { ok(`${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`, a === b); }

// ---- localStorage mock (best/playerName need it) -----------------------
function mockLS(initial) {
  const m = new Map(Object.entries(initial || {}));
  globalThis.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  };
}
mockLS();

const EL = (await import('../shared/game.js')).default;

// ---- deterministic helpers --------------------------------------------
eq('clamp mid', EL.clamp(5, 0, 10), 5);
eq('clamp low', EL.clamp(-3, 0, 10), 0);
eq('clamp high', EL.clamp(99, 0, 10), 10);
eq('lerp 0', EL.lerp(0, 10, 0), 0);
eq('lerp .5', EL.lerp(0, 10, 0.5), 5);
eq('lerp 1', EL.lerp(0, 10, 1), 10);
eq('dist2 3-4-5', EL.dist2(0, 0, 3, 4), 25);
eq('dist2 zero', EL.dist2(2, 2, 2, 2), 0);

// ---- randomized helpers: assert invariants over many samples ----------
let rndOk = true, rintOk = true; const rintSeen = new Set();
for (let i = 0; i < 5000; i++) {
  const r = EL.rnd(2, 5); if (r < 2 || r >= 5) rndOk = false;
  const n = EL.rint(2, 5); if (n < 2 || n > 5 || n !== Math.floor(n)) rintOk = false; rintSeen.add(n);
}
ok('rnd stays in [2,5)', rndOk);
ok('rint stays in [2,5] and is integral', rintOk);
ok('rint hits both endpoints (2 and 5)', rintSeen.has(2) && rintSeen.has(5));

let pickOk = true;
for (let i = 0; i < 1000; i++) { if (![7, 8, 9].includes(EL.pick([7, 8, 9]))) pickOk = false; }
ok('pick returns an element of the array', pickOk);
eq('pick single', EL.pick([42]), 42);

// shuffle: same reference, same multiset, same length
const arr = [1, 2, 3, 4, 5]; const ref = EL.shuffle(arr);
ok('shuffle returns same array ref', ref === arr);
eq('shuffle preserves length', arr.length, 5);
eq('shuffle preserves multiset', JSON.stringify([...arr].sort()), JSON.stringify([1, 2, 3, 4, 5]));

// ---- best(key): round-trip + defaults ----------------------------------
mockLS();
const b = EL.best('demo.best');
eq('best default is 0', b.load(), 0);
b.save(42); eq('best round-trips', b.load(), 42);
b.save(7); eq('best overwrites', b.load(), 7);
mockLS({ 'x.best': 'not-a-number' });
eq('best non-numeric -> 0', EL.best('x.best').load(), 0);

// ---- playerName: trim / fallback / corrupt -----------------------------
mockLS({ 'elise.playerNames': JSON.stringify(['Ann', '   ', null]) });
eq('playerName returns stored', EL.playerName(0, 'P1'), 'Ann');
eq('playerName blank -> fallback', EL.playerName(1, 'P2'), 'P2');
eq('playerName missing -> fallback', EL.playerName(9, 'P10'), 'P10');
mockLS({ 'elise.playerNames': '{bad json' });
eq('playerName corrupt -> fallback', EL.playerName(0, 'PX'), 'PX');

// ---- canvasPos: maps client coords into canvas W x H -------------------
const fakeCanvas = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }) };
const p1 = EL.canvasPos(fakeCanvas, { clientX: 60, clientY: 45 }, 200, 100);
eq('canvasPos x (mouse)', p1.x, 100); // (60-10)/100*200
eq('canvasPos y (mouse)', p1.y, 50);  // (45-20)/50*100
const p2 = EL.canvasPos(fakeCanvas, { changedTouches: [{ clientX: 110, clientY: 70 }] }, 200, 100);
eq('canvasPos x (touch)', p2.x, 200);
eq('canvasPos y (touch)', p2.y, 100);

// ---- report ------------------------------------------------------------
console.log(`\nEL unit tests: ${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach(f => console.error('  FAIL: ' + f)); process.exit(1); }
console.log('  all EL helpers OK');

// ---- chain smoke test --------------------------------------------------
if (process.argv.includes('--no-smoke')) process.exit(0);
try {
  console.log('\nRunning smoke test (tools/smoke.mjs)...');
  execFileSync('node', [join(ROOT, 'tools/smoke.mjs')], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
