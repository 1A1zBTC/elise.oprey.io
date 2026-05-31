# Task: Match It-style start dialog for games that need input

Reference design: Match It setup overlay (`.overlay` > `.panel` with `<h2>` title, `.sub`,
`.group-label`, `.choices`/`.choice`, `.start-btn`).

## Scope (confirmed with user)
- [x] Match It — already the reference (no change)
- [ ] Snakes & Ladders — convert `#setup` (player count 2/3/4) to styled dialog
- [ ] Kitten Jump — replace canvas `select` screen with HTML dialog (1/2 players)
- [ ] Flappy Dog — add launch dialog (1/2 players), shop stays; replay unchanged
- Out of scope: PicWits, Battleship (no start options)

## Decisions
- Dialog shown at first launch only; existing replay/game-over flow untouched.
- Kitten Jump: `state==='select'` now drives the HTML dialog (replay returns to select = shows dialog, matching existing flow).
- Reuse exact Match It CSS block + `selectChoice` interaction pattern in each file.

## Steps
1. [x] Snakes & Ladders: add shared dialog CSS, rewrite `#setup` markup, wire selection + Start → startGame(n)
2. [x] Kitten Jump: add CSS + `#setup` markup; show/hide via state; strip canvas select text/buttons
3. [x] Flappy Dog: add CSS + `#setup` markup; show at load; Start → setPlayers + hide; keep shop toggle
4. [x] Verify each in browser (headless, GSTACK_CHROMIUM_NO_SANDBOX=1)

## Review
- Shared Match It dialog (`.overlay`/`.panel`/`.choices`/`.choice`/`.start-btn`) added to all three
  games; same Pacifico title + red 3D Start button + selectable cards.
- Snakes: `#setup` now the styled overlay; select player count → Start → `startGame(n)`. Verified
  setup hides / game shows / numPlayers=4.
- Kitten Jump: `state==='select'` drives the HTML overlay; canvas `drawSelect` reduced to scenery
  (kittens) behind the blur. Start → split-screen game. Replay (over → select) re-shows the dialog,
  matching existing flow.
- Flappy Dog: overlay shown at launch; Start applies player count + hides; shop sidebar and 1P/2P
  toggle untouched. Replay unchanged (tap to restart).
- No console errors on any game. Browse needed GSTACK_CHROMIUM_NO_SANDBOX=1 (host AppArmor userns).
