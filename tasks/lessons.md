# Lessons

## Never mutate state inside a per-frame draw closure
- 2026-07-04: Pet Vet's `drawDoorOpening()` ended with `doorways.push(...)`. It was written
  to run once at collect time, but the refactor moved it into a per-frame wallSegs draw
  closure — so every frame added duplicate doorway entries, and update()/draw() loops over
  `doorways` grew unboundedly. Symptom: performance degrades over minutes of play, resets
  when renderStatic runs (e.g. entering build mode) — which misdirects blame to "walls".
- Rule: draw functions must be pure rasterization. Registration/state mutation belongs at
  collect/build time. When perf degrades OVER TIME (not constant-slow), hunt for an
  unbounded collection first: log `.length` of every array touched per frame.
- Companion fix: static geometry drawn per frame (walls/shelves/decor) can be sprite-cached
  at collect time — rasterize each depth-sorted segment once to a small offscreen canvas and
  swap its fn for a drawImage blit; depth interleaving with actors is preserved because only
  the fn body changes. Camera translation (no zoom) ⇒ sprites are camera-invariant, no
  re-bake on pan. 2.6× draw speedup in Pet Vet with 0 visual diff.
- Extensions that compounded it: (a) key wall sprites by CONTENT + edge DELTA (not absolute
  position) so identical segments share one sprite and the cache survives rebuilds — kills
  the re-bake hitch; (b) the same lazy sprite cache works for ANIMATED characters by
  quantizing the walk/gait sine into ~7 buckets (≤0.5px error, invisible) and mapping the
  bucket back through asin for an exact baked pose; (c) don't forget the cheap-looking
  killers — per-frame createRadialGradient (shadows) and fillText (emoji bubbles) cost as
  much as whole figures; cache those as shared sprites too. Crowd draw 6.96→4.31ms (1.61×).

## Pet Vet: adding a room type needs more than the ROOM_TYPES descriptor
- 2026-07-04: Added a Grooming room. The `ROOM_TYPES` registry drives place/canPlace/free/door,
  but several sibling functions enumerate the room arrays by hand and each must be extended too:
  `inWalledRoom()` (MISSING it makes the new room's floor render as a corridor carpet + breaks
  isPlainCorridor/isOpenAdj/door classification), `roomWallEdge()` (visitors phase through the
  walls without it), `roomAt()`/`removeRoom()`/`cancelPlacing()` (pickup/remove/abort), the
  `['exam','xray','restroom','pharmacy','shop']` list in the wall-render pass, `inWalledRoom`,
  save (`buildSave`) + load (`applySave`) + `resetTransient`/`newGame` array clears, and
  `tryPlace`/`drawGhost` dispatch. Grep the shop's id across the file (`shops.some/forEach`,
  `=== 'shop'`) to find every parallel site before declaring done.
- Verify a new room by driving a real dog through it headlessly (window.__t) AND screenshotting —
  the carpet-floor bug was invisible to node --check + smoke; only the screenshot caught it.


## Don't assume a game's genre from its name — research the actual mechanics first
- 2026-06-29: Asked to add "Burgle Cats" (a PONOS game). I assumed from the PONOS/Battle Cats
  connection that it was a lane-pushing battler and built a whole lane-battler. Wrong genre —
  The Burgle Cats is a turn-based stealth HEIST PUZZLE (sneak a crew through a manor, dodge
  sleeping guard doges + traps, find the real vault among decoys, escape via a shutter; 3
  captures = bust). Had to rebuild from scratch.
- Rule: when cloning/recreating a named real-world game, web-research its real mechanics BEFORE
  building (sources: fandom/miraheze wikis, appgamer guides). One quick search would have saved
  a full wrong build. Also: recreate mechanics/genre only — never copy the original's art,
  character names, or exact stats (IP); ship original assets.

## Never run `git restore .` / discard without inspecting the diff first
- 2026-05-30: User asked to "revert all changes since the last commit". I ran `git restore .`
  immediately. One of the wiped files (`battleships/index.html`) had uncommitted work the user
  cared about (weapons). Because the changes were never staged/committed, they are
  unrecoverable from git, and I never read them so they aren't in any transcript either.
- Rule: before any destructive revert/restore/checkout that discards working-tree changes,
  FIRST `git diff` (and ideally `git stash` instead of restore) so the work is recoverable.
  Show the user the diff/summary of what will be lost, especially when "all changes" spans
  multiple files. A stash is reversible; `restore` is not.

