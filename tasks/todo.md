# Pet Vet — Grooming room + Worker staff

## Spec
- New room **Grooming**, 3×6, fixed orientation. Two sequential stations down the centre:
  Shower (fixture y+0, dog y+1, operator circle y+2) → Blow-Dry (fixture y+3, dog y+4, operator circle y+5).
  Dog showers first, walks to the dry station, gets blow-dried, pays **$80** (only on full completion).
- Operated by the player on a station circle (full rate) or a hired **Worker** (half rate); no operator → wait drains → leaves unpaid.
- New staff **Worker** $350: roams to any grooming station that needs work; when none, mans the shop.
- **20%** of reception-processed visitors divert to grooming (skip exam); **30%** after the dog park.

## Tasks
- [ ] Catalog: Worker (staff) + Grooming (room) entries
- [ ] Grooming geometry + ROOM_TYPES descriptor + place/canPlace/free
- [ ] roomWalls / roomWallEdge / roomAt / removeRoom / cancelPlacing / tryPlace / ghost
- [ ] Grooming fixtures + circles drawing; drawWorker sprite
- [ ] Visitor FSM: claim/assign/release + toGroom/inGroom phases (shower->dry, pay $80)
- [ ] Reception 20% + dog-park 30% diversions; exam excludes wantsGroom
- [ ] workers[] + updateWorkers (grooming, shop fallback) + update() wiring
- [ ] eachStaffHandle worker block + staff icon + emoji + progress bar
- [ ] Save/load + resetTransient/newGame/applySave
- [ ] Verify headless (build grooming, hire worker, run scenario, assert $80 payout)

## Review
All tasks done. Grooming room (3×6) + Worker ($350) shipped into grindy-vet/js/main.js.

- Grooming is a station-based room like pharmacy but SEQUENTIAL: shower (fixture y+0 /
  dogSpot y+1 / circle y+2) → blow-dry (fixture y+3 / dogSpot y+4 / circle y+5). One dog
  at a time (occupant-based, freeRoom('grooming')). Each station needs an operator (player
  on the circle = full rate, Worker = half); no operator → wait drains → leaves unpaid.
  Full groom pays $80 (only on completing the dry stage).
- Worker is a roaming staffer (workers[], like vets[]): updateWorkers routes it to any
  grooming station whose dog needs work; with nothing to groom it goes and stands at the
  shop floor. Hired via catalog ($350), drag-relocate, save/load, staff modal, fire refund.
- Routing: serveVisitor sets wantsGroom on 20% of processed clients (they skip exam via the
  exam.waiting `!wantsGroom` guard); the dog-park done block diverts 30% to grooming.
  assignGrooming pulls wantsGroom clients into free rooms in ticket order.

### Bug found + fixed during verification
- `inWalledRoom()` didn't include grooming → its floor rendered as a corridor carpet and
  door/placement classification was wrong. Added grooming to inWalledRoom (screenshot-confirmed
  the floor now renders as proper vinyl room floor).

### Verification
- node --check: clean. tools/smoke.mjs: grindy-vet boots with 0 console errors.
- Headless functional test (scratchpad/groom-test.mjs): a dog routes to grooming, showers,
  walks to the dry station, is blow-dried, pays $80; a roaming Worker operates both stations
  (maxShowerT/maxDryT reach the full 15s, a +$80 payout observed). Screenshot confirms the
  room, fixtures, Worker sprite, and lit station circle render correctly.

### Concurrency note
Another Claude instance was editing grindy-vet/js/main.js throughout this session (file grew
~319KB→346KB). One functional-test run failed transiently because the browser loaded a
half-written main.js mid-edit; it passed cleanly once the file settled. Dan confirmed "proceed".

### Not done (didn't deploy)
Left to Dan: `node tools/build-sw.mjs` + `tools/deploy.sh` (S3 + CloudFront) to go live.

## Pet Vet: cat park items (2026-07-04, session "cat park")

### Plan
- [x] 5 cat items under the Park shop tab (Litter Box, Cardboard Box, Scratching Post, Catnip Planter, Cat Tree)
- [x] `catItem` flag + canPlace gate: placeable only on blank-room floor (openRoom minus park)
- [x] Cat-park mechanic: reused whole dog-park pipeline via optional `zone` param ('dog' default / 'cat') + `v.parkZone`
- [x] Cats leave the carrier and roam blank rooms (new `drawCat`, scene gate widened)
- [x] Litter box: cats run to it instead of pooping; every 2nd use → `kind:'litterbox'` mess (8s scoop); no box → floor poo fallback
- [x] `__t` hooks: catParkInfo(), puddleList(), setPet()

