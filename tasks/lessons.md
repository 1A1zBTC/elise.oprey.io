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
