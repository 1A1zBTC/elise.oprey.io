// Isometric world + layout constants for Pet Vet. Pure values, no state —
// safe to import anywhere. (Game-state lives in main.js; these never change.)

// ---- Isometric world ----------------------------------------------------
export var TILE_W = 64, TILE_H = 32;          // 2:1 isometric tile footprint
export var TILE_HW = TILE_W / 2, TILE_HH = TILE_H / 2;
export var WALL_H = 62;                        // tall back walls
export var FRONT_WALL_H = 30;                  // short front walls (see over them)
export var ROOM = 8;                           // floor grid is ROOM x ROOM

// Automatic sliding double doors centred in the front-left wall: the opening
// spans tiles 3 & 4 (grid gx 2.5 … 4.5, centred on gx 3.5).
export var DOOR_A = 2.5, DOOR_B = 4.5, DOOR_MID = 3.5;
export var DOOR_H = WALL_H;                    // doors rise to full ceiling height

// Player's base movement (the Speed skill adds to it).
export var BASE_SPEED = 3.3;

// "Front" (customer-facing) grid direction for each rotation 0/90/180/270°.
export var FRONT = [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }];
