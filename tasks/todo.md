# Scroot Rooms — realism + content overhaul

## Goals (from user)
1. Make each place look like what it actually is (subway = subway, forest = forest…).
2. Redesign the Bacteria: no eyes, blobby/gloopy, built from thin lines (pipe-cleaner look).
3. Add levels: school, hospital, grocery store, bubblegum factory (+ more real Backrooms levels).
4. Remove the eerie ambient music (keep the jumpscare screech).
5. Make entities look more realistic.
6. Add entities: Partygoers, Smilers (+ more real Backrooms entities).

## Plan
### A. Themed props system (the main "looks real" win)
- New `props` array per level + `THEME_PROPS` map of prop sprites placed against walls / in open cells.
- Subway: benches, turnstile, route sign. Forest: pine trees, bushes, ferns, rocks.
- School: lockers, desks, chalkboard. Hospital: gurney, IV stand, wheelchair.
- Grocery: shelving, glowing freezer case, shopping cart. Factory: pink gum vats, lollipops, gumball piles.
- Party: table w/ cake, balloons, banner. Office: cubicle+CRT, chair. Garage: dead car, pillar marker.

### B. New level themes (textures + door styles + names)
- Keep: yellow, pool, subway(improve), haunted, sewer, forest(improve).
- Add: school, hospital, grocery, factory, party, office, garage.

### C. Bacteria redesign — eyeless gloopy pipe-cleaner blob.
### D. Remove ambient music; keep screech.
### E. Entities: add Smiler, Partygoer, Hound, Faceling; tune spawns/speeds.

## Review
Done & verified in a headless browser (screenshots of every new theme + an entity
sprite sheet + a jumpscare-face sheet):
- **Themes**: improved subway (white/teal brick tile) + forest (mossy floor); added
  school, hospital, grocery, factory, party (Level Fun =)), office, garage — each with
  its own wall/floor/ceiling textures, door style, name, and slide/destination wiring.
- **Props**: new `THEME_PROPS` + `placeProps()` scatter benches/turnstiles/signs (subway),
  pine trees/bushes/rocks (forest), lockers/desks (school), gurneys/IV stands (hospital),
  shelving/freezers/carts (grocery), gum vats/lollipops (factory), party table/balloons/
  banner (party), cubicles/coolers (office), dead cars/pillars (garage).
- **Bacteria**: rebuilt as an eyeless gloopy blob of thin twisted pipe-cleaner strands
  with drips (body + jumpscare face).
- **Entities**: added Smiler, Partygoer, Hound, Faceling (walk sprites + jumpscare faces),
  driven by a unified `ENTITY_DEFS` table; theme-aware spawns so each place has a
  signature hunter.
- **Music**: removed the ambient drone (startMusic/stinger/stopMusic); kept the screech.
- SW cache bumped v30 → v31 so installed PWA users get the update.

**Not deployed yet** — committed to git only. Run the S3 sync + CloudFront invalidate to go live.
