# Hog Ball — meter feel, animations, My Team + tournament

## Requests

1. Shot meter: **bigger green**, but the bar **fills faster**.
2. **Animations** for shooting, dunking, dribbling and more.
3. **Superstar spinner → 3 reels**: tier (rarity), position, stars (upgrade level).
4. **My Team mode**, separate from Season, built on a collectible card economy.
5. **Tournament mode**: enter the playoffs; winning gives **10 draft picks on a 4×10 board**.
6. Every card has an **overall** that can be upgraded / buffed.
7. My Team cards get **real sports-card art**.
8. Currency is **coins**.

## Plan

- [x] A — meter: green window 0.05→0.11 base (cap 0.14→0.26), bar 2.25×→3.2× faster
      (elite ~0.35s to the top). Free throws track it. CPU release spread widened
      0.28→0.44 so the fatter green doesn't turn the AI into a 78% shooter.
- [x] B — animations: shot cycle (charge dip → set point → follow-through with wrist
      snap), 4-phase dunk (gather/soar/hammer/rim-hang) with rim wobble, net stretch
      and a floor shockwave, real dribble with hand tracking + protect stance +
      between-the-legs, landing squash, celebration hop, defensive slide stance.
- [x] C — coins: every price, payout and label converted (×100 scale, `coinStr`).
      One shared wallet across Season and My Team.
- [x] D1 — `TIERS` Bronze→Legend; `ovrOf` = tier floor + 2/star; `cardStats` re-derived
      from OVERALL so an upgrade genuinely changes how the mob plays.
- [x] D2 — sports-card art: tier foil + sheen, die-cut portrait window with a court
      arc, OVR badge, position chip, vertical tier banner, name plate, star rail.
- [x] D3 — Collection: tap to start/bench, green upgrade button priced by tier+stars.
- [x] D4 — Store: four tier-odds packs, 3 cards each, tap-to-flip reveal.
- [x] D5 — 3-reel spinner (TIER / POSITION / STARS) stopping one reel at a time.
- [x] D6 — Playoffs: Quarterfinal → Semifinal → Final, opponents built to a fixed OVR
      gap from your squad.
- [x] D7 — Draft board: 4×10 = 40 squares, 10 picks (14 coin prizes, 23 cards across
      six tiers, 3 star-upgrades).
- [x] D8 — Menu button, save/load, every new overlay added to the `seasonOpen` list.

## Review

### Verified

- Card model: Bronze 60–68 → Legend 96–100; upgrade costs 150×(tier+1)×1.8^(stars-1).
- Full tournament run: QF → SF → Final → trophy → 10 picks. All 10 picks spend
  correctly (mixed coins/cards/upgrades). A real playoff game plays tip-off to buzzer
  and posts the round result.
- Spinner: forced roll `('diamond','C',4)` produced "DIAMOND C ★4 — 98 OVR".
- Shooting balance after the meter change: **48.6% FG, ~13 FGA per team per game** —
  right on the NBA mark and unchanged in shape from before.
- Every animation state fires over a full game (dunks, follow-throughs, landings,
  celebrations). No console errors anywhere.
- Season mode, card shop, packs, old spinner and free throws all still work on coins.

### Bug found and fixed

`shared/game.css` sets `canvas { width:100%; height:100% }` for the responsive game
stage, which silently stretched every card canvas — the collection's upgrade buttons
were pushed outside their card box and invisible. All card canvases now pin their own
CSS size; the pre-existing `.cr-slot` and `.pr-cards` canvases were pinned too.

### Notes

- `mtFinish` guards against a stale match (reload mid-game) rather than throwing.
- Harness: `HB.mt/mtNew/mtCoins/mtGive/mtPack/mtSpin/mtStartTourn/mtPlay/mtFinish/
  mtDraftTake/mtOvr/ovrOf/upCost/tiers/drawCard`.
