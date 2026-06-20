# Task: Add a new game — Naughty Shelf 🐶 (drag-to-wrangle corgis)

A new single-player drag-and-drop game. A screen fills with more and more identical all-white
corgis. When one **growls / pees / poops** it turns naughty — drag it **up** onto the naughty
shelf. A shelved corgi slowly gets **sad and cries** — drag it **back down** before it breaks.
Lose if (a) too many naughty corgis pile up on the floor, or (b) a shelf corgi gets too sad.
Decisions: **core scope** (no shop), **one gentle escalating difficulty**, **1 player**.

## Plan (checklist)
- [x] New self-contained `naughty-shelf/index.html` reusing the Flappy Dog shell (head/CSS/topbar/
      stage/overlay), `playerName()`, the iframe back-link hide, and Crossy Pets' `dtMs/dtf`
      real-time loop.
- [x] First click-and-drag mechanic in the set: `pointerdown/move/up` (mouse + touch) with
      client→canvas mapping (kitten-jump pattern) and topmost-corgi hit-testing.
- [x] Procedural side-view **white corgi** (`drawCorgi`) with states walk / naughty
      (growl/pee/poop + floating bubble + floor mess) / held / shelf (sadness bar + crying tears).
- [x] Gentle escalation: spawn rate, max corgis, naughty frequency and sadness speed all lerp
      from calm→hectic over ~3 min.
- [x] Shelf with 5 slots; full shelf snaps an extra drop back to the floor.
- [x] Lose (a) chaos limit (5 naughty), lose (b) shelf sadness max; score = calm-downs + rescues;
      `naughtyshelf.best` persisted.
- [x] Registered launcher card (🐶, "1 player", "Arcade · Drag") in root `index.html`.

## Review — DONE, verified headless (browse), no console errors
- Scene renders: wooden "NAUGHTY SHELF" plank, grass floor, HUD (🦴 score, chaos meter, best),
  cute white corgis.
- Natural pacing is gentle: 0 naughty over 6s from a fresh start.
- **Calm-down:** dragging a naughty corgi onto a free slot → state `shelf`, naughty count −1,
  score +1, mess cleared. Verified via the **real PointerEvent handlers** (not just a debug hook).
- **Rescue:** dragging a shelf corgi down → state `walk`, score +1, sadness reset.
- **Lose (a):** 5 naughty on floor → "Too much chaos! 🐾".
- **Lose (b):** shelf sadness ≥ max → "A corgi got too sad 😢"; game-over card shows score + best.
- **Shelf full:** 6th drop on a full shelf snaps back to the floor and stays naughty.
- **Best persists** across reload. Mobile (390×844) stacks and the stage fills the width
  (`touch-action:none` so drags don't scroll). Launcher card loads in the desktop iframe pane
  (back link hidden via `window.self !== window.top`).
- Temporary `window.__ns` debug hook removed; `node --check` passes; final load clean.

## Files
- `naughty-shelf/index.html` (new, single file)
- `index.html` (one game card added)