## Deploying elise.oprey.io: git push does NOT deploy — push to AWS S3 + invalidate CloudFront
- 2026-06-20: After adding Hungry Pig and Naughty Shelf I committed + pushed to GitHub and told
  the user it would go live. It did not — the live site is hosted on S3, not GitHub Pages, so
  the push deployed nothing (Hungry Pig had been "pushed" days earlier and still wasn't live).
- The site serves from S3 bucket `s3://elise.oprey.io` (us-east-1 website endpoint) behind
  CloudFront distribution `EDR208IJW4SS7` (alias elise.oprey.io). AWS CLI auths as IAM user
  `claude` (account 212911667782).
- Deploy steps (after committing): upload changed files WITHOUT `--delete` so other games are
  untouched, then invalidate CloudFront:
  ```
  aws s3 cp index.html s3://elise.oprey.io/index.html --content-type text/html
  aws s3 sync <game>/ s3://elise.oprey.io/<game>/
  aws cloudfront create-invalidation --distribution-id EDR208IJW4SS7 \
    --paths "/" "/index.html" "/<game>/*"
  aws cloudfront wait invalidation-completed --distribution-id EDR208IJW4SS7 --id <id>
  ```
- Rule: "ship/publish/go live" for this repo = git commit/push (source control) AND the S3 +
  CloudFront deploy above. A push alone never updates the live site. Verify with
  `curl -o /dev/null -w "%{http_code}" https://elise.oprey.io/<game>/`.

## Shared assets + tooling (2026-06-29)
- Games now share `/shared/game.css` (palette as CSS variables + topbar/overlay/panel/
  scoreline/start-btn/stage/reset) and `/shared/game.js` (`window.EL`: playerName, best(key),
  rnd/rint/pick/clamp/lerp/dist2/shuffle, canvasPos). Each game links both; per-game files keep
  only their own styles + value-differing overrides, and alias helpers (`const pick = EL.pick;`).
- New add-a-game / change workflow: create the game dir, then run `node tools/build-sw.mjs`
  (auto-regenerates sw.js PAGES from the dir listing, keeps shared assets in ASSETS, bumps
  CACHE), then `tools/deploy.sh` (build-sw + `aws s3 sync` + CloudFront invalidate). No more
  hand-editing sw.js or remembering the cache bump.
- Tests (dependency-free, no npm): `node tools/test.mjs` runs unit tests for the EL.* helpers
  AND the headless smoke test (`tools/smoke.mjs`: loads every game + launcher, asserts no console
  errors and that pages linking /shared/game.js expose window.EL). Run it after editing shared/
  or any game. Smoke skips gracefully if the gstack browse binary isn't installed.

## CSS-leak gotcha when extracting shared component rules
- 2026-06-29: When a game keeps a shared-named rule (e.g. `body`, `.stage`) as an override, the
  override CANNOT remove properties the shared rule sets — it can only change/add. So shared
  `body { justify-content:center; touch-action:none }` LEAKED into DOM/board games that were
  top-aligned + scrollable, re-centering tall boards and blocking touch scroll; and shared
  `.stage { max-width; border; aspect-ratio }` LEAKED into scroot-rooms' full-bleed `position:fixed`
  stage, constraining it.
- Rule: when a game relies on the ABSENCE of a shared property, explicitly reset it in the
  override (`justify-content:flex-start; touch-action:auto; max-width:none; aspect-ratio:auto;`
  etc.). Verify by reasoning about the cascade AND by measuring `getComputedStyle` at both mobile
  and desktop widths — not just eyeballing the start screen.
- QA caveat: the service worker serves precached pages cache-first, so after editing a file the
  browser may show a STALE copy. QA on a fresh port (new origin) or with a `?v=N` cache-bust
  query, or unregister the SW + clear caches first.


## Chase odd states seen during verification — don't explain them away
- 2026-07-18: While verifying Street Fighter art changes, a screenshot showed a fighter in
  state 'down' and I wrote it off as "mid hit-flash, not a bug". The 'down' state was actually
  a pre-existing permanent freeze (no code path ever left it), which the user then hit as
  "1P can't move or attack". The clue was in my own verification output and I moved past it.
- Rule: when a verification probe surfaces a state you didn't expect (a fighter 'down' while
  the scene looks idle, a counter that isn't what the code implies), trace the state machine
  transition OUT of that state before declaring it fine. For games: verify the HUMAN input
  path by actually playing a few seconds (move + attack + get knocked down + recover), not
  just CPU-vs-CPU sims and special-case hooks.

## 2026-07-26 — Shared-file clobber via stale read (tasks/todo.md)
Read tasks/todo.md early, then Write'd it much later; a concurrent instance had
appended ~830 lines in between and my Write wiped them (restored from git).
Rule: for shared cross-instance files (tasks/todo.md, sw.js, shared/*), re-read
or check mtime IMMEDIATELY before writing, and prefer append (cat >>) over
whole-file Write. Also: sw.js cache version may be bumped by the other instance
mid-session — re-check the current version right before bumping.

## Raycaster verticality (scroot-rooms, 2026-08-02)
When adding a camera height to a Wolfenstein-style raycaster, GENERALISE the
existing projection instead of adding special cases: every screen y is
`halfH + (eyeZ - z) * (RH / dist)`. Setting eyeZ = 0.5 and ceilH = 1 reproduces
the original formulas exactly, so the change is provably a no-op on old content
(A/B it against a `git show HEAD:file` copy served alongside).

## Deterministic sim stepping beats real-time key presses
Testing movement/AI through RAF + dispatched KeyboardEvents is flaky because the
loop keeps running between browse commands. Expose `__sr.step(n, dt)` (call
update() n times directly) plus a `key(k, down)` shim and assert inside ONE js
call. This is what caught the "slow entity reads as wall-bump and spins" bug.

## Sim games: AI helpers need a different policy from the player (2026-08-02)
Smeeche's Lasagna shipped with the sous chef reusing the player's "nothing to do?
cook the dearest dish" fallback. For a human that's a nice prep affordance; for an
always-on agent it filled every pass with unordered plates and starved the real
tickets until they all timed out at 1 star. Same for the purchaser: reusing the
player's "how much is in the pantry" number made it re-buy forever once storage was
full. Rule: when an employee/automation shares a helper with the player, check
whether the *fallback* branch is safe to run continuously — usually it needs a
`ticketsOnly`-style flag and a resource count that includes everything you own, not
just what's tidied away.

## Look for livelocks in resource loops, not just deadlocks (2026-08-02)
The nastiest bug was self-inflicted starvation: storage filled with the wrong
ingredient, so the crate holding the needed one could never be unpacked, so nothing
was consumed, so no space ever freed. It only showed up in ~1 of 3 long hands-off
runs. Catching it needed a *time-series* probe (pantry levels every 50s), not an
end-state assertion — the end state looked merely "bad", the series showed `veg=0`
frozen while crates sat on the floor. When testing a sim, sample the resource
counters over time and look for a value that never moves.

## Tune game-feel with a headless self-play harness, not by eyeballing it
- 2026-08-09: Reworking Hog Ball's steals/pacing, every intuition I had about the
  numbers was wrong until I could measure. Adding `HB.demo()` (both benches AI) +
  `HB.sim(frames)` (synchronous update() loop, no RAF) + event counters turned a
  guessing game into arithmetic: full 6-minute games ran in seconds, so a 24-game
  balance sweep was cheap.
- What it caught that watching never would have: 26% of ALL passes were being
  intercepted (passes peaked at z≈23 under a z<26 catch ceiling, so they never once
  cleared a defender's head); a shot-selection rule that pinned the ball-handler at
  a fixed radius and produced 5 shots per GAME; off-ball players stacking on the
  same spacing spot; 6-12 over-and-back turnovers a game.
- Rule: before tuning a simulation's feel, build the self-play harness and count
  events per game. State a target from the real sport (NBA ~47% FG, ~15 steals,
  ~1.85 FGA/min/team), then tune until the numbers land. Screenshot only to confirm
  the picture matches the numbers.
- Corollary — beware small-sample balance claims. Intermediate runs read 1-11, 2-10
  and 3-13 (all "obviously" a side bias) and 7-7 and 5-5 from the same code. Only a
  24-game run settled it at 12-12. Low-scoring games have huge variance: compare
  TOTAL POINTS (low variance per unit compute), not win counts.
- Corollary — an asymmetry hunt should start by deleting the asymmetry's *hiding
  places*: three separate `side === 0 ? x > ... : x < ...` half-court tests were
  rewritten to derive from `attackDir(side)`. Even when that turned out not to be
  the bug, it removed a whole class of suspects for free.

## Shared browse daemon: other Claude instances will steal your tab
- 2026-08-09: Mid-QA, `HB.hoop` started throwing — the daemon's active tab had been
  navigated to a different game by a concurrent instance. Symptom is confusing: every
  `js` call fails, including trivial ones, and `console` shows no errors (it's a
  different page).
- Rule: for any multi-step browser session, claim a dedicated tab up front with
  `browse newtab <url> --json`, keep the returned tabId, and prefix each command with
  `browse tab <id>`. Check `browse url` first when JS calls start failing for no reason.

## shared/game.css forces `canvas { width:100%; height:100% }` — pin every non-stage canvas
- 2026-08-09: Building Hog Ball's My Team card screens, the upgrade button under each
  card was in the DOM with a real 105x22 rect but invisible on screen. Cause: the shared
  stylesheet sizes the responsive game canvas with `canvas { display:block; width:100%;
  height:100% }`, which also caught every little card canvas — a 92x129 card rendered
  105x191, overflowing its parent so the siblings below it drew outside the visible box.
- Rule: any `<canvas>` created for UI (cards, previews, thumbnails, sparklines) in these
  games must set `cv.style.width`/`cv.style.height` to its intrinsic size, or carry an
  explicit CSS rule. Setting only the `width`/`height` attributes is not enough.
- Diagnostic that found it fast: compare `getBoundingClientRect()` of the container and
  each child. When a child's `bottom` exceeds the parent's `bottom`, something is
  stretching it — don't keep re-screenshotting, measure the boxes.
