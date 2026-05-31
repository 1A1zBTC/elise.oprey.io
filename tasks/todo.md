# Task: Flappy Dog — per-player breed + costume customisation in 2P

## Goal
In 2-player mode, each dog (P1 and P2) can be given its own breed and costume.
Bones/unlocks stay a shared pool; only the *equipped* selection is per-player.

## Design
- Per-slot selections: `skins=[p1,p2]`, `costumes=[p1,p2]`, `pendingSkins=[null,null]`.
- `editSlot` (0/1) = which dog the shop currently customises. Always 0 in 1P.
- New "Customising: Player 1 / Player 2" toggle in the shop, shown only in 2P.
- Persist per-player: SKIN_KEYS/COSTUME_KEYS arrays (P1 keys unchanged → old saves preserved).
- P2 default breed = next owned breed (or same if only one owned). Replaces the old
  auto "contrasting challenger" default (which could be a locked breed).

## Steps
1. [ ] Keys → arrays (SKIN_KEYS, COSTUME_KEYS); keep COSTUMES_KEY (shared owned set)
2. [ ] State: skins/costumes/pendingSkins arrays + editSlot; drop scalar skin/skinIndex/costumeIndex
3. [ ] equipSkin(slot,i)/selectSkin/buyBreed/equipCostume/buyOrEquipCostume → editSlot-aware
4. [ ] buildPlayers uses per-slot selections; remove p2BreedIndex
5. [ ] endRound applies pendingSkins for both slots
6. [ ] refreshBreeds/refreshCostumes highlight editSlot's selection
7. [ ] draw text (1P screens) use skins[0]
8. [ ] Add dress toggle markup + wiring; refresh in setPlayers/dialog-start/init
9. [ ] Verify in browser (1P unaffected; 2P per-dog breed+costume)

## Review
Done — all steps complete, verified headless in browser:
- 1P unchanged: Customising toggle hidden, single dog uses P1's saved breed/costume.
- 2P: "Customising · Player 1 / Player 2" toggle in shop picks which dog the breed+costume
  grids edit. Each dog equips independently from the shared owned pool.
- Persistence: flappydog.skin/skin2 + flappydog.costume/costume2 (P1 keys unchanged → old
  saves intact). Verified skin_p1=2/skin_p2=3, costume_p1=0/costume_p2=1 after equipping.
- Switching P1↔P2 re-highlights each dog's own selection; ready screen shows "Dalmatian vs Husky".
- No console errors. Browse needed GSTACK_CHROMIUM_NO_SANDBOX=1 (host AppArmor userns).

Behaviour change to note: P2's default breed is now the next *owned* breed (or same as P1 if
only one owned), replacing the old auto "contrasting challenger" that could show a locked breed.
