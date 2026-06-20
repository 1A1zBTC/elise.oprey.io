# Task: Add a new game — Hungry Pig 🐷 (snake)

Add a 1–2 player game that fits the cute-pet arcade theme, with a pig main character.
Chosen concept: a grid **snake** — a pig leads a growing line of piglets, eating truffles
to grow. Full scope: polished game + an in-editor unlock shop (pig breeds + costumes
bought with collected truffles), matching Flappy Dog's expansion pattern.

## Plan (checklist)
- [x] New self-contained `hungry-pig/index.html` reusing Flappy Dog's shell (head, topbar,
      overlay, shop CSS), `playerName()` helper, currency/shop machinery, iframe back-link hide.
- [x] Snake mechanics: 20×20 grid, simultaneous step on a wall-clock ms accumulator
      (frame-rate independent), direction queue (no 180° flip), wall/self/other/head-on death,
      speed ramps with the leader's length.
- [x] 1P survival with persisted high score; 2P shared arena (3 truffles), last-alive wins,
      tie on equal length.
- [x] Input: P1 arrows, P2 WASD (WASD also drives P1 in solo); swipe to steer (split halves in 2P).
- [x] `drawPig()` — pig head (snout/ears/eyes leaning toward travel dir) + piglet trail + curly
      tail + upright costume overlay; 10 breeds, 10 costumes.
- [x] Register card in root `index.html` (🐷, "1 – 2 players", "Arcade · Snake").

## Review — DONE, verified headless (browse) at desktop + 390×844 mobile
- Loads with **no console errors**; setup overlay + shop render.
- **1P:** drove the pig onto a truffle — score 0→1, length 3→4, truffle count banked 0→1, truffle
  respawned (read via a temporary `window.__hp` debug hook, since removed). Wall hit → **Game Over**
  card ("Game Over", "0 truffles · best 1", restart hint); best score updated only on game over.
- **2P:** two independent pigs (P1 arrows / P2 WASD), HUD "P1 0 / 0 P2", 3 truffles, "Customising
  P1/P2" toggle appears.
- **Shop:** bought Spotty breed (15) + Party hat (8) → balance 30→7, owned/equipped/costume keys
  written; **persist across reload**; equipped Spotty coat + pink party hat render on the pig.
  (Shop chips are covered by the full-screen setup overlay until Start Game — same as Flappy Dog.)
- **Mobile:** setup overlay centered; gameplay layout stacks (canvas → toggles → shop).
- **Launcher:** 🐷 Hungry Pig card present between Snakes & Ladders and Flappy Dog; on desktop it
  loads in the iframe pane (`stage.src=hungry-pig/index.html`, welcome hidden); the in-iframe
  back link hides via `window.self !== window.top` (file:// cross-origin blocks parent hide, same
  as every other game).
- Debug hook removed; `node --check` on the extracted script passes; final clean load = no errors.

## Files
- `hungry-pig/index.html` (new, single file)
- `index.html` (one game card added)
