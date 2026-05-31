# Task: Kitten Jump — different fur coats

Replaced the 2 hardcoded colour themes with 8 distinct patterned fur coats; players pick
their coat in the start dialog (per-player in 2P, like Flappy Dog breeds); choices persist.

## Coats (COATS array, each has a `pattern`)
Grey Tabby, Orange Tabby, Brown Tabby (tabby stripes) · Tuxedo (black + white chest/muzzle)
· Calico (cream + orange/dark patches) · Siamese (cream + dark face/points) · Black Cat,
Snowy White (solid).

## Implementation
- COATS array (was THEMES) with pattern + extra colours (stripe/white/patchA/patchB/points).
- drawKitten: clip-to-body and clip-to-head pattern layers (tabby stripes, tuxedo muzzle,
  calico patches, siamese mask). Solid coats draw nothing extra.
- State: coats=[p1,p2] loaded from COAT_KEYS (kittenjump.coat / .coat2), editCoatSlot.
- Start dialog: "Fur coat" swatch row (CSS gradient previews per pattern) + a P1/P2 tab row
  shown only in 2P. Picking saves to localStorage; player-count change resets to P1.
- startGame + drawSelect demo kittens use the chosen coats.

## Review — DONE, verified headless (no console errors):
- Dialog shows 8 coat swatches with pattern previews; tabs hidden in 1P, shown in 2P.
- In-game patterns confirmed: Calico, Siamese, Tuxedo, Grey Tabby all render distinctly.
- 2P uses each player's own coat (P1 Siamese / P2 Tuxedo); panel labels show coat names.
- Persistence verified: coat=5/coat2=3 restored after reload.
- Browse needed GSTACK_CHROMIUM_NO_SANDBOX=1 (host AppArmor userns).
