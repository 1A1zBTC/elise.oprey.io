# Task: "‹ Games" back button on every game (mobile)

Every game needs a top "‹ Games" button linking to ../index.html (the elise.oprey.io
games list). On mobile the homepage navigates full-page to a game, so the game's own
topbar must carry the back link; on desktop the homepage loads games in an iframe pane
and the link is hidden (redundant with the sidebar).

## Findings
- flappy-dog, kitten-jump, match-it, picwits, crossy-pets already had `.topbar` > `.back`
  ("‹ Games", href ../index.html) + an iframe-hide script (window.self !== window.top).
- battleships and snakes-and-ladders had NO topbar/back button → the gap.

## Changes (battleships + snakes-and-ladders)
- Added `.topbar` + `.back` CSS (matching the other games' muted-link style).
- Added `<div class="topbar"><a class="back" href="../index.html">‹ Games</a>…</div>`
  at the top of the body, above the game's `<h1>`.
- Added the standard iframe-hide script so the link hides in the desktop pane.

## Review — DONE, verified headless at 390×844 (mobile):
- All 7 games: `.back` present, text "‹ Games", href "../index.html", visibility visible.
- battleships + snakes show the button (screenshots); snakes shows it during play once the
  start dialog is dismissed.
- Back link → index.html, which lists all 7 game cards (Battleships, Snakes & Ladders,
  Flappy Dog, PicWits, Match It, Kitten Jump, Crossy Pets).
- Desktop iframe pane still hides the link (same script as the 4 already-working games;
  file:// cross-origin blocks parent introspection but the in-iframe script is identical).
