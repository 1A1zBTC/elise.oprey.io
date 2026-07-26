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

## Pet Vet: fix — bubble shows one service, visitor goes to another (2026-07-05, session "janitors")

### Root cause
The intent rework (eec96d3) routes served visitors by `v.intent` ('exam'|'pharm'|'park'|'shop'|'groom'),
but `visitorEmoji` still derived the bubble from legacy flags only. `!v.examined -> stethoscope` sat above
the meds check, and park/shop had no waiting-state branch at all — so pharmacy-intent clients showed the
stethoscope for their ENTIRE visit (walking to + standing at the counter), and park/shop-intent clients
showed it while waiting to head out.

### Fix
Three intent-aware lines in visitorEmoji, inserted between the reception check and the exam fallthrough:
meds-without-exam -> pill, intent 'park' && !parkDone -> paws, intent 'shop' && !shopped -> bags.

### Verification (headless, 240 sim-seconds, all services built)
Zero phase/emoji mismatches; toPharm/inPharm now sample as the pill emoji, waiting park clients as paws,
shop as bags; exam-intent visitors still show the stethoscope (correct).
Harness note: __t.placeDesk() REQUIRES coordinates (e.g. placeDesk(3,1,0)) — argless places a desk at
undefined coords, queue slots become NaN and reception never serves (this was yesterday's "reception
doesn't serve in tests" mystery, not a game bug).

### Not committed
Other instance has in-flight uncommitted work in the same file.

## Street Fighter: graphics + stutter + full Warhammer roster (2026-07-18)

### Plan
- [x] Roster: add all Warhammer 40k factions (20 new fighters, 24 total)
- [x] Art system: faction helmets, backpacks, chest decor, emblems; richer shading
- [x] Fix select-card portraits (heads were clipped off the top of the canvas)
- [x] Stutter: cache static arena + vignette to offscreen canvases (~700 fillRects + ~30 gradient allocs per frame -> GC hitches)
- [x] Stutter: cache limb/joint gradients (local-space rendering)
- [x] Stutter: cut hit-freeze (hitstop) from up to 9 frames to 2-4
- [x] Fixed 60Hz timestep so high-refresh displays don't fast-forward the game
- [x] Select screen: 4-column grid (3 on phones) to fit 24 fighters
- [x] sw.js cache bump v64 -> v65
- [x] Verify: syntax check + headless browser screenshots

### Review
- Roster: 22 Warhammer 40k factions (Imperium 7, Chaos 7, Xenos 8) + Predator/Xenomorph = 24
  fighters. Each CHARS entry now carries an `art` block (helm/back/decor/emblem/crest/horns/
  tall/beard/pauldron) consumed by drawFighter/drawHead/bodyDecor — adding a fighter is data
  + at most one new helm case.
- Stutter root cause: per-frame allocation churn (arena redraw ~700 fillRects + ~30 gradient
  objects/frame -> periodic GC pauses), compounded by design hitstop up to 9 frames (150ms)
  on heavy hits. Fixed: arena + vignette baked to offscreen canvases (rebuilt on dpr change),
  limbs render in local space with memoized gradients keyed color|size, memoized
  lighten/darken, hitstop now 2 (light/shot/block) or 4 (heavy). Also moved to a fixed 60Hz
  accumulator loop — 120/144Hz screens no longer fast-forward the game, and each display
  frame renders at most once per sim step.
- Pre-existing bug fixed: select cards / HUD portraits drew fighters with heads above the
  canvas (feet at y=108 of 120 but fighters are ~160 units tall). Portraits now scale 0.58.
- Verified headless (file://, browse daemon): 24 chars boot, select screen renders full
  bodies, marine-vs-ork / daemon-vs-knight / aeldari-vs-tyranid screenshots look right,
  finisher super fires with FINISHER! banner, 2 simulated minutes of CPU fight with round
  transitions and draw/win bookkeeping, zero JS errors, avg step+render 1.22ms (software).
  Mobile 375px select layout fits after switching picks to 3 columns + min-width:0.
- NOT deployed, NOT committed (per convention: Dan commits; deploy = aws s3 sync +
  CloudFront invalidation EDR208IJW4SS7 + the sw.js v65 bump is already in).

### Follow-up (same day): "1P can't move or attack" bug
- Root cause (PRE-EXISTING): nothing ever exited the 'down' state — stepFighter early-returned
  on state==='down' forever, so any knockdown (CPU sweep = 28% of its attack rolls, super,
  8-hit combo cap) froze that fighter for the whole round, drawn in a normal STANDING pose
  (hence "I'm still and can't attack"). Downed fighters are also invulnerable, which is why
  stuck rounds ended in timeout draws.
- Fix: on ground with stun expired, 'down' -> 'idle' (get back up). Plus: down/KO fighters now
  visibly lie flat (rotate about the feet) so the state reads on screen.
- Also: 1-player mode now accepts EITHER keyset (WASD/QER or Arrows/1-2-4) for the human,
  since kids pressing the "other" side's keys also experienced "nothing works". 2P keeps the
  keysets separate (verified: arrows move only P2 in 2P).
- Verified headless: forced knockdown -> lying pose screenshot -> recovers to idle; arrows
  moved P1 95px in 1P; Digit1 punch landed for 5 dmg; 2P isolation intact; no JS errors.


## Fruit Merge: round progression rework (2026-07-18)
- [x] Target fruit grows per round: round 1 clears at 🍎, then 🍐 🍑 🍍 🍈, 🍉 from round 6 on
- [x] Jar shrinks 20px on even rounds (328 → floor 268 wide), announced on the clear screen
- [x] Spawn pool + gravity retuned to the new target curve; side ladder highlights the target
- [x] window.__t test hook; verified headless via browse daemon
- [x] Sleep physics: settled fruit locks in place (infinite mass), can't be shoved by new
      drops; fruit-fruit contacts now kill into-contact velocity (fixes Verlet phantom
      velocity in stacks); any merge wakes the pile so unsupported fruit falls

## Mob Soccer: FIFA-style possession & passing (2026-07-18)
- [x] Lead passes with designated receiver + pulsing FIFA-style receiver indicator
- [x] Control auto-switches to the receiver; assisted run to meet the pass
- [x] Possession change animated: first-touch ball settle + team-color flash ring, INTERCEPTED! pop
- [x] Animated switch marker (arrow flies from old to new active player)
- [x] CPU passes in build-up play; possession dot on scoreboard
- [x] window.__t hook + headless verify

### Follow-up 2 (same day): army-unit roster + signature wargear
- Every faction fighter renamed to its iconic troop unit: Intercessor, Battle Sister,
  Custodian Guard, Grey Knight, Skitarii Ranger, Cadian Trooper, Armiger, Chaos Legionary,
  Khorne Berzerker, Plague Marine, Rubric Marine, Noise Marine, Bloodletter, War Dog,
  Guardian Defender, Kabalite Warrior, Ork Boy, Termagant, Neophyte Hybrid, Hearthkyn
  Warrior, Pathfinder, Necron Warrior. Descs updated to name unit + faction.
- New drawWeapon() renderer + art.weapon data: each unit holds signature wargear in
  idle/walk/jump poses (7 kinds: rifle w/ optional glow strip — gauss flayer green tube,
  pulse carbine, lasgun, shuriken catapult, splinter rifle...; halberd — guardian spear /
  nemesis force halberd; chain-axe; ork choppa; hellblade sword; organic fleshborer;
  arm cannon for Armiger/War Dog). Mirrors via scale(-1,1) for left-facing.
- Verified in browser tab 3 (browse daemon tab 2 was in use by another instance — used a
  dedicated tab): select screen shows all units armed, Custodian spear + Necron gauss
  flayer + Berzerker chain-axe + Ork choppa all render in-fight both directions; no JS
  errors; node --check clean. sw.js already at v65 pending deploy.

## Mr Grizzles: cans, ramps, super grizzly, graphics pass (2026-07-18)
- [x] Coins → spinning cans of Bud Light (blue body, white band, silver rim; HUD can icon; copy updated)
- [x] Ramp carts (always warning-orange w/ chevron wedge): run up onto roofs, ride, jump cart-to-cart;
      any train roof is landable; 5 new roof-run chunks (tier 1-3); jump now launches from current
      surface (jumpBase) with fall physics off edges
- [x] Hit while fresh → stumble → SUPER GRIZZLY 15s: bigger dark-grizzly bear, orange aura, hackles,
      countdown ring + HUD meter, smashes bars/signs/whole trains (+15 ea, particles, screen shake).
      After super: 10s worn-out (sweat drop) — a hit there is the only knockout. Then re-arms.
- [x] Graphics pass: steel rails + wooden sleepers, brick retaining walls w/ amber tunnel lamps +
      graffiti, twinkling stars + moon glow, depth haze, train side windows/rivets/roof ribs/
      headlight glow, blinking barrier lights, film grain + vignette
- [x] Verified headless in browse tab: ramp climb (y→2.1), roof can pickup, hit→super→smash(45pts)→
      tired→knockout→re-arm, gap jump stays at roof height, 50s unattended run ends properly;
      node tools/test.mjs all green (31 pages); screenshots reviewed. sw.js bumped to v69 (pending deploy)
### Review
- Death path changed by design: only a hit during the 10s worn-out window ends the run (super is
  fully invincible per request, so an always-rearming super would otherwise make the game unlosable).
- Concurrent-instance note: browse daemon smoke test reuses tabs — game QA tabs were re-opened after
  tools/test.mjs ran. Not committed/deployed (working tree has other instances' pending changes).

## Pet Lovers: new game (2026-07-18)
- [x] pet-lovers/index.html — DOM pet-care sim, 8 species (dog cat parrot bunny fish crab ferret pig)
- [x] Needs: feed / play / groom / clean cage-tank / walk (dog) + sickness → vet trips
- [x] Shop: food, treats, permanent toys; hearts → coins; adopt pets for progression
- [x] Walk minigame (tap bones for coins); localStorage save with capped offline decay
- [x] Register in index.html launcher + sw.js PAGES (+ cache bump)
- [x] window.__t hook + headless verify
- [x] v2: rebuilt as a walk-around house — player character (WASD/tap-to-move), rooms
      (living room, tank shelf, cages, garden with hutch + pen, shop counter), walk up to a
      pet for its care panel, walk over hearts to collect, shop opens at the counter
- [x] v3: earn money — neighbours ring the front door for paid dog walks (10-16🪙, rotating
      dogs), foster pets visit the basket for a 150s stay and pay out 12-38🪙 scaled by how
      happy they leave (⭐ perfect-care bonus)
- [x] v4: phone system — jobs now arrive as phone calls (walk requests from named neighbours,
      foster requests from the shelter). Phone rings 10s (shake + ringtone + badge countdown),
      P or tap answers, then 5s to Accept/Decline; missed / hung-up / declined all handled.
      Doorbell flow removed; door stays as decor.
- [x] fix: phone Accept dead when panel was already open at ring time (ring phase now shows
      an Answer button); all stage buttons converted to tap() (click+touchstart) since plain
      click is eaten on touch devices; P no longer closes the phone mid-decision
- [x] v5: coins only from other people's pets — hearts now give ❤ Love (HUD chip, saved),
      own dog walk pays nothing and spawns no bones (bones/pay only on phone-job walks);
      foster + neighbour-walk pay unchanged
- [x] v6: Pet Lovers — removed per-pet Vet button from the care panel; added a VET CLINIC
      counter (purple awning, below the pet shop) that opens a Vet Clinic overlay like the
      shop: lists all sick pets with Treat · 15 🪙 buttons, shows healing countdowns, and
      "All your pets are healthy! 🎉" when nothing needs treatment. Verified headless via
      window.__t (care panel has no vet act; treat deducts coins; heal completes; close
      steps player back so it doesn't re-open).
- [x] v7: Pet Lovers — chore minigames now need the right gear: added GEAR shop items
      (🧼 Pet Soap 8🪙 → wash, 🧹 Broom & Scoop 8🪙 → clean home, 🦮 Dog Leash 12🪙 → own-dog
      walk; play already needed a toy). Missing gear disables the button with a "Need soap!"
      style label; gear is one-time purchase (Owned ✓ in shop), saved in G.gear, applies to
      foster wash too; neighbour dog-walk jobs unaffected. Verified headless: blocked before
      buying, shop purchase, unlock after, persistence across reload.
- [x] v6: care minigames — every chore is a game and the score (0-1) scales the stat gain
      (gain = base × (0.3 + 0.7×score)). Feed = catch-the-food themed per species (motion +
      item per animal); Play = per-animal: dog fetch-timing, pig puddle-hop, cat laser-chase,
      bunny burrow-peek, ferret tube-dash, fish bubble-pop, parrot song-mimic (simon), crab
      shell game; Wash = scrub dirt spots (drag or tap); Clean = tap-the-mess themed per home.
      Own-dog walk: bones tapped fill the walk meter (55 + 12/bone). Fosters map to nearest
      species' games. Treat/vet/adopt stay instant. NOTE: merged live alongside another
      instance's vet-clinic counter + gear (soap/broom/leash) work — combined flows verified.
- [x] v8: Pet Lovers — Pet Vet-style named save slots: Saves button in topbar opens a modal
      (name input + Save, + New Game, per-slot Load/Delete, current slot highlighted, sub line
      shows coins/pets/love/date). Slots live in petlovers.saves + petlovers.current; actions
      and a 5s tick autosave into the active slot ("Autosave" until named, shown as a 📂 HUD
      chip); autosave paused while the intro overlay is up so + New Game can't clobber a slot;
      boot auto-resumes the most recent slot and migrates the old single petlovers.save into
      an "Autosave" slot; loads reset transient state (minigame/walk/phone/overlays); typing
      in the name field no longer moves the player or toggles the phone. Verified headless.
- [x] balance: food decay 0.34 -> 0.11/s (full belly ~15 min instead of ~5) — "pets need food too often"
- [x] v9: Pet Lovers — every pet's chore minigame is now a different game. Added 4 new
      mechanics (whack = tap before they vanish, sort = tap good/avoid bad, order = tap in
      1→5 number order, meter = stop the marker in the green) alongside catch/chase/timing/
      sequence/shells/mess/scrub. No two species share a mechanic within a task:
      FEED dog catch·cat whack·parrot sort·bunny order·fish meter·crab chase·ferret shells
      (egg under bowls)·pig mess; PLAY dog timing·cat chase·parrot sequence·bunny whack·
      fish catch·crab shells·ferret order·pig meter; WASH dog scrub·cat chase·parrot meter·
      bunny mess·ferret whack·pig sort; CLEAN parrot mess·bunny scrub(hutch)·fish sort·
      crab whack·ferret order·pig meter. Kept the kid-friendly timing tunings; foster pets
      inherit via FOSTER_AS. Verified all 28 combos headless + interaction tests.
- [x] food: shop item is now "Bag of Pet Food 🛍️ — one bag feeds 5 pets" (same 5🪙 / 5 servings);
      out of food = Feed button shows "Need food!" (live-updating) and the minigame can't start
- [x] v10: Pet Lovers — needs director replaces constant decay: pets no longer drain
      stats passively; a need event fires every ~20-32s (first at ~10s) and hard caps
      apply — max 3 pets needing care at once, two with ONE need + one with TWO (≤4 total).
      Need = stat dropped to ~24-34 with a "X needs food 🍖!" popup; canvas alert icon now
      shows for any stat < 55. Sick/at-vet/being-walked pets are skipped. normalizeNeeds()
      settles old decayed saves down to the caps on load. Foster-pet decay unchanged (it's
      the paid job). Verified headless: 30 forced events hold 1+1+2; no passive decay over
      2 min; caring frees a slot; fully-drained save normalizes to 1+1+2.
- [x] v11: Pet Lovers — after caring for a pet it now rests 40-70s (p.restT, saved with the
      pet) before the needs director may pick it again, for both its first need and a
      second one. Stamped on every care completion: feed minigame, treat, play, wash,
      clean-home, own-dog walk, and vet cure. Verified headless: fed pet gained zero new
      needs across 30 forced director events while resting; eligible again after rest expiry.
- [x] v12: Pet Lovers — "can't buy more food" rescue: when broke (coins < 5) with 0 food,
      the next phone call is pulled forward to 4-8s and is always a dog-WALK job (pays
      instantly, unlike fosters which pay after 150s). Normal call cadence untouched
      otherwise. (Feed/treat buttons already show "Need food!" when the pantry is empty.)
      Verified headless: 2 coins + 0 food → walk call ringing within 9s.
- [x] shop UX: broke-player fix — "not enough coins" hint in the shop pointing at phone jobs,
      and buy buttons + hint now live-update while the shop is open (a payout re-enables them)
- [x] shop: toys are stackable (buy multiples, ×N count shown in shop, play bonus caps at 6
      toys); gear (soap/broom/leash) stays one-time Owned ✓; consumables unchanged
- [x] v13: Pet Lovers — phone rework: incoming calls are now ONLY dog-walk jobs (foster
      calls removed; broke-rescue still forces a walk). Fostering moved to a Foster app:
      pressing P opens the phone home screen (note + 🧺 Foster app icon); the app lists 3
      random shelter pets (emoji, name, kind) with Foster buttons — player CHOOSES who to
      take in. While fostering, the app shows the pet + live pickup countdown; when the
      foster leaves, the list refreshes. Back button returns to home; phone always opens on
      home. __t.fosterApp {open, choices, pick} added. Verified headless: 12 forced rings
      all walk-type; app shows 3 choices; picking starts the foster; payout on completion;
      list refresh + Back both work. Screenshot confirmed.
- [x] fix "can't buy food": root cause was test contamination — automated tests shared the
      real localStorage save and had forced coins to 2. Restored coins in the live session;
      added ?test=1 isolated save slots (testsaves/testcurrent, migration skipped) so tests
      can never touch real progress; added shelter pity-drop (+3 food after 20s when food=0
      and coins<5) so being broke never blocks feeding
- [x] overlays un-clipped: removed position:absolute-in-stage from all 5 overlays (they now
      use the shared fixed full-viewport .overlay), panel margin:auto so tall panels scroll
      from the top, touch-action pan-y for touch scrolling, and shop/vet lists lay out fully
      (no inner scrollbox) so every item is visible in one scroll
- [x] v14: Pet Lovers — dogs poo on walks (own-dog AND job walks): up to 3 💩 drop near the
      dog's feet (plop animation), tap to scoop (🧻✨). Poo left at walk's end is "missed":
      job pay -3🪙 each (min 4) with a "you left 💩!" message; own-dog walk meter -10 each
      (min 40) with "Oops — you forgot to scoop!". Walk subtitles now say to scoop. Fixed
      acceptCall's walkRun missing the poo fields. Verified headless: job walk with missed
      poo paid 9 instead of 12; fully-scooped own walk had no penalty. Screenshot confirmed.
- [x] v15: Pet Lovers — Pet Store is now a walkable scene like the vet clinic: walking to
      the shop counter enters HAPPY PAWS PET STORE. Two aisles of 12 shelves (Pet Food,
      Treats, Poo Bags, Soap, Brooms, Leashes, Toys, Pet Beds, Litter & Box, Big Cages,
      Tanks & Water [sand/salt/fresh], Mud & Dirt), an ADOPT A FRIEND pen (up to 3
      unadopted pets), and a REGISTER. Walk near a shelf → item into basket (basket +
      total drawn at top); register auto-puts-back items you can't afford then charges the
      rest; 🏠 Home exits (unpaid basket discarded). New items: 💩 Poo Bags (+1🪙 per poo
      scooped on walks); comfort supplies (beds→dog/bunny, litter→cat, cage→parrot/ferret,
      tank→fish/crab, mud→pig) double that pet's rest between needs via restFor(). World +
      needs pause during the trip. Old shop overlay no longer opens (kept for __t.buy).
      __t.storeTrip {start,home,step,checkout,state,shelves,reg,pen}. Verified headless:
      full shop→checkout, adoption via pen (dog now costs 20 — other instance rebalanced),
      put-back at 15 coins, dupe-block, home discard, beds doubling rest (133s). Screenshot.
- [x] v16: Pet Lovers — store is now tap-to-buy: canvas pointerdown in the store hit-tests
      shelves / adoption-pen pets / register and buys on tap (checkout on register tap);
      taps elsewhere still walk the player. Removed the walk-near auto-add (stepStore is a
      no-op). Hints + intro updated to "tap what you want to buy". __t.storeTrip.click(x,y).
      Verified headless: shelf/pen/register taps all work from anywhere, walking near a
      shelf adds nothing, empty-floor tap falls through to walking.

## Burgle Cats: gem bundles (2026-07-18, session "street fighter/burgle")

- Gacha now has 4 purchase options built from a BUNDLES table: Pull 1💎 (1 cat, as before),
  Triple Pull 3💎 (3 cats, ★★★ Rare+ guaranteed), Epic Bundle 6💎 (4 cats, ★★★★ Epic+
  guaranteed), Royal Bundle 12💎 (5 cats, ★★★★★ Legendary+ guaranteed — gold-highlighted).
  Saving gems = more cats per gem-ish AND a rarity floor.
- Guarantee mechanic: roll normally; if no pull meets the bundle's floor, the last slot is
  re-rolled via rollCatMin(minR) (weighted roll over the >=minR pool, lazily cached per floor).
- Multi-reveal: best cat of the haul gets the big portrait; whole haul renders as a mini
  canvas strip with rarity-colored borders + ✨ for new cats. Single pull unchanged.
- Old #pull-btn removed (listener too); buttons are generated from BUNDLES with data-cost,
  disabled when gems < cost. __bc.gacha grew bundles/bundle/rollMin for testing.
- Verified (browse tab 17, then closed + test localStorage keys cleared): 200 sims per bundle
  type — zero guarantee misses; insufficient gems no-op; single deducts 1; at 2💎 only Pull
  enabled; Royal pull screenshot shows 12💎 deducted, 5-cat strip, Legendary big reveal.
  node --check clean, no new console errors (only the pre-existing file:// manifest pair).
- NOT committed/deployed; sw.js already at v65 pending Dan's deploy.
- [x] v17: Pet Lovers — poo emergency on walks: when the dog poos you get 10s (countdown in
      the walk subtitle) to press B (or tap the shaking "🛍️ Grab a poo bag!" button — touch
      support) and then DRAG the pointer over the glowing 💩 to pick it up (tap-with-bag
      also works; tapping without the bag does nothing). Miss the 10s → you step in it →
      voidWalk(): walk ends instantly with NO pay / no walk-meter fill ("Ew, you stepped in
      it!"). One poo at a time (max 3/walk); the walk can't finish while a poo is pending.
      Meshes with other instance's new gate (poo bags gear required to accept walk jobs).
      __t: walkPoo/bag/scoop. Verified headless: happy path (bag→glow→scoop→paid+tips) and
      void path (held past walk end, voided at deadline, 0 pay).
- [x] v18: Pet Lovers — hygiene stations: LITTER BOX (cat, needs the store's Litter & Box;
      that shelf then sells Litter ×3 refills 6🪙) and PEE PAD (dog, PEE PADS ×3 6🪙 new
      shelf, first-aisle regridded to 7 shelves). Station level drains (~3.5 min per fill);
      stand next to it to top up from supply (🧴/🧻 HUD chips). Empty station → accident
      timer 25-40s (60-90s if you never bought the gear) → pet pees: puddle drawn on the
      floor (max 4, saved), that pet drops no hearts while its puddle sits; walk over a
      puddle to mop (🧽). Accidents pause during store/clinic trips and vet stays. Buying
      the box includes 3 starter litter. __t: hygiene/pee/dryStation. Verified headless:
      slow-vs-fast arming, forced pees, mopping, store purchase both modes, refill/lay,
      no accidents while stocked. (Other instance added pet-naming dialog + house restyle
      mid-test — coexists fine.)
- [x] v19: Pet Lovers — SAND & DIRT is now hermit-crab tank substrate: the MUD & DIRT shelf
      became SAND & DIRT ×3 (6🪙 consumable, 🏖️ HUD chip); third hygiene station TANK SAND
      by the crab's tank — stand next to it to pour sand (level drains like the others).
      No sand → Sheldon hides in his shell (drawn as 🐚), drops no hearts, and sulk
      reminders pop every ~30s (no puddles from the crab). Pig's comfort-supply mapping
      removed (mud item gone). Verified headless: reminder arming, no-puddle sulk, store
      purchase, pour-from-supply, timer clears when filled.
- [x] shop: Aquarium Rocks 🪨 (10🪙, one-time gear) — drawn in the fish tank (+🌿) once
      owned; when the needs system rolls a "bored fish", 50% of the time the fish plays in
      the rocks instead ("playing in the rocks!" pop) and gets a rest breather
- [x] minigame variety (Elise voice feedback: "too much tapping") — two continuous-motion
      mechanics added: 'bowl' steer-to-catch (dog feed: slide bowl under falling bones,
      pointer/finger steering, no taps) and 'bin' drag-and-drop (pig feed: apples → trough;
      parrot clean: feathers → bucket). Verbs now: steer, drag-drop, rub, hold-release,
      stop-the-meter, memory, sort, order, tap.
- [x] v20 (verified, built by concurrent instance): pet-necessity supplies + adoption kits —
      new bottom shelf row (FOOD BOWLS, WATER KIT, CLIMBING SET, HABITAT DIRT, ROCKS &
      PLANTS), per-species SUPPLIES kits (e.g. crab: tank+dirt+sand+bowls+water+climb;
      fish: tank+rocks+water+bowls), and a "meet a pet" adoption flow: choose a pet →
      supply checklist → buy everything at the store → build/place each item at home →
      pet comes home. Fish with rocks sometimes entertains itself. This instance verified
      the full flow headless (choose dog → 5 supplies → checkout ticks checklist → buy →
      5 place steps → adopted, no console errors) and made NO edits to avoid conflicts.
- [x] v21: Pet Lovers — "can't accept walk calls" fix: cause was the (concurrent-instance)
      poo-bags-required-for-walk-jobs gate failing silently — Accept looked dead, reason
      only in a phone note. Now (1) saves with any adopted pet are grandfathered a free
      poobags (walk jobs pre-dated the rule; don't cut off an existing family's income),
      and (2) when you still lack bags the call screen says so: bubble hint + Accept
      replaced by a disabled "💩 Need poo bags!" button. Verified headless both ways.
- [x] v22: Pet Lovers — fish play is now hide & seek in the tank ('seek' mech): 5 tank
      decorations (🪸🌿🪨🐚🌱), Bubbles hides behind one; tap to find, fish pops out then
      swims to a new hiding spot (never the same twice); find 4 within 18s, wrong taps
      flash red. Replaces pop-the-bubbles. Verified headless: full 4-find playthrough
      with wrong-guess flashes, clean finish; screenshot confirmed.
- [x] v23: Pet Lovers — two more store essentials with real perks: 💊 PET VITAMINS (12🪙,
      aisle B 7th slot; sickness cooldowns ×2 everywhere → pets get sick half as often)
      and 🪮 SOFT BRUSH (8🪙, bottom row 6th slot; +15 clean on every wash incl. fosters).
      Regridded aisle B to the 7-slot grid and bottom row to 6 slots (200..700). Verified
      headless: both purchasable at their new spots, wash path applies bonus (clamped test).
      NOT deployed yet. (Left __t.reset out of cleanup — other instance mid-run on shared
      test slots.)
- [x] first pet via the clinic too: freshGame no longer pre-adopts a random starter — every
      pet incl. the first is met at the vet clinic pen. Pocket money 20 → 90 so a first
      dog/cat/parrot/bunny (fee+supplies 57-83🪙) is affordable day one; fish/crab/ferret/pig
      stay earn-up goals. Intro copy updated + bobbing "Meet your first pet here!" arrow at
      the clinic counter while you own zero pets.
- [x] v24: Pet Lovers — you now LOAD new pets into their homes: extended the concurrent
      instance's carrier-release step (dog/cat travel cage) to ALL enclosure pets — after
      building the cage/tank/hutch/pen, the pet waits beside it (bobbing, flashing 🫳) and
      one more tap "puts X into their <home>" ("💕 settles into their new tank!") before
      adoption finalizes. releaseStep()/homeNoun() helpers; placeNext + build-site drawing
      updated. Verified headless: fish needed 4 build taps + 1 loading tap (previously
      adopted on the 4th); screenshot of Mango waiting to be put in their cage.
- [x] pet fights: rival pairs (dog-cat, cat-parrot, ferret-bunny, dog-pig, ferret-parrot,
      bunny-pig) squabble every ~3-5 min (paused during trips/sickness, one drama at a time).
      Dust-cloud scrap with 25s countdown — run over to break it up (both grumpy + messy) or
      one pet gets hurt 🤕 (sick+hurt flags) and needs the existing vet-clinic treatment.
      fightCd saved with load grace; tank pets never fight; intro line added.
- [x] v25: Pet Lovers — lag fixes: (1) emoji sprite cache in em() — each (emoji,size,flip)
      rasterized once to an offscreen canvas then blitted (same as Pet Vet's char cache;
      per-frame color-emoji fillText is the top canvas cost on tablets); (2) the RAF loop
      no longer repaints the canvas while a full-screen .overlay is open — overlays have
      backdrop-filter blur(4px) (shared/game.css) and re-blurring an animating canvas
      every frame is a tablet killer during minigames/walks. Added __t.timeDraw(n) probe.
      Desktop draw 0.15→0.13 ms/frame (tablet wins are the real target); visuals verified
      identical; minigame open/close clean. NOT deployed yet.

## Scroot Rooms: scarier entities, Level Fun rebuild, harder maps (2026-07-19)
- [x] Entities: Clark (feather, peg straps, nails, cheek scratches), Bacteria (ichor drips,
      vertebrae, taut-skin glints, maw strand), Smiler (slit pupils, pointed fangs + dark gullet,
      body & jumpscare), Partygoer (sagging hat, running smile, gloves, confetti), Hound (spine
      knobs, hip bone, mange, whip tail, drool, glowing eye, torn ear, claws), Faceling (head
      cocked 0.09rad, tie, sweat stains, knee dirt, taut-skin mounds). All deterministic.
- [x] Level Fun rebuilt (buildParty): lobby wall w/ 2 doorways, speaker-ring dance floor with
      3-tier cake centerpiece, present-row gift maze, snack-table rows, streamer poles + balloons.
      New PA props: cake, presents×3, speaker, streamer — each with custom 3D boxes.
- [x] Complexity: maze openP 0.5/0.38→0.44/0.3 scaling down w/ level + 1-4 partition runs;
      forest 0.12→0.15 density + 2-5 bramble ridges; grocery aisle cut-throughs + storeroom +
      pallet chokes + carts; garage serpentine dividers w/ nose-in parking (shortcut gap <lvl4);
      school/hospital shared-wall interconnect doors + collapsed-hall barricades (lvl≥2) + ward
      clutter; subway 2 fare-fence lines + kiosk; office partition maze + corner office; factory
      2-4 offset-hatch vat chambers. Door/slide reachability safe by construction (BFS-picked).
- [x] Verified: 52 gens (13 themes × lvl 1/5/10/20) clean, spawn never walled; ASCII map dumps
      confirm garage/office/subway structure; party + all 6 entity screenshots reviewed; hunters
      still catch (Partygoers/Smiler got the idle QA player); tools/test.mjs 31 pages green.
      New __sr QA hooks: clear() / tp(x,y,d) / map(). sw.js → v72 (pending deploy).

## Burgle Cats: capture cinematics + floor-scoped dogs + gacha lure (2026-07-19)

- Decoy vault now plays a cage CINEMATIC (S.cine, input-blocked): 2 alert guard dogs leap
  out of the vault in an arc to the cat's flanks, a birdcage drops with a rattle + CAGED!
  pop, then the capture resolves — and those 2 dogs are permanently added to that FLOOR's
  patrol (spawnDecoyDogs picks the free row cells nearest the vault; rows can now hold 3 dogs).
- Ordinary dog captures got the same cage-drop cine (kind 'cage', capturing dog looms beside).
  capture() is now two-step: fxCaught + set S.cine; resolveCine() applies the state change.
- Dog aggro is FLOOR-SCOPED: rouse(x,y,radius) replaced by rouseRow(y,turns). Spike trap →
  that row chases cfg.chase turns; alarm trap → cfg.chase+3; REAL vault → current row only,
  cfg.chase*2 (replaced the old permanent all-dog 999 hunt). cfg.wakeR removed. Dogs
  otherwise just pace their row randomly — they never head for you unprovoked.
- Real vault open got jackpot juice (gold flash/shake/burst + 💎 JACKPOT! pop).
- Gacha re-themed as BAITS: Kibble Bait 1💎 / Sardine Bait 3💎 (Rare+) / Tuna Bait 6💎
  (Epic+) / Golden Tuna 12💎 (Legendary+). Every pull plays a lure animation on the reveal
  canvas: pitch-black stray (glowing eyes) creeps in, spots the bait emoji ("!"), darts to
  it, cage slams down, then the normal reveal (big best cat + mini strip). drawCage/rrect2
  shared between game + gacha; lure guarded against double-pulls + closes cleanly if the
  panel is dismissed mid-animation.
- __bc grew: cine(), gacha.luring().
- Verified headless (dedicated tab 10 + chain to dodge tab hijacking by other instances;
  tab closed + test localStorage cleared after): decoy → cine 'decoy', dogs 5→7 with 3 on
  that row, captures/phase correct, mid-cine screenshot shows dogs+cage+CAGED!; spike trap
  row 1 → only row 1 dog chases; real vault row 3 → only row 3 chases; Golden Tuna lure
  animation screenshots (cage-slam frame + Legendary reveal with 5-mini strip); no JS errors;
  node --check clean. NOT committed/deployed (sw.js already at v65 pending).
- [x] v26: Pet Lovers — investigated "home/More/choose-pet not working": could NOT reproduce
      on (a) current working copy, (b) the EXACT live v71 html byte-for-byte, (c) a save
      stuck mid-build. All three flows pass headless via the real user path (vet counter →
      Visit → pen). Likeliest cause: a torn deploy snapshot — 3 deploys today from a
      working tree both instances edit live; a mid-edit sync = script parse error = every
      button dead (matches symptoms exactly). Fix for Elise: full reload (sw is network-
      first). PROCESS FLAG: deploys should happen from committed state or with instances
      coordinated, never from a mid-edit tree.

## Burgle Cats: real-game fidelity pass (2026-07-19, same session)

Researched the actual PONOS game (web: mrguider/appgamer/miraheze/fandom snippets; the
detail pages are Cloudflare-blocked headless). Key real mechanics adopted:
- DROWSY DOGES, SAFE TO PASS (the real game's core stealth loop): calm doges are harmless —
  walking into their room or them wandering into yours does nothing ("🤫 You slip past the
  drowsy doge…"), and they're drawn dozing in your room. Only noise (spike clatter, alarm
  bell, creaky chest lids, the vault jackpot) alerts that FLOOR's pack; alert dogs beeline
  and capture on contact, incl. waking up with the cat in their room. Alert wears off back
  to drowsy. (Kept them roaming per Dan's earlier request — real game has them asleep in
  place; drowsy-wandering preserves both.)
- TREASURE CHESTS (real game: "snatch as much treasure as you can"): 3-6 chests/manor,
  +20×level loot on walk-in, 35% creaky lid wakes the floor. Chest sprite (closed/opened
  w/ gems), minimap gold squares, drawn in room + map views.
- SPIDERWEB TRAP (real game has movement-hampering traps): silent, no damage, snares the
  cat — next move is spent wriggling free (S.stuck). Web sprite w/ spider, drawn LARGE
  (0.62) in room view so it peeks around the cat. Trap kinds now cycle spike/alarm/web,
  traps 5+level. Map view now draws proper alarm/web sprites too (was spikes for all).
- Real game manor = 3 roaming doges + 2 hidden in fake vaults — our decoy-dog spawn
  already matches that shape.
- Verified headless (bc-test.js in dedicated tabs; HEAVY tab hijacking from concurrent
  instances — single atomic chains newtab+eval+screenshot was the only reliable recipe):
  drowsy walk-in safe, alert walk-in captures (cage cine), web stuck=1/no hp/turn wasted/
  then free, chest +20 loot, trap kind distribution 2/2/2 at L1, screenshots of chest+
  drowsy-doge room and web room. node --check clean, no JS errors.
- NOT committed/deployed; sw.js v65 still pending.

### Follow-up (same day): realistic 3D props, better characters, scarier jumpscares, no red alert
- [x] Removed the red proximity pulse entirely (nearHunter gone, per request)
- [x] Real multi-part 3D models in boxesFor: cars (wheels/body-color-by-spot/bumpers/glasshouse/
      roof/headlights), chalkboards (frame/slate/tray/chalk), lockers (kick/seams/vent), desks
      (legs/chair/workbook), gurneys (mattress/pillow/rails/legs), stocked shelves (goods rows
      vary per spot), freezers (glass doors), trains (under-skirt/window band/red livery/roof +
      open doorway on door cars), turnstiles (tripod arms), benches (slats/iron ends), columns
      (plinth/capital), cubicles (cap rail/monitor+glowing screen/papers), vats (rim/dome/pipe),
      party tables (cloth/punch bowl), speakers (grilles/glow trim), wheelchair, IV stand, cart,
      lollipop, gumball machine, balloons, subsign, log, cooler
- [x] Characters: grounding contact shadows under all hunters + corpses (not Smiler), high-quality
      upscaling
- [x] Jumpscare: two-phase hang-then-SNAP lunge, motion-smear ghost, crushing iris vignette,
      signal-loss static bursts + horizontal screen tear, white blink at the snap; screech gains
      a 58→27Hz sub-bass slam + late-arriving 880/932Hz shriek pair
- [x] __sr.scare(type, jumpT) + freeze() QA hooks; verified: train livery/school lockers/garage
      car/grocery shelves/party + Clark snap-frame screenshots, 13-theme live render sweep clean,
      tools/test.mjs green. sw.js → v73 (pending deploy)

### Follow-up (2026-07-19): real-time dogs, safe side columns, spike DoT, Jimmy the Mythic
- Dogs now move in REAL TIME on their own clocks (simTick, called from the frame loop):
  one room per 1.5s drowsy / 1.0s alert, whether or not the player moves. All turn-based
  dogesTurn() calls removed; Speedy remaps to a 1.35x interval slowdown; chaseT now counts
  alert steps (~seconds). dt is capped 0.05/frame so backgrounded tabs slow the sim (fine).
- SIDE DOOR COLUMNS ARE SAFE GROUND: dogs can never enter x=0 / cols-1 — even chasing a
  cat standing there (enterable() requires !shutter for the cat's cell too). Verified: an
  alert dog hunted a door-camping cat for 12 sim-seconds, paced at x=1-2, never captured.
- Spikes now damage-over-time: standing on a sprung spike ticks 40% of trapDmg (tough-
  reduced) every second until you leave (can kill). Room view draws spikes ARMED under
  your paws; verified 3 ticks x7 dmg in 3.1s, stops on leaving.
- JIMMY THE RACCOON, rarity 7 MYTHIC (#ff8ad8, w=1 like a single Secret): GACHA_N 300→301,
  index 300; raccoon coat (eye mask, pale muzzle/brow/belly, setLineDash ringed tail);
  +26 HP / Tough 55% / Speedy / Vault Sense; 'MYTHIC ·' reveal prefix; realistic odds path
  is the Golden Tuna Legendary+ guarantee pool (~2%). gOwned() PADS old 300-length saves
  (no collection wipe).
- New __bc.tick(dt) = simTick for deterministic headless testing (tab-hijack-proof single-
  eval tests; the shared daemon was extremely contended this session — real-time waits in
  background tabs are RAF-throttled and useless, atomic eval + tick() is the recipe).
- Verified: all 5 dogs step once per interval standing still; side ban; DoT; rollMin(7)
  → Jimmy; forced pull → lure → "Jimmy the Raccoon ✨NEW / MYTHIC ★★★★★" reveal screenshot;
  node --check clean; test storage cleared. NOT committed/deployed (sw.js v65 pending).
- [x] v27: Pet Lovers — clinic "not working" root cause: a mid-BUILD adoption hard-blocked
      choosing any other pen pet, with only a 1.4s fading popup as explanation — to a kid
      (esp. on mobile) the whole clinic looks dead. Fixes: (1) never trap — tapping another
      pen pet mid-build REFUNDS the paid adoption and switches to the new pet (verified:
      +200🪙 refund, clean switch to shop stage); tapping your own mid-build pet says
      "Go home and tap X's spot to build!"; (2) mobile touch fixes — pen hit radius 44→54,
      MORE arrow 30→42 (off-center taps land), canvas touch-action:none so taps never
      become scroll gestures; (3) all clinic flows re-verified with touch-flavored events
      (pointerType:'touch' + touchstart, no click). NOT deployed yet.
- [x] toys: every species now has ≥2 dedicated toy types (added Birdie Mirror, Play Tunnel,
      Tank Castle, Coral Playset, Rattle Ball, Splash Pool) on top of the per-species toy
      system (toysFor gating, "needs a dog toy" messaging, store prioritisation) that the
      concurrent instance shipped; teddy + puzzle stay universal. 18 toy types total.
- [x] v28: Pet Lovers — To-Do app now lists ONLY buttonless jobs: removed per-pet
      feed/play/wash/clean/walk lines (care panel + pet alert icons already cover those)
      and the foster line (basket has buttons); kept adoption pipeline, sick→vet trips,
      station refills, puddle mopping, out-of-food; added "buy poo bags" when unowned.
      Verified headless: with 4+ active pet needs the list shows zero chore lines.
      Deployed (targeted pet-lovers cp + invalidation).
- [x] "clinic still not working" diagnosis: engine + input flow verified working end-to-end
      (trip start from vet panel, walk-at-clinic, wrong-room hint, right-room treatment, cure,
      home). Root cause of user-visible breakage: stale client — live sw.js was v71 (local
      v73) and the offline-first SW serves cached pages until a new SW installs. Ran
      tools/deploy.sh: sw.js v74 live, full sync + CloudFront invalidation completed.
- [x] clinic dead-inputs report (round 2): could not reproduce his exact freeze on fresh,
      migrated-legacy, or virgin saves (all flows pass incl. real pointer events). Fixed the
      real bugs found while hunting: (1) vet/shop counters now win proximity vs pet spots
      (dog bed could block the vet panel), (2) canvas draw-freeze now limited to the 5 known
      overlays and never during trips (stray overlay can't freeze the screen), (3) plain
      clinic visits: Dr. Paws + rooms respond with friendly pops instead of dead silence,
      (4) on-screen error beacon (red bar with message/line) + __t.debug() dump. Deployed.
- [x] CLINIC FREEZE ROOT CAUSE (via the new on-screen beacon, Dan's screenshot):
      draw()'s clinic block did spOf(clinicTrip.key).em with key=null on PLAIN visits
      (the carry-your-pet visual, added for treatment trips) → TypeError every frame →
      RAF loop dead → frozen screen, all canvas input apparently dead, home button
      "disappearing". Treatment trips were unaffected, which is why every treatment-flow
      test passed. Fixed (guard on clinicTrip.key) + loop body now try/catch-wrapped so a
      bad frame reports to the beacon instead of killing the game. Deployed v76.
      LESSON: never grep-filter console output when hunting a bug — the TypeError was in
      my earlier console dump but filtered/tail'd away.
- [x] v29: Pet Vet (grindy-vet) — LEGENDARY adoptions: 2% of adopted cats/dogs are a named
      legendary with a fixed name (never renameable — no naming exists in Pet Vet anyway).
      Cats: Mona (calico), Smidge (tortoiseshell), Kuku (tuxedo), Mimi (calico-tortie),
      Sweet Pea (snowy calico). Dogs: Funny (border collie, medium-small), Pijiu (all-white
      corgi), Milo (english cream retriever, larger) — dogs adopt out at their true breed
      size/kind. Shown via: golden 2.6s "✨ LEGENDARY! <name> joins a family!" floater,
      custom coat colors + patches on the drawn pet (sprite cache bypassed for legends),
      and a persistent gold "✨ name" tag over the pet (over the carrier for cats).
      __t: forceLegend(), legendPool(), visitors().legend. Verified in-sim: full pipeline
      (desk+receptionist+adoption room+worker clerk) → Milo adopted at step 812 with tag
      visible in screenshot; cat path → Kuku. NOTE: adds one Math.random call per adoption
      (parity harness sequences shift). NOT deployed yet.
- [x] v30: Pet Lovers — hamster (foster Pip) had no visible toys: added 🎡 Hamster Wheel
      (10🪙, ferret-family toy → works for hamster fosters via FOSTER_AS and for ferrets);
      toy descriptions now name the foster pals (yarn: kittens, bell: chicks, carrot:
      hedgehogs, shells: turtles, sock: hamsters); foster play refusal message now says
      "Pip the hamster plays with ferret toys (or any teddy) — pet store!" instead of the
      confusing bare "needs a ferret toy". Verified headless: play blocked without suitable
      toys, wheel purchasable from the cycling toys shelf, play works after. NOT deployed.

### Follow-up 2 (same day): 30-min improvement session — audio + game-feel
- [x] Per-theme procedural ambient beds, all null-guarded: fluorescent hum (yellow/office/school/
      hospital/grocery), echoing drips (pool/sewer), gusting wind (forest), deep rumble + distant
      squeal (subway/garage), settling creaks (haunted), machine thump + relay clack (factory),
      muffled 4-on-floor party through the wall (Level Fun). stopAmbient on scare/slide/door.
- [x] Positional hunter audio (stereo pan + inverse-square falloff, 12-tile radius): Clark boot+peg,
      hound growl, bacteria squelch, partygoer giggle, smiler hiss, faceling shuffle; faster cadence
      while chasing. Spotted-you sting (per-type pitch) + 0.35s freeze + 1.6s 1.18x burst chase.
- [x] Footsteps every 0.58 tiles (alternating), head-bob + sway scaled by actual movement
- [x] Doors: step-through white bloom (0.5s) + latch/creak sfx + after-glare fade-in; slides get
      falling whoosh + same fade-in
- [x] Jumpscare screech per entity: register table (hound 55Hz…smiler 590Hz) + noise shaped
      lowpass/highpass per hunter
- [x] Verified live: door walk-through lands in target theme; spot→freeze(alertT)→burst→catch→over
      chain via localStorage-atomic test (shared daemon races dodged); 7-theme cycle with live
      AudioContext error-free; tools/test.mjs 31 pages green. New hooks: state/theme/doorsAt/
      hunterInfo. sw.js → v79 (pending deploy)

### Polish pass (2026-07-19, "spend 30min improving it")
- SOUND: tiny WebAudio synth (no asset files, file:// safe) — 14 effects: paw steps, sneak
  notes, spike crunch (noise burst + saw drop), web boing, alarm bell, dog bark on wake,
  chest jingle, cage clang (game cine + gacha lure), decoy sting, jackpot/win/lose
  fanfares, UI pop, rarity-scaled reveal arpeggio (longer for rarer, 8 notes for Jimmy).
  AudioContext unlocks on first gesture; 🔊/🔇 mute button in the topbar persists via
  burgle-cats.mute. sfx() no-ops safely when muted/unavailable; exposed as __bc.sfx.
- DUPE TRADE-IN: duplicate pulls feed the strays — points by rarity (1/2/4/8/15/30/60),
  every 20 auto-converts to +1 💎 (banked synchronously in doBundle via bankDupes).
  "🍖 Dupe points: N/20" line in the gacha panel. __bc.dupe getter. Verified: pre-owned
  Jimmy dupe pull = +60 pts -> +3 gems with 5-pt remainder shown in UI.
- FLAWLESS BONUS: winning with zero captures pays +2 💎 total ("🏆 FLAWLESS — no cats
  caged!"). Verified +2 on a 0-capture win.
- SMOOTH DOGS: per-dog px/py eased toward grid cell each frame (dt*9) — dogs glide on the
  map + minimap instead of teleporting on their 1.5s/1.0s clocks.
- DANGER TELEGRAPH: when an ALERT dog is in an adjacent room, its doorway pulses red with
  a 🐕 icon (drowsy dogs stay hidden — blundering is still on you). Minimap now tints
  alerted floors pulsing red. Screenshot-verified both.
- Verified via atomic newtab+eval chains (bc-imp2.js/bc-vis4.js); all sfx smoke-ran
  without exceptions headlessly; node --check clean; test localStorage keys (incl. new
  dupe/mute) cleared; my tabs closed. NOT committed/deployed (sw.js v65 pending).

## Mob Soccer: realistic slide tackles + fouls (2026-07-19)

- REPLACED instant guaranteed steals with committed SLIDE TACKLES (attemptTackle/
  resolveTackle): press F near a carrier -> burst lunge (2.2x speed cap during slide),
  resolves on CONTACT (r+r+20). Clean tackle POKES THE BALL LOOSE (vx along slide dir,
  freeCD 8 — not glued to the tackler); the carrier stumbles. Missed tackle = tackler on
  the grass (down 40, 💫), beaten by the dribble. Success: 72% front/side, 50% from behind,
  ±mass bonus. Tackle costs 5 stamina, 60-frame cooldown.
- FOULS: failed tackles roll a foul — 45% from behind, 15% front. Foul = ✋ FOUL!/🟨 YELLOW
  CARD! (every 2nd team foul books), tackler down 70, FREE KICK restart to the victim at
  the spot (reuses restart()). Team foul counts on teams[].fouls.
- FREQUENCY: AI defenders (incl. your AI teammates) attempt tackles only within 115px on a
  55-130-frame cooldown (~1-2s) — knobs in the TK const. Body contact NO LONGER steals:
  only the GK smothers on contact (🧤 SMOTHERED!) — dribbling/shielding is real now, so
  possession changes via discrete tackle events. Measured AI-vs-AI: ~12 slides + 2 fouls
  per 20 sim-seconds.
- Visuals: sliding mobs rotate feet-first along the slide direction w/ grass-spray dots;
  downed mobs lie flat with 💫 until they get up. Works in both renderers (mob + UT card).
- Test hooks: __t.step(n) deterministic stepper, __t.attempt/tackle/pstate/fouls/p/ballRaw/TK.
- Two bugs found via step-debug: moveMob's speed cap clamped the lunge to walking pace
  (slides never reached the carrier from behind), and the contact window (+10px) sat inside
  mobCollide's separation distance. Fixed (slide cap 2.2x, window +20px).
- Verified deterministically (600 scripted tackles): front 67% clean/20% of fails foul;
  behind 49% clean/49% of fails foul; shielding holds 90 frames of contact; clean tackles
  leave a loose ball; foul->free-kick flow + slide/prone poses screenshot-confirmed.
  node --check clean on all 3 scripts, no console errors. NOT committed/deployed (sw v65 pending).

### Follow-up 3 (2026-07-19): open atriums + furniture phasing into walls AND floors
- [x] buildMaze carves 1-2 big pillar atriums (7-10 x 5-7, even/even pillars kept) into every
      maze theme; atriumCells tracked for glitch pooling
- [x] Glitches now have wall + floor modes: floor pieces half-swallowed (22%-62%), slowly bobbing
      through the slab (drawSprite srcH top-slice support); pool in atriums; 3rd glitch img
      (filing cabinet, middle drawer out); Yellow Halls ALWAYS unstable, others lvl>=2 roll as before,
      poolrooms still excluded; floor count scales 3..8 with depth
- [x] Verified: yellow always has both modes (lvl 1/5/12), haunted/sewer roll correctly, pool never;
      floor glitches placed clustered in atrium; screenshots show sunk crate bobbing + wall crate;
      no console errors; smoke 31/31; sw.js → v80 (pending deploy). __sr.glitchInfo() hook added.

# Hog Ball — full 2K-style sim upgrade

## Spec
Make Hog Ball play like a modern sim basketball game, adapted to the existing
2D canvas 3-on-3. Original mechanics/assets only.

## Tasks
- [x] Fix latent bug: bare `pick()` (no EL.pick alias) broke crossover dribble moves
- [x] Four 45s quarters (was two 90s halves), team fouls reset per quarter, bonus at 5
- [x] Timed 30s overtime periods (repeat while tied) instead of sudden death
- [x] Release feedback: VERY EARLY/EARLY/GREEN/LATE/VERY LATE + OPEN/CONTESTED/SMOTHERED
- [x] And-one: made shot + shooting foul = points count + 1 FT; 3 FTs on a fouled 3PA
- [x] FT rework: same vertical timing meter as jump shots (tap to stop in the green)
- [x] Takeover: 3 straight makes = 1.6x green window, +8% speed, golden aura; miss cools off
- [x] Turbo sprint: Shift (P1) / 5 (P2) + touch buttons; 1.4x cap, 5x stamina drain
- [x] Pump fake: quick shoot tap with ball; baits CPU defenders (0.55/iq chance)
- [x] 8-second backcourt violation
- [x] Fatigue shrinks the green window (0.7 + 0.3 * stamina)
- [x] Broadcast: quarter HUD + bonus chips, commentary lower-third, halftime box score
- [x] Headless verify via browse daemon (HB API): green make + stats + heat, takeover
      at heat 3, 3-shot FT trip w/ green +1, 8s turnover to CPU, quarter rollover
      (period 2, clock 45000, fouls reset). Screenshot: HUD/turbo button/hints OK.
- [x] Commit f39f432, sw.js cache v83, deployed to S3 + CloudFront invalidation

## Review
All shipped in hog-ball/index.html (single-file game, classic script, file:// safe).
Key decisions: kept the state name 'half' for all period breaks to avoid churn;
HB.state() now returns `period` (with `half` alias); HB gained ftFill/turbo/pump
hooks. OT is timed and repeats while tied — basket() no longer sudden-death ends.
NOTE: this file was accidentally overwritten by a concurrent-instance race
(read → other instance appended → my write clobbered); restored from git and
re-appended. Lesson recorded in tasks/lessons.md.

# Hog Ball — Card Shop, Superstar Spinner, Full Court Press
- [x] Shop overlay (main menu + season hub): 4 card packs (Starter $8M / Pro $18M /
      Elite $32M 4★+ guaranteed / Legend $55M 25% legend), odds shown on pack art
- [x] Superstar Spinner: canvas prize wheel, $10M/spin, 8 segments incl. LEGEND slice,
      eased landing animation, cash/card/legend payouts, full-club cash fallbacks
- [x] Full Court Press boost: $25M, gated behind 3 total wins (career + quick-play),
      toggleable; on-ball gap -8 + off-ball sag 0.12 for team 0 in season games, HUD chip
- [x] 4 legend foil cards (Golden Hog/Midnight Moo/Emerald Fizz/Baron von Brains) with
      stat bonuses, painted card art (rarity gradients, foil sparkles, OVR/pos badges,
      blocky portraits), card-back design, pack flip reveal, mini-cards in lineup slots
- [x] Save migration (items/totalWins), duplicate→cash conversion, HB shop test hooks
- [x] Verified headless: pack buy/economy, flip flow, FCP lock at 0 wins → buy at 3,
      forced legend spin lands + pays out, pressing(0) true in career game only