### Verification (headless browse, file:// open)
- node --check clean; zero new console errors across ~1000 sim rounds with active cat visits.
- Placement gates: litterbox blank✓ clinic✗ grass✗; frisbee blank✗ grass✓.
- catParkInfo: size 9, quality 11, appeal 0.438; parkInfo (dog) unaffected by cat items.
- Cats divert to furnished blank rooms (goers>0), litterbox messes appear beside the box, cleaners scoop them; without a box cats poo on the cat floor.
- Save/load round-trips cat items + blank room (no schema change, v:1).
- Screenshots: Park tab shows 11 cost-sorted cards; grey cats visibly roaming off-carrier next to owners with 🐾 bubbles.

### Sim parity
Cat-branch RNG draws are guarded by `parkAppeal('cat') > 0` BEFORE Math.random(), so games without a cat park keep an identical RNG stream.

### Not done (didn't deploy or commit)
main.js is shared with another active instance; left commit + `aws s3 sync` / CloudFront invalidation to Dan.

## Pet Vet: wall-rendering performance fix (2026-07-04, session "grooming/perf")

### Root causes found
1. **doorways leak (the "severe, worsens over time" part):** `drawDoorOpening()` did
   `doorways.push(...)` — but it runs inside a per-frame wallSegs draw closure, so every
   door segment registered a duplicate doorway EVERY FRAME (cleared only on renderStatic).
   update()'s door-proximity scan and draw()'s animated-door scene items then grew
   unboundedly: O(frames × doors × visitors). Build mode cleared it → the reported speedup.
2. **Walls re-rasterized as vectors every frame:** ~167 wallSegs closures (wallFace =
   clip+gradient+seam/grout/rail strokes; supply/med/shop shelf billboards; x-ray decor
   with shadowBlur) → >1000 canvas path ops/frame of static geometry.

### Fix
1. Moved doorway registration into `D()` at collect time; `drawDoorOpening` is now pure.
2. Sprite-cache: tagged wall/shelf/decor segments with `_ax/_ay/_bx/_by/_htop`
   (BILLBOARD_H=78 for billboard-bearing walls); new `bakeWallSprites()` at the end of
   `collectWalls()` rasterizes each tagged segment once into a small offscreen canvas
   (bake by swapping the module `ctx` var; bbox margins 16/16/8) and swaps its fn for one
   camera-tracking drawImage blit. Depth sort/interleaving untouched. Park fences +
   entrance frame stay live (cheap, untagged). No re-bake on pan (camera-invariant math).
   Debug hooks: `__t.setWallSprites(on)`, `__t.doorwayCount()`, `__t.wallSegCount()`,
   `__t.timeDraw(n)`.

### Verification (headless browse, scratchpad/wall-perf-test.mjs)
- 5-room clinic, 167 wall segments: doorways constant at 5 across draws + 2 sim-min
  (previously +5/frame). 2.6× faster draw (11.15ms → 4.32ms, software rendering).
- Pixel compare baked vs unbaked: 0 pixels differ >8/channel (max diff 4 — sub-visible).
  Screenshots visually identical incl. shelf occlusion by cashier/pharmacist.
- node --check + tools/test.mjs (unit + 28-page smoke): all green.

### Follow-up round 2 (same session): character sprites + wall sprite memoization
- **Wall sprite memoization**: cache keyed by CONTENT (_key) + edge DELTA + dpr, not
  absolute position — identical walls/shelves/doors share ONE sprite; the cache
  persists across collectWalls() runs so placement toggles / far-pan re-bakes
  re-rasterize nothing (removed the re-bake hitch). Anonymous cabinet wrappers named
  (cabinetPlain/cabinetCross) so fn.name-keyed decor can't collide.
- **Character sprite cache** (charSprite/blitChar + staffSprite): visitor bodies keyed
  by shirt|legs|skin|hair|facing|walk-bucket(7, ≤0.5px)|seated|angry; dogs/cats/carriers
  keyed by pet|facing|gait/wag buckets (asin-mapped back so the baked pose is exact);
  staff keyed kind|gender|facing (no staff animates legs). Shared shadow sprite + per-
  emoji bubble sprites (killed per-frame createRadialGradient + fillText). Overlays
  (bars, steam, lift, ghosts, labels) stay live. LRU wipe at 600 sprites; dpr-aware.
- __t hooks: setCharSprites(on), charSpriteCount().
- Verified (scratchpad/char-perf-test.mjs): 46-visitor crowd 6.96 → 4.31 ms/draw
  (1.61×; walls test now 3.4×); strong pixel diffs 0.02% (quantized legs + text AA),
  screenshots visually identical; full suite green.

### Not done (didn't deploy or commit)
Same as above — Dan commits + deploys (build-sw + s3 sync + CloudFront invalidation).
