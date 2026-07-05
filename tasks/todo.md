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

## Pet Vet: shared worker pool + Pet Hotel (2026-07-04, session "hotel")

### Plan
- [x] Worker POST system: one pool staffs grooming (pri 0) > hotel (pri 1) > shop (pri 2); stable keys, 0.35s fill throttle, preemption only steals from strictly lower priority
- [x] Shop needs >=1 worker to ring up sales, supports 3 (spend x1/x1.25/x1.5); browsers walk out unpaid when unstaffed; cashier sprite only when staffed
- [x] Pet Hotel room: 6x5, $1100, Rooms tab. 3 dog + 3 cat beds along the back wall, reception desk, ficus plants, warm cream/tan walls + parquet + rug, PET HOTEL sign/portraits/paw plaques
- [x] Boarding: 15% of served clients (guarded roll) drop pet off; stay 60-240s, fee $60+round5(stay) = $120-300 fixed at check-in; pickup owner spawns on expiry (idempotent), pet trots to them, fee paid, both leave
- [x] Requires 3 workers on post for check-ins; boarded pets still cared for below 3
- [x] Wings dirty independently (grime only while occupied); dirty wing blocks that species; cleaners scrub via dirtyRooms()
- [x] Park interplay: boarded dogs visit the dog park, cats the cat rooms, reusing updateParkDog verbatim via a host shim (incl. poop/litter-box messes); walk out and back via examRoute
- [x] Save/load: hotels + pets {kind,bed,stayT,fee} + wing dirty round-trip (v:1 unchanged); expired stay on load re-triggers pickup
- [x] __t: canHotel/placeHotel/hotelList/hotelInfo/hotelCheckIn/shopInfo/workerPostList/setWantHotel/setDirty('hotelDog'/'hotelCat')

### Verification (headless browse, file://)
- 2 workers -> not taking; 3 assigned+present -> taking. Priority: 3 workers all pick hotel over shop; 4th/5th spill to shop; placing a hotel steals all 3 shop workers (preemption).
- Boarding: 2 pets x $150 -> exactly +$300, frq boosted twice, pets collected by walk-in owners.
- Trips: dog reached dog park and returned to bed; cat reached cat room and returned; park messes appear.
- Wing dirt: wings grime independently while occupied; setDirty('hotelDog') -> scrub job at (gx+1,gy+1), check-ins blocked for dogs only; cleaner scrubs clean.
- Shop: unstaffed 120s of traffic -> $0; staffed x1.5 -> +$2585.
- Save/load: pets + wing dirt + workers restored; expired-stay pet collected after load.
- RNG parity: Math.random draw counts current vs HEAD baseline overlap fully within RAF noise (179-192 vs 182-187 over 3 runs each); all new draws behind hotels.length/occupancy guards.
- node --check clean, zero console errors. Screenshots confirm hotel look + pets on beds + workers at posts.
- NOTE pre-existing (also on HEAD baseline): __t placeDesk+hireReceptionist alone doesn't serve queues in headless tests; not a regression.

### Concurrency
Other instance actively edited main.js mid-session (three edit-conflict retries; waited for 60s-stable window). All hotel/worker code re-verified on the merged file.

### Not done (didn't deploy or commit)
Left to Dan: commit + aws s3 sync + CloudFront invalidation (EDR208IJW4SS7).

## Surgery room (Jul 4, separate instance)

Plan: ~/.claude/plans/create-a-plan-to-toasty-raven.md (approved). Parameters confirmed with Dan:
35% of X-rayed pets need surgery; $1500 build / $400 payout / 18×procTime (90s base, 3× X-ray);
requires 2 vets + 1 worker simultaneously on the three staff circles (player fills any one slot).

- [x] 4×5 surgeries room type: surgeryTiles/surgeryKeyTiles (table + monitor + trolley solid,
      2 vet flanks + nurse circle + visitor spot), ROOM_TYPES.surgery descriptor
- [x] roomKey(type, rm) generalization — claimRoomGeneric/toRoomGeneric/dirtyRooms now honor a
      descriptor `key` fn instead of hardcoding examKeyTiles (exam/xray hit the default, unchanged)
- [x] X-ray onDone rolls 0.35 → needsSurgery → claimSurgery / waitSurgery loiter
- [x] Multi-staff: roomVetSlots (2 for surgery) in roomClaimed, vetCircle assigns flank slots,
      surgeryStaffed = both flanks + nurse tile manned; worker via 'surg:i' post at pri 0
- [x] Integration: inWalledRoom, collectWalls + hangBackWall decor, roomAt/removeRoom/tryPlace/
      cancelPlacing/roomWallEdge/dirtyRooms/drawRoomDirt, FURN row, save/load/newGame/resetTransient
