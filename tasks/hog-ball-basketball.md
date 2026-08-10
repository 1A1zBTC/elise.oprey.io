# Hog Ball — make it play like a real game of basketball

Goal: steals stop being an instant coin-flip, and possessions actually play out
(bring it up → run offence → contest → rebound) instead of being a scramble.

## Plan

- [x] 1. **Steals: a telegraphed reach, not an instant roll.** `attemptSteal` commits the
      defender to a 15-frame lunge that resolves at frame 8 on LIVE geometry.
- [x] 2. **Positional outcome ladder** — strip / knock loose / foul / whiff, weighted by
      how well the defender is actually placed (`reachPosition`).
- [x] 3. **Immunity windows** — dribble move, gather after a catch, airborne handler.
- [x] 4. **CPU stops spamming reaches** — situational gate + foul-trouble discipline.
- [x] 5. **Loose-ball scrambles** — `ball.loose`, two chasers per team.
- [x] 6. **Rebounding** — `driveRebound`, inside position + box-out, jump-timed boards.
- [x] 7. **Possession pacing** — `shotQuality` (expected points) vs a shot-clock
      patience curve.
- [x] 8. **Screens** — off-ball ball screens; contact sets `screenT` on the defender.
- [x] 9. **Longer quarters** — 45s → 90s (OT 30s → 40s).
- [x] 10. **Visual feedback** — reach arm + swipe arc, off-balance stumble.
- [x] 11. Verified headlessly and interactively.

## Review

### What changed (hog-ball/index.html)

**The reach.** `attemptSteal` no longer rolls dice on the spot. It starts a 15-frame
lunge (`reachT`) that resolves at frame 8 against wherever everyone actually is by
then, so a ball-handler who pulls back or crosses over beats it. Outcomes are
weighted by `reachPosition` (goal-side, is the handler dribbling into you, are you
under control) against the handler's new `handle` stat: ~13% clean strip, ~30%
deflection into a live scramble, ~9–25% reach-in foul, the rest whiffs and leaves the
defender off balance for 30 frames (`recoverT`, via `agility()`).

**Everything else that made it feel like basketball.** Rebounding (`driveRebound`:
defenders take inside position and box out, offence crashes, jump-timed boards);
shot selection driven by an expected-points `shotQuality` read against a shot-clock
patience curve; ball screens; basket cuts; claimed spacing spots; 90-second quarters.

### Bugs found and fixed along the way

- **Passes never cleared anyone's head.** `kickBall(..., vz=5)` peaked at z≈23, under
  the z<26 catch ceiling for the entire flight, so *26% of all passes were
  intercepted*. Loft now scales with distance; interceptions dropped 51/game → ~15.
- **Off-ball players stacked on the same spot** — independent random spot rotation let
  two mates pick the same one. Spots are now claimed greedily. Spacing 99 → 130.
- **A hard wall at D≈191.** The first "reset to the arc" rule I wrote fired whenever
  `D < THREE_R*0.85`, pinning the carrier just outside a good look forever — 5 shots
  in a whole game. Removed; patience lives in the shot threshold instead.
- **Over-and-back epidemic** (6–12/game): the AI passed to teammates trailing in the
  backcourt, and a deflection didn't reset the backcourt count. Fixed via `passable()`
  plus `possFront = false` on any defensive touch or rim contact.
- **Fouled-out mobs still contested shots** from the bench (`contestOn` didn't skip
  `ejected`).
- **Half-court/paint tests hardcoded "side 0 attacks right"** in three places; now
  derived from `attackDir(side)`.

### Verified

24-game CPU-vs-CPU sim with identical teams: **12–12 wins, 353 vs 348 points** — the
two ends are balanced. Per team per game: ~14 FGA, 50–58% FG, ~15 points (≈117 scaled
to 48 minutes). Reach ladder across both teams per game: 3.5 clean steals, 7.7
deflections, 4.3 reach-in fouls, ~23 whiffs. Interactively confirmed the reach holds
for 7 frames before resolving, and that a handler who pulls the ball back beats it
8/8 times. Season mode and free throws still work; no console errors.

### Harness

`window.HB` gained `demo()` (both benches AI), `sim(frames)` (synchronous frames),
`pause()`, `dbg()`, `pops()`, `poss()`, `flip()`. These made the balance work possible
and are worth keeping.
