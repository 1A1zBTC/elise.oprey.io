# Lessons

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