- [x] Visuals: drawSurgTable (lamp lights mid-op) / drawSurgMonitor / drawSurgTrolley, 3 lit circles,
      ghost + drawGhost dispatch, pink inSurgery progress bar, ⚕️ emoji
- [x] __t: canSurgery/placeSurgery/surgeries()/surgSend/setDirty('surgery')

### Bug found + fixed (pre-existing, all room types)
roomDoorFor could pick a tile INSIDE the room's own footprint as the door — on save/load
(footprints are persisted in `corridor` and restored before rooms re-place) and when carving a room
inside a blank room — leaving the room fully walled/unenterable after reload. Fix: door candidates
now skip the room's own tiles. Verified door identical before/after save/load.

### Verified (headless __t, file:// tab)
Happy path: claim → walk in → 2 vets + worker converge → 90s at rate 1 only while staffed → +$400,
uses++. Understaffed (no worker): timer frozen, $0, pet bails at 60s, room + staff release cleanly.
Full RNG chain (Math.random stubbed 0.1 only during inExam/inXray): exam→X-ray→⚕️→surgery, +$710 total.
Dirt: scrub job at nurse circle, goal 20s. Save/load round-trips uses/dirty/door. node --check clean.
Note: the game ALSO advances via RAF in the live tab — assertions must run inside one js call.

### Not done (didn't deploy or commit)
Same as above — Dan commits + deploys.

## Pet Vet: fix — cleaners idle while rooms stay dirty (2026-07-04, session "hotel")

### Root cause
Building a room (or furniture) over ANOTHER room's door tile sealed that room: canPlaceRoom
only validated the new room's own footprint + door, so a later room could pave over an
earlier room's doorway. Sealed rooms are unenterable (patients silently skip them), stay
dirty forever, and every cleaner idle-loops retrying the unreachable scrub job.
Reproduced headlessly: 6 dirty exam rooms + 6 cleaners -> 2 rooms unreachable from every
cleaner (route matrix all-false), never cleaned.

### Fix
- isAnyRoomDoor(x,y): placement guard — canPlaceRoom AND furniture canPlace now reject any
  tile that is an existing room's door.
- repairRoomDoors(): re-derives a room's door when its doorway is no longer isOpenAdj;
  runs after every placeRoom (which also covers save-load, since applySave places through
  placeRoom). Restrooms skipped (door fixed by restroomLayout rot).

### Verification (headless)
- Same greedy build that previously sealed 2 rooms: guard prevents it; all 6 dirty rooms
  now cleaned. Legacy sealed save: repairable room's door re-derived on load and cleaned;
  a room with NO adjacent walkable tile stays sealed by construction (player can pick it
  up to relocate). Hotel/shop/worker regression re-run: all green.

### Not committed
Other instance is mid-feature on the same file (smoke test running); left for Dan or the
next commit sweep.

## 2026-07-04 — Multi-desk reception (visitors + receptionists per desk)

### Bug
Extra reception desks were decorative: deskAnchor() always returned the FIRST placed
desk, so all visitors queued at desk 1 and nearestStation() only offered desk 1's two
stations when placing a receptionist.

### Fix (grindy-vet/js/main.js)
- Line indices are now global: line L belongs to desk L>>1, side L&1. New helpers
  deskList/deskAnchor(i)/deskForLine/numLines.
- ensureQueues() (called each update frame + on spawn): resizes queue[] to 2 lines per
  desk; on desk removal, orphaned queuers rejoin the shortest surviving line and
  orphaned receptionists step to the first free station.
- spawnVisitor joins the shortest line across ALL desks (random among ties).
- Lone-receptionist alternation generalized per desk (deskStaff/staffLine replace
  loneStaffLine); serveVisitor hands the turn to the SAME desk's other line.
- nearestStation() scans every desk's stations (fixes hiring/relocating onto desk 2+).
- stationTile/slotPos/drawDeskCircles/scene draw use the line's own desk; receptionist
  sprite takes a per-desk rot so it faces its own desk's front.

### Verification (headless __t, browse daemon)
- Two desks: visitors split across lines [0,1] and [2,3]; lone receptionist hired on
  line 2 drained BOTH desk-2 lines (alternation) and earned check-in fees; relocation
  desk B -> desk A -> desk B all landed on correct station tiles.
- Single-desk regression: both stations hirable, service + queue behavior unchanged.
- Screenshot: two desks with 3 receptionists serving simultaneously.

### Not committed
Another instance was concurrently editing main.js (waited for quiet before each edit);
left uncommitted for Dan / next commit sweep.
