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
(filled in after implementation)
