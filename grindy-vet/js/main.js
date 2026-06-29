    'use strict';

    import {
      TILE_W, TILE_H, TILE_HW, TILE_HH, WALL_H, FRONT_WALL_H, ROOM,
      DOOR_A, DOOR_B, DOOR_MID, DOOR_H, BASE_SPEED, FRONT
    } from './constants.js';
    import { isoRaw, hash, diamondPath, shade, chooseDir } from './util.js';

    var canvas = document.getElementById('game');
    var ctx = canvas.getContext('2d');

    // ---- Game state (small + extendable) ---------------------------------
    var vet = {
      x: ROOM / 2 - 0.5, y: ROOM / 2 - 0.5,  // float grid position (tile units)
      speed: BASE_SPEED, dir: 'SE', moving: false, walkPhase: 0
    };
    var input = { up: false, down: false, left: false, right: false };
    var touchInput = { active: false, dx: 0, dy: 0 };

    // Automatic doors: open (0..1) eases toward 1 when the vet OR a visitor is near.
    var door = { open: 0 };
    // Corridor↔room doorways get the same auto sliding doors as the entry. Each
    // drawDoorOpening() registers its opening in `doorways` (rebuilt by
    // renderStatic); the run loop eases a per-doorway value in `doorOpen`.
    var doorways = [];                     // [{ax,ay,bx,by,H}] one per corridor doorway
    var doorOpen = {};                     // edge-key -> 0..1 eased open amount
    var animT = 0;                         // running time, drives idle/anger wobble

    // ---- Visitors --------------------------------------------------------
    // Every `frq` seconds a new client walks in from the road, up the path,
    // through the doors, and waits inside. Each visitor follows a fixed list of
    // grid waypoints; `wait` parks them at a spot inside the clinic.
    var frq = 30;                          // seconds between arrivals
    var wait = 50;                         // seconds a client waits before storming off
    var spawnTimer = 0;                    // first visitor arrives immediately, then every `frq` seconds
    var visitors = [];
    var visitorSeq = 0;
    var examTicketSeq = 0;                  // monotonic check-in number → exam order
    // Visitors queue in two lines in front of the reception desk (one per desk
    // tile). queue[0] / queue[1] are ordered arrays of visitors; index 0 = front.
    var queue = [[], []];

    // Vet skills (top bar). Both start at 1.0 and upgrade +0.5 at a time; the
    // price starts at 10 coins and doubles per purchase, per skill.
    //  - Processing: multiplier on desk/task speed. Reception takes 0.5s ×
    //    (10 / processing) per client → 5s at 1.0, 2.5s at 2.0, …
    //  - Speed: additive to the vet's movement (BASE_SPEED + (speed - 1.0)).
    var skills = {
      speed:      { val: 1.0, cost: 10 },
      processing: { val: 1.0, cost: 10 },
      cleaning:   { val: 1.0, cost: 10 }
    };
    function procTime() { return 0.5 * (10 / skills.processing.val); }
    var floaters = [];                     // floating "+10" coin pop-ups
    // After being served, clients step aside to one of these spots and wait.
    var SIDE_SPOTS = [
      { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 },
      { x: 6, y: 4 }, { x: 5, y: 5 }, { x: 6, y: 3 }
    ];
    function sideSpot() {
      for (var i = 0; i < SIDE_SPOTS.length; i++) {
        var s = SIDE_SPOTS[i];
        if (occupied[s.x + ',' + s.y]) continue;
        if (visitors.some(function (v) { return v.sideIdx === i || (Math.round(v.x) === s.x && Math.round(v.y) === s.y); })) continue;  // don't reuse a spot someone is still standing on
        return { idx: i, x: s.x, y: s.y };
      }
      // all preset spots taken → any free clinic tile no one else is on/heading to
      for (var yy = ROOM - 1; yy >= 0; yy--)
        for (var xx = ROOM - 1; xx >= 0; xx--) {
          if (occupied[xx + ',' + yy]) continue;
          if (visitors.some(function (v) {
            return (Math.round(v.x) === xx && Math.round(v.y) === yy) ||
                   (v.sideX === xx && v.sideY === yy);
          })) continue;
          return { idx: -1, x: xx, y: yy };
        }
      return { idx: -1, x: SIDE_SPOTS[0].x, y: SIDE_SPOTS[0].y };
    }
    // Visitor look-up tables (cycled by arrival order).
    var V_SHIRT = ['#e0683c', '#d94f6e', '#5a8fd6', '#e0a93c', '#7d5bbe', '#3aa686'];
    var V_LEGS  = ['#3a4760', '#42506a', '#5a4636', '#384a44'];
    var V_SKIN  = ['#f0c8a4', '#e0b189', '#c98e63', '#a86c45'];
    var V_HAIR  = ['#3a2c22', '#6b4a32', '#241a14', '#8a6a3a', '#2b2b33'];
    var PETS    = ['dog-s', 'dog-m', 'dog-l', 'cat'];      // arrival cycle
    var CARRIER = ['#e0683c', '#3d8fd0', '#7d5bbe', '#3bb1a2', '#e0a93c', '#d94f6e'];

    // ---- Economy + build / placement -------------------------------------
    var money = 1000;                      // player's cash
    var placed = [];                       // [{id, gx, gy}] furniture in the room
    var occupied = {};                     // "gx,gy" -> true (a placed footprint tile)
    var staff = [];                        // [{type:'receptionist', line}] hired staff at desk circles
    var placing = null;                    // { item } while positioning a purchase
    var pointer = { gx: 0, gy: 0, on: false }; // snapped tile under the cursor

    // ---- Rooms / corridors -----------------------------------------------
    // The clinic is the fixed ROOM×ROOM grid. The player can also buy
    // "corridors": lines of grass squares (outside the clinic) turned into
    // floor, walled in, and joined to whatever room they touch via a doorway.
    // Stored as a set of "gx,gy" keys lying outside the clinic bounds.
    var corridor = {};                     // "gx,gy" -> true (a built corridor tile)
    var corridorDrag = null;               // { sx, sy } while dragging out a line
    var openRoom = {};                     // "gx,gy" corridor tiles that are open rooms (no lane rule)

    function isClinic(x, y) { return x >= 0 && y >= 0 && x < ROOM && y < ROOM; }
    function isCorridor(x, y) { return !!corridor[x + ',' + y]; }
    function isRoomFloor(x, y) { return isClinic(x, y) || isCorridor(x, y); }
    // The tile directly across a 2-wide corridor (its other lane), or null. A
    // corridor tile has one corridor neighbour along its narrow axis and grass on
    // the opposite side — that neighbour is the "across" lane. Used to keep one
    // lane clear: seating can't go on both sides of the corridor at the same spot.
    function corridorAcross(x, y) {
      if (isCorridor(x, y - 1) !== isCorridor(x, y + 1))
        return isCorridor(x, y - 1) ? { x: x, y: y - 1 } : { x: x, y: y + 1 };
      if (isCorridor(x - 1, y) !== isCorridor(x + 1, y))
        return isCorridor(x - 1, y) ? { x: x - 1, y: y } : { x: x + 1, y: y };
      return null;
    }
    // The non-grass surfaces out front (entrance path + sidewalk/road band).
    function onPath(x, y) { return (x === 3 || x === 4) && y >= ROOM && y <= ROOM + 4; }
    function onRoadZone(x, y) { return y >= ROOM + 5 && y <= ROOM + 10; }
    // A square you may turn into corridor: plain grass, nothing already on it.
    function isGrassBuildable(x, y) {
      return !isRoomFloor(x, y) && !onPath(x, y) && !onRoadZone(x, y) && !occupied[x + ',' + y];
    }
    function adjacentToRoom(x, y) {
      return isRoomFloor(x - 1, y) || isRoomFloor(x + 1, y) ||
             isRoomFloor(x, y - 1) || isRoomFloor(x, y + 1);
    }
    // A "plain corridor" is a corridor tile that is NOT part of any built room
    // (exam/X-ray/pharmacy/blank/restroom) — an actual passage. Operating-room doors
    // open onto an OPEN tile (a plain corridor or a blank room), never onto a walled
    // room (see isOpenAdj + adjacentToWalledRoom).
    // A WALLED room tile (exam/X-ray/pharmacy/restroom) — a room with its own walls
    // and a single doorway, as opposed to an open blank room or a plain corridor.
    function inWalledRoom(x, y) {
      if (examRooms.some(function (rm) { return x >= rm.gx && x < rm.gx + 3 && y >= rm.gy && y < rm.gy + 3; })) return true;
      if (xrayRooms.some(function (rm) { return x >= rm.gx && x < rm.gx + 3 && y >= rm.gy && y < rm.gy + 4; })) return true;
      if (pharmacies.some(function (ph) { return x >= ph.gx && x < ph.gx + PHARM_W && y >= ph.gy && y < ph.gy + PHARM_H; })) return true;
      if (restrooms.some(function (rm) { return footprintTiles(FURN_BY_ID.restroom, rm.gx, rm.gy, rm.rot).some(function (t) { return t.x === x && t.y === y; }); })) return true;
      return false;
    }
    function inRoomFootprint(x, y) { return !!openRoom[x + ',' + y] || inWalledRoom(x, y); }
    // True if any of `tiles` is orthogonally adjacent to a walled room. Used to keep
    // operating rooms apart, so each connects to a corridor / blank room rather than
    // sharing a wall with another room. (Diagonal touching is fine — no shared wall.)
    function adjacentToWalledRoom(tiles) {
      var n = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var i = 0; i < tiles.length; i++)
        for (var j = 0; j < n.length; j++)
          if (inWalledRoom(tiles[i].x + n[j][0], tiles[i].y + n[j][1])) return true;
      return false;
    }
    function isPlainCorridor(x, y) { return isCorridor(x, y) && !inRoomFootprint(x, y); }
    // Open rooms (blank rooms + the clinic) join corridors with no wall/door.
    function isOpenAdj(x, y) { return isPlainCorridor(x, y) || !!openRoom[x + ',' + y]; }
    // Validate a click-drag into a straight, TWO-wide line of buildable grass.
    // The line follows whichever axis the drag favours; each step lays a 2×1 rung
    // (the tile + its perpendicular neighbour) costing $10. The start tile must
    // touch an existing room, and the run stops at the first rung that isn't clear
    // grass or once the wallet (at $10 per 2×1) runs out. Returns { tiles, cost }.
    function corridorLineTiles(sx, sy, ex, ey) {
      if (!isGrassBuildable(sx, sy) || !adjacentToRoom(sx, sy)) return { tiles: [], cost: 0 };
      var dx = ex - sx, dy = ey - sy, stepx = 0, stepy = 0, n, perpx, perpy;
      if (Math.abs(dx) >= Math.abs(dy)) { stepx = dx > 0 ? 1 : dx < 0 ? -1 : 0; n = Math.abs(dx); perpx = 0; perpy = 1; }
      else { stepy = dy > 0 ? 1 : dy < 0 ? -1 : 0; n = Math.abs(dy); perpx = 1; perpy = 0; }
      // Widen onto whichever perpendicular side is open grass at the start.
      if (!isGrassBuildable(sx + perpx, sy + perpy)) { perpx = -perpx; perpy = -perpy; }
      var budget = Math.floor(money / 10), tiles = [], rungs = 0, cx = sx, cy = sy;
      for (var i = 0; i <= n; i++) {
        if (!isGrassBuildable(cx, cy) || !isGrassBuildable(cx + perpx, cy + perpy)) break;
        if (rungs >= budget) break;            // can't afford another 2×1 rung
        tiles.push({ x: cx, y: cy });
        tiles.push({ x: cx + perpx, y: cy + perpy });
        rungs++;
        if (stepx === 0 && stepy === 0) break;  // single rung
        cx += stepx; cy += stepy;
      }
      return { tiles: tiles, cost: rungs * 10 };
    }
    function commitCorridor(sx, sy, ex, ey) {
      var res = corridorLineTiles(sx, sy, ex, ey);
      if (!res.tiles.length) return;
      res.tiles.forEach(function (t) { corridor[t.x + ',' + t.y] = true; });
      money -= res.cost;
      renderStatic();                        // walls / floor / doorways changed
      renderMoney();
    }

    // Blank room: drag a filled rectangle of clear grass that touches the existing
    // building. Each tile is $10 and becomes open room floor (walled, no lane rule),
    // ready for the player to furnish into a waiting/check-in area.
    function blankRectTiles(sx, sy, ex, ey) {
      var x0 = Math.min(sx, ex), x1 = Math.max(sx, ex), y0 = Math.min(sy, ey), y1 = Math.max(sy, ey);
      var tiles = [], touches = false;
      for (var y = y0; y <= y1; y++)
        for (var x = x0; x <= x1; x++) {
          if (!isGrassBuildable(x, y)) return { tiles: [], cost: 0, ok: false };
          tiles.push({ x: x, y: y });
          if (adjacentToRoom(x, y)) touches = true;
        }
      var cost = tiles.length * 10;
      return { tiles: tiles, cost: cost, ok: touches && cost <= money };
    }
    function commitBlank(sx, sy, ex, ey) {
      var res = blankRectTiles(sx, sy, ex, ey);
      if (!res.ok) return;
      res.tiles.forEach(function (t) { corridor[t.x + ',' + t.y] = true; openRoom[t.x + ',' + t.y] = true; });
      money -= res.cost;
      renderStatic();
      renderMoney();
    }

    // ---- Restrooms -------------------------------------------------------
    // A 2×3 outdoor building placed on grass that touches a corridor. One visitor
    // uses it at a time; they reach it via the `door` tile (the adjacent corridor).
    var restrooms = [];                    // [{gx,gy,rot,door:{x,y},occupant}]
    var puddles = [];                      // [{x,y}] accidents left on the floor
    var cleaners = [];                     // [{x,y,...}] hired cleaners who mop up puddles

    function isAdjacentToCorridor(x, y) {
      return isCorridor(x - 1, y) || isCorridor(x + 1, y) || isCorridor(x, y - 1) || isCorridor(x, y + 1);
    }
    // The corridor tile a placed restroom opens onto (or null if it touches none).
    function restroomDoor(gx, gy, rot) { return roomDoorFor(footprintTiles(FURN_BY_ID.restroom, gx, gy, rot)); }
    function canPlaceRestroom(gx, gy, rot) { return canPlaceRoom('restroom', gx, gy, rot); }
    function freeRestroom() { return freeRoom('restroom'); }
    // Interior layout of a restroom: the doorway tile it opens onto, the room tile
    // just inside it (entry), the toilet (deepest tile from the entry) and the
    // stand tile in front of the toilet the user faces while using it.
    function restroomLayout(gx, gy, rot) {
      var fp = footprintTiles(FURN_BY_ID.restroom, gx, gy, rot);
      var door = restroomDoor(gx, gy, rot), entry = fp[0];
      if (door) for (var i = 0; i < fp.length; i++)
        if (Math.abs(fp[i].x - door.x) + Math.abs(fp[i].y - door.y) === 1) { entry = fp[i]; break; }
      var toilet = fp[0], best = -1;
      fp.forEach(function (t) { var d = Math.abs(t.x - entry.x) + Math.abs(t.y - entry.y); if (d > best) { best = d; toilet = t; } });
      var stand = entry, sbest = 1e9;
      fp.forEach(function (t) {
        if (Math.abs(t.x - toilet.x) + Math.abs(t.y - toilet.y) !== 1) return;  // adjacent to toilet
        var d = Math.abs(t.x - entry.x) + Math.abs(t.y - entry.y);
        if (d < sbest) { sbest = d; stand = t; }
      });
      return { door: door, entry: entry, toilet: toilet, stand: stand,
               face: { x: Math.sign(stand.x - toilet.x), y: Math.sign(stand.y - toilet.y) } };
    }
    // Build the restroom as a walled room: its footprint joins the corridor floor
    // (so renderStatic walls it in and opens a doorway onto the connecting corridor)
    // and the toilet tile becomes a solid fixture. Mirrors placeExam.
    function placeRestroom(gx, gy, rot) { return placeRoom('restroom', gx, gy, rot); }

    // ---- Exam rooms ------------------------------------------------------
    // A 3×3 room (corridor-class floor so the vet can walk in) holding a desk and
    // an exam table. The pet's owner stands one side of the table; the vet stands
    // on the circle the other side to examine. Built on grass touching a corridor.
    var examRooms = [];                    // [{gx,gy,rot,occupant,examT,door}]

    // Key tiles relative to the room, by rotation (centre is the exam table).
    function examKeyTiles(gx, gy, rot) {
      var C = { x: gx + 1, y: gy + 1 }, f = FRONT[rot || 0];
      var perp = { x: -f.y, y: f.x };
      return {
        table:   { x: C.x, y: C.y },
        circle:  { x: C.x - f.x, y: C.y - f.y },            // vet's side (behind table)
        visitor: { x: C.x + f.x, y: C.y + f.y },            // owner's side (in front)
        desk:    { x: C.x - f.x + perp.x, y: C.y - f.y + perp.y }
      };
    }
    function examTiles(gx, gy) {           // all 9 floor tiles
      var t = [];
      for (var j = 0; j < 3; j++) for (var i = 0; i < 3; i++) t.push({ x: gx + i, y: gy + j });
      return t;
    }
    function examDoor(gx, gy) { return roomDoorFor(examTiles(gx, gy)); }
    function canPlaceExam(gx, gy) { return canPlaceRoom('exam', gx, gy); }
    function placeExam(gx, gy, rot) { return placeRoom('exam', gx, gy, rot); }
    function freeExamRoom() { return freeRoom('exam'); }

    // ---- X-ray rooms -----------------------------------------------------
    // A 3×4 room (corridor-class floor) with an X-ray bed + control desk. After an
    // exam, 20% of pets need an X-ray; it pays $200, takes 2× an exam, and is sped
    // by the Processing skill (same procTime) — operated by the player on the
    // circle, or a hired Vet. Geometry reuses the exam layout (bed = the exam
    // "table" slot), with an extra floor row at the front of the room.
    var xrayRooms = [];                    // [{gx,gy,rot,occupant,xrayT,door,vet}]
    function xrayTiles(gx, gy) {           // all 12 floor tiles (3 wide × 4 deep)
      var t = [];
      for (var j = 0; j < 4; j++) for (var i = 0; i < 3; i++) t.push({ x: gx + i, y: gy + j });
      return t;
    }
    function xrayDoor(gx, gy) { return roomDoorFor(xrayTiles(gx, gy)); }
    function canPlaceXray(gx, gy) { return canPlaceRoom('xray', gx, gy); }
    function placeXray(gx, gy, rot) { return placeRoom('xray', gx, gy, rot); }
    function freeXrayRoom() { return freeRoom('xray'); }

    // ---- Pharmacy --------------------------------------------------------
    // A 4-wide × 3-deep room with 2 counter sections; at each, a patient stands on
    // the front tile and the player (or a hired Pharmacist) stands on the circle
    // behind to fill the prescription. Fixed orientation (like the X-ray room).
    // Built on grass touching a corridor, like other rooms.
    var PHARM_W = 4, PHARM_H = 3;          // across × down
    var pharmacies = [];                   // [{gx,gy,rot,door,stations:[{patient,procT,pharm}x2]}]
    function pharmTiles(gx, gy) {          // all 12 floor tiles (4 wide × 3 deep)
      var t = [];
      for (var j = 0; j < PHARM_H; j++) for (var i = 0; i < PHARM_W; i++) t.push({ x: gx + i, y: gy + j });
      return t;
    }
    // 2 sections, each {counter, patient(front), circle(back)}, centred in the
    // 4-wide room (columns 1 & 2). Columns 0 & 3 stay open as walking lanes so
    // clients and the player don't jam.
    function pharmStations(gx, gy) {
      return [1, 2].map(function (cx) {
        return {
          counter: { x: gx + cx, y: gy + 1 },
          patient: { x: gx + cx, y: gy + 2 },   // front tile (toward viewer)
          circle:  { x: gx + cx, y: gy + 0 }    // staff tile (back)
        };
      });
    }
    function pharmDoor(gx, gy) { return roomDoorFor(pharmTiles(gx, gy)); }
    function canPlacePharmacy(gx, gy) { return canPlaceRoom('pharmacy', gx, gy); }
    function placePharmacy(gx, gy, rot) { return placeRoom('pharmacy', gx, gy, rot); }
    function freePharmStation() {
      for (var i = 0; i < pharmacies.length; i++)
        for (var j = 0; j < pharmacies[i].stations.length; j++)
          if (!pharmacies[i].stations[j].patient) return { ph: pharmacies[i], idx: j };
      return null;
    }

    // ---- Room registry ---------------------------------------------------
    // One descriptor per walled-room type drives the (previously duplicated)
    // place / canPlace / free / door logic. Each declares: its `list` array, a
    // `tiles(gx,gy,rot)` footprint, and `make(gx,gy,rot,door)` which returns the
    // room object to store plus the tiles that become solid (block movement).
    // The per-type place*/canPlace*/free*/`*Door` functions below are now thin
    // wrappers over the generics, so adding a room type means adding a descriptor.
    var ROOM_TYPES = {
      restroom: {
        list: restrooms,
        tiles: function (gx, gy, rot) { return footprintTiles(FURN_BY_ID.restroom, gx, gy, rot); },
        make: function (gx, gy, rot, door) {
          var L = restroomLayout(gx, gy, rot);
          return { room: { gx: gx, gy: gy, rot: rot, door: L.door, entry: L.entry, toilet: L.toilet, stand: L.stand, face: L.face, occupant: null }, solid: [L.toilet] };
        }
      },
      exam: {
        list: examRooms,
        tiles: function (gx, gy) { return examTiles(gx, gy); },
        make: function (gx, gy, rot, door) {
          var k = examKeyTiles(gx, gy, rot);
          return { room: { gx: gx, gy: gy, rot: rot, occupant: null, examT: 0, door: door }, solid: [k.table] };
        },
        // occupant-claim service flow (see claimRoomGeneric/assignRoomGeneric):
        timer: 'examT', vRoom: 'examRoom', toPhase: 'toExam',
        waiting: function (v) {
          return v.served && !v.examined && !v.examRoom &&
            (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated');
        },
        // in-room service (see toRoomGeneric/inRoomGeneric): operated by the
        // player on the circle (full rate) or a roaming hired Vet (half rate).
        inPhase: 'inExam', waitField: 'examWait', duration: 3, payout: 100,
        operator: function (rm) { return vetAtExam(rm) || roomVetWorking(rm); },
        fullRate: function (rm) { return vetAtExam(rm) ? 1 : 0.5; },
        release: function (v) { releaseExam(v); },
        onDone: function (v) { v.examined = true; releaseExam(v); examFollowUp(v); }
      },
      xray: {
        list: xrayRooms,
        tiles: function (gx, gy) { return xrayTiles(gx, gy); },
        make: function (gx, gy, rot, door) {
          var k = examKeyTiles(gx, gy, rot);
          return { room: { gx: gx, gy: gy, rot: rot, occupant: null, xrayT: 0, door: door, vet: false }, solid: [k.table, k.desk] };
        },
        timer: 'xrayT', vRoom: 'xrayRoom', toPhase: 'toXray',
        waiting: function (v) {
          return v.needsXray && !v.xrayed && !v.xrayRoom &&
            (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated');
        },
        // X-ray takes 2x an exam (6x procTime) and pays 200; happy-leaves on done.
        inPhase: 'inXray', waitField: 'xrayWait', duration: 6, payout: 200,
        operator: function (rm) { return vetAtXray(rm) || roomVetWorking(rm); },
        fullRate: function (rm) { return vetAtXray(rm) ? 1 : 0.5; },
        release: function (v) { releaseXray(v); },
        onDone: function (v) { v.xrayed = true; v.happy = true; releaseXray(v); leaveOutbound(v); }
      },
      pharmacy: {
        list: pharmacies,
        tiles: function (gx, gy) { return pharmTiles(gx, gy); },
        make: function (gx, gy, rot, door) {
          var st = pharmStations(gx, gy, rot);
          return { room: { gx: gx, gy: gy, rot: rot, door: door, stations: [{ patient: null, procT: 0, pharm: false }, { patient: null, procT: 0, pharm: false }] }, solid: st.map(function (s) { return s.counter; }) };
        }
      }
    };
    // The corridor tile a room's footprint opens onto, or null.
    function roomDoorFor(tiles) {
      var n = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var i = 0; i < tiles.length; i++)
        for (var j = 0; j < 4; j++) {
          var dx = tiles[i].x + n[j][0], dy = tiles[i].y + n[j][1];
          if (isOpenAdj(dx, dy)) return { x: dx, y: dy };
        }
      return null;
    }
    function canPlaceRoom(type, gx, gy, rot) {
      var ts = ROOM_TYPES[type].tiles(gx, gy, rot || 0);
      for (var i = 0; i < ts.length; i++) if (!isGrassBuildable(ts[i].x, ts[i].y)) return false;
      if (adjacentToWalledRoom(ts)) return false;          // keep rooms apart, not wall-to-wall
      return !!roomDoorFor(ts);                            // must open onto a corridor or blank room
    }
    function placeRoom(type, gx, gy, rot) {
      rot = rot || 0;
      var d = ROOM_TYPES[type], ts = d.tiles(gx, gy, rot), door = roomDoorFor(ts);
      var m = d.make(gx, gy, rot, door);
      ts.forEach(function (t) { corridor[t.x + ',' + t.y] = true; });   // walkable room floor
      m.solid.forEach(function (t) { occupied[t.x + ',' + t.y] = true; }); // fixtures block movement
      d.list.push(m.room);
      renderStatic();                                       // floor + walls around the new room
      return m.room;
    }
    function freeRoom(type) {                                // occupant-based rooms (not pharmacy)
      var L = ROOM_TYPES[type].list;
      for (var i = 0; i < L.length; i++) if (!L[i].occupant) return L[i];
      return null;
    }

    // Catalog: the single source for the shop rows AND placement. `cat` picks the
    // shop tab; `kind:'staff'` items snap to a desk action-circle instead of a tile.
    // (drawChair/drawDesk are function declarations, hoisted, so usable here.)
    var FURNITURE = [
      { id: 'chair', name: 'Chair',          cost: 20,  w: 1, h: 1, icon: '🪑', cat: 'reception', corridorOK: true, draw: drawChair, interact: chairInteractTiles },
      { id: 'bench', name: 'Bench',          cost: 35,  w: 2, h: 1, icon: '<svg width="34" height="34" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="10.5" y="11" width="3.5" height="15" rx="1" fill="#8c6638"/><rect x="34" y="11" width="3.5" height="15" rx="1" fill="#8c6638"/><rect x="9" y="11.5" width="30" height="4" rx="2" fill="#c79a63"/><rect x="9" y="18" width="30" height="4" rx="2" fill="#c79a63"/><rect x="6.5" y="24.5" width="35" height="6" rx="2.5" fill="#cda06a"/><rect x="10" y="30" width="4" height="11" rx="1.5" fill="#8c6638"/><rect x="34" y="30" width="4" height="11" rx="1.5" fill="#8c6638"/></svg>', cat: 'reception', corridorOK: true, draw: drawBench, interact: benchInteractTiles },
      { id: 'desk',  name: 'Reception Desk', cost: 100, w: 2, h: 1, icon: '🖥️', cat: 'reception', draw: drawDesk, interact: deskInteractTiles },
      { id: 'tv',    name: 'TV',             cost: 150, w: 1, h: 1, icon: '📺', cat: 'reception', draw: drawTV },
      { id: 'receptionist', name: 'Receptionist', cost: 500, w: 1, h: 1, icon: '🧑‍💼', cat: 'staff', kind: 'staff' },
      { id: 'vet', name: 'Vet', cost: 800, w: 1, h: 1, icon: '🧑‍⚕️', cat: 'staff', kind: 'examstaff' },
      { id: 'corridor', name: 'Corridor', cost: 10, icon: '🚪', cat: 'rooms', kind: 'corridor', perSquare: true },
      { id: 'blank', name: 'Blank', cost: 10, icon: '⬜', cat: 'rooms', kind: 'blank', perSquare: true },
      { id: 'restroom', name: 'Restroom', cost: 120, w: 2, h: 3, icon: '🚻', cat: 'rooms', kind: 'restroom', draw: drawRestroom },
      { id: 'exam', name: 'Exam Room', cost: 300, w: 3, h: 3, icon: '🩺', cat: 'rooms', kind: 'exam' },
      { id: 'xray', name: 'X-Ray Room', cost: 600, w: 3, h: 4, icon: '🩻', cat: 'rooms', kind: 'xray' },
      { id: 'pharmacy', name: 'Pharmacy', cost: 400, w: 4, h: 3, icon: '💊', cat: 'rooms', kind: 'pharmacy' },
      { id: 'pharmacist', name: 'Pharmacist', cost: 600, w: 1, h: 1, icon: '🧑‍🔬', cat: 'staff', kind: 'pharmstaff' },
      { id: 'cleaner', name: 'Cleaner', cost: 400, w: 1, h: 1, icon: '🧹', cat: 'staff', kind: 'cleaner' }
    ].sort(function (a, b) { return a.cost - b.cost; });
    var FURN_BY_ID = {};
    FURNITURE.forEach(function (f) { FURN_BY_ID[f.id] = f; });
    var activeTab = 'reception';            // current shop tab

    // ---- Canvas + offscreen layers ---------------------------------------
    // Everything static (grass, path, floor, back walls) is cached in `bg`;
    // the short front walls (which occlude the vet) cache in `fg`. Each frame
    // we just blit bg, draw the vet, blit fg — cheap.
    var view = { w: 0, h: 0, dpr: 1 };
    var camera = { x: 0, y: 0 };
    var bg = document.createElement('canvas'), bgx = bg.getContext('2d');
    var fg = document.createElement('canvas'), fgx = fg.getContext('2d');
    var ghostC = document.createElement('canvas'), ghostCtx = ghostC.getContext('2d'); // for tinting the placement preview

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      view.w = rect.width; view.h = rect.height; view.dpr = dpr;
      canvas.width = bg.width = fg.width = ghostC.width = Math.round(rect.width * dpr);
      canvas.height = bg.height = fg.height = ghostC.height = Math.round(rect.height * dpr);
      // Centre the room; nudge up so the front path has room below.
      var c = isoRaw(ROOM / 2 - 0.5, ROOM / 2 - 0.5);
      camera.x = view.w / 2 - c.x;
      camera.y = view.h / 2 - c.y - 28;
      renderStatic();
    }

    function iso(gx, gy) {
      return { x: (gx - gy) * TILE_HW + camera.x, y: (gx + gy) * TILE_HH + camera.y };
    }
    function screenToGrid(sx, sy) {
      var a = (sx - camera.x) / TILE_HW, b = (sy - camera.y) / TILE_HH;
      return { gx: (a + b) / 2, gy: (b - a) / 2 };
    }

    // ---- Tile + surface primitives (draw onto a given context) -----------
    // Scatter `n` tiny flecks inside the current tile (caller has already clipped
    // to the diamond). `pick(t)` returns a fill colour from a 0..1 sample.
    function fleck(c, s, gx, gy, n, spread, sz, pick) {
      for (var i = 0; i < n; i++) {
        var fx = hash(gx * 13 + i * 7 + 5, gy * 17 - i * 5 + 2);
        var fy = hash(gx * 5 - i * 11 + 9, gy * 23 + i * 3 + 1);
        c.fillStyle = pick(hash(i * 3 + gx, i * 9 + gy));
        c.fillRect(s.x + (fx - 0.5) * TILE_W * spread, s.y + (fy - 0.5) * TILE_H * spread, sz, sz);
      }
    }

    var GRASS = ['#7cc15f', '#74ba56', '#82c766', '#6fb551'];
    var GRASS_FLECK = ['rgba(122,184,94,0.55)', 'rgba(96,160,74,0.5)', 'rgba(62,118,52,0.42)'];

    // Bevelled rim inside a diamond tile: light along the two upper edges, shadow
    // along the two lower edges — makes slabs/tiles read as raised blocks.
    function bevel(c, s, inset, light, dark) {
      var hw = TILE_HW - inset, hh = TILE_HH - inset;
      c.lineWidth = 1.2;
      c.strokeStyle = light;
      c.beginPath(); c.moveTo(s.x - hw, s.y); c.lineTo(s.x, s.y - hh); c.lineTo(s.x + hw, s.y); c.stroke();
      c.strokeStyle = dark;
      c.beginPath(); c.moveTo(s.x - hw, s.y); c.lineTo(s.x, s.y + hh); c.lineTo(s.x + hw, s.y); c.stroke();
    }
    // Occasional hairline crack scribbled across a tile (only ~22% of tiles).
    function crack(c, s, gx, gy, seed, col) {
      if (hash(gx * 31 + seed, gy * 17 + seed) < 0.78) return;
      var x = s.x + (hash(gx + seed, gy) - 0.5) * TILE_W * 0.4;
      var y = s.y + (hash(gx, gy + seed) - 0.5) * TILE_H * 0.4;
      c.strokeStyle = col; c.lineWidth = 0.8;
      c.beginPath(); c.moveTo(x, y);
      for (var k = 1; k <= 3; k++) {
        x += (hash(gx * 7 + k + seed, gy * 5 - k) - 0.5) * 11;
        y += (hash(gx - k, gy + k + seed) - 0.5) * 5.5;
        c.lineTo(x, y);
      }
      c.stroke();
    }

    function grassTile(c, gx, gy) {
      var s = iso(gx, gy), h = hash(gx, gy);
      // griddy base: each cell keeps one flat turf colour
      diamondPath(c, s.x, s.y);
      c.fillStyle = GRASS[(h * GRASS.length) | 0];
      c.fill();
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      // coarse patch mottling (spans several cells) for a natural lawn
      var ph = hash((gx >> 1) + 200, (gy >> 1) + 200);
      if (ph > 0.62) { c.fillStyle = 'rgba(156,204,116,0.16)'; c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H); }
      else if (ph < 0.36) { c.fillStyle = 'rgba(46,96,46,0.14)'; c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H); }
      // mottled flecks so the cell reads as turf rather than flat colour
      fleck(c, s, gx, gy, 9, 0.86, 1.6, function (t) { return GRASS_FLECK[(t * GRASS_FLECK.length) | 0]; });
      // scattered blades (a couple of shades, varied height), denser on rougher cells
      var blades = 4 + ((h * 4) | 0);
      for (var b = 0; b < blades; b++) {
        var bxh = hash(gx * 7 + b, gy * 13 - b);
        var byh = hash(gx - b * 3, gy + b * 5);
        var bx = s.x + (bxh - 0.5) * TILE_W * 0.7;
        var by = s.y + (byh - 0.5) * TILE_H * 0.7;
        c.strokeStyle = bxh > 0.5 ? 'rgba(58,112,48,0.5)' : 'rgba(150,196,108,0.55)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(bx, by);
        c.lineTo(bx + (bxh - 0.5) * 3, by - 4 - bxh * 4);
        c.stroke();
      }
      // rare daisy cluster or a pebble for landscaping detail
      if (hash(gx * 3 + 1, gy * 3 + 2) > 0.9) {
        var dx = s.x + (hash(gx + 4, gy) - 0.5) * TILE_W * 0.4;
        var dy = s.y + (hash(gx, gy + 4) - 0.5) * TILE_H * 0.4;
        c.fillStyle = '#f6f8ee';
        for (var p = 0; p < 5; p++) {
          var ang = p / 5 * Math.PI * 2;
          c.beginPath(); c.arc(dx + Math.cos(ang) * 2, dy + Math.sin(ang) * 1.4, 1.1, 0, Math.PI * 2); c.fill();
        }
        c.fillStyle = '#f2c84b'; c.beginPath(); c.arc(dx, dy, 1.2, 0, Math.PI * 2); c.fill();
      } else if (hash(gx * 5 + 7, gy * 5 + 3) > 0.92) {
        var qx = s.x + (hash(gx + 2, gy + 6) - 0.5) * TILE_W * 0.4;
        var qy = s.y + (hash(gx + 6, gy + 2) - 0.5) * TILE_H * 0.4;
        c.fillStyle = 'rgba(118,118,114,0.7)';
        c.beginPath(); c.ellipse(qx, qy, 2.4, 1.6, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(172,172,166,0.6)';
        c.beginPath(); c.ellipse(qx - 0.5, qy - 0.5, 1.1, 0.7, 0, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    }

    function pathTile(c, gx, gy) {
      var s = iso(gx, gy), h = hash(gx * 3 + 99, gy * 3 + 7);
      diamondPath(c, s.x, s.y);
      c.fillStyle = h > 0.5 ? '#d9cfb8' : '#d0c5ac';
      c.fill();
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      // concrete aggregate: light + dark grit specks, plus the odd crack
      fleck(c, s, gx, gy, 11, 0.9, 1.5, function (t) {
        return t > 0.5 ? 'rgba(120,108,84,0.35)' : 'rgba(247,242,230,0.45)';
      });
      crack(c, s, gx, gy, 13, 'rgba(110,98,76,0.4)');
      c.restore();
      // bevelled paver edge + joint groove
      bevel(c, s, 1.5, 'rgba(255,250,235,0.5)', 'rgba(120,108,84,0.4)');
      c.strokeStyle = 'rgba(150,138,110,0.5)';
      c.lineWidth = 1;
      diamondPath(c, s.x, s.y); c.stroke();
    }

    function roadTile(c, gx, gy) {
      var s = iso(gx, gy), h = hash(gx * 5 + 3, gy * 5 + 8);
      diamondPath(c, s.x, s.y);
      c.fillStyle = h > 0.5 ? '#5c636c' : '#565d66';
      c.fill();
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      // asphalt grit: bright + dark aggregate flecks
      fleck(c, s, gx, gy, 14, 0.94, 1.6, function (t) {
        return t > 0.62 ? 'rgba(152,158,166,0.32)' : t < 0.32 ? 'rgba(28,32,38,0.42)' : 'rgba(110,116,124,0.24)';
      });
      // occasional oil stain blotch
      if (hash(gx * 9 + 2, gy * 11 + 5) > 0.86) {
        var ox = s.x + (hash(gx + 3, gy) - 0.5) * TILE_W * 0.4;
        var oy = s.y + (hash(gx, gy + 3) - 0.5) * TILE_H * 0.4;
        var og = c.createRadialGradient(ox, oy, 1, ox, oy, 11);
        og.addColorStop(0, 'rgba(20,22,28,0.4)'); og.addColorStop(1, 'rgba(20,22,28,0)');
        c.fillStyle = og; c.fillRect(ox - 12, oy - 12, 24, 24);
      }
      crack(c, s, gx, gy, 21, 'rgba(20,22,26,0.45)');
      c.restore();
    }

    function sidewalkTile(c, gx, gy) {
      var s = iso(gx, gy), h = hash(gx * 9 + 1, gy * 9 + 4);
      diamondPath(c, s.x, s.y);
      c.fillStyle = h > 0.5 ? '#c4c8cd' : '#bcc0c6';
      c.fill();
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      // fine concrete speckle + the odd hairline crack
      fleck(c, s, gx, gy, 10, 0.9, 1.4, function (t) {
        return t > 0.5 ? 'rgba(150,154,160,0.3)' : 'rgba(228,231,235,0.42)';
      });
      crack(c, s, gx, gy, 17, 'rgba(120,124,130,0.4)');
      c.restore();
      // bevelled slab + expansion joint
      bevel(c, s, 1.5, 'rgba(236,239,243,0.55)', 'rgba(150,154,160,0.45)');
      c.strokeStyle = 'rgba(140,144,150,0.55)'; c.lineWidth = 1;
      diamondPath(c, s.x, s.y); c.stroke();
    }

    function floorTile(c, gx, gy) {
      var s = iso(gx, gy);
      var light = (gx + gy) % 2 === 0;
      var h = hash(gx + 31, gy + 17);
      diamondPath(c, s.x, s.y);
      c.fillStyle = light ? '#eaf3f6' : '#dde9ee';
      c.fill();
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      // faint per-tile shade variance
      c.fillStyle = 'rgba(120,150,170,' + (0.03 + h * 0.05).toFixed(3) + ')';
      c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      // glossy vinyl sheen sweeping down from the top corner
      var hg = c.createLinearGradient(s.x, s.y - TILE_HH, s.x, s.y + TILE_HH);
      hg.addColorStop(0, 'rgba(255,255,255,0.30)');
      hg.addColorStop(0.5, 'rgba(255,255,255,0.05)');
      hg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = hg;
      c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      // a few mineral specks + the occasional scuff mark
      fleck(c, s, gx, gy, 5, 0.7, 1.2, function () { return 'rgba(150,180,196,0.22)'; });
      if (hash(gx * 7 + 5, gy * 7 + 9) > 0.9) {
        c.strokeStyle = 'rgba(120,140,155,0.25)'; c.lineWidth = 1.4;
        c.beginPath(); c.arc(s.x + (h - 0.5) * 14, s.y + (h - 0.4) * 7, 4, 0.2, 2.2); c.stroke();
      }
      c.restore();
      // bevelled polished tile + grout
      bevel(c, s, 1, 'rgba(255,255,255,0.32)', 'rgba(150,180,196,0.35)');
      c.strokeStyle = 'rgba(150,180,196,0.55)';
      c.lineWidth = 1;
      diamondPath(c, s.x, s.y); c.stroke();
    }

    // Plain corridors get a soft teal runner so passages read clearly differently
    // from the glossy white-blue vinyl of the clinic, blank rooms and exam rooms.
    function carpetTile(c, gx, gy) {
      var s = iso(gx, gy);
      var h = hash(gx + 13, gy + 7);
      diamondPath(c, s.x, s.y);
      c.fillStyle = ((gx + gy) % 2 === 0) ? '#8cc1b6' : '#80b6ab';
      c.fill();
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      // per-tile shade variance
      c.fillStyle = 'rgba(28,82,74,' + (0.04 + h * 0.06).toFixed(3) + ')';
      c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      // woven pile: light + dark flecks scattered across the tile
      fleck(c, s, gx, gy, 16, 0.74, 1.1, function () { return 'rgba(255,255,255,0.12)'; });
      fleck(c, s, gx * 3 + 2, gy * 3 + 5, 12, 0.7, 1.0, function () { return 'rgba(20,60,54,0.16)'; });
      c.restore();
      // bevel + bound edge so each runner tile reads as a woven square
      bevel(c, s, 1, 'rgba(255,255,255,0.18)', 'rgba(28,82,74,0.30)');
      c.strokeStyle = 'rgba(36,96,86,0.5)';
      c.lineWidth = 1;
      diamondPath(c, s.x, s.y); c.stroke();
    }

    // Gradient cache. Most per-frame gradients (walls, fixtures, character bodies)
    // are at repeating coordinates with fixed colour stops, so memoising them turns
    // hundreds of createLinearGradient/addColorStop calls per frame into map hits.
    // Keyed by context (a CanvasGradient is bound to its context), coords, and stops.
    var _gcache = new Map(), _cid = 0;
    function ctxId(c) { return c.__cid || (c.__cid = ++_cid); }
    function gradL(c, x0, y0, x1, y1, stops) {           // stops: [[off,'#color'], ...]
      var k = ctxId(c) + 'L' + (x0 | 0) + ',' + (y0 | 0) + ',' + (x1 | 0) + ',' + (y1 | 0);
      for (var i = 0; i < stops.length; i++) k += '|' + stops[i][0] + stops[i][1];
      var g = _gcache.get(k);
      if (g) return g;
      g = c.createLinearGradient(x0, y0, x1, y1);
      for (var j = 0; j < stops.length; j++) g.addColorStop(stops[j][0], stops[j][1]);
      if (_gcache.size > 3000) _gcache.clear();
      _gcache.set(k, g);
      return g;
    }
    function gradR(c, x0, y0, r0, x1, y1, r1, stops) {
      var k = ctxId(c) + 'R' + (x0 | 0) + ',' + (y0 | 0) + ',' + (r0 | 0) + ',' + (x1 | 0) + ',' + (y1 | 0) + ',' + (r1 | 0);
      for (var i = 0; i < stops.length; i++) k += '|' + stops[i][0] + stops[i][1];
      var g = _gcache.get(k);
      if (g) return g;
      g = c.createRadialGradient(x0, y0, r0, x1, y1, r1);
      for (var j = 0; j < stops.length; j++) g.addColorStop(stops[j][0], stops[j][1]);
      if (_gcache.size > 3000) _gcache.clear();
      _gcache.set(k, g);
      return g;
    }

    // Vertical wall face rising height `H` from base segment a→b.
    function wallFace(c, ax, ay, bx, by, H, faceTop, faceBot, capCol, trimCol) {
      var a = iso(ax, ay), b = iso(bx, by);
      var grad = gradL(c, 0, a.y - H, 0, a.y, [[0, faceTop], [1, faceBot]]);
      c.beginPath();
      c.moveTo(a.x, a.y - H);
      c.lineTo(b.x, b.y - H);
      c.lineTo(b.x, b.y);
      c.lineTo(a.x, a.y);
      c.closePath();
      c.fillStyle = grad;
      c.fill();
      // subtle wall texture (clipped to the face): vertical panel seams, a
      // chair-rail moulding line, and faint vertical streaks for a painted look.
      c.save();
      c.beginPath();
      c.moveTo(a.x, a.y - H); c.lineTo(b.x, b.y - H);
      c.lineTo(b.x, b.y); c.lineTo(a.x, a.y); c.closePath();
      c.clip();
      var dlen = Math.hypot(b.x - a.x, b.y - a.y);
      var ry = H * 0.42;   // chair-rail height = top of the lower wainscot
      // lower wainscot: a faintly cooler tiled band from baseboard up to the rail
      c.fillStyle = 'rgba(214,228,236,0.32)';
      c.beginPath();
      c.moveTo(a.x, a.y - ry); c.lineTo(b.x, b.y - ry);
      c.lineTo(b.x, b.y); c.lineTo(a.x, a.y); c.closePath(); c.fill();
      var segs = Math.max(2, Math.round(dlen / (TILE_W * 0.5)));   // ~one seam per ½ tile
      for (var wi = 1; wi < segs; wi++) {
        var wt = wi / segs;
        var lx = a.x + (b.x - a.x) * wt, ly = a.y + (b.y - a.y) * wt;
        c.strokeStyle = 'rgba(120,150,165,0.12)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(lx, ly - H); c.lineTo(lx, ly); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.10)';
        c.beginPath(); c.moveTo(lx + 1, ly - H); c.lineTo(lx + 1, ly); c.stroke();
      }
      // horizontal grout lines through the wainscot to complete the tile grid
      [0.34, 0.67].forEach(function (gf) {
        var gyy = ry * gf;
        c.strokeStyle = 'rgba(120,150,165,0.12)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(a.x, a.y - gyy); c.lineTo(b.x, b.y - gyy); c.stroke();
      });
      // chair-rail moulding at the top of the wainscot (shadow + highlight)
      c.strokeStyle = 'rgba(92,122,138,0.2)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(a.x, a.y - ry); c.lineTo(b.x, b.y - ry); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(a.x, a.y - ry + 2); c.lineTo(b.x, b.y - ry + 2); c.stroke();
      c.restore();
      // coloured baseboard trim along the bottom
      if (trimCol) {
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.lineTo(b.x, b.y - 6);
        c.lineTo(a.x, a.y - 6);
        c.closePath();
        c.fillStyle = trimCol;
        c.fill();
      }
      // top cap edge
      c.beginPath();
      c.moveTo(a.x, a.y - H);
      c.lineTo(b.x, b.y - H);
      c.strokeStyle = capCol;
      c.lineWidth = 3;
      c.stroke();
    }

    // A filled band on the front-left wall plane (gy = ROOM-0.5), between grid
    // columns gxA..gxB and screen-heights hBot..hTop above the floor line.
    function wallQuad(c, gxA, gxB, hTop, hBot, fill) {
      var a = iso(gxA, ROOM - 0.5), b = iso(gxB, ROOM - 0.5);
      c.beginPath();
      c.moveTo(a.x, a.y - hTop); c.lineTo(b.x, b.y - hTop);
      c.lineTo(b.x, b.y - hBot); c.lineTo(a.x, a.y - hBot); c.closePath();
      c.fillStyle = fill; c.fill();
    }

    // A filled band on ANY wall edge a→b (grid corner coords), between
    // screen-heights hBot..hTop above the floor line. (wallQuad, but generic.)
    function edgeQuad(c, ax, ay, bx, by, hTop, hBot, fill) {
      var a = iso(ax, ay), b = iso(bx, by);
      c.beginPath();
      c.moveTo(a.x, a.y - hTop); c.lineTo(b.x, b.y - hTop);
      c.lineTo(b.x, b.y - hBot); c.lineTo(a.x, a.y - hBot); c.closePath();
      c.fillStyle = fill; c.fill();
    }
    // A doorway opening on a wall edge a→b at height H: two jambs + a lintel,
    // leaving the middle clear so the connected floor shows through.
    function drawDoorOpening(c, ax, ay, bx, by, H, reg) {
      var frame = '#d6dfe4', jw = 0.18;
      var lx = ax + (bx - ax) * jw, ly = ay + (by - ay) * jw;       // inner edge of left jamb
      var rx = ax + (bx - ax) * (1 - jw), ry = ay + (by - ay) * (1 - jw); // inner edge of right jamb
      edgeQuad(c, ax, ay, lx, ly, H, 0, frame);                    // left jamb
      edgeQuad(c, rx, ry, bx, by, H, 0, frame);                    // right jamb
      edgeQuad(c, ax, ay, bx, by, H, H - 9, frame);                // lintel
      edgeQuad(c, ax, ay, bx, by, H - 9, H - 11, '#37b3a3');       // teal accent stripe
      doorways.push({ ax: ax, ay: ay, bx: bx, by: by, H: H,        // register for animated doors
                      style: (reg && reg.style) || 'slide', inx: (reg && reg.inx) || 0, iny: (reg && reg.iny) || 0 });
    }
    // A wall shared with a corridor gets ONE doorway, not an opening at every tile:
    // true only at the first tile of each contiguous run of corridor-adjacent edge
    // tiles (corr(i) = does edge index i abut a corridor?). The rest stay solid.
    function firstOfRun(corr, i) { return corr(i) && !corr(i - 1); }
    // One frosted-glass door leaf between iso points a→b, rising to H. `handleAtB`
    // puts the vertical handle on the b end (the leaf's meeting edge).
    function genPanel(c, a, b, H, handleAtB) {
      var g = gradL(c, 0, a.y - H, 0, a.y, [[0, 'rgba(210,236,244,0.94)'], [1, 'rgba(168,208,224,0.94)']]);
      c.beginPath();
      c.moveTo(a.x, a.y - H); c.lineTo(b.x, b.y - H);
      c.lineTo(b.x, b.y); c.lineTo(a.x, a.y); c.closePath();
      c.fillStyle = g; c.fill();
      c.strokeStyle = '#9fb6c2'; c.lineWidth = 2; c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(a.x + (b.x - a.x) * 0.32, a.y - H * 0.82);
      c.lineTo(a.x + (b.x - a.x) * 0.5, a.y - H * 0.2);
      c.stroke();
      var hx = handleAtB ? b.x - 4 : a.x + 4, hy = handleAtB ? b.y : a.y;
      c.strokeStyle = '#566873'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(hx, hy - H * 0.62); c.lineTo(hx, hy - H * 0.34); c.stroke();
    }
    // Automatic double sliding doors filling a 1-tile doorway `d` ({ax,ay,bx,by,H}).
    // `open` 0 (shut, leaves meet in the middle) … 1 (slid apart into the jambs).
    // Clipped to the opening so the leaves vanish into the wall, like the entry.
    function drawDoorwayPanels(c, d, open) {
      var H = d.H - 10;
      function P(t) { return iso(d.ax + (d.bx - d.ax) * t, d.ay + (d.by - d.ay) * t); }
      var a = P(0), b = P(1);
      c.save();
      c.beginPath();
      c.moveTo(a.x, a.y - H); c.lineTo(b.x, b.y - H);
      c.lineTo(b.x, b.y); c.lineTo(a.x, a.y); c.closePath();
      c.clip();
      genPanel(c, P(-0.5 * open), P(0.5 - 0.5 * open), H, true);     // left leaf
      genPanel(c, P(0.5 + 0.5 * open), P(1 + 0.5 * open), H, false); // right leaf
      c.restore();
    }
    // A regular hinged wooden door filling a 1-tile doorway `d`. Hinged at its a→b
    // start and swinging into the room (d.inx,d.iny) as `open` goes 0 (shut) … 1.
    function drawBrownDoor(c, d, open) {
      var Hd = d.H - 10;
      var th = open * Math.PI * 0.5 * 0.82;                  // swing up to ~74°
      var ex = d.bx - d.ax, ey = d.by - d.ay;                // closed-leaf direction (1 tile)
      var A = iso(d.ax, d.ay);
      var F = iso(d.ax + Math.cos(th) * ex + Math.sin(th) * (d.inx || 0),
                  d.ay + Math.cos(th) * ey + Math.sin(th) * (d.iny || 0));
      var g = gradL(c, 0, A.y - Hd, 0, A.y, [[0, '#b07c45'], [1, '#875528']]);
      c.beginPath();
      c.moveTo(A.x, A.y - Hd); c.lineTo(F.x, F.y - Hd);
      c.lineTo(F.x, F.y); c.lineTo(A.x, A.y); c.closePath();
      c.fillStyle = g; c.fill();
      c.strokeStyle = '#6f4621'; c.lineWidth = 1.5; c.stroke();
      c.strokeStyle = 'rgba(80,50,22,0.5)'; c.lineWidth = 1;   // two recessed-panel division lines
      [0.36, 0.64].forEach(function (hf) {
        c.beginPath(); c.moveTo(A.x, A.y - Hd * hf); c.lineTo(F.x, F.y - Hd * hf); c.stroke();
      });
      var hx = A.x + (F.x - A.x) * 0.82, hy = (A.y + (F.y - A.y) * 0.82) - Hd * 0.5; // brass handle
      c.fillStyle = '#e8d28a'; c.beginPath(); c.arc(hx, hy, 1.8, 0, Math.PI * 2); c.fill();
    }
    // Walls for every corridor square and exam room, baked in ONE pass so they
    // layer correctly across structures. Within each layer (tall→bgx behind the
    // actors, short→fgx in front) segments are sorted back-to-front by gx+gy, so a
    // nearer wall always paints over a farther one — fixing the z-fighting you get
    // when a room's wall was drawn on top of a corridor wall standing in front of
    // it. Corridor edges wall off anything that isn't room floor; exam rooms wall
    // off the corridor side too, leaving a single doorway at rm.door.
    var wallSegs = [];     // {d, fn}; rebuilt by collectWalls(), depth-sorted in draw()
    function collectWalls() {
      // Every wall / door / wall-decoration / entrance-frame segment becomes a
      // depth-sorted scene item drawn live in draw(), so walls interleave with
      // furniture and characters by their foot depth (no more baked bg/fg split).
      // d = midpoint grid-sum ((ax+ay+bx+by)/2) — the SAME scale as an actor's
      // gx+gy, so a back wall sorts just behind, a front wall just in front of, an
      // actor sharing its tile, and nearer structures always paint over farther.
      wallSegs.length = 0;
      function W(isTall, ax, ay, bx, by, H, c1, c2, c3, c4) {
        wallSegs.push({ d: (ax + ay + bx + by) / 2,
          fn: function () { wallFace(ctx, ax, ay, bx, by, H, c1, c2, c3, c4); } });
      }
      function D(isTall, ax, ay, bx, by, H, opts) {
        wallSegs.push({ d: (ax + ay + bx + by) / 2,
          fn: function () { drawDoorOpening(ctx, ax, ay, bx, by, H, opts); } });
      }
      // clinic perimeter, segmented per tile so a corridor run punches one doorway.
      // Collected here (not drawn directly) so it depth-sorts with corridor/exam
      // walls — otherwise a corridor behind the clinic draws over the back wall.
      // Open (no wall/door) where a plain corridor or a blank room abuts; else wall.
      for (var pby = 0; pby < ROOM; pby++)
        if (!isOpenAdj(-1, pby)) W(true, -0.5, pby - 0.5, -0.5, pby + 0.5, WALL_H, '#fbfdfe', '#e2ecf1', '#ffffff', '#37b3a3');
      for (var pbx = 0; pbx < ROOM; pbx++)
        if (!isOpenAdj(pbx, -1)) W(true, pbx - 0.5, -0.5, pbx + 0.5, -0.5, WALL_H, '#e4edf2', '#cad9e2', '#eef4f7', '#2f9e90');
      for (var pfy = 0; pfy < ROOM; pfy++)
        if (!isOpenAdj(ROOM, pfy)) W(false, ROOM - 0.5, pfy - 0.5, ROOM - 0.5, pfy + 0.5, FRONT_WALL_H, '#dbe7ed', '#c2d3dd', '#e9f1f4', '#2f9e90');
      for (var pdx = 0; pdx < ROOM; pdx++) {
        if (pdx === 3 || pdx === 4) continue;   // main entrance opening
        if (!isOpenAdj(pdx, ROOM)) W(false, pdx - 0.5, ROOM - 0.5, pdx + 0.5, ROOM - 0.5, FRONT_WALL_H, '#eef5f8', '#d7e4eb', '#f6fafb', '#37b3a3');
      }
      // corridor squares: wall every edge that borders non-room-floor
      for (var key in corridor) {
        if (!corridor.hasOwnProperty(key)) continue;
        var p = key.split(','), x = +p[0], y = +p[1];
        if (!isRoomFloor(x - 1, y)) W(true,  x - 0.5, y - 0.5, x - 0.5, y + 0.5, WALL_H, '#fbfdfe', '#e2ecf1', '#ffffff', '#37b3a3');
        if (!isRoomFloor(x, y - 1)) W(true,  x - 0.5, y - 0.5, x + 0.5, y - 0.5, WALL_H, '#e4edf2', '#cad9e2', '#eef4f7', '#2f9e90');
        if (!isRoomFloor(x + 1, y)) W(false, x + 0.5, y - 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, '#dbe7ed', '#c2d3dd', '#e9f1f4', '#2f9e90');
        if (!isRoomFloor(x, y + 1)) W(false, x - 0.5, y + 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, '#eef5f8', '#d7e4eb', '#f6fafb', '#37b3a3');
      }
      // Walled rooms (exam / xray / restroom / pharmacy): wall every corridor-
      // facing edge, punching a brown doorway at the room's door tile. One generic
      // pass over the room registry — membership is a tile-set lookup so it works
      // for any footprint (rectangular or rotated). Order matches the registry so
      // equal-depth segments sort identically to before.
      function roomWalls(rm, tiles) {
        var door = rm.door, set = {};
        tiles.forEach(function (t) { set[t.x + ',' + t.y] = true; });
        function mine(x, y) { return !!set[x + ',' + y]; }
        function isDoor(x, y) { return door && door.x === x && door.y === y; }
        tiles.forEach(function (t) {
          var x = t.x, y = t.y;
          if (!mine(x - 1, y) && isRoomFloor(x - 1, y)) { if (isDoor(x - 1, y)) D(true, x - 0.5, y - 0.5, x - 0.5, y + 0.5, WALL_H, { style: 'brown', inx: 1, iny: 0 }); else W(true, x - 0.5, y - 0.5, x - 0.5, y + 0.5, WALL_H, '#fbfdfe', '#e2ecf1', '#ffffff', '#37b3a3'); }
          if (!mine(x, y - 1) && isRoomFloor(x, y - 1)) { if (isDoor(x, y - 1)) D(true, x - 0.5, y - 0.5, x + 0.5, y - 0.5, WALL_H, { style: 'brown', inx: 0, iny: 1 }); else W(true, x - 0.5, y - 0.5, x + 0.5, y - 0.5, WALL_H, '#e4edf2', '#cad9e2', '#eef4f7', '#2f9e90'); }
          if (!mine(x + 1, y) && isRoomFloor(x + 1, y)) { if (isDoor(x + 1, y)) D(false, x + 0.5, y - 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, { style: 'brown', inx: -1, iny: 0 }); else W(false, x + 0.5, y - 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, '#dbe7ed', '#c2d3dd', '#e9f1f4', '#2f9e90'); }
          if (!mine(x, y + 1) && isRoomFloor(x, y + 1)) { if (isDoor(x, y + 1)) D(false, x - 0.5, y + 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, { style: 'brown', inx: 0, iny: -1 }); else W(false, x - 0.5, y + 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, '#eef5f8', '#d7e4eb', '#f6fafb', '#37b3a3'); }
        });
      }
      ['exam', 'xray', 'restroom', 'pharmacy'].forEach(function (type) {
        var d = ROOM_TYPES[type];
        d.list.forEach(function (rm) { roomWalls(rm, d.tiles(rm.gx, rm.gy, rm.rot || 0)); });
      });
      // ---- decorations billboarded onto the tall back-wall planes ----------
      // Each is its own scene item; d = the billboard's far grid-edge so its own
      // back wall never paints over it, while an actor standing in front (larger
      // gx+gy) still occludes it. Heights are well above the floor, so the rare
      // close actor barely overlaps.
      function rRB(c, cx, dw, hLo, hHi, fill, stroke, lw) {   // back-right plane (gy=-0.5)
        var p0 = iso(cx - dw, -0.5), p1 = iso(cx + dw, -0.5);
        c.beginPath();
        c.moveTo(p0.x, p0.y - hHi); c.lineTo(p1.x, p1.y - hHi);
        c.lineTo(p1.x, p1.y - hLo); c.lineTo(p0.x, p0.y - hLo); c.closePath();
        if (fill) { c.fillStyle = fill; c.fill(); }
        if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw || 2; c.stroke(); }
      }
      function rLB(c, cy, dw, hLo, hHi, fill, stroke, lw) {   // back-left plane (gx=-0.5)
        var p0 = iso(-0.5, cy - dw), p1 = iso(-0.5, cy + dw);
        c.beginPath();
        c.moveTo(p0.x, p0.y - hHi); c.lineTo(p1.x, p1.y - hHi);
        c.lineTo(p1.x, p1.y - hLo); c.lineTo(p0.x, p0.y - hLo); c.closePath();
        if (fill) { c.fillStyle = fill; c.fill(); }
        if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw || 2; c.stroke(); }
      }
      wallSegs.push({ d: -0.5 + (2.5 + 0.95), fn: function () {   // back-left window + sill
        var c = ctx;
        rLB(c, 2.5, 0.95, 30, 52, '#cfe8f5', '#9fb4c0', 3);
        var wm = iso(-0.5, 2.5);
        c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(wm.x, wm.y - 52); c.lineTo(wm.x, wm.y - 30); c.stroke();
        var wl = iso(-0.5, 2.5 - 0.95), wr = iso(-0.5, 2.5 + 0.95);
        c.beginPath(); c.moveTo(wl.x, wl.y - 41); c.lineTo(wr.x, wr.y - 41); c.stroke();
        rLB(c, 2.5, 1.05, 28, 30, '#eef4f7', null);             // sill
      } });
      wallSegs.push({ d: -0.5 + (5.2 + 0.5), fn: function () {    // back-left certificate
        rLB(ctx, 5.2, 0.5, 35, 49, '#f3ead2', '#9a7b46', 3);
      } });
      wallSegs.push({ d: 2.0 + -0.5, fn: function () {            // back-right wall clock
        var c = ctx, cl = iso(2.0, -0.5), clY = cl.y - 45;
        c.fillStyle = '#f7fbfc'; c.beginPath(); c.arc(cl.x, clY, 8, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#5a6b76'; c.lineWidth = 2; c.stroke();
        c.strokeStyle = '#2a3640'; c.lineWidth = 1.5; c.lineCap = 'round';
        c.beginPath(); c.moveTo(cl.x, clY); c.lineTo(cl.x, clY - 5); c.stroke();
        c.beginPath(); c.moveTo(cl.x, clY); c.lineTo(cl.x + 4, clY + 1); c.stroke();
        c.lineCap = 'butt';
      } });
      wallSegs.push({ d: (4.7 + 0.95) + -0.5, fn: function () {   // back-right vet-cross poster
        var c = ctx, pc = iso(4.7, -0.5), pcY = pc.y - 41;
        rRB(c, 4.7, 0.95, 30, 52, '#ffffff', '#37b3a3', 3);
        c.fillStyle = '#e0563f';
        c.fillRect(pc.x - 2.5, pcY - 7, 5, 14);
        c.fillRect(pc.x - 7, pcY - 2.5, 14, 5);
      } });
      // entrance frame: front perimeter (gy = ROOM-0.5), so it draws in front of
      // the clinic interior just like the short front walls it sits on.
      wallSegs.push({ d: DOOR_MID + (ROOM - 0.5), fn: function () { drawDoorFrame(ctx); } });
    }

    // Static frame (jambs + lintel + sign) around the sliding doors.
    function drawDoorFrame(c) {
      var H = DOOR_H, frame = '#d6dfe4';
      wallQuad(c, DOOR_A, DOOR_A + 0.16, H, 0, frame);        // left jamb
      wallQuad(c, DOOR_B - 0.16, DOOR_B, H, 0, frame);        // right jamb
      wallQuad(c, DOOR_A, DOOR_B, H, H - 9, frame);           // top lintel
      wallQuad(c, DOOR_A, DOOR_B, H - 9, H - 11, '#37b3a3');  // teal accent stripe
      // white vet cross on the lintel
      var m = iso(DOOR_MID, ROOM - 0.5);
      c.fillStyle = '#fff';
      c.fillRect(m.x - 2.5, m.y - (H - 1), 5, 8);
      c.fillRect(m.x - 5, m.y - (H - 1) + 1.5, 11, 4);
    }

    // Animated automatic sliding double doors. `open` is 0 (shut) … 1 (apart).
    // Drawing is clipped to the opening so panels appear to slide into the wall.
    function drawSlidingDoors(c, open) {
      var H = DOOR_H - 10;
      var a = iso(DOOR_A, ROOM - 0.5), b = iso(DOOR_B, ROOM - 0.5);
      c.save();
      c.beginPath();
      c.moveTo(a.x, a.y - H); c.lineTo(b.x, b.y - H);
      c.lineTo(b.x, b.y); c.lineTo(a.x, a.y); c.closePath();
      c.clip();
      doorPanel(c, DOOR_MID - 1 - open, DOOR_MID - open, H, true);   // left panel
      doorPanel(c, DOOR_MID + open, DOOR_MID + 1 + open, H, false);  // right panel
      c.restore();
    }

    function doorPanel(c, gxA, gxB, H, handleRight) {
      var a = iso(gxA, ROOM - 0.5), b = iso(gxB, ROOM - 0.5);
      var g = gradL(c, 0, a.y - H, 0, a.y, [[0, 'rgba(210,236,244,0.94)'], [1, 'rgba(168,208,224,0.94)']]);
      c.beginPath();
      c.moveTo(a.x, a.y - H); c.lineTo(b.x, b.y - H);
      c.lineTo(b.x, b.y); c.lineTo(a.x, a.y); c.closePath();
      c.fillStyle = g; c.fill();
      c.strokeStyle = '#9fb6c2'; c.lineWidth = 2; c.stroke();
      // sheen
      c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(a.x + (b.x - a.x) * 0.32, a.y - H * 0.82);
      c.lineTo(a.x + (b.x - a.x) * 0.5, a.y - H * 0.2);
      c.stroke();
      // vertical handle near the meeting edge
      var hx = handleRight ? b.x - 4 : a.x + 4, hy = handleRight ? b.y : a.y;
      c.strokeStyle = '#566873'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(hx, hy - H * 0.62); c.lineTo(hx, hy - H * 0.34); c.stroke();
    }

    // ---- Build the static layers -----------------------------------------
    // During bulk layout changes (load) we place many rooms in a loop, each of
    // which calls renderStatic(); suspend it and bake once at the end.
    var _suspendStatic = false;
    var staticDirty = false;               // coalesces static redraws (e.g. while panning) to one per frame
    function renderStatic() {
      if (_suspendStatic) return;
      bgx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      fgx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      bgx.clearRect(0, 0, view.w, view.h);
      fgx.clearRect(0, 0, view.w, view.h);
      doorways.length = 0;                  // rebuilt as drawDoorOpening() runs in collectWalls()
      wallSegs.length = 0;                   // cleared so walls vanish while placing (collectWalls rebuilds)

      // 1) grass: cover the whole viewport (grid bbox of the 4 screen corners)
      var corners = [screenToGrid(0, 0), screenToGrid(view.w, 0),
                     screenToGrid(0, view.h), screenToGrid(view.w, view.h)];
      var minGx = 1e9, maxGx = -1e9, minGy = 1e9, maxGy = -1e9;
      corners.forEach(function (p) {
        minGx = Math.min(minGx, p.gx); maxGx = Math.max(maxGx, p.gx);
        minGy = Math.min(minGy, p.gy); maxGy = Math.max(maxGy, p.gy);
      });
      minGx = Math.floor(minGx) - 2; maxGx = Math.ceil(maxGx) + 2;
      minGy = Math.floor(minGy) - 2; maxGy = Math.ceil(maxGy) + 2;
      for (var gy = minGy; gy <= maxGy; gy++)
        for (var gx = minGx; gx <= maxGx; gx++)
          grassTile(bgx, gx, gy);

      // 2) path (2 tiles wide) from the doors out to the road
      for (var py = ROOM; py <= ROOM + 4; py++) { pathTile(bgx, 3, py); pathTile(bgx, 4, py); }
      // road + sidewalks at the end of the path (runs along the gx axis).
      // gy cross-section: sidewalk | lane lane | <centre> | lane lane | sidewalk
      var swNear = ROOM + 5, laneN0 = ROOM + 6, laneN1 = ROOM + 7,
          laneF0 = ROOM + 8, laneF1 = ROOM + 9, swFar = ROOM + 10,
          roadMid = ROOM + 7.5;
      for (var rgx = minGx; rgx <= maxGx; rgx++) {
        sidewalkTile(bgx, rgx, swNear); sidewalkTile(bgx, rgx, swFar);
        roadTile(bgx, rgx, laneN0); roadTile(bgx, rgx, laneN1);
        roadTile(bgx, rgx, laneF0); roadTile(bgx, rgx, laneF1);
      }
      // faint tyre-wear strips running along each lane (under the road markings)
      bgx.strokeStyle = 'rgba(28,32,38,0.16)'; bgx.lineWidth = 5;
      [laneN0 + 0.3, laneN1 - 0.3, laneF0 + 0.3, laneF1 - 0.3].forEach(function (ty) {
        var t1 = iso(minGx - 0.5, ty), t2 = iso(maxGx + 0.5, ty);
        bgx.beginPath(); bgx.moveTo(t1.x, t1.y); bgx.lineTo(t2.x, t2.y); bgx.stroke();
      });
      // light curb line along each sidewalk/lane boundary
      bgx.strokeStyle = 'rgba(232,234,237,0.6)'; bgx.lineWidth = 2;
      [swNear + 0.5, swFar - 0.5].forEach(function (cy) {
        var c1 = iso(minGx - 0.5, cy), c2 = iso(maxGx + 0.5, cy);
        bgx.beginPath(); bgx.moveTo(c1.x, c1.y); bgx.lineTo(c2.x, c2.y); bgx.stroke();
      });
      // dashed yellow centre line down the middle of the road
      bgx.strokeStyle = '#ecc94b'; bgx.lineWidth = 3;
      for (var lx = minGx; lx <= maxGx; lx++) {
        if ((lx & 1) === 0) {
          var p1 = iso(lx - 0.32, roadMid), p2 = iso(lx + 0.32, roadMid);
          bgx.beginPath(); bgx.moveTo(p1.x, p1.y); bgx.lineTo(p2.x, p2.y); bgx.stroke();
        }
      }
      // welcome mat just outside the doors (2 wide)
      [3, 4].forEach(function (mx) {
        var s = iso(mx, ROOM - 0.02);
        diamondPath(bgx, s.x, s.y);
        bgx.fillStyle = '#b5564f'; bgx.fill();
        bgx.strokeStyle = 'rgba(120,50,45,0.55)'; bgx.lineWidth = 1; bgx.stroke();
      });

      // 3) clinic floor (+ any bought corridor squares)
      for (var fy = 0; fy < ROOM; fy++)
        for (var fx = 0; fx < ROOM; fx++)
          floorTile(bgx, fx, fy);
      for (var ckey in corridor) {
        if (!corridor.hasOwnProperty(ckey)) continue;
        var cc = ckey.split(','), cgx = +cc[0], cgy = +cc[1];
        if (isPlainCorridor(cgx, cgy)) carpetTile(bgx, cgx, cgy);   // passages → carpet runner
        else floorTile(bgx, cgx, cgy);                             // blank/exam/etc → vinyl
      }
      // soft warm light pool, clipped to the floor diamond
      (function () {
        var ctr = iso(ROOM / 2 - 0.5, ROOM / 2 - 0.5);
        var g = bgx.createRadialGradient(ctr.x, ctr.y, 10, ctr.x, ctr.y, ROOM * TILE_W * 0.42);
        g.addColorStop(0, 'rgba(255,244,210,0.22)');
        g.addColorStop(1, 'rgba(255,244,210,0)');
        bgx.save();
        var t = iso(-0.5, -0.5), r = iso(ROOM - 0.5, -0.5),
            b2 = iso(ROOM - 0.5, ROOM - 0.5), l = iso(-0.5, ROOM - 0.5);
        bgx.beginPath();
        bgx.moveTo(t.x, t.y); bgx.lineTo(r.x, r.y); bgx.lineTo(b2.x, b2.y); bgx.lineTo(l.x, l.y);
        bgx.closePath(); bgx.clip();
        bgx.fillStyle = g; bgx.fillRect(ctr.x - 460, ctr.y - 460, 920, 920);
        bgx.restore();
      })();

      // 4) ALL walls (clinic perimeter + corridors + rooms) + their wall
      //    decorations + the entrance frame are collected into wallSegs and drawn
      //    depth-sorted in draw(). Skipped while placing so walls never obscure
      //    the build view (renderStatic re-runs when placement starts/ends).
      if (!placing) collectWalls();
    }

    // ---- The vet character (clean flat-iso style) ------------------------
    function drawVet() {
      var s = iso(vet.x, vet.y);
      var bob = vet.moving ? Math.sin(vet.walkPhase) * 2.5 : 0;
      var step = vet.moving ? Math.sin(vet.walkPhase) : 0;
      var front = (vet.dir === 'SE' || vet.dir === 'SW');   // facing camera
      var mirror = (vet.dir === 'SW' || vet.dir === 'NW') ? -1 : 1;
      var baseY = s.y - bob;

      // soft ground shadow
      var sh = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, 17);
      sh.addColorStop(0, 'rgba(20,40,30,0.30)');
      sh.addColorStop(1, 'rgba(20,40,30,0)');
      ctx.fillStyle = sh;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 16, 8, 0, 0, Math.PI * 2); ctx.fill();

      ctx.save();
      ctx.translate(s.x, baseY);

      // legs (white scrub trousers) with a little walk step
      ctx.fillStyle = '#e7edf0';
      ctx.fillRect(-7, -15, 6, 15 + step * 1.5);
      ctx.fillRect(1, -15, 6, 15 - step * 1.5);
      // shoes (white clinical clogs)
      ctx.fillStyle = '#c4ced4';
      ctx.fillRect(-8, -2 + step * 1.5, 7, 3);
      ctx.fillRect(1, -2 - step * 1.5, 7, 3);

      // torso — head vet's white coat with a soft gradient
      var bodyTop = -42;
      ctx.fillStyle = gradL(ctx, 0, bodyTop, 0, -12, [[0, '#ffffff'], [1, '#dbe4e9']]);
      roundRect(ctx, -12, bodyTop, 24, 30, 8); ctx.fill();
      ctx.strokeStyle = 'rgba(150,170,185,0.5)'; ctx.lineWidth = 1; ctx.stroke();   // soft edge so the white coat reads on the pale floor
      // short sleeves
      ctx.fillStyle = '#eef3f5';
      roundRect(ctx, -15, bodyTop + 2, 5, 14, 2.5); ctx.fill();
      roundRect(ctx, 10, bodyTop + 2, 5, 14, 2.5); ctx.fill();
      // hands
      ctx.fillStyle = '#f0c8a4';
      ctx.fillRect(-15, bodyTop + 15, 5, 4);
      ctx.fillRect(10, bodyTop + 15, 5, 4);

      if (front) {
        // V-neck
        ctx.fillStyle = '#cbd5dc';
        ctx.beginPath();
        ctx.moveTo(-5, bodyTop); ctx.lineTo(0, bodyTop + 9); ctx.lineTo(5, bodyTop); ctx.closePath();
        ctx.fill();
        // chest pocket
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        ctx.fillRect(3, bodyTop + 14, 7, 6);
        // stethoscope
        ctx.strokeStyle = '#243240'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, bodyTop + 4, 7, Math.PI * 0.1, Math.PI * 0.9, false); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-5, bodyTop + 8); ctx.lineTo(-4, bodyTop + 22); ctx.stroke();
        ctx.fillStyle = '#9fb3c4';
        ctx.beginPath(); ctx.arc(-4, bodyTop + 23, 2.4, 0, Math.PI * 2); ctx.fill();
      } else {
        // back: a centre seam
        ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, bodyTop + 3); ctx.lineTo(0, -14); ctx.stroke();
      }

      // neck
      ctx.fillStyle = '#e7bd98';
      ctx.fillRect(-3, bodyTop - 4, 6, 5);

      // head
      var hy = bodyTop - 13;
      ctx.fillStyle = '#f0c8a4';
      ctx.beginPath(); ctx.arc(0, hy, 9, 0, Math.PI * 2); ctx.fill();
      // ears
      ctx.fillRect(-10, hy - 1, 2, 3);
      ctx.fillRect(8, hy - 1, 2, 3);
      // hair (brown) over the top of the head
      ctx.fillStyle = '#6b4a32';
      ctx.beginPath(); ctx.arc(0, hy - 1, 9, Math.PI * 1.02, Math.PI * 1.98, false); ctx.closePath(); ctx.fill();
      ctx.fillRect(-9, hy - 2, 18, 3);

      if (front) {
        // face
        ctx.fillStyle = '#2b2b33';
        ctx.beginPath();
        ctx.arc(-3.2 * mirror, hy, 1.4, 0, Math.PI * 2);
        ctx.arc(3.2 * mirror, hy, 1.4, 0, Math.PI * 2);
        ctx.fill();
        // light beard
        ctx.fillStyle = 'rgba(120,80,55,0.5)';
        ctx.beginPath(); ctx.arc(0, hy + 5, 5, 0.1 * Math.PI, 0.9 * Math.PI); ctx.fill();
        // smile
        ctx.strokeStyle = '#9a5f44'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(0, hy + 3, 2.4, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
      } else {
        // back of head: hair under the cap
        ctx.fillStyle = '#6b4a32';
        ctx.beginPath(); ctx.arc(0, hy + 3, 8, Math.PI * 0.05, Math.PI * 0.95, false); ctx.fill();
      }

      ctx.restore();
    }

    function roundRect(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    // ---- Visitor + pet rendering -----------------------------------------
    var DOG_SIZE = { 'dog-s': 0.78, 'dog-m': 1.0, 'dog-l': 1.32 };
    var DOG_COLOR = { 'dog-s': '#cba36e', 'dog-m': '#9c6b43', 'dog-l': '#5b4a3a' };

    // The status bubble above a visitor's head: which service they still need, or
    // — once leaving — how they felt. 🙂 only if they completed everything (got an
    // exam); any early exit (gave up waiting, accident) leaves them 😠.
    function visitorEmoji(v) {
      if (v.phase === 'leaving') return v.happy ? '🙂' : '😡';
      if (v.phase === 'toRestroom' || v.phase === 'inRestroom') return '🚻';
      if (!v.served) return '💻';                 // arriving / in line → needs reception
      if (!v.examined) return '🩺';               // seen reception → needs an exam room
      if (v.needsXray && !v.xrayed) return '🩻';  // examined → needs an X-ray
      if (v.needsMeds && !v.medicated) return '💊'; // examined → needs medicine
      return null;
    }

    function drawVisitor(v) {
      var seated = v.phase === 'seated';
      // When seated, draw a little toward the seat front so the chair's backrest
      // stays visible behind the figure (otherwise the body covers the chair).
      var dgx = v.x, dgy = v.y;
      if (seated && v.chair) {
        dgx += (v.chair.fx - v.chair.gx) * 0.3;
        dgy += (v.chair.fy - v.chair.gy) * 0.3;
      }
      var s = iso(dgx, dgy);
      // Every standing-and-waiting visitor shows a patience bar: in line, idle aside,
      // seated, or holding for a free X-ray room / pharmacy counter. (In-room waits
      // — inExam/inXray/inPharm — draw their own bars below.)
      var waiting = (v.phase === 'queuing' || v.phase === 'idle' || seated ||
                     v.phase === 'waitXray' || v.phase === 'waitMeds');
      var maxWait = (seated ? 2 : 1) * baseWait();   // TV doubles the room's base; seated doubles again
      var p = waiting ? v.patience / maxWait : 1;
      var angry = waiting && p < 0.34;
      var jit = angry ? Math.sin(animT * 26) * 0.8 : 0;
      var bob = v.moving ? Math.sin(v.walkPhase) * 2.3 : 0;
      var step = v.moving ? Math.sin(v.walkPhase) : 0;
      var front = (v.dir === 'SE' || v.dir === 'SW');
      var mirror = (v.dir === 'SW' || v.dir === 'NW') ? -1 : 1;
      // Sitting raises the hips onto the ~13px-high seat, so the body stays at
      // about standing height — only the legs fold (handled below). No big lift.
      var baseY = s.y - bob;
      var cx = s.x + jit;

      // ground shadow
      var sh = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, 16);
      sh.addColorStop(0, 'rgba(20,40,30,0.28)'); sh.addColorStop(1, 'rgba(20,40,30,0)');
      ctx.fillStyle = sh;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 15, 7, 0, 0, Math.PI * 2); ctx.fill();

      // a dog walks alongside; draw it first if it's "behind" (waiting/leaving facing
      // camera). When seated the pet is placed in front of the owner instead (below).
      var isDog = v.pet.charAt(0) === 'd';
      if (isDog && front && !seated) drawDog(v, cx - 17 * mirror, s.y + 3, mirror > 0);

      ctx.save();
      ctx.translate(cx, baseY);

      // legs + shoes
      if (seated) {
        // sitting pose: thighs rest forward on the seat, shins drop to the floor
        // in front, so the figure reads as sitting in (not standing on) the chair.
        ctx.fillStyle = v.legs;
        roundRect(ctx, -7, -13, 14, 7, 3); ctx.fill();   // lap / thighs on the seat
        ctx.fillRect(-6, -7, 5, 8);                      // left shin
        ctx.fillRect(1, -7, 5, 8);                       // right shin
        ctx.fillStyle = '#2a2a30';
        ctx.fillRect(-7, 0, 6, 3);                       // shoes on the floor in front
        ctx.fillRect(1, 0, 6, 3);
      } else {
        ctx.fillStyle = v.legs;
        ctx.fillRect(-6, -14, 5, 14 + step * 1.4);
        ctx.fillRect(1, -14, 5, 14 - step * 1.4);
        ctx.fillStyle = '#2a2a30';
        ctx.fillRect(-7, -2 + step * 1.4, 6, 3);
        ctx.fillRect(1, -2 - step * 1.4, 6, 3);
      }

      // torso (shirt)
      var bodyTop = -40;
      ctx.fillStyle = gradL(ctx, 0, bodyTop, 0, -12, [[0, shade(v.shirt, 1.12)], [1, v.shirt]]);
      roundRect(ctx, -11, bodyTop, 22, 28, 7); ctx.fill();
      // sleeves
      ctx.fillStyle = shade(v.shirt, 0.9);
      roundRect(ctx, -14, bodyTop + 2, 5, 13, 2.5); ctx.fill();
      roundRect(ctx, 9, bodyTop + 2, 5, 13, 2.5); ctx.fill();
      // hands
      ctx.fillStyle = v.skin;
      ctx.fillRect(-14, bodyTop + 14, 5, 4);
      ctx.fillRect(9, bodyTop + 14, 5, 4);
      if (!front) { // back seam
        ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, bodyTop + 3); ctx.lineTo(0, -13); ctx.stroke();
      }

      // neck + head
      ctx.fillStyle = shade(v.skin, 0.94);
      ctx.fillRect(-3, bodyTop - 4, 6, 5);
      var hy = bodyTop - 13;
      ctx.fillStyle = v.skin;
      ctx.beginPath(); ctx.arc(0, hy, 8.5, 0, Math.PI * 2); ctx.fill();
      // hair
      ctx.fillStyle = v.hair;
      ctx.beginPath(); ctx.arc(0, hy - 1, 8.5, Math.PI * (front ? 1.02 : 0.05), Math.PI * (front ? 1.98 : 0.95), false); ctx.fill();
      if (!front) { ctx.beginPath(); ctx.arc(0, hy + 1, 8, Math.PI * 0.04, Math.PI * 0.96, false); ctx.fill(); }

      if (front) {
        // eyes (a frown-y angle when cross)
        ctx.fillStyle = '#2b2b33';
        ctx.beginPath();
        ctx.arc(-3 * mirror, hy, 1.3, 0, Math.PI * 2);
        ctx.arc(3 * mirror, hy, 1.3, 0, Math.PI * 2);
        ctx.fill();
        if (angry) {
          // angry eyebrows + frown
          ctx.strokeStyle = '#2b2b33'; ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.moveTo(-5, hy - 3); ctx.lineTo(-1.5, hy - 1.5);
          ctx.moveTo(5, hy - 3); ctx.lineTo(1.5, hy - 1.5); ctx.stroke();
          ctx.strokeStyle = '#9a5f44';
          ctx.beginPath(); ctx.arc(0, hy + 6, 2.4, 1.15 * Math.PI, 1.85 * Math.PI); ctx.stroke();
        } else {
          ctx.strokeStyle = '#9a5f44'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(0, hy + 3, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
        }
      }
      ctx.restore();

      if (seated) {
        // pet set down on the floor in front of the seated owner (at their feet)
        if (isDog) drawDog(v, cx + 9, s.y + 13, false);
        else drawCarrier(cx, s.y + 2, v.carrier, mirror);
      } else {
        // cat carrier held in front of the body
        if (!isDog) drawCarrier(cx, baseY - 14, v.carrier, mirror);
        // dog drawn after the body when it should appear in front (walking up, back to us)
        if (isDog && !front) drawDog(v, cx - 16 * mirror, s.y + 4, mirror > 0);
      }

      // anger steam puffs
      if (angry) {
        ctx.fillStyle = 'rgba(230,80,60,0.85)';
        for (var k = 0; k < 2; k++) {
          var px = cx + (k ? 11 : -11), py = baseY - 58 + Math.sin(animT * 8 + k) * 2;
          ctx.beginPath(); ctx.arc(px, py, 2.6, 0, Math.PI * 2); ctx.fill();
        }
      }

      // patience progress bar above the head (while waiting in line or aside)
      if (waiting) {
        var bw = 24, bx = cx - bw / 2, by = baseY - 64;
        ctx.fillStyle = 'rgba(15,20,30,0.65)';
        roundRect(ctx, bx - 1.5, by - 1.5, bw + 3, 7, 3); ctx.fill();
        var col = p > 0.6 ? '#4cc46a' : p > 0.33 ? '#e8c34a' : '#e0563f';
        ctx.fillStyle = col;
        roundRect(ctx, bx, by, Math.max(0, bw * p), 4, 2); ctx.fill();
      }

      // processing bar — fills 0 → 1 while the vet is serving this client
      if ((v.procT || 0) > 0 && v.phase === 'queuing') {
        var prog = Math.min(1, v.procT / procTime());
        var pw = 24, px = cx - pw / 2, py = baseY - 74;
        ctx.fillStyle = 'rgba(15,20,30,0.65)';
        roundRect(ctx, px - 1.5, py - 1.5, pw + 3, 7, 3); ctx.fill();
        ctx.fillStyle = v.processing ? '#36b3f5' : '#6f7d8a'; // dim/grey if paused (vet away)
        roundRect(ctx, px, py, Math.max(0, pw * prog), 4, 2); ctx.fill();
      }

      // restroom-need: a draining orange "hold it" bar above the head (the 🚻
      // status bubble below shows what it's for)
      if (v.phase === 'toRestroom' && v.relief != null) {
        var rw = 24, rx = cx - rw / 2, ry = baseY - 64, r = Math.max(0, v.relief / 40);
        ctx.fillStyle = 'rgba(15,20,30,0.65)';
        roundRect(ctx, rx - 1.5, ry - 1.5, rw + 3, 7, 3); ctx.fill();
        ctx.fillStyle = r > 0.5 ? '#52b0e8' : r > 0.25 ? '#e8a13a' : '#e0563f';
        roundRect(ctx, rx, ry, Math.max(0, rw * r), 4, 2); ctx.fill();
      }

      // exam bars: while being examined a blue bar fills 0→1; while waiting to be
      // seen a separate "patience" bar drains green→red.
      if (v.phase === 'inExam' && v.examRoom) {
        var ew2 = 26, ex = cx - ew2 / 2, ey = baseY - 66;
        ctx.fillStyle = 'rgba(15,20,30,0.65)';
        roundRect(ctx, ex - 1.5, ey - 1.5, ew2 + 3, 7, 3); ctx.fill();
        if (v.processing) {
          var eprog = Math.min(1, (v.examRoom.examT || 0) / (3 * procTime()));
          ctx.fillStyle = '#36b3f5';
          roundRect(ctx, ex, ey, Math.max(0, ew2 * eprog), 4, 2); ctx.fill();
        } else {
          var ep = Math.max(0, (v.examWait || 0) / baseWait());
          ctx.fillStyle = ep > 0.6 ? '#4cc46a' : ep > 0.33 ? '#e8c34a' : '#e0563f';
          roundRect(ctx, ex, ey, Math.max(0, ew2 * ep), 4, 2); ctx.fill();
        }
      }
      if (v.phase === 'inXray' && v.xrayRoom) {
        var xw2 = 26, xx = cx - xw2 / 2, xy = baseY - 66;
        ctx.fillStyle = 'rgba(15,20,30,0.65)';
        roundRect(ctx, xx - 1.5, xy - 1.5, xw2 + 3, 7, 3); ctx.fill();
        if (v.processing) {
          var xprog = Math.min(1, (v.xrayRoom.xrayT || 0) / (6 * procTime()));
          ctx.fillStyle = '#36b3f5';
          roundRect(ctx, xx, xy, Math.max(0, xw2 * xprog), 4, 2); ctx.fill();
        } else {
          var xp = Math.max(0, (v.xrayWait || 0) / baseWait());
          ctx.fillStyle = xp > 0.6 ? '#4cc46a' : xp > 0.33 ? '#e8c34a' : '#e0563f';
          roundRect(ctx, xx, xy, Math.max(0, xw2 * xp), 4, 2); ctx.fill();
        }
      }
      if (v.phase === 'inPharm' && v.pharmacy) {
        var pw3 = 26, pxx = cx - pw3 / 2, pyy = baseY - 66, pst = v.pharmacy.stations[v.pharmIdx];
        ctx.fillStyle = 'rgba(15,20,30,0.65)';
        roundRect(ctx, pxx - 1.5, pyy - 1.5, pw3 + 3, 7, 3); ctx.fill();
        if (v.processing) {
          var pprog = Math.min(1, (pst.procT || 0) / procTime());
          ctx.fillStyle = '#36b3f5'; roundRect(ctx, pxx, pyy, Math.max(0, pw3 * pprog), 4, 2); ctx.fill();
        } else {
          var pp = Math.max(0, (v.pharmWait || 0) / baseWait());
          ctx.fillStyle = pp > 0.6 ? '#4cc46a' : pp > 0.33 ? '#e8c34a' : '#e0563f';
          roundRect(ctx, pxx, pyy, Math.max(0, pw3 * pp), 4, 2); ctx.fill();
        }
      }

      // status bubble: the service this visitor still needs, or 🙂/😠 on the way out
      var emo = visitorEmoji(v);
      if (emo) {
        var by3 = baseY - 90;
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.94)';
        ctx.beginPath(); ctx.arc(cx, by3, 11, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(cx - 4, by3 + 8); ctx.lineTo(cx + 4, by3 + 8); ctx.lineTo(cx, by3 + 13); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(15,20,30,0.22)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(cx, by3, 11, 0, Math.PI * 2); ctx.stroke();
        ctx.font = '15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(emo, cx, by3 + 1);
        ctx.restore();
      }
    }

    // Side-profile dog on a leash. (cx,cy) is the dog's centre on the ground.
    function drawDog(v, cx, cy, faceRight) {
      var sz = DOG_SIZE[v.pet] || 1, col = DOG_COLOR[v.pet] || '#9c6b43';
      var f = faceRight ? 1 : -1;
      // shadow
      ctx.fillStyle = 'rgba(20,40,30,0.22)';
      ctx.beginPath(); ctx.ellipse(cx, cy, 11 * sz, 4 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // legs
      ctx.fillStyle = shade(col, 0.85);
      ctx.fillRect(cx - 7 * sz, cy - 7 * sz, 2.4 * sz, 7 * sz);
      ctx.fillRect(cx + 4 * sz, cy - 7 * sz, 2.4 * sz, 7 * sz);
      // body
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(cx, cy - 8 * sz, 9 * sz, 5.5 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // tail
      ctx.strokeStyle = col; ctx.lineWidth = 2.4 * sz; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - 8 * sz * f, cy - 9 * sz); ctx.lineTo(cx - 12 * sz * f, cy - 13 * sz); ctx.stroke();
      ctx.lineCap = 'butt';
      // head
      var hx = cx + 8 * sz * f, hy = cy - 11 * sz;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(hx, hy, 4.6 * sz, 4.2 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // ear
      ctx.fillStyle = shade(col, 0.82);
      ctx.beginPath();
      ctx.moveTo(hx - 2 * sz * f, hy - 3 * sz); ctx.lineTo(hx - 4 * sz * f, hy - 7 * sz);
      ctx.lineTo(hx + 0.5 * sz * f, hy - 4 * sz); ctx.closePath(); ctx.fill();
      // snout
      ctx.fillStyle = shade(col, 1.08);
      ctx.beginPath(); ctx.ellipse(hx + 4 * sz * f, hy + 1.5 * sz, 2.6 * sz, 2 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // nose + eye
      ctx.fillStyle = '#23201c';
      ctx.beginPath(); ctx.arc(hx + 6 * sz * f, hy + 1 * sz, 1 * sz, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hx + 1.5 * sz * f, hy - 0.5 * sz, 0.9 * sz, 0, Math.PI * 2); ctx.fill();
      // red collar
      ctx.strokeStyle = '#d23b3b'; ctx.lineWidth = 1.6 * sz;
      ctx.beginPath(); ctx.arc(hx - 3 * sz * f, hy + 2 * sz, 2.4 * sz, -0.4, 1.4); ctx.stroke();
      // leash up to the owner's hand
      ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(hx - 3 * sz * f, hy + 1 * sz);
      ctx.lineTo(cx + (faceRight ? 12 : -12), cy - 28); ctx.stroke();
    }

    // Pet carrier (for cats): a coloured box with a grille door and a top handle.
    function drawCarrier(cx, cy, color, mirror) {
      var w = 19, h = 14, x = cx - w / 2, y = cy;
      // handle
      ctx.strokeStyle = shade(color, 0.7); ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(cx, y - 1, 6, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
      // body
      var g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, shade(color, 1.12)); g.addColorStop(1, color);
      ctx.fillStyle = g;
      roundRect(ctx, x, y, w, h, 4); ctx.fill();
      // grille door (lighter inset + dark bars)
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      roundRect(ctx, x + w * 0.46, y + 2.5, w * 0.46, h - 5, 2.5); ctx.fill();
      ctx.strokeStyle = 'rgba(40,50,60,0.65)'; ctx.lineWidth = 1;
      for (var i = 1; i <= 3; i++) {
        var gx = x + w * 0.46 + (w * 0.46) * (i / 4);
        ctx.beginPath(); ctx.moveTo(gx, y + 3); ctx.lineTo(gx, y + h - 2.5); ctx.stroke();
      }
      // little cat eyes peeking through
      ctx.fillStyle = '#2b2b33';
      ctx.beginPath();
      ctx.arc(x + w * 0.16, y + h * 0.5, 1.2, 0, Math.PI * 2);
      ctx.arc(x + w * 0.30, y + h * 0.5, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Lighten (>1) / darken (<1) a #rrggbb colour.
    // ---- Furniture rendering ---------------------------------------------
    // A solid isometric box over the grid rect [gx0..gx1] x [gy0..gy1], height h.
    function isoBox(c, gx0, gy0, gx1, gy1, h, topCol, leftCol, rightCol) {
      var T = iso(gx0, gy0), R = iso(gx1, gy0), F = iso(gx1, gy1), L = iso(gx0, gy1);
      function up(p) { return { x: p.x, y: p.y - h }; }
      var Tu = up(T), Ru = up(R), Fu = up(F), Lu = up(L);
      c.fillStyle = rightCol;          // right face (gx1 edge)
      c.beginPath(); c.moveTo(Ru.x, Ru.y); c.lineTo(Fu.x, Fu.y); c.lineTo(F.x, F.y); c.lineTo(R.x, R.y); c.closePath(); c.fill();
      c.fillStyle = leftCol;           // left face (gy1 edge)
      c.beginPath(); c.moveTo(Lu.x, Lu.y); c.lineTo(Fu.x, Fu.y); c.lineTo(F.x, F.y); c.lineTo(L.x, L.y); c.closePath(); c.fill();
      c.fillStyle = topCol;            // top face
      c.beginPath(); c.moveTo(Tu.x, Tu.y); c.lineTo(Ru.x, Ru.y); c.lineTo(Fu.x, Fu.y); c.lineTo(Lu.x, Lu.y); c.closePath(); c.fill();
    }

    function furnShadow(c, gx0, gy0, gx1, gy1) {
      var cx = (iso(gx0, gy0).x + iso(gx1, gy1).x) / 2;
      var cy = (iso(gx0, gy0).y + iso(gx1, gy1).y) / 2;
      c.fillStyle = 'rgba(20,40,30,0.18)';
      c.beginPath(); c.ellipse(cx, cy + 6, (gx1 - gx0 + 1) * 16, (gy1 - gy0 + 1) * 9, 0, 0, Math.PI * 2); c.fill();
    }

    // Single waiting-room chair on tile (gx,gy); backrest sits on the back side
    // (opposite the rotation's "front"), so the seat faces outward.
    function drawChair(c, gx, gy, rot) {
      rot = rot || 0;
      furnShadow(c, gx - 0.3, gy - 0.3, gx + 0.3, gy + 0.3);
      isoBox(c, gx - 0.34, gy - 0.34, gx + 0.34, gy + 0.34, 13, '#5bb3d6', '#3f93b8', '#357fa0'); // seat
      var bx0 = gx - 0.34, by0 = gy - 0.34, bx1 = gx + 0.34, by1 = gy + 0.34;
      if (rot === 0) by1 = gy - 0.16;       // back at -gy
      else if (rot === 2) by0 = gy + 0.16;  // back at +gy
      else if (rot === 1) bx1 = gx - 0.16;  // back at -gx
      else bx0 = gx + 0.16;                 // back at +gx
      isoBox(c, bx0, by0, bx1, by1, 30, '#69bdde', '#3f93b8', '#357fa0'); // backrest
    }

    // A 2x1 wooden bench: a long seat (2 tiles) with a backrest along the back
    // and a divider so it reads as two seats. Footprint follows the rotation.
    function drawBench(c, gx, gy, rot) {
      rot = rot || 0;
      var ew = (rot & 1) ? 1 : 2, eh = (rot & 1) ? 2 : 1;
      var x0 = gx - 0.42, y0 = gy - 0.42, x1 = gx + (ew - 1) + 0.42, y1 = gy + (eh - 1) + 0.42;
      furnShadow(c, x0, y0, x1, y1);
      isoBox(c, x0, y0, x1, y1, 13, '#cda06a', '#a87d4e', '#946c41');   // seat slab
      // backrest: a thin tall slab along the back (opposite the FRONT side)
      var bx0 = x0, by0 = y0, bx1 = x1, by1 = y1;
      if (rot === 0) by1 = y0 + 0.18;        // back at -gy
      else if (rot === 2) by0 = y1 - 0.18;   // back at +gy
      else if (rot === 1) bx1 = x0 + 0.18;   // back at -gx
      else bx0 = x1 - 0.18;                  // back at +gx
      isoBox(c, bx0, by0, bx1, by1, 30, '#d8b07e', '#a87d4e', '#946c41');
      // divider groove between the two seats (down the centre of the seat top)
      var m0 = iso((rot & 1) ? x0 : gx + 0.5, (rot & 1) ? gy + 0.5 : y0);
      var m1 = iso((rot & 1) ? x1 : gx + 0.5, (rot & 1) ? gy + 0.5 : y1);
      c.strokeStyle = 'rgba(90,62,34,0.5)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(m0.x, m0.y - 13); c.lineTo(m1.x, m1.y - 13); c.stroke();
    }

    // Reception desk: a 2x1 counter (white top, teal front) with a computer.
    function drawDesk(c, gx, gy, rot) {
      rot = rot || 0;
      var H = 26, ew = (rot & 1) ? 1 : 2, eh = (rot & 1) ? 2 : 1;
      var x0 = gx - 0.5, y0 = gy - 0.5, x1 = gx + ew - 0.5, y1 = gy + eh - 0.5;
      furnShadow(c, x0, y0, x1, y1);
      isoBox(c, x0, y0, x1, y1, H, '#f4f7f9', '#2f9e90', '#268a7e');
      // counter-top lip along the two front edges of the top face
      var L = iso(x0, y1), F = iso(x1, y1), R = iso(x1, y0);
      c.strokeStyle = '#dfe8ee'; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(L.x, L.y - H); c.lineTo(F.x, F.y - H); c.lineTo(R.x, R.y - H);
      c.stroke();
      // one computer per station tile (one per queue line), nudged to the back
      var f = FRONT[rot];
      var tiles = (rot & 1) ? [[gx, gy], [gx, gy + 1]] : [[gx, gy], [gx + 1, gy]];
      tiles.forEach(function (t) { drawComputer(c, t[0] - f.x * 0.1, t[1] - f.y * 0.1, H, rot); });
    }

    // A monitor + keyboard on the desk. The screen faces the staff (-front) side
    // and the keyboard sits on that side too, so by default (rot 0) we see the
    // BACK of the screen; rotating the desk turns it around to reveal the screen.
    function drawComputer(c, gx, gy, deskH, rot) {
      rot = rot || 0;
      var f = FRONT[rot];
      var showScreen = (f.x + f.y) < 0;       // staff side faces the camera → screen visible
      var m = iso(gx, gy), topY = m.y - deskH;
      var kb = iso(gx - f.x * 0.32, gy - f.y * 0.32), kbY = kb.y - deskH; // keyboard on the staff side

      function keyboard() {
        c.fillStyle = '#cdd6dd';
        c.beginPath();
        c.moveTo(kb.x - 8, kbY + 2); c.lineTo(kb.x + 4, kbY + 6);
        c.lineTo(kb.x + 11, kbY + 2); c.lineTo(kb.x - 1, kbY - 2); c.closePath(); c.fill();
        c.strokeStyle = 'rgba(90,100,110,0.45)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(kb.x - 3, kbY + 1.5); c.lineTo(kb.x + 7, kbY + 2); c.stroke();
      }

      if (!showScreen) keyboard();            // staff far → keyboard behind the monitor
      c.fillStyle = '#3a444e'; c.fillRect(m.x - 1, topY - 6, 3, 7);                  // stand
      c.fillStyle = '#2a323b'; roundRect(c, m.x - 11, topY - 21, 22, 16, 2.5); c.fill(); // body
      if (showScreen) {                       // glowing screen face (the front)
        c.fillStyle = gradL(c, 0, topY - 20, 0, topY - 6, [[0, '#6fd4e6'], [1, '#3b9fd0']]); roundRect(c, m.x - 9, topY - 19, 18, 12, 1.5); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.7)';
        c.fillRect(m.x - 6, topY - 16, 9, 1.6); c.fillRect(m.x - 6, topY - 13, 12, 1.6);
      } else {                                // plain back panel (the back of the screen)
        c.fillStyle = '#39434d'; roundRect(c, m.x - 9, topY - 19, 18, 12, 1.5); c.fill();
        c.strokeStyle = 'rgba(255,255,255,0.09)'; c.lineWidth = 1;
        for (var i = 0; i < 3; i++) { var yy = topY - 17 + i * 3.5; c.beginPath(); c.moveTo(m.x - 6, yy); c.lineTo(m.x + 6, yy); c.stroke(); }
        c.fillStyle = 'rgba(255,255,255,0.16)'; c.beginPath(); c.arc(m.x, topY - 12, 1.6, 0, Math.PI * 2); c.fill();
      }
      if (showScreen) keyboard();             // staff camera-side → keyboard in front of the monitor
    }

    // A flat-panel TV on a low media console. Decorative, but a room with one
    // keeps clients entertained (doubles their wait). The screen faces the camera.
    function drawTV(c, gx, gy, rot) {
      furnShadow(c, gx - 0.34, gy - 0.34, gx + 0.34, gy + 0.34);
      var H = 14;
      isoBox(c, gx - 0.42, gy - 0.32, gx + 0.42, gy + 0.32, H, '#46505b', '#2b333c', '#232a31'); // media console
      var m = iso(gx, gy), topY = m.y - H;
      // stand neck + foot, then the bezel
      c.fillStyle = '#1b2127'; c.fillRect(m.x - 2, topY - 7, 4, 8);
      c.fillStyle = '#11161b'; c.fillRect(m.x - 8, topY - 1, 16, 2.5);
      c.fillStyle = '#14181d'; roundRect(c, m.x - 19, topY - 35, 38, 29, 3); c.fill();
      // screen
      var sx = m.x - 16, sy = topY - 32, sw = 32, sh = 23;
      c.fillStyle = gradL(c, 0, sy, 0, sy + sh, [[0, '#86d8ea'], [1, '#54a7d8']]); roundRect(c, sx, sy, sw, sh, 2); c.fill();
      // a cheery broadcast: sun, green ground, a red vet cross, plus a glass sheen
      c.save();
      roundRect(c, sx, sy, sw, sh, 2); c.clip();
      c.fillStyle = '#ffe07a'; c.beginPath(); c.arc(sx + 7, sy + 6, 3.2, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#74ba56'; c.fillRect(sx, sy + sh - 8, sw, 8);
      c.fillStyle = '#e0563f';
      c.fillRect(m.x - 1.6, sy + 7, 3.2, 11);
      c.fillRect(m.x - 5, sy + 10.4, 12, 3.2);
      c.fillStyle = 'rgba(255,255,255,0.14)';
      c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + 11, sy); c.lineTo(sx, sy + 11); c.closePath(); c.fill();
      c.restore();
      // power LED
      c.fillStyle = '#5fe08a'; c.beginPath(); c.arc(m.x + 16, topY - 9, 1, 0, Math.PI * 2); c.fill();
    }

    // A 2×3 restroom building with a flat roof, a door and a WC sign.
    function drawRestroom(c, gx, gy, rot) {
      rot = rot || 0;
      var ew = (rot & 1) ? 3 : 2, eh = (rot & 1) ? 2 : 3, H = 50;
      var x0 = gx - 0.5, y0 = gy - 0.5, x1 = gx + ew - 0.5, y1 = gy + eh - 0.5;
      furnShadow(c, x0, y0, x1, y1);
      isoBox(c, x0, y0, x1, y1, H, '#dbe5ee', '#9fb4c4', '#88a0b2');     // walls
      var T = iso(x0, y0), R = iso(x1, y0), F = iso(x1, y1), L = iso(x0, y1);
      c.beginPath();                                                     // flat roof slab
      c.moveTo(T.x, T.y - H); c.lineTo(R.x, R.y - H); c.lineTo(F.x, F.y - H); c.lineTo(L.x, L.y - H); c.closePath();
      c.fillStyle = '#74899b'; c.fill(); c.strokeStyle = '#5d7184'; c.lineWidth = 2; c.stroke();
      var fc = iso((x0 + x1) / 2, y1);                                   // door + WC sign on the camera-side wall
      c.fillStyle = '#48535f'; c.fillRect(fc.x - 7, fc.y - 31, 14, 29);
      c.fillStyle = '#6f7c88'; c.fillRect(fc.x - 7, fc.y - 31, 14, 2);
      c.fillStyle = '#2f6fd0'; c.fillRect(fc.x - 8, fc.y - 43, 16, 9);
      c.fillStyle = '#fff'; c.font = '800 8px Nunito, sans-serif'; c.textAlign = 'center';
      c.fillText('WC', fc.x, fc.y - 36);
      c.fillStyle = '#cdd6dd'; c.beginPath(); c.arc(fc.x + 4, fc.y - 16, 1.4, 0, Math.PI * 2); c.fill();
    }

    // A toilet fixture standing inside a restroom room: a white cistern at the
    // back with the bowl toward `face` (the direction the user stands / faces).
    function drawToilet(c, gx, gy, face) {
      face = face || { x: 0, y: 1 };
      furnShadow(c, gx - 0.34, gy - 0.34, gx + 0.34, gy + 0.34);
      var tx = gx - face.x * 0.3, ty = gy - face.y * 0.3;               // cistern, against the back wall
      isoBox(c, tx - 0.26, ty - 0.26, tx + 0.26, ty + 0.26, 26, '#eef4f8', '#b9c8d3', '#a6b8c5');
      var s = iso(gx + face.x * 0.12, gy + face.y * 0.12);              // bowl, toward the open side
      c.strokeStyle = '#7d93a3'; c.lineWidth = 1.5;
      c.fillStyle = '#b3c2cd'; c.beginPath(); c.ellipse(s.x, s.y - 4, 9.5, 6.2, 0, 0, Math.PI * 2); c.fill();           // pedestal base
      c.fillStyle = '#f5f9fb'; c.beginPath(); c.ellipse(s.x, s.y - 9, 8.6, 5.4, 0, 0, Math.PI * 2); c.fill(); c.stroke(); // seat rim
      c.fillStyle = '#9fb1bf'; c.beginPath(); c.ellipse(s.x, s.y - 9.5, 5.2, 3.1, 0, 0, Math.PI * 2); c.fill();          // bowl opening
    }

    // Exam table — a teal-topped table on white legs; shows the pet on top in use.
    function drawExamTable(c, gx, gy, occ) {
      var H = 17;
      furnShadow(c, gx - 0.42, gy - 0.42, gx + 0.42, gy + 0.42);
      c.fillStyle = '#cdd6dd';                 // legs
      [[-0.32, -0.32], [0.32, -0.32], [0.32, 0.32], [-0.32, 0.32]].forEach(function (o) {
        var p = iso(gx + o[0], gy + o[1]); c.fillRect(p.x - 1.5, p.y - H, 3, H);
      });
      var T = iso(gx - 0.42, gy - 0.42), R = iso(gx + 0.42, gy - 0.42), F = iso(gx + 0.42, gy + 0.42), L = iso(gx - 0.42, gy + 0.42);
      c.fillStyle = '#2f9e90';                 // top thickness (front faces)
      c.beginPath(); c.moveTo(L.x, L.y - H); c.lineTo(F.x, F.y - H); c.lineTo(F.x, F.y - H + 5); c.lineTo(L.x, L.y - H + 5); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(F.x, F.y - H); c.lineTo(R.x, R.y - H); c.lineTo(R.x, R.y - H + 5); c.lineTo(F.x, F.y - H + 5); c.closePath(); c.fill();
      c.fillStyle = '#a6e3d7';                 // top
      c.beginPath(); c.moveTo(T.x, T.y - H); c.lineTo(R.x, R.y - H); c.lineTo(F.x, F.y - H); c.lineTo(L.x, L.y - H); c.closePath(); c.fill();
      if (occ) drawDog(occ, iso(gx, gy).x, iso(gx, gy).y - H, true);   // the pet being examined
    }

    // A compact exam desk (white) with the computer on top.
    function drawExamDesk(c, gx, gy, rot) {
      var H = 24;
      furnShadow(c, gx - 0.42, gy - 0.42, gx + 0.42, gy + 0.42);
      isoBox(c, gx - 0.42, gy - 0.42, gx + 0.42, gy + 0.42, H, '#f4f7f9', '#c4d2da', '#b0c0c9');
      drawComputer(c, gx, gy - 0.05, H, rot);
    }

    // The ring the vet stands in to examine (brighter when the vet is on it).
    function drawExamCircle(c, gx, gy, on) {
      var s = iso(gx, gy);
      c.save();
      c.beginPath(); c.ellipse(s.x, s.y, TILE_HW * 0.6, TILE_HH * 0.6, 0, 0, Math.PI * 2);
      c.fillStyle = on ? 'rgba(80,210,130,0.32)' : 'rgba(60,190,165,0.20)'; c.fill();
      c.lineWidth = on ? 4 : 3; c.strokeStyle = on ? 'rgba(70,205,120,1)' : 'rgba(55,179,163,0.95)'; c.stroke();
      c.restore();
    }

    // ---- Placement -------------------------------------------------------
    // Footprint tiles for an item at (gx,gy) with rotation rot (0..3). A 90°/270°
    // turn swaps width and height; the anchor stays the min (top-left) corner.
    function footprintTiles(item, gx, gy, rot) {
      var ew = (rot & 1) ? item.h : item.w, eh = (rot & 1) ? item.w : item.h, t = [];
      for (var dy = 0; dy < eh; dy++)
        for (var dx = 0; dx < ew; dx++) t.push({ x: gx + dx, y: gy + dy });
      return t;
    }
    // Interaction tiles: floor squares a person must be able to stand on to use
    // the item. Each is tagged with a `kind`: 'customer' (visitors' side, where
    // the queue forms) or 'staff' (the vet/user's side, behind the counter).
    // They are validated at placement — every one must be in-bounds and clear —
    // so the item can't be shoved against a wall or other furniture that would
    // block either side. Unlike footprint tiles they are NOT marked occupied;
    // people still walk and stand on them. Items without interactions return [].
    function deskInteractTiles(gx, gy, rot) {
      var f = FRONT[rot || 0], tiles = [];
      deskLineTiles({ gx: gx, gy: gy, rot: rot || 0 }).forEach(function (t) {
        tiles.push({ x: t.x + f.x, y: t.y + f.y, kind: 'customer' }); // visitor side
        tiles.push({ x: t.x - f.x, y: t.y - f.y, kind: 'staff' });    // vet/user side
      });
      return tiles;
    }
    // A chair seats one visitor: the tile in front of the seat (FRONT side) must
    // stay clear so they can reach and sit on it.
    function chairInteractTiles(gx, gy, rot) {
      var f = FRONT[rot || 0];
      return [{ x: gx + f.x, y: gy + f.y, kind: 'customer' }];
    }
    // The two seat tiles of a 2x1 bench, accounting for rotation.
    function benchSeatTiles(b) {
      var rot = b.rot || 0;
      return (rot & 1)
        ? [{ x: b.gx, y: b.gy }, { x: b.gx, y: b.gy + 1 }]
        : [{ x: b.gx, y: b.gy }, { x: b.gx + 1, y: b.gy }];
    }
    // A bench seats two: the tile in front of each seat must stay clear.
    function benchInteractTiles(gx, gy, rot) {
      var f = FRONT[rot || 0];
      return benchSeatTiles({ gx: gx, gy: gy, rot: rot || 0 }).map(function (t) {
        return { x: t.x + f.x, y: t.y + f.y, kind: 'customer' };
      });
    }
    function interactTiles(item, gx, gy, rot) {
      return item.interact ? item.interact(gx, gy, rot) : [];
    }
    function canPlace(item, gx, gy, rot) {
      var vtx = Math.round(vet.x), vty = Math.round(vet.y);   // tile the player stands on
      var tiles = footprintTiles(item, gx, gy, rot);
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        // any furniture may sit on any room floor (clinic, corridors, blank rooms)
        if (!isRoomFloor(t.x, t.y)) return false;
        if (occupied[t.x + ',' + t.y]) return false;
        if (t.x === vtx && t.y === vty) return false;          // can't drop on the player
      }
      // every interaction square must be clear room floor, too
      var it = interactTiles(item, gx, gy, rot);
      for (var j = 0; j < it.length; j++) {
        var u = it[j];
        if (!isRoomFloor(u.x, u.y)) return false;
        if (occupied[u.x + ',' + u.y]) return false;
      }
      // In a corridor, keep one lane open: nothing directly across, and a bench
      // may not span both lanes. (Only applies to footprint tiles in a corridor.)
      for (var k = 0; k < tiles.length; k++) {
        var c = tiles[k];
        if (!isCorridor(c.x, c.y) || openRoom[c.x + ',' + c.y]) continue;  // open rooms have no lane rule
        var across = corridorAcross(c.x, c.y);
        if (!across) continue;
        var spans = tiles.some(function (q) { return q.x === across.x && q.y === across.y; });
        if (spans || occupied[across.x + ',' + across.y]) return false;
      }
      return true;
    }

    // Ghost for hiring staff: highlight the targeted desk circle + a preview figure.
    function drawStaffGhost() {
      var st = nearestStation();
      if (!st) return;                       // no desk → nowhere to stand
      var s = iso(st.x, st.y);
      ctx.save();
      ctx.beginPath(); ctx.ellipse(s.x, s.y, TILE_HW * 0.62, TILE_HH * 0.62, 0, 0, Math.PI * 2);
      ctx.fillStyle = st.ok ? 'rgba(76,196,106,0.32)' : 'rgba(224,86,63,0.40)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = st.ok ? 'rgba(70,205,120,1)' : 'rgba(224,86,63,0.95)'; ctx.stroke();
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawReceptionist(ghostCtx, st.x, st.y);
      if (!st.ok) {
        ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop';
        ghostCtx.fillStyle = 'rgba(222,58,44,0.62)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // Preview for the corridor brush: the validated line of squares (green) with
    // a running cost, or a single red square if the start tile isn't valid.
    function drawCorridorGhost() {
      var s = corridorDrag || { sx: pointer.gx, sy: pointer.gy };
      var res = corridorLineTiles(s.sx, s.sy, pointer.gx, pointer.gy);
      ctx.save();
      if (res.tiles.length) {
        res.tiles.forEach(function (t) {
          var p = iso(t.x, t.y); diamondPath(ctx, p.x, p.y);
          ctx.fillStyle = 'rgba(76,196,106,0.42)'; ctx.fill();
          ctx.strokeStyle = 'rgba(76,196,106,0.95)'; ctx.lineWidth = 2; ctx.stroke();
        });
        var lp = iso(pointer.gx, pointer.gy);
        ctx.font = '800 15px Nunito, sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(20,30,20,0.55)';
        ctx.strokeText('$' + res.cost, lp.x, lp.y - 18);
        ctx.fillStyle = '#ffd24a'; ctx.fillText('$' + res.cost, lp.x, lp.y - 18);
      } else {
        var p2 = iso(pointer.gx, pointer.gy); diamondPath(ctx, p2.x, p2.y);
        ctx.fillStyle = 'rgba(224,86,63,0.40)'; ctx.fill();
        ctx.strokeStyle = 'rgba(224,86,63,0.9)'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.restore();
    }

    // Ghost for the Blank-room brush: a filled rectangle, green if buildable+affordable.
    function drawBlankGhost() {
      var st = corridorDrag || { sx: pointer.gx, sy: pointer.gy };
      var res = blankRectTiles(st.sx, st.sy, pointer.gx, pointer.gy);
      ctx.save();
      if (res.tiles.length && res.ok) {
        res.tiles.forEach(function (t) {
          var p = iso(t.x, t.y); diamondPath(ctx, p.x, p.y);
          ctx.fillStyle = 'rgba(76,196,106,0.40)'; ctx.fill();
          ctx.strokeStyle = 'rgba(76,196,106,0.9)'; ctx.lineWidth = 2; ctx.stroke();
        });
        var lp = iso(pointer.gx, pointer.gy);
        ctx.font = '800 15px Nunito, sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(20,30,20,0.55)';
        ctx.strokeText('$' + res.cost, lp.x, lp.y - 18);
        ctx.fillStyle = '#ffd24a'; ctx.fillText('$' + res.cost, lp.x, lp.y - 18);
      } else {
        var tiles = res.tiles.length ? res.tiles : [{ x: pointer.gx, y: pointer.gy }];
        tiles.forEach(function (t) { var p = iso(t.x, t.y); diamondPath(ctx, p.x, p.y); ctx.fillStyle = 'rgba(224,86,63,0.38)'; ctx.fill(); ctx.strokeStyle = 'rgba(224,86,63,0.9)'; ctx.lineWidth = 2; ctx.stroke(); });
      }
      ctx.restore();
    }

    // Ghost for the 2×3 restroom: footprint tinted green only on buildable grass
    // that touches a corridor, plus a translucent toilet preview inside.
    function drawRestroomGhost(rot) {
      var item = FURN_BY_ID.restroom, ok = canPlaceRestroom(pointer.gx, pointer.gy, rot);
      var L = restroomLayout(pointer.gx, pointer.gy, rot);
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.38)' : 'rgba(224,86,63,0.42)';
      footprintTiles(item, pointer.gx, pointer.gy, rot).forEach(function (t) {
        var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill();
      });
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawToilet(ghostCtx, L.toilet.x, L.toilet.y, L.face);
      if (!ok) {
        ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop';
        ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // Ghost for the 3×3 exam room: footprint tint + a preview of desk/table/circle.
    function drawExamGhost(rot) {
      var ok = canPlaceExam(pointer.gx, pointer.gy);
      var k = examKeyTiles(pointer.gx, pointer.gy, rot);
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.34)' : 'rgba(224,86,63,0.42)';
      examTiles(pointer.gx, pointer.gy).forEach(function (t) { var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill(); });
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawExamCircle(ghostCtx, k.circle.x, k.circle.y, false);
      drawExamTable(ghostCtx, k.table.x, k.table.y, null);
      if (!ok) {
        ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop';
        ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // X-ray machine — a grey scanner bed with an overhead C-arm + emitter head.
    function drawXrayMachine(c, gx, gy, occ) {
      var H = 16;
      furnShadow(c, gx - 0.42, gy - 0.42, gx + 0.42, gy + 0.42);
      c.fillStyle = '#b8c2cc';                 // legs
      [[-0.32, -0.32], [0.32, -0.32], [0.32, 0.32], [-0.32, 0.32]].forEach(function (o) {
        var p = iso(gx + o[0], gy + o[1]); c.fillRect(p.x - 1.5, p.y - H, 3, H);
      });
      var T = iso(gx - 0.42, gy - 0.42), R = iso(gx + 0.42, gy - 0.42), F = iso(gx + 0.42, gy + 0.42), L = iso(gx - 0.42, gy + 0.42);
      c.fillStyle = '#5a6b78';                 // bed thickness (front faces)
      c.beginPath(); c.moveTo(L.x, L.y - H); c.lineTo(F.x, F.y - H); c.lineTo(F.x, F.y - H + 5); c.lineTo(L.x, L.y - H + 5); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(F.x, F.y - H); c.lineTo(R.x, R.y - H); c.lineTo(R.x, R.y - H + 5); c.lineTo(F.x, F.y - H + 5); c.closePath(); c.fill();
      c.fillStyle = '#d7dee4';                 // bed surface
      c.beginPath(); c.moveTo(T.x, T.y - H); c.lineTo(R.x, R.y - H); c.lineTo(F.x, F.y - H); c.lineTo(L.x, L.y - H); c.closePath(); c.fill();
      if (occ) drawDog(occ, iso(gx, gy).x, iso(gx, gy).y - H, true);   // the pet being scanned
      // overhead C-arm: post at the back corner, arm over the bed, emitter above the pet
      var base = iso(gx - 0.5, gy - 0.5), ctr = iso(gx, gy);
      c.strokeStyle = '#8b97a3'; c.lineWidth = 4; c.lineJoin = 'round'; c.lineCap = 'round';
      c.beginPath(); c.moveTo(base.x, base.y - 2); c.lineTo(base.x, base.y - 50); c.lineTo(ctr.x, ctr.y - 50); c.stroke();
      c.lineCap = 'butt';
      c.fillStyle = '#3a444e'; roundRect(c, ctr.x - 6, ctr.y - 50, 12, 9, 2); c.fill();   // emitter head
      c.fillStyle = '#6fd4e6'; c.fillRect(ctr.x - 3, ctr.y - 42, 6, 2);                    // lens
    }

    // Ghost for the 3×4 X-ray room: footprint tint + a preview of bed/desk/circle.
    function drawXrayGhost(rot) {
      var ok = canPlaceXray(pointer.gx, pointer.gy);
      var k = examKeyTiles(pointer.gx, pointer.gy, rot);
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.34)' : 'rgba(224,86,63,0.42)';
      xrayTiles(pointer.gx, pointer.gy).forEach(function (t) { var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill(); });
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawExamCircle(ghostCtx, k.circle.x, k.circle.y, false);
      drawExamDesk(ghostCtx, k.desk.x, k.desk.y, rot);
      drawXrayMachine(ghostCtx, k.table.x, k.table.y, null);
      if (!ok) {
        ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop';
        ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // A pharmacy counter (white) with colourful medicine bottles on top.
    function drawPharmCounter(c, gx, gy) {
      var H = 22;
      furnShadow(c, gx - 0.42, gy - 0.42, gx + 0.42, gy + 0.42);
      isoBox(c, gx - 0.42, gy - 0.42, gx + 0.42, gy + 0.42, H, '#f4f7f9', '#cdd9e0', '#b9c8d0');
      var m = iso(gx, gy), topY = m.y - H, cols = ['#e0683c', '#3d8fd0', '#7d5bbe', '#3bb1a2', '#e0a93c'];
      for (var i = 0; i < 3; i++) {
        c.fillStyle = cols[(Math.round(gx) * 3 + i) % cols.length];
        c.fillRect(m.x - 9 + i * 7, topY - 9, 5, 9);
        c.fillStyle = '#fff'; c.fillRect(m.x - 9 + i * 7, topY - 9, 5, 2.5);
      }
    }

    // Ghost for the 4×3 pharmacy: footprint tint + previews of the 2 counters/circles.
    function drawPharmGhost(rot) {
      var ok = canPlacePharmacy(pointer.gx, pointer.gy), st = pharmStations(pointer.gx, pointer.gy, rot);
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.34)' : 'rgba(224,86,63,0.42)';
      pharmTiles(pointer.gx, pointer.gy).forEach(function (t) { var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill(); });
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      st.forEach(function (s) { drawExamCircle(ghostCtx, s.circle.x, s.circle.y, false); drawPharmCounter(ghostCtx, s.counter.x, s.counter.y); });
      if (!ok) { ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop'; ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // A cleaner: the generic worker figure holding a mop.
    // A janitor: grey-blue coveralls, a red ball cap, and a mop — distinct from
    // the receptionist (purple top + headset). Drawn facing the camera.
    function drawCleaner(c, gx, gy) {
      var s = iso(gx, gy);
      c.fillStyle = 'rgba(20,40,30,0.26)';
      c.beginPath(); c.ellipse(s.x, s.y, 13, 6, 0, 0, Math.PI * 2); c.fill();
      c.save(); c.translate(s.x, s.y);
      // legs (work trousers) + boots
      c.fillStyle = '#3c4654'; c.fillRect(-6, -14, 5, 14); c.fillRect(1, -14, 5, 14);
      c.fillStyle = '#22252b'; c.fillRect(-7, -3, 6, 4); c.fillRect(1, -3, 6, 4);
      // coveralls torso (grey-blue) with zip, collar + chest patch
      var bt = -40;
      c.fillStyle = gradL(c, 0, bt, 0, -12, [[0, '#6c8197'], [1, '#4f6275']]); roundRect(c, -11, bt, 22, 28, 7); c.fill();
      c.fillStyle = '#445667'; roundRect(c, -14, bt + 2, 5, 13, 2.5); c.fill(); roundRect(c, 9, bt + 2, 5, 13, 2.5); c.fill(); // sleeves
      c.strokeStyle = '#36444f'; c.lineWidth = 1.4;                                   // zip
      c.beginPath(); c.moveTo(0, bt + 2); c.lineTo(0, bt + 22); c.stroke();
      c.fillStyle = '#36444f'; c.beginPath(); c.moveTo(-4, bt); c.lineTo(0, bt + 6); c.lineTo(4, bt); c.closePath(); c.fill(); // collar
      c.fillStyle = '#e0a93c'; c.fillRect(3, bt + 7, 6, 4);                            // hi-vis chest patch
      c.fillStyle = '#f0c8a4'; c.fillRect(-14, bt + 14, 5, 4); c.fillRect(9, bt + 14, 5, 4); // hands
      c.fillStyle = '#e7bd98'; c.fillRect(-3, bt - 4, 6, 5);                            // neck
      var hy = bt - 13;
      c.fillStyle = '#f0c8a4'; c.beginPath(); c.arc(0, hy, 8.5, 0, Math.PI * 2); c.fill(); // head
      c.fillStyle = '#7a5a3a'; c.fillRect(-8.5, hy + 1, 17, 4);                         // a bit of hair under the cap
      // red ball cap (crown + brim)
      c.fillStyle = '#c0392b';
      c.beginPath(); c.arc(0, hy - 1, 9, Math.PI, Math.PI * 2, false); c.closePath(); c.fill();
      c.fillRect(-9, hy - 2, 18, 3);
      c.fillStyle = '#9e2f24'; roundRect(c, -8.5, hy - 2.5, 17, 2.6, 1.3); c.fill();    // brim
      // face (eyes + smile) below the brim
      c.fillStyle = '#2b2b33';
      c.beginPath(); c.arc(-3, hy + 1.5, 1.3, 0, Math.PI * 2); c.arc(3, hy + 1.5, 1.3, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#9a5f44'; c.lineWidth = 1.2;
      c.beginPath(); c.arc(0, hy + 4, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
      // mop in hand
      c.strokeStyle = '#9a6a3a'; c.lineWidth = 2.5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(11, -30); c.lineTo(15, -2); c.stroke();
      c.fillStyle = '#cfd6dd'; c.beginPath(); c.ellipse(15, -1, 5, 3, 0, 0, Math.PI * 2); c.fill();
      c.lineCap = 'butt';
      c.restore();
    }
    // Ghost for placing a cleaner: a figure at the cursor, valid on clear room floor.
    function drawCleanerGhost() {
      var ok = canPlaceCleaner(pointer.gx, pointer.gy), s = iso(pointer.gx, pointer.gy);
      ctx.save();
      ctx.beginPath(); ctx.ellipse(s.x, s.y, TILE_HW * 0.55, TILE_HH * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.3)' : 'rgba(224,86,63,0.4)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = ok ? 'rgba(70,205,120,1)' : 'rgba(224,86,63,0.95)'; ctx.stroke();
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawCleaner(ghostCtx, pointer.gx, pointer.gy);
      if (!ok) { ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop'; ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    function drawGhost() {
      if (!placing) return;
      var item = placing.item, rot = placing.rot || 0;
      if (item.kind === 'corridor') { if (pointer.on || corridorDrag) drawCorridorGhost(); return; }
      if (item.kind === 'blank') { if (pointer.on || corridorDrag) drawBlankGhost(); return; }
      if (!pointer.on) return;
      if (item.kind === 'staff') { drawStaffGhost(); return; }
      if (item.kind === 'examstaff') { drawVetStaffGhost(); return; }
      if (item.kind === 'restroom') { drawRestroomGhost(rot); return; }
      if (item.kind === 'exam') { drawExamGhost(rot); return; }
      if (item.kind === 'xray') { drawXrayGhost(rot); return; }
      if (item.kind === 'pharmacy') { drawPharmGhost(rot); return; }
      if (item.kind === 'pharmstaff') { drawPharmStaffGhost(); return; }
      if (item.kind === 'cleaner') { drawCleanerGhost(); return; }
      var ok = canPlace(item, pointer.gx, pointer.gy, rot);
      // footprint tint on the floor (green = ok, red = blocked)
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.40)' : 'rgba(224,86,63,0.42)';
      footprintTiles(item, pointer.gx, pointer.gy, rot).forEach(function (t) {
        var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill();
      });
      // interaction tiles (where people stand to use it) — must stay clear.
      // Shape differentiates the side: blue diamonds = the customer side, green
      // circles = the user/vet's side. Red = blocked / out of bounds.
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      interactTiles(item, pointer.gx, pointer.gy, rot).forEach(function (t) {
        var clear = isRoomFloor(t.x, t.y) && !occupied[t.x + ',' + t.y];
        var staff = t.kind === 'staff';
        var hue = staff ? '76,196,106' : '70,170,235';   // green | blue
        var s = iso(t.x, t.y);
        if (staff) { ctx.beginPath(); ctx.ellipse(s.x, s.y, TILE_HW * 0.58, TILE_HH * 0.58, 0, 0, Math.PI * 2); }
        else diamondPath(ctx, s.x, s.y);
        ctx.fillStyle = clear ? 'rgba(' + hue + ',0.30)' : 'rgba(224,86,63,0.42)';
        ctx.fill();
        ctx.strokeStyle = clear ? 'rgba(' + hue + ',0.95)' : 'rgba(224,86,63,0.95)';
        ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.restore();
      // the item preview itself — rendered to an offscreen buffer so we can wash
      // it red when the spot is invalid (otherwise drawn in normal colours).
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      item.draw(ghostCtx, pointer.gx, pointer.gy, rot);
      if (!ok) {
        ghostCtx.save();
        ghostCtx.globalCompositeOperation = 'source-atop';
        ghostCtx.fillStyle = 'rgba(222,58,44,0.62)';
        ghostCtx.fillRect(0, 0, view.w, view.h);
        ghostCtx.restore();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.72;
      ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1;
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // The placed furniture item whose footprint covers (gx,gy), topmost first.
    function placedAt(gx, gy) {
      for (var i = placed.length - 1; i >= 0; i--) {
        var f = placed[i], def = FURN_BY_ID[f.id];
        var tiles = footprintTiles(def, f.gx, f.gy, f.rot || 0);
        for (var j = 0; j < tiles.length; j++)
          if (tiles[j].x === gx && tiles[j].y === gy) return { idx: i, f: f, def: def };
      }
      return null;
    }
    // Double-click/tap a placed item to pick it back up and reposition it: free its
    // tiles and re-enter placement in "moving" mode (no second charge). Cancelling
    // (Esc / right-click / off-grid) drops it back where it was.
    function pickUpAt(gx, gy) {
      if (placing) return;
      var hit = placedAt(gx, gy);
      if (!hit) { pickUpRoomAt(gx, gy); return; }   // not furniture — maybe a whole room
      var f = hit.f, def = hit.def;
      footprintTiles(def, f.gx, f.gy, f.rot || 0).forEach(function (t) { delete occupied[t.x + ',' + t.y]; });
      placed.splice(hit.idx, 1);
      placing = { item: def, rot: f.rot || 0, moving: true, orig: { gx: f.gx, gy: f.gy, rot: f.rot || 0 } };
      pointer.gx = gx; pointer.gy = gy; pointer.on = true;
      document.body.classList.add('placing');
      renderStatic();                          // picked up to move → hide walls
      renderShop();
    }

    // Which placed ROOM (exam / X-ray / restroom / pharmacy) covers (gx,gy), if any.
    function roomAt(gx, gy) {
      function inTiles(ts) { for (var j = 0; j < ts.length; j++) if (ts[j].x === gx && ts[j].y === gy) return true; return false; }
      var i;
      for (i = examRooms.length - 1; i >= 0; i--) if (inTiles(examTiles(examRooms[i].gx, examRooms[i].gy))) return { kind: 'exam', room: examRooms[i], arr: examRooms, idx: i };
      for (i = xrayRooms.length - 1; i >= 0; i--) if (inTiles(xrayTiles(xrayRooms[i].gx, xrayRooms[i].gy))) return { kind: 'xray', room: xrayRooms[i], arr: xrayRooms, idx: i };
      for (i = pharmacies.length - 1; i >= 0; i--) if (inTiles(pharmTiles(pharmacies[i].gx, pharmacies[i].gy))) return { kind: 'pharmacy', room: pharmacies[i], arr: pharmacies, idx: i };
      for (i = restrooms.length - 1; i >= 0; i--) if (inTiles(footprintTiles(FURN_BY_ID.restroom, restrooms[i].gx, restrooms[i].gy, restrooms[i].rot || 0))) return { kind: 'restroom', room: restrooms[i], arr: restrooms, idx: i };
      return null;
    }
    // A room with a patient (or pharmacy customer) in/incoming can't be moved.
    function roomBusy(rh) {
      if (rh.kind === 'pharmacy') return rh.room.stations.some(function (s) { return s.patient; });
      return !!rh.room.occupant;
    }
    // Free a room's floor + fixtures and drop it from its array (reverse of place*).
    function removeRoom(rh) {
      var r = rh.room, k = examKeyTiles(r.gx, r.gy, r.rot);
      function clearFloor(ts) { ts.forEach(function (t) { delete corridor[t.x + ',' + t.y]; }); }
      if (rh.kind === 'exam') { clearFloor(examTiles(r.gx, r.gy)); delete occupied[k.table.x + ',' + k.table.y]; }
      else if (rh.kind === 'xray') { clearFloor(xrayTiles(r.gx, r.gy)); delete occupied[k.table.x + ',' + k.table.y]; delete occupied[k.desk.x + ',' + k.desk.y]; }
      else if (rh.kind === 'pharmacy') { clearFloor(pharmTiles(r.gx, r.gy)); pharmStations(r.gx, r.gy, r.rot).forEach(function (s) { delete occupied[s.counter.x + ',' + s.counter.y]; }); }
      else if (rh.kind === 'restroom') { clearFloor(footprintTiles(FURN_BY_ID.restroom, r.gx, r.gy, r.rot || 0)); delete occupied[r.toilet.x + ',' + r.toilet.y]; }
      rh.arr.splice(rh.idx, 1);
    }
    // Double-click/tap a room to pick it up and reposition it (free, like furniture).
    function pickUpRoomAt(gx, gy) {
      var rh = roomAt(gx, gy);
      if (!rh || roomBusy(rh)) return;
      var r = rh.room;
      removeRoom(rh);
      placing = { item: FURN_BY_ID[rh.kind], rot: r.rot || 0, moving: true,
                  origRoom: { kind: rh.kind, gx: r.gx, gy: r.gy, rot: r.rot || 0 } };
      pointer.gx = gx; pointer.gy = gy; pointer.on = true;
      document.body.classList.add('placing');
      renderStatic();
      renderShop();
    }

    function tryPlace() {
      if (!placing) return;
      var item = placing.item, rot = placing.rot || 0;
      if (item.kind === 'staff') {          // hire onto a desk station circle
        var st = nearestStation();
        if (pointer.on && st && st.ok) {
          staff.push({ type: item.id, line: st.line });
          money -= item.cost; renderMoney();
          cancelPlacing();
        }
        return;
      }
      if (item.kind === 'examstaff') {      // assign a Vet to an exam room's circle
        var ec = nearestExamCircle();
        if (pointer.on && ec && ec.ok) {
          vets.push({ x: ec.x, y: ec.y, room: null, working: false, speed: 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0 });
          money -= item.cost; renderMoney();
          cancelPlacing();
        }
        return;
      }
      if (item.kind === 'restroom') {       // 2×3 walled room off a corridor
        if (pointer.on && canPlaceRestroom(pointer.gx, pointer.gy, rot)) {
          placeRestroom(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'exam') {           // 3×3 walkable room on corridor-adjacent grass
        if (pointer.on && canPlaceExam(pointer.gx, pointer.gy)) {
          placeExam(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'xray') {           // 3×4 walkable room on corridor-adjacent grass
        if (pointer.on && canPlaceXray(pointer.gx, pointer.gy)) {
          placeXray(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'pharmacy') {       // 4x4 walkable room with 3 medicine counters
        if (pointer.on && canPlacePharmacy(pointer.gx, pointer.gy)) {
          placePharmacy(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'pharmstaff') {     // hire a Pharmacist onto a counter circle
        var pc = nearestPharmCircle();
        if (pointer.on && pc && pc.ok) {
          pc.station.pharm = true;
          money -= item.cost; renderMoney();
          cancelPlacing();
        }
        return;
      }
      if (item.kind === 'cleaner') {        // drop a roaming cleaner on clear room floor
        if (pointer.on && canPlaceCleaner(pointer.gx, pointer.gy)) {
          cleaners.push({ x: pointer.gx, y: pointer.gy, speed: 2.3, dir: 'SE', walkPhase: 0, moving: false, target: null, path: null, wp: 0 });
          money -= item.cost; renderMoney();
          cancelPlacing();
        }
        return;
      }
      if (pointer.on && canPlace(item, pointer.gx, pointer.gy, rot)) {
        placed.push({ id: item.id, gx: pointer.gx, gy: pointer.gy, rot: rot });
        footprintTiles(item, pointer.gx, pointer.gy, rot).forEach(function (t) {
          occupied[t.x + ',' + t.y] = true;
        });
        if (!placing.moving) { money -= item.cost; renderMoney(); }  // moving a placed item is free
        placing.orig = null;               // committed → don't restore on the cancel below
        cancelPlacing();                   // place one, then back to the shop
      }
      // clicking an invalid spot just keeps you in placement mode
    }

    function cancelPlacing() {
      if (placing && placing.moving && placing.orig) {   // move aborted → drop it back where it was
        var o = placing.orig, def = placing.item;
        placed.push({ id: def.id, gx: o.gx, gy: o.gy, rot: o.rot });
        footprintTiles(def, o.gx, o.gy, o.rot).forEach(function (t) { occupied[t.x + ',' + t.y] = true; });
      }
      if (placing && placing.moving && placing.origRoom) {   // room move aborted → rebuild it where it was
        var rr = placing.origRoom;
        if (rr.kind === 'exam') placeExam(rr.gx, rr.gy, rr.rot);
        else if (rr.kind === 'xray') placeXray(rr.gx, rr.gy, rr.rot);
        else if (rr.kind === 'restroom') placeRestroom(rr.gx, rr.gy, rr.rot);
        else if (rr.kind === 'pharmacy') placePharmacy(rr.gx, rr.gy, rr.rot);
      }
      placing = null;
      document.body.classList.remove('placing');
      renderStatic();                          // placement ended → walls visible again
      renderShop();
    }

    // ---- Money + shop DOM ------------------------------------------------
    var moneyEl = document.getElementById('moneyCount');
    var shopItemsEl = document.getElementById('shopItems');

    // Hovering a Staff card dims everyone except staff of that type (see draw()).
    // Delegated on the persistent container so it survives shop re-renders.
    var hoverStaff = null;
    shopItemsEl.addEventListener('mouseover', function (e) {
      var card = e.target.closest ? e.target.closest('.shop-item[data-staff]') : null;
      hoverStaff = card ? card.getAttribute('data-staff') : null;
    });
    shopItemsEl.addEventListener('mouseleave', function () { hoverStaff = null; });

    function renderMoney() {
      moneyEl.textContent = money;
      renderShop();                        // affordability may have changed (also repaints Skills tab)
      renderRating();
    }

    // Clinic rating: derived from arrival frequency `frq` (lower frq = busier =
    // better). Rating = 100 / frq, clamped to [1, 10], 2 decimal places.
    var skillRatingEl = document.getElementById('skillRating');
    function ratingValue() { return Math.max(1, Math.min(10, 100 / frq)); }
    function renderRating() {
      skillRatingEl.innerHTML = '<span class="star">★</span><span class="rv">' +
        ratingValue().toFixed(1) + '</span>';
    }
    // Spawn a floating +/- delta that drifts up out of the rating chip.
    function floatRatingDelta(delta) {
      if (Math.abs(delta) < 0.05) return;          // no visible change → skip
      var f = document.createElement('span');
      f.className = 'rating-delta ' + (delta > 0 ? 'pos' : 'neg');
      f.textContent = (delta > 0 ? '+' : '−') + Math.abs(delta).toFixed(1);
      skillRatingEl.appendChild(f);
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1000);
    }

    var SKILL_DEFS = [
      { key: 'speed',      name: 'Speed',      icon: '⚡' },
      { key: 'processing', name: 'Processing', icon: '⚙️' },
      { key: 'cleaning',   name: 'Cleaning',   icon: '🧹' }
    ];

    // The "Skills" shop tab: skill upgrade cards rendered into the shop strip.
    function renderSkillCards() {
      shopItemsEl.innerHTML = '';
      SKILL_DEFS.forEach(function (def) {
        var s = skills[def.key];
        var afford = money >= s.cost;
        var card = document.createElement('div');
        card.className = 'shop-item' + (afford ? '' : ' disabled');
        card.innerHTML = '<div class="ic">' + def.icon + '</div>' +
                         '<div class="nm">' + def.name + '</div>' +
                         '<div class="vl">Lv ' + s.val.toFixed(1) + '</div>' +
                         '<div class="pr">+0.5  $' + s.cost + '</div>';
        card.addEventListener('click', function () {
          if (money < s.cost) return;
          money -= s.cost;
          s.val += 0.5;
          s.cost *= 2;                     // price doubles per purchase, per skill
          renderMoney();                   // repaints money + shop
        });
        shopItemsEl.appendChild(card);
      });
    }

    function renderShop() {
      if (activeTab === 'skills') { renderSkillCards(); return; }
      shopItemsEl.innerHTML = '';
      FURNITURE.filter(function (item) { return (item.cat || 'reception') === activeTab; }).forEach(function (item) {
        var afford = money >= item.cost;
        var card = document.createElement('div');
        card.className = 'shop-item' + (afford ? '' : ' disabled') +
                         (placing && placing.item.id === item.id ? ' selected' : '');
        if (item.cat === 'staff') card.setAttribute('data-staff', item.id);  // hover → highlight this staff type
        card.innerHTML = '<div class="ic">' + item.icon + '</div>' +
                         '<div class="nm">' + item.name + '</div>' +
                         '<div class="pr">$' + item.cost + (item.perSquare ? '/sq' : '') + '</div>';
        card.addEventListener('click', function () {
          if (money < item.cost) return;
          placing = (placing && placing.item.id === item.id) ? null : { item: item, rot: 0 };
          corridorDrag = null;
          document.body.classList.toggle('placing', !!placing);
          renderStatic();                      // toggle walls off (placing) / on (deselected)
          renderShop();
        });
        shopItemsEl.appendChild(card);
      });
    }

    // Shop tabs switch the visible category. Switching cancels any in-progress
    // placement so a half-selected item doesn't linger across tabs.
    Array.prototype.forEach.call(document.querySelectorAll('.shop-tab'), function (btn) {
      btn.addEventListener('click', function () {
        activeTab = btn.getAttribute('data-tab');
        Array.prototype.forEach.call(document.querySelectorAll('.shop-tab'), function (b) {
          b.classList.toggle('active', b === btn);
        });
        if (placing) cancelPlacing(); else renderShop();
      });
    });

    // ---- Visitors ---------------------------------------------------------
    // The reception desk visitors queue at (first placed desk, or a back-of-room
    // fallback before one is bought). Two lines form on its front (+gy) side.
    function deskAnchor() {
      for (var i = 0; i < placed.length; i++) if (placed[i].id === 'desk') return placed[i];
      return { gx: 3, gy: 1, rot: 0 };
    }
    // The two desk tiles (one per queue line), accounting for rotation.
    function deskLineTiles(d) {
      var rot = d.rot || 0;
      return (rot & 1)
        ? [{ x: d.gx, y: d.gy }, { x: d.gx, y: d.gy + 1 }]   // vertical desk
        : [{ x: d.gx, y: d.gy }, { x: d.gx + 1, y: d.gy }];  // horizontal desk
    }
    // A visitor's target tile in its line: front of its desk tile + its position back.
    function slotPos(v) {
      var d = deskAnchor(), f = FRONT[d.rot || 0];
      var base = deskLineTiles(d)[v.line], idx = queue[v.line].indexOf(v);
      if (idx < 0) idx = 0;
      var sx = base.x + f.x * (1 + idx), sy = base.y + f.y * (1 + idx);
      return { x: sx, y: sy };   // no clamp: long lines extend out in front, not stacked on the edge tile
    }

    function spawnVisitor() {
      var seq = visitorSeq++;
      // join the shorter line (random on a tie)
      var line = queue[0].length < queue[1].length ? 0
               : queue[1].length < queue[0].length ? 1
               : (Math.random() < 0.5 ? 0 : 1);
      var v = {
        id: seq, line: line,
        x: ROOM + 5, y: ROOM + 5,          // start on the near sidewalk, off to the side
        speed: 1.7 + (seq % 3) * 0.12,
        dir: 'NE', moving: true, walkPhase: (seq % 2) * Math.PI,
        phase: 'arriving',                 // arriving → queuing → leaving
        patience: baseWait(),              // seconds left (ticks once queuing); a TV doubles it
        shirt: V_SHIRT[seq % V_SHIRT.length],
        legs: V_LEGS[seq % V_LEGS.length],
        skin: V_SKIN[seq % V_SKIN.length],
        hair: V_HAIR[seq % V_HAIR.length],
        pet: PETS[seq % PETS.length],
        carrier: CARRIER[seq % CARRIER.length]
      };
      v.path = [
        { x: DOOR_MID, y: ROOM + 5 },      // walk along the sidewalk to the path foot
        { x: DOOR_MID, y: ROOM + 0.2 },    // up the path, approach the doors
        { x: DOOR_MID, y: ROOM - 1.4 }     // step inside, then head to the queue slot
      ];
      v.wp = 0;
      queue[line].push(v);
      visitors.push(v);
    }

    function leaveOutbound(v) {
      if (!v.left) {                        // tune arrival rate once per departure, by reason
        v.left = true;
        var rBefore = ratingValue();
        if (v.served && !v.peed) frq = Math.max(3, frq - 1);    // happy (service complete) → arrivals speed up
        else frq = Math.min(100, frq + 1.5);                    // unhappy (gave up / accident) → arrivals slow down (frq 100 = 1-star floor)
        renderRating();                                         // arrival rate changed → refresh rating
        floatRatingDelta(ratingValue() - rBefore);              // animate the +/- change out of the chip
      }
      v.phase = 'leaving';
      v.sideIdx = -1;                      // release any side spot
      if (v.chair) {                       // stand up off the seat onto its clear front tile
        v.x = v.chair.fx; v.y = v.chair.fy; v.seated = false; v.chair = null;
      }
      var qi = queue[v.line].indexOf(v);   // drop out of the queue so others advance
      if (qi >= 0) queue[v.line].splice(qi, 1);
      // BFS back over the connected room floor (exam rooms / corridors -> clinic) so a
      // client leaving from an exam room routes out through the doors instead of
      // beelining into walls/furniture and jamming. Then out the front and away.
      v.path = examRoute(v.x, v.y, DOOR_MID, ROOM - 1.4).concat([
        { x: DOOR_MID, y: ROOM + 0.2 },    // out through the doors
        { x: DOOR_MID, y: ROOM + 5 },      // down the path to the sidewalk
        { x: -6,        y: ROOM + 5 }      // off along the sidewalk, then despawn
      ]);
      v.wp = 0;
    }

    // Collision: any tile holding a placed item is off-limits to people.
    function tileBlocked(x, y) { return !!occupied[Math.round(x) + ',' + Math.round(y)]; }
    // The vet may roam any room floor (clinic + corridors) but not step off it.
    function vetBlocked(x, y) { return tileBlocked(x, y) || !isRoomFloor(Math.round(x), Math.round(y)); }
    // Axis-separated move so actors slide along furniture instead of stopping dead.
    // `blocked` defaults to furniture-only (visitors walk the path/road too).
    // If the actor is already standing ON a blocked tile (e.g. a seated client on a
    // bench/chair), let them move freely so they can escape it — otherwise the tile
    // they occupy blocks every step and they get stuck getting up.
    function moveActor(a, nx, ny, blocked) {
      blocked = blocked || tileBlocked;
      var escaping = blocked(a.x, a.y);
      if (escaping || !blocked(nx, a.y)) a.x = nx;
      if (escaping || !blocked(a.x, ny)) a.y = ny;
    }

    // A tile is taken if another, currently-stationary visitor is standing on it,
    // so two visitors never share a square. Moving visitors aren't blockers (else
    // two walkers meeting head-on would deadlock, and a vacating visitor frees its
    // tile the moment it steps off).
    function visitorOn(self, x, y) {
      var rx = Math.round(x), ry = Math.round(y);
      for (var i = 0; i < visitors.length; i++) {
        var o = visitors[i];
        if (o === self || o.moving) continue;
        if (Math.round(o.x) === rx && Math.round(o.y) === ry) return true;
      }
      return false;
    }
    // Move a visitor toward a target tile; returns true once essentially there.
    function stepToward(v, tx, ty, dt, eps) {
      var dx = tx - v.x, dy = ty - v.y, dist = Math.hypot(dx, dy);
      if (dist < (eps || 0.05)) return true;
      var ux = dx / dist, uy = dy / dist;
      moveActor(v, v.x + ux * v.speed * dt, v.y + uy * v.speed * dt,
                function (x, y) { return tileBlocked(x, y) || visitorOn(v, x, y); });
      v.dir = chooseDir(ux, uy); v.walkPhase += dt * 9; v.moving = true;
      return false;
    }

    // Breadth-first route over the clinic grid from (sx,sy) to (tx,ty), avoiding
    // occupied tiles (the target is allowed even if it's a reserved approach tile).
    // Returns the list of step tiles (start excluded, target last), or null. Used
    // so visitors walk AROUND furniture to a seat's front tile instead of jamming
    // against it — a single chair slides past, but a 2-tile bench needs routing.
    function findPath(sx, sy, tx, ty) {
      sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
      var key = function (x, y) { return x + ',' + y; };
      var came = {}; came[key(sx, sy)] = null;
      var q = [{ x: sx, y: sy }], head = 0;
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      while (head < q.length) {
        var c = q[head++];
        if (c.x === tx && c.y === ty) break;
        for (var i = 0; i < 4; i++) {
          var nx = c.x + dirs[i][0], ny = c.y + dirs[i][1], k = key(nx, ny);
          if (nx < 0 || ny < 0 || nx >= ROOM || ny >= ROOM || k in came) continue;
          if (!(nx === tx && ny === ty) && occupied[k]) continue;   // can't pass through furniture
          came[k] = { x: c.x, y: c.y }; q.push({ x: nx, y: ny });
        }
      }
      if (!(key(tx, ty) in came)) return null;
      var path = [], cur = { x: tx, y: ty };
      while (cur) { path.unshift(cur); cur = came[key(cur.x, cur.y)]; }
      path.shift();                              // drop the start tile
      return path;
    }

    // Snap a visitor onto their claimed seat and start the (extended) sit timer.
    function sitDown(v) {
      v.x = v.chair.gx; v.y = v.chair.gy; v.moving = false; v.seated = true;
      v.dir = chooseDir(v.chair.fx - v.chair.gx, v.chair.fy - v.chair.gy); // face outward
      v.patience *= (v.chair.mult || 2);         // chair ×2, bench ×1.8
      v.phase = 'seated';
    }
    // Send a visitor to their claimed seat, routing around furniture.
    function headToSeat(v) {
      v.sideIdx = -1; v.seated = false; v.phase = 'toChair';
      v.seatPath = findPath(v.x, v.y, v.chair.fx, v.chair.fy);
      v.seatWp = 0;
    }

    function hasDesk() { return placed.some(function (f) { return f.id === 'desk'; }); }

    // The action-circle tile behind the desk for a queue line (where the vet must
    // stand to process that line), and whether the vet is standing on it.
    function stationTile(line) {
      var d = deskAnchor(), f = FRONT[d.rot || 0], t = deskLineTiles(d)[line];
      return { x: t.x - f.x, y: t.y - f.y };
    }
    function vetAtStation(line) {
      if (!hasDesk()) return false;
      var s = stationTile(line);
      return Math.round(vet.x) === s.x && Math.round(vet.y) === s.y;
    }
    // A hired receptionist mans a line's station. With two receptionists each
    // covers their own line; a lone receptionist alternates (their `curLine`
    // toggles after each client — see updateReceptionist / serveVisitor), so they
    // serve both queues instead of leaving one starved.
    function loneStaffLine() {
      var s = staff[0];
      return s.curLine != null ? s.curLine : (s.line || 0);
    }
    function staffAtStation(line) {
      if (staff.length === 1) return loneStaffLine() === line;
      return staff.some(function (s) { return s.line === line; });
    }
    // A lone receptionist switches to the other queue when their current one runs
    // out (so they never sit idle while clients wait on the other side).
    function updateReceptionist() {
      if (staff.length !== 1) return;
      var s = staff[0];
      if (s.curLine == null) s.curLine = (s.line || 0);
      var other = 1 - s.curLine;
      if (queue[s.curLine].length === 0 && queue[other].length > 0) s.curLine = other;
    }

    // Is the vet standing in an exam room's processing circle?
    function vetAtExam(rm) {
      var k = examKeyTiles(rm.gx, rm.gy, rm.rot);
      return Math.round(vet.x) === k.circle.x && Math.round(vet.y) === k.circle.y;
    }

    // True if a step between adjacent tiles a->b crosses ANY walled room's wall
    // (exam / X-ray / pharmacy / restroom) — i.e. a perimeter edge that isn't the
    // door — so visitors and the vet can only enter/leave a room through its door.
    function roomWallEdge(ax, ay, bx, by) {
      // Crossing a room perimeter (inA != inB) is a wall unless it's the door step.
      function crosses(door, inA, inB) {
        if (inA === inB) return false;
        var ds = door && ((inA && bx === door.x && by === door.y) ||
                          (inB && ax === door.x && ay === door.y));
        return !ds;
      }
      var i, rm, fp, inA, inB;
      for (i = 0; i < examRooms.length; i++) { rm = examRooms[i];
        if (crosses(rm.door, ax >= rm.gx && ax < rm.gx + 3 && ay >= rm.gy && ay < rm.gy + 3,
                             bx >= rm.gx && bx < rm.gx + 3 && by >= rm.gy && by < rm.gy + 3)) return true; }
      for (i = 0; i < xrayRooms.length; i++) { rm = xrayRooms[i];
        if (crosses(rm.door, ax >= rm.gx && ax < rm.gx + 3 && ay >= rm.gy && ay < rm.gy + 4,
                             bx >= rm.gx && bx < rm.gx + 3 && by >= rm.gy && by < rm.gy + 4)) return true; }
      for (i = 0; i < pharmacies.length; i++) { rm = pharmacies[i];
        if (crosses(rm.door, ax >= rm.gx && ax < rm.gx + PHARM_W && ay >= rm.gy && ay < rm.gy + PHARM_H,
                             bx >= rm.gx && bx < rm.gx + PHARM_W && by >= rm.gy && by < rm.gy + PHARM_H)) return true; }
      for (i = 0; i < restrooms.length; i++) { rm = restrooms[i];
        fp = footprintTiles(FURN_BY_ID.restroom, rm.gx, rm.gy, rm.rot);
        inA = fp.some(function (t) { return t.x === ax && t.y === ay; });
        inB = fp.some(function (t) { return t.x === bx && t.y === by; });
        if (crosses(rm.door, inA, inB)) return true; }
      return false;
    }

    // BFS a route over ALL connected room floor (clinic + corridors + exam rooms),
    // avoiding furniture, so clients reach an exam table via the corridors instead
    // of beelining into a wall. Returns step tiles (start dropped); falls back to a
    // single direct step if no route exists.
    function examRoute(sx, sy, tx, ty) {
      sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
      var key = function (x, y) { return x + ',' + y; };
      var pass = function (x, y) { return isRoomFloor(x, y) && !occupied[key(x, y)]; };
      if (!pass(tx, ty)) return [{ x: tx, y: ty }];
      var came = {}; came[key(sx, sy)] = null;
      var q = [{ x: sx, y: sy }], head = 0, dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]], n = 0;
      while (head < q.length && n++ < 6000) {
        var c = q[head++];
        if (c.x === tx && c.y === ty) break;
        for (var i = 0; i < 4; i++) {
          var nx = c.x + dirs[i][0], ny = c.y + dirs[i][1], kk = key(nx, ny);
          if (kk in came || !pass(nx, ny) || roomWallEdge(c.x, c.y, nx, ny)) continue;
          came[kk] = { x: c.x, y: c.y }; q.push({ x: nx, y: ny });
        }
      }
      if (!(key(tx, ty) in came)) return [{ x: tx, y: ty }];
      var path = [], cur = { x: tx, y: ty };
      while (cur) { path.unshift(cur); cur = came[key(cur.x, cur.y)]; }
      if (path.length > 1) path.shift();
      return path;
    }

    // Send a waiting client to a free exam room (the next stage after reception).
    // Generic occupant-claim for the exam/xray rooms (pharmacy is station-based, so
    // it keeps its own claim below). The per-type room field, timer field, target
    // phase and waiting predicate come from the room descriptor, so the exam and
    // X-ray flows are the same code parameterized by type.
    function claimRoomGeneric(v, type) {
      var d = ROOM_TYPES[type], rm = freeRoom(type);
      if (!rm) return false;
      var k = examKeyTiles(rm.gx, rm.gy, rm.rot);
      rm.occupant = v; rm[d.timer] = 0; v[d.vRoom] = rm;
      v.seated = false; v.chair = null; v.sideIdx = -1;
      v.patience = baseWait();              // fresh patience for the stage (restroom need persists)
      // BFS a real route over connected room floor (clinic → corridors → room),
      // around furniture, so clients don't beeline into walls and jam.
      v.path = examRoute(v.x, v.y, k.visitor.x, k.visitor.y);
      v.wp = 0; v.phase = d.toPhase;
      return true;
    }
    function releaseRoomGeneric(v, type) {
      var d = ROOM_TYPES[type], rm = v[d.vRoom];
      if (rm) { rm.occupant = null; rm[d.timer] = 0; v[d.vRoom] = null; }
    }
    // Fill free rooms with waiting clients in check-in (ticket) order, so the
    // longest-waiting client is seen next and nobody leap-frogs the queue.
    function assignRoomGeneric(type) {
      if (!freeRoom(type)) return;
      var waiting = visitors.filter(ROOM_TYPES[type].waiting)
        .sort(function (a, b) { return (a.ticket || 0) - (b.ticket || 0); });
      for (var i = 0; i < waiting.length && freeRoom(type); i++) claimRoomGeneric(waiting[i], type);
    }
    function claimExam(v) { return claimRoomGeneric(v, 'exam'); }
    function releaseExam(v) { releaseRoomGeneric(v, 'exam'); }
    function assignExams() { assignRoomGeneric('exam'); }

    // ---- X-ray flow (mirrors exam) ---------------------------------------
    function vetAtXray(rm) {
      var k = examKeyTiles(rm.gx, rm.gy, rm.rot);
      return Math.round(vet.x) === k.circle.x && Math.round(vet.y) === k.circle.y;
    }
    function claimXray(v) { return claimRoomGeneric(v, 'xray'); }
    function releaseXray(v) { releaseRoomGeneric(v, 'xray'); }
    function assignXrays() { assignRoomGeneric('xray'); }

    // ---- Pharmacy patient flow ------------------------------------------
    function playerAtPharm(ph, idx) {
      var sec = pharmStations(ph.gx, ph.gy, ph.rot)[idx];
      return Math.round(vet.x) === sec.circle.x && Math.round(vet.y) === sec.circle.y;
    }
    function claimPharmacy(v) {
      var f = freePharmStation();
      if (!f) return false;
      var sec = pharmStations(f.ph.gx, f.ph.gy, f.ph.rot)[f.idx];
      f.ph.stations[f.idx].patient = v; f.ph.stations[f.idx].procT = 0;
      v.pharmacy = f.ph; v.pharmIdx = f.idx;
      v.seated = false; v.chair = null; v.sideIdx = -1; v.patience = baseWait();
      v.path = examRoute(v.x, v.y, sec.patient.x, sec.patient.y);
      v.wp = 0; v.phase = 'toPharm';
      return true;
    }
    function releasePharm(v) {
      if (v.pharmacy != null && v.pharmIdx != null) {
        var st = v.pharmacy.stations[v.pharmIdx];
        if (st && st.patient === v) { st.patient = null; st.procT = 0; }
      }
      v.pharmacy = null; v.pharmIdx = null;
    }
    // Fill free pharmacy counters with examined clients that rolled "needs meds",
    // in check-in order.
    function assignPharmacies() {
      if (!freePharmStation()) return;
      var waiting = visitors.filter(function (v) {
        return v.needsMeds && !v.medicated && v.pharmacy == null &&
          (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated' || v.phase === 'waitMeds');
      }).sort(function (a, b) { return (a.ticket || 0) - (b.ticket || 0); });
      for (var i = 0; i < waiting.length && freePharmStation(); i++) claimPharmacy(waiting[i]);
    }

    // ---- Cleaners --------------------------------------------------------
    function canPlaceCleaner(gx, gy) { return isRoomFloor(gx, gy) && !occupied[gx + ',' + gy]; }
    // Clean-up time for a mess: litter wipes in 2s, an accident takes 5s.
    function messGoal(p) { return p.kind === 'litter' ? 2 : 5; }
    // Whoever (player or a cleaner) stands on a mess scrubs it; the Cleaning skill
    // scrubs faster. A mess left alone slowly un-scrubs again.
    function updatePuddles(dt) {
      var rate = skills.cleaning.val;
      for (var i = puddles.length - 1; i >= 0; i--) {
        var pd = puddles[i];
        var scrub = (Math.round(vet.x) === pd.x && Math.round(vet.y) === pd.y) ||
                    cleaners.some(function (c) { return Math.round(c.x) === pd.x && Math.round(c.y) === pd.y; });
        if (scrub) { pd.clean = (pd.clean || 0) + dt * rate; if (pd.clean >= messGoal(pd)) puddles.splice(i, 1); }
        else if (pd.clean > 0) pd.clean = Math.max(0, pd.clean - dt * 0.5);
      }
    }
    // A hired cleaner walks to the nearest reachable puddle and mops it (the mopping
    // itself is handled by updatePuddles once they're standing on it).
    function updateCleaner(c, dt) {
      if (c.target && puddles.indexOf(c.target) < 0) { c.target = null; c.path = null; }
      if (!c.target) {
        var best = null, bd = 1e9;
        puddles.forEach(function (pd) { var d = Math.abs(c.x - pd.x) + Math.abs(c.y - pd.y); if (d < bd) { bd = d; best = pd; } });
        if (best) { var path = examRoute(c.x, c.y, best.x, best.y); if (path) { c.target = best; c.path = path; c.wp = 0; } }
      }
      if (c.target && c.path && c.wp < c.path.length) {
        var t = c.path[c.wp];
        if (stepToward(c, t.x, t.y, dt, 0.06)) c.wp++;
      } else { c.moving = false; }
    }
    // The desk station nearest the cursor (for placing a receptionist), with validity.
    function nearestStation() {
      if (!hasDesk()) return null;
      var best = null, bd = 1e9;
      for (var L = 0; L < 2; L++) {
        var s = stationTile(L), d = Math.abs(pointer.gx - s.x) + Math.abs(pointer.gy - s.y);
        if (d < bd) { bd = d; best = { line: L, x: s.x, y: s.y }; }
      }
      best.ok = best.x >= 0 && best.y >= 0 && best.x < ROOM && best.y < ROOM && !staffAtStation(best.line);
      return best;
    }

    // A receptionist figure (headset + name badge) standing at a desk station.
    function drawReceptionist(c, gx, gy) {
      var s = iso(gx, gy);
      var f = FRONT[deskAnchor().rot || 0];
      var dir = chooseDir(f.x, f.y);              // face the customers
      var front = (dir === 'SE' || dir === 'SW');
      var mirror = (dir === 'SW' || dir === 'NW') ? -1 : 1;
      c.fillStyle = 'rgba(20,40,30,0.26)';
      c.beginPath(); c.ellipse(s.x, s.y, 13, 6, 0, 0, Math.PI * 2); c.fill();
      c.save(); c.translate(s.x, s.y);
      c.fillStyle = '#33405a'; c.fillRect(-6, -14, 5, 14); c.fillRect(1, -14, 5, 14); // legs
      c.fillStyle = '#23262d'; c.fillRect(-7, -2, 6, 3); c.fillRect(1, -2, 6, 3);      // shoes
      var bt = -40;                                                                    // torso (purple top)
      c.fillStyle = gradL(c, 0, bt, 0, -12, [[0, '#9b80e0'], [1, '#6f53c0']]); roundRect(c, -11, bt, 22, 28, 7); c.fill();
      c.fillStyle = '#6149b3'; roundRect(c, -14, bt + 2, 5, 13, 2.5); c.fill(); roundRect(c, 9, bt + 2, 5, 13, 2.5); c.fill();
      c.fillStyle = '#f0c8a4'; c.fillRect(-14, bt + 14, 5, 4); c.fillRect(9, bt + 14, 5, 4); // hands
      c.fillStyle = '#fff'; c.fillRect(4, bt + 6, 5, 4);                                // name badge
      c.fillStyle = '#e7bd98'; c.fillRect(-3, bt - 4, 6, 5);                            // neck
      var hy = bt - 13;
      c.fillStyle = '#f0c8a4'; c.beginPath(); c.arc(0, hy, 8.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#3a2c22'; c.beginPath(); c.arc(0, hy - 1, 8.5, Math.PI * (front ? 1.02 : 0.05), Math.PI * (front ? 1.98 : 0.95), false); c.fill();
      if (front) {
        c.fillStyle = '#2b2b33';
        c.beginPath(); c.arc(-3 * mirror, hy, 1.3, 0, Math.PI * 2); c.arc(3 * mirror, hy, 1.3, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#9a5f44'; c.lineWidth = 1.2;
        c.beginPath(); c.arc(0, hy + 3, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
      }
      c.strokeStyle = '#2b2b33'; c.lineWidth = 1.6;                                     // headset band
      c.beginPath(); c.arc(0, hy - 1, 9, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
      c.fillStyle = '#2b2b33'; c.beginPath(); c.arc(-8 * mirror, hy + 1, 2, 0, Math.PI * 2); c.fill(); // earpiece
      if (front) { c.lineWidth = 1.2; c.beginPath(); c.moveTo(-8 * mirror, hy + 1); c.quadraticCurveTo(-6 * mirror, hy + 7, -2 * mirror, hy + 6); c.stroke(); } // mic
      c.restore();
    }

    // A hired Vet figure (teal scrubs, blue surgical cap, stethoscope) standing on
    // an exam room circle, facing the table. `rot` is the room's rotation.
    function drawVetStaff(c, gx, gy, rot, dirOverride) {
      var s = iso(gx, gy);
      var f = FRONT[rot || 0];
      var dir = dirOverride || chooseDir(f.x, f.y); // face movement while roaming, else the table
      var front = (dir === 'SE' || dir === 'SW');
      var mirror = (dir === 'SW' || dir === 'NW') ? -1 : 1;
      c.fillStyle = 'rgba(20,40,30,0.26)';
      c.beginPath(); c.ellipse(s.x, s.y, 13, 6, 0, 0, Math.PI * 2); c.fill();
      c.save(); c.translate(s.x, s.y);
      c.fillStyle = '#34506f'; c.fillRect(-6, -14, 5, 14); c.fillRect(1, -14, 5, 14); // legs (navy scrubs)
      c.fillStyle = '#26323f'; c.fillRect(-7, -2, 6, 3); c.fillRect(1, -2, 6, 3);      // shoes
      var bt = -40;                                                                    // torso (teal scrubs)
      c.fillStyle = gradL(c, 0, bt, 0, -12, [[0, '#46c3b3'], [1, '#2f9e90']]); roundRect(c, -11, bt, 22, 28, 7); c.fill();
      c.fillStyle = '#3bb1a2'; roundRect(c, -14, bt + 2, 5, 13, 2.5); c.fill(); roundRect(c, 9, bt + 2, 5, 13, 2.5); c.fill();
      c.fillStyle = '#f0c8a4'; c.fillRect(-14, bt + 14, 5, 4); c.fillRect(9, bt + 14, 5, 4); // hands
      c.fillStyle = '#e7bd98'; c.fillRect(-3, bt - 4, 6, 5);                            // neck
      var hy = bt - 13;
      c.fillStyle = '#f0c8a4'; c.beginPath(); c.arc(0, hy, 8.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#3d8fd0';                                                          // blue surgical cap
      c.beginPath(); c.arc(0, hy - 1, 8.5, Math.PI * 1.02, Math.PI * 1.98, false); c.closePath(); c.fill();
      c.fillRect(-8.5, hy - 2, 17, 3);
      if (front) {
        c.fillStyle = '#2a8d80';                                                       // V-neck
        c.beginPath(); c.moveTo(-5, bt); c.lineTo(0, bt + 8); c.lineTo(5, bt); c.closePath(); c.fill();
        c.strokeStyle = '#243240'; c.lineWidth = 2;                                     // stethoscope
        c.beginPath(); c.arc(0, bt + 4, 6, Math.PI * 0.1, Math.PI * 0.9, false); c.stroke();
        c.beginPath(); c.moveTo(-4, bt + 8); c.lineTo(-3, bt + 20); c.stroke();
        c.fillStyle = '#9fb3c4'; c.beginPath(); c.arc(-3, bt + 21, 2.2, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#2b2b33';                                                        // eyes + smile
        c.beginPath(); c.arc(-3 * mirror, hy, 1.3, 0, Math.PI * 2); c.arc(3 * mirror, hy, 1.3, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#9a5f44'; c.lineWidth = 1.2;
        c.beginPath(); c.arc(0, hy + 3, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
      } else {
        c.fillStyle = '#6b4a32'; c.beginPath(); c.arc(0, hy + 2, 8, Math.PI * 0.05, Math.PI * 0.95, false); c.fill(); // hair under cap
      }
      c.restore();
    }

    // The exam-room circle nearest the cursor (for placing a Vet), with validity.
    function nearestExamCircle() {
      var rooms = examRooms.concat(xrayRooms);    // a Vet can man an exam OR an X-ray circle
      if (!rooms.length) return null;
      var best = null, bd = 1e9;
      rooms.forEach(function (rm) {
        var k = examKeyTiles(rm.gx, rm.gy, rm.rot);
        var d = Math.abs(pointer.gx - k.circle.x) + Math.abs(pointer.gy - k.circle.y);
        if (d < bd) { bd = d; best = { room: rm, x: k.circle.x, y: k.circle.y }; }
      });
      if (best) best.ok = true;                   // a roaming Vet can be hired from any room circle
      return best;
    }

    // Ghost for hiring a Vet: highlight the targeted exam circle + a vet preview.
    function drawVetStaffGhost() {
      var ec = nearestExamCircle();
      if (!ec) return;                            // no exam room → nowhere to stand
      var s = iso(ec.x, ec.y);
      ctx.save();
      ctx.beginPath(); ctx.ellipse(s.x, s.y, TILE_HW * 0.62, TILE_HH * 0.62, 0, 0, Math.PI * 2);
      ctx.fillStyle = ec.ok ? 'rgba(76,196,106,0.32)' : 'rgba(224,86,63,0.40)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = ec.ok ? 'rgba(70,205,120,1)' : 'rgba(224,86,63,0.95)'; ctx.stroke();
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawVetStaff(ghostCtx, ec.x, ec.y, ec.room.rot);
      if (!ec.ok) {
        ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop';
        ghostCtx.fillStyle = 'rgba(222,58,44,0.62)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // Nearest pharmacy counter circle to the cursor (for hiring a Pharmacist).
    function nearestPharmCircle() {
      if (!pharmacies.length) return null;
      var best = null, bd = 1e9;
      pharmacies.forEach(function (ph) {
        pharmStations(ph.gx, ph.gy, ph.rot).forEach(function (sec, idx) {
          var d = Math.abs(pointer.gx - sec.circle.x) + Math.abs(pointer.gy - sec.circle.y);
          if (d < bd) { bd = d; best = { ph: ph, station: ph.stations[idx], x: sec.circle.x, y: sec.circle.y }; }
        });
      });
      if (best) best.ok = !best.station.pharm;
      return best;
    }
    // Ghost for hiring a Pharmacist: highlight the targeted counter circle + figure.
    function drawPharmStaffGhost() {
      var pc = nearestPharmCircle();
      if (!pc) return;
      var s = iso(pc.x, pc.y);
      ctx.save();
      ctx.beginPath(); ctx.ellipse(s.x, s.y, TILE_HW * 0.62, TILE_HH * 0.62, 0, 0, Math.PI * 2);
      ctx.fillStyle = pc.ok ? 'rgba(76,196,106,0.32)' : 'rgba(224,86,63,0.40)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = pc.ok ? 'rgba(70,205,120,1)' : 'rgba(224,86,63,0.95)'; ctx.stroke();
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawReceptionist(ghostCtx, pc.x, pc.y);
      if (!pc.ok) { ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop'; ghostCtx.fillStyle = 'rgba(222,58,44,0.62)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // Every seat slot across placed seating. A chair is one seat that ×2's the
    // remaining wait; a bench is two seats, each only 80% as effective (×1.8).
    // Each slot carries its tile, the front tile to approach from, and the mult.
    function allSeats() {
      var out = [];
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i], rot = p.rot || 0, f = FRONT[rot];
        if (p.id === 'chair') {
          out.push({ gx: p.gx, gy: p.gy, fx: p.gx + f.x, fy: p.gy + f.y, mult: 2 });
        } else if (p.id === 'bench') {
          benchSeatTiles(p).forEach(function (t) {
            out.push({ gx: t.x, gy: t.y, fx: t.x + f.x, fy: t.y + f.y, mult: 1.8 });
          });
        }
      }
      return out;
    }
    // A free seat slot no visitor has claimed, or null.
    // The room a waiting client is queued for, as an (x,y) anchor — so they take the
    // nearest free seat to it (nearest exam room, or pharmacy/X-ray if that's next).
    function waitTarget(v) {
      var rooms = [];
      if (v.needsMeds && !v.medicated) pharmacies.forEach(function (ph) { rooms.push({ x: ph.gx + 1.5, y: ph.gy + 1.5 }); });
      else if (v.needsXray && !v.xrayed) xrayRooms.forEach(function (rm) { rooms.push({ x: rm.gx + 1, y: rm.gy + 1.5 }); });
      else examRooms.forEach(function (rm) { rooms.push({ x: rm.gx + 1, y: rm.gy + 1 }); });
      if (!rooms.length) return { x: v.x, y: v.y };
      var best = rooms[0], bd = 1e9;
      rooms.forEach(function (r) { var d = Math.abs(r.x - v.x) + Math.abs(r.y - v.y); if (d < bd) { bd = d; best = r; } });
      return best;
    }
    // The unoccupied seat closest to the room the client is waiting for.
    function freeSeat(v) {
      var ref = v ? waitTarget(v) : { x: 0, y: 0 }, best = null, bd = 1e9;
      allSeats().forEach(function (s) {
        var taken = visitors.some(function (o) { return o.chair && o.chair.gx === s.gx && o.chair.gy === s.gy; });
        if (taken) return;
        var d = Math.abs(s.gx - ref.x) + Math.abs(s.gy - ref.y);
        if (d < bd) { bd = d; best = s; }
      });
      return best;
    }

    // Base wait before a client storms off. A room with a TV keeps them
    // entertained, so the whole room's wait time is doubled.
    // A TV only entertains visitors within 2 squares of it (any direction): a nearby
    // visitor's patience drains at half speed (≈ doubling their wait) while in range,
    // rather than a clinic-wide buff. baseWait stays the plain base patience value.
    function nearTV(v) {
      var vx = Math.round(v.x), vy = Math.round(v.y);
      return placed.some(function (p) {
        return p.id === 'tv' && Math.abs(p.gx - vx) <= 2 && Math.abs(p.gy - vy) <= 2;
      });
    }
    function baseWait() { return wait; }

    // A waiting client within 3 tiles of a puddle gets impatient twice as fast.
    function nearPee(v) {
      var vx = Math.round(v.x), vy = Math.round(v.y);
      return puddles.some(function (p) { return Math.abs(p.x - vx) <= 3 && Math.abs(p.y - vy) <= 3; });
    }
    // Combined wait-drain multiplier: a TV halves it, nearby pee doubles it.
    function drainMult(v) { return (nearTV(v) ? 0.5 : 1) * (nearPee(v) ? 2 : 1); }

    // A reception client is served: pay out, pop a +10, give a fresh wait bar so
    // the queue advances. If a chair is free they head over to sit; otherwise
    // they step aside to a side spot as before.
    function serveVisitor(v) {
      money += 10; renderMoney();
      floaters.push({ v: v, t: 0 });
      var qi = queue[v.line].indexOf(v); if (qi >= 0) queue[v.line].splice(qi, 1);
      // a lone receptionist hands the next turn to the other queue (alternation)
      if (staff.length === 1 && !vetAtStation(v.line) && loneStaffLine() === v.line && queue[1 - v.line].length > 0) {
        staff[0].curLine = 1 - v.line;
      }
      v.served = true;                       // service complete → counts as a happy departure later
      v.ticket = examTicketSeq++;            // check-in order → examined first-come-first-served
      v.procT = 0; v.patience = baseWait();
      // ~55% of clients will need the loo, 20–50s into their wait. Unlike patience
      // (which refills each phase), this need is a single persistent countdown — so
      // it actually fires before a comfortable (seated/TV) client is examined.
      v.bladder = Math.random() < 0.55 ? 20 + Math.random() * 30 : null;
      // exam rooms are assigned centrally, in check-in order, by assignExams()
      var seat = freeSeat(v);
      if (seat) {                            // go sit in an empty chair / bench seat
        v.chair = { gx: seat.gx, gy: seat.gy, fx: seat.fx, fy: seat.fy, mult: seat.mult };
        headToSeat(v);
      } else {                               // no seat free → step aside
        var s = sideSpot();
        v.phase = 'served'; v.sideIdx = s.idx; v.sideX = s.x; v.sideY = s.y;
      }
    }

    // The client suddenly needs the loo: drop their seat/spot and go seek a restroom
    // (they have 40s before an accident).
    function needRestroom(v) {
      v.seated = false; v.chair = null; v.sideIdx = -1;
      v.relief = 40; v.rm = null; v.path = null; v.wp = 0;
      v.phase = 'toRestroom';
    }
    function peeAndLeave(v) {
      if (v.rm) { v.rm.occupant = null; v.rm = null; }
      puddles.push({ x: Math.round(v.x), y: Math.round(v.y), clean: 0 });
      v.relief = null; v.bladder = null; v.peed = true;
      leaveOutbound(v);
    }

    function messAt(x, y) { for (var i = 0; i < puddles.length; i++) if (puddles[i].x === x && puddles[i].y === y) return true; return false; }
    // Waiting visitors occasionally drop a piece of litter where they stand; the
    // player (stand on it ~2s) or a cleaner mops it up like an accident.
    function maybeLitter(v, dt) {
      if (v.litterT == null) v.litterT = 12 + Math.random() * 28;
      if (v.phase !== 'queuing' && v.phase !== 'idle' && v.phase !== 'seated' && v.phase !== 'served' && v.phase !== 'waitXray') return;
      v.litterT -= dt;
      if (v.litterT > 0) return;
      v.litterT = 18 + Math.random() * 30;
      var lx = Math.round(v.x), ly = Math.round(v.y);
      if (isRoomFloor(lx, ly) && !occupied[lx + ',' + ly] && !messAt(lx, ly))
        puddles.push({ x: lx, y: ly, clean: 0, kind: 'litter' });
    }

    // ---- Generic occupant-room care (exam / X-ray) ----------------------
    // Walk to the room's owner-side tile; on arrival, stand and face the
    // table/bed and start the "waiting to be seen" timer. Drain patience en
    // route; give up (releasing the room) if it runs out.
    function toRoomGeneric(v, dt, type) {
      var d = ROOM_TYPES[type], t = v.path[v.wp];
      if (stepToward(v, t.x, t.y, dt, 0.06)) {
        v.wp++;
        if (v.wp >= v.path.length) {
          v.x = t.x; v.y = t.y; v.moving = false; v.phase = d.inPhase;
          v.patience = baseWait(); v[d.waitField] = baseWait();   // fresh "waiting to be seen" timer
          var rm = v[d.vRoom], k = examKeyTiles(rm.gx, rm.gy, rm.rot);
          v.dir = chooseDir(k.table.x - v.x, k.table.y - v.y);    // face the table/bed
        }
      }
      v.patience -= dt * drainMult(v);
      if (v.patience <= 0) { d.release(v); leaveOutbound(v); }
    }
    // At the table/bed: the player on the circle (full rate) or a roaming hired
    // Vet (half) works; the timer fills to duration×procTime, pays out, then the
    // descriptor's onDone decides what happens next (exam → follow-up roll;
    // X-ray → leave happy). With no operator, the wait timer drains and they go.
    function inRoomGeneric(v, dt, type) {
      var d = ROOM_TYPES[type];
      v.moving = false;
      var rm = v[d.vRoom];
      v.processing = d.operator(rm);
      if (v.processing) {
        rm[d.timer] = (rm[d.timer] || 0) + dt * d.fullRate(rm);
        if (rm[d.timer] >= d.duration * procTime()) {
          money += d.payout; renderMoney();
          floaters.push({ v: v, t: 0, amt: d.payout });
          d.onDone(v);
        }
      } else {
        if (v[d.waitField] == null) v[d.waitField] = baseWait();
        v[d.waitField] -= dt * drainMult(v);
        if (v[d.waitField] <= 0) { d.release(v); leaveOutbound(v); return; }
      }
    }
    // "Loiter until a room frees up" (waitXray / waitMeds): drift along the path
    // to a side spot, draining patience; leave if it expires.
    function waitRoomGeneric(v, dt) {
      if (v.path && v.wp < v.path.length) { var wt = v.path[v.wp]; if (stepToward(v, wt.x, wt.y, dt, 0.08)) v.wp++; }
      else { v.moving = false; }
      v.patience -= dt * drainMult(v);
      if (v.patience <= 0) { v.patience = 0; leaveOutbound(v); }
    }
    // After an exam the pet may need follow-up care, rolled regardless of whether
    // that room exists yet — if none is free, the client waits and eventually
    // leaves unhappy, pressuring you to build it. (Roll order is load-bearing for
    // determinism — keep the 0.2 then 0.4 sequence.)
    function examFollowUp(v) {
      if (Math.random() < 0.2) {             // 20% need an X-ray
        v.needsXray = true;
        if (!claimXray(v)) {                 // no free X-ray room → go wait for one
          var ss = sideSpot();
          v.path = examRoute(v.x, v.y, ss.x, ss.y);
          v.wp = 0; v.phase = 'waitXray'; v.patience = baseWait();
        }
      } else if (Math.random() < 0.4) {      // 40% of the rest need medicine
        v.needsMeds = true;
        if (!claimPharmacy(v)) {             // no free pharmacy counter → wait for one
          var ps = sideSpot();
          v.path = examRoute(v.x, v.y, ps.x, ps.y);
          v.wp = 0; v.phase = 'waitMeds'; v.patience = baseWait();
        }
      } else {
        v.happy = true; leaveOutbound(v);    // done → leaves happy
      }
    }

    function updateVisitor(v, dt) {
      maybeLitter(v, dt);                    // visitors randomly drop litter while waiting
      // After reception, the bladder ticks while the client waits; at zero they
      // break off to find a restroom.
      if (v.bladder != null &&
          (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated')) {
        v.bladder -= dt;
        if (v.bladder <= 0) { v.bladder = null; needRestroom(v); return; }
      }
      if (v.phase === 'toRestroom') {      // break off to find/walk to a restroom
        v.relief -= dt;
        if (!v.rm) {                       // claim a free restroom and route into the room
          var rm = freeRestroom();
          if (rm) {
            rm.occupant = v; v.rm = rm;
            // route internally over connected floor (clinic → corridor → restroom),
            // around furniture — same as exam rooms, not out the front doors
            v.path = examRoute(v.x, v.y, rm.stand.x, rm.stand.y);
            v.wp = 0;
          } else { v.moving = false; }     // none free → squirm until one opens or time runs out
        }
        if (v.rm && v.path) {
          var tgt = v.path[v.wp];
          if (stepToward(v, tgt.x, tgt.y, dt, 0.06)) {
            v.wp++;
            if (v.wp >= v.path.length) {
              v.x = v.rm.stand.x; v.y = v.rm.stand.y; v.moving = false;
              v.dir = chooseDir(v.rm.toilet.x - v.x, v.rm.toilet.y - v.y);   // face the toilet
              v.phase = 'inRestroom'; v.useT = 3;
            }
          }
        }
        if (v.relief <= 0) peeAndLeave(v);
        return;
      }
      if (v.phase === 'inRestroom') {      // using the restroom inside the room, then head back in
        v.useT -= dt;
        if (v.useT <= 0) {
          if (v.rm) { v.rm.occupant = null; v.rm = null; }
          v.relief = null; v.bladder = null;     // relieved for the rest of this visit
          var s = sideSpot();
          v.phase = 'served'; v.sideIdx = s.idx; v.sideX = s.x; v.sideY = s.y; v.patience = baseWait();
        }
        return;
      }
      // Occupant-room care (exam + X-ray) runs through the generic walk / serve /
      // wait handlers, parameterized by the room descriptor. The waitXray and
      // waitMeds "loiter until a room frees up" states are identical.
      if (v.phase === 'toExam') { toRoomGeneric(v, dt, 'exam'); return; }
      if (v.phase === 'inExam') { inRoomGeneric(v, dt, 'exam'); return; }
      if (v.phase === 'toXray') { toRoomGeneric(v, dt, 'xray'); return; }
      if (v.phase === 'inXray') { inRoomGeneric(v, dt, 'xray'); return; }
      if (v.phase === 'waitXray' || v.phase === 'waitMeds') { waitRoomGeneric(v, dt); return; }
      if (v.phase === 'toPharm') {          // walk to the counter's patient-side tile
        var pt = v.path[v.wp];
        if (stepToward(v, pt.x, pt.y, dt, 0.06)) {
          v.wp++;
          if (v.wp >= v.path.length) {
            var psec = pharmStations(v.pharmacy.gx, v.pharmacy.gy, v.pharmacy.rot)[v.pharmIdx];
            v.x = pt.x; v.y = pt.y; v.moving = false; v.phase = 'inPharm';
            v.dir = chooseDir(psec.counter.x - v.x, psec.counter.y - v.y); // face the counter
            v.pharmWait = baseWait();
          }
        }
        v.patience -= dt * drainMult(v);
        if (v.patience <= 0) { releasePharm(v); leaveOutbound(v); }
        return;
      }
      if (v.phase === 'inPharm') {          // at the counter; player or Pharmacist fills it
        v.moving = false;
        var pst = v.pharmacy.stations[v.pharmIdx];
        v.processing = playerAtPharm(v.pharmacy, v.pharmIdx) || pst.pharm;
        if (v.processing) {
          pst.procT = (pst.procT || 0) + dt;   // same rate for player & Pharmacist (reception speed)
          if (pst.procT >= procTime()) {
            money += 40; renderMoney();
            floaters.push({ v: v, t: 0, amt: 40 });
            v.medicated = true; v.needsMeds = false; v.happy = true;
            releasePharm(v); leaveOutbound(v);  // prescription filled → leaves happy
          }
        } else {                            // waiting to be served — its own timer drains
          if (v.pharmWait == null) v.pharmWait = baseWait();
          v.pharmWait -= dt * drainMult(v);
          if (v.pharmWait <= 0) { releasePharm(v); leaveOutbound(v); return; }
        }
        return;
      }
      if (v.phase === 'queuing') {
        var t = slotPos(v);
        var reached = stepToward(v, t.x, t.y, dt);
        if (reached) {
          var f = FRONT[(deskAnchor().rot || 0)];
          v.x = t.x; v.y = t.y; v.moving = false; v.dir = chooseDir(-f.x, -f.y); // face the desk
        }
        v.patience -= dt * drainMult(v);                  // tick down while in line
        if (v.patience <= 0) { v.patience = 0; leaveOutbound(v); return; }
        // the front-of-line client is processed while the vet stands on the desk's
        // action circle for that line, OR a hired receptionist mans it; bar fills.
        v.processing = (reached && queue[v.line][0] === v && (vetAtStation(v.line) || staffAtStation(v.line)));
        if (v.processing) {
          // the player works at full speed; a hired receptionist is 50% as effective
          v.procT = (v.procT || 0) + dt * (vetAtStation(v.line) ? 1 : 0.5);
          if (v.procT >= procTime()) serveVisitor(v);
        }
        return;
      }
      if (v.phase === 'served') {          // walk aside after being served
        if (stepToward(v, v.sideX, v.sideY, dt)) {
          v.x = v.sideX; v.y = v.sideY; v.moving = false; v.dir = 'SE';
          v.phase = 'idle'; v.patience = baseWait();  // bar resets and starts again
        }
        return;
      }
      if (v.phase === 'idle') {            // standing aside, fresh wait bar
        var openSeat = freeSeat(v);
        if (openSeat) {                    // a seat opened up (e.g. player built one) → go sit
          v.chair = { gx: openSeat.gx, gy: openSeat.gy, fx: openSeat.fx, fy: openSeat.fy, mult: openSeat.mult };
          headToSeat(v);
          return;
        }
        v.moving = false;
        v.patience -= dt * drainMult(v);
        if (v.patience <= 0) { v.patience = 0; leaveOutbound(v); }
        return;
      }
      if (v.phase === 'toChair') {         // route around furniture, then drop into the seat
        var path = v.seatPath;
        if (path && path.length) {
          var wp = path[Math.min(v.seatWp, path.length - 1)];
          if (stepToward(v, wp.x, wp.y, dt, 0.12)) {
            v.seatWp++;
            if (v.seatWp >= path.length) sitDown(v);
          }
        } else if (stepToward(v, v.chair.fx, v.chair.fy, dt)) {  // no route found → direct
          sitDown(v);
        }
        return;
      }
      if (v.phase === 'seated') {          // sitting comfortably, doubled wait bar
        v.moving = false;
        v.patience -= dt * drainMult(v);
        if (v.patience <= 0) { v.patience = 0; leaveOutbound(v); }
        return;
      }
      // arriving / leaving: follow the fixed waypoint list
      var tgt = v.path[v.wp];
      if (stepToward(v, tgt.x, tgt.y, dt, 0.06)) {
        v.wp++;
        if (v.wp >= v.path.length) {
          if (v.phase === 'arriving') { v.phase = 'queuing'; }   // stay moving: queuing handler walks them to their slot, not parked on the door funnel
          else { v.dead = true; }          // finished leaving → remove
        }
      }
    }

    // ---- Update -----------------------------------------------------------
    // ---- Roaming hired vets ----------------------------------------------
    // A hired Vet isn't pinned to one room: it walks to the nearest room it can
    // work (exam or X-ray) that has a patient and no other vet, works there, then
    // moves on. A room "has a vet" now means one is standing on its circle.
    var vets = [];   // [{x,y,room,working,speed,dir,walkPhase,moving,path,wp}]
    function vetRooms() { return examRooms.concat(xrayRooms); }
    function roomNeedsVet(rm) {
      return !!rm.occupant && (rm.occupant.phase === 'inExam' || rm.occupant.phase === 'inXray');
    }
    function roomVetWorking(rm) {
      for (var i = 0; i < vets.length; i++) if (vets[i].room === rm && vets[i].working) return true;
      return false;
    }
    function roomClaimed(rm, self) {
      for (var i = 0; i < vets.length; i++) if (vets[i] !== self && vets[i].room === rm) return true;
      return false;
    }
    function vetCircle(rm) { return examKeyTiles(rm.gx, rm.gy, rm.rot).circle; }
    function updateVets(dt) {
      var rooms = vetRooms();
      for (var i = 0; i < vets.length; i++) {
        var v = vets[i];
        if (v.room && (rooms.indexOf(v.room) < 0 || !roomNeedsVet(v.room))) {
          v.room = null; v.working = false; v.path = null;   // patient finished / room gone
        }
        if (!isRoomFloor(Math.round(v.x), Math.round(v.y))) { v.x = ROOM / 2 - 0.5; v.y = ROOM - 1.5; v.path = null; v.working = false; }  // stranded (room moved) -> back to clinic
        if (!v.room) {
          var best = null, bd = 1e9;
          for (var j = 0; j < rooms.length; j++) {
            var rm = rooms[j];
            if (!roomNeedsVet(rm) || roomClaimed(rm, v)) continue;
            var c = vetCircle(rm), d = Math.abs(c.x - v.x) + Math.abs(c.y - v.y);
            if (d < bd) { bd = d; best = rm; }
          }
          if (!best) { v.moving = false; v.walkPhase = 0; continue; }   // nothing needs a vet
          v.room = best; v.working = false;
          var bc = vetCircle(best); v.path = examRoute(v.x, v.y, bc.x, bc.y); v.wp = 0;
        }
        var cc = vetCircle(v.room);
        if (Math.round(v.x) === cc.x && Math.round(v.y) === cc.y) {     // on the circle -> work
          v.x = cc.x; v.y = cc.y; v.moving = false; v.walkPhase = 0; v.working = true;
          var f = FRONT[v.room.rot || 0]; v.dir = chooseDir(f.x, f.y);  // face the table
        } else if (v.path && v.wp < v.path.length) {
          v.working = false;
          if (stepToward(v, v.path[v.wp].x, v.path[v.wp].y, dt, 0.12)) v.wp++;
        } else {
          v.path = examRoute(v.x, v.y, cc.x, cc.y); v.wp = 0;           // stranded -> recompute
        }
      }
    }

    function update(dt) {
      animT += dt;

      // Autosave to the active slot every minute of play. Overwrites in place;
      // creates the "Autosave" slot if the hospital hasn't been named yet.
      autoSaveTimer += dt;
      if (autoSaveTimer >= AUTOSAVE_PERIOD) {
        autoSaveTimer = 0;
        if (lsAvailable()) {
          writeSave(currentName || AUTOSAVE_NAME);    // sets currentName, persists LS_CURRENT
          updateHospitalLabel();                       // label reflects the (now-named) slot
          if (!saveModal.hidden) renderSaveList();     // keep an open Saves panel fresh
        }
      }

      vet.speed = BASE_SPEED + (skills.speed.val - 1.0);  // Speed skill: additive movement
      var mx = 0, my = 0;
      if (touchInput.active) { mx = touchInput.dx; my = touchInput.dy; }
      else {
        if (input.right) mx += 1; if (input.left) mx -= 1;
        if (input.down) my += 1; if (input.up) my -= 1;
      }
      var len = Math.hypot(mx, my);
      vet.moving = len > 0.01;
      if (vet.moving) {
        mx /= len; my /= len;
        // vetBlocked confines the vet to room floor (clinic + corridors).
        moveActor(vet, vet.x + mx * vet.speed * dt, vet.y + my * vet.speed * dt, vetBlocked);
        vet.dir = chooseDir(mx, my);
        vet.walkPhase += dt * 10;
      } else {
        vet.walkPhase = 0;
      }

      // visitors: spawn on a timer, then step each one along its path
      spawnTimer -= dt;
      if (spawnTimer <= 0) { spawnVisitor(); spawnTimer += frq; }
      updateReceptionist();                  // lone receptionist picks which queue to man
      for (var i = visitors.length - 1; i >= 0; i--) {
        updateVisitor(visitors[i], dt);
        if (visitors[i].dead) visitors.splice(i, 1);
      }
      assignExams();                         // hand free exam rooms to the longest-waiting clients
      assignXrays();                         // hand free X-ray rooms to pets that need one
      assignPharmacies();                    // hand free pharmacy counters to clients needing meds
      updateVets(dt);                        // roaming vets move between rooms that need them
      cleaners.forEach(function (c) { c.speed = 2.3 * skills.cleaning.val; updateCleaner(c, dt); }); // cleaners head to messes (Cleaning skill speeds them)
      updatePuddles(dt);                     // scrub puddles the player/cleaners stand on
      // advance + retire the +10 coin pops
      for (var fi = floaters.length - 1; fi >= 0; fi--) {
        floaters[fi].t += dt;
        if (floaters[fi].t > 1.2) floaters.splice(fi, 1);
      }

      // automatic doors open when the vet or any visitor is near the doorway
      var near = isNearDoor(vet.x, vet.y) ||
                 visitors.some(function (v) { return isNearDoor(v.x, v.y); });
      var target = near ? 1 : 0;
      door.open += (target - door.open) * Math.min(1, dt * 9);
      if (Math.abs(door.open - target) < 0.002) door.open = target;
      // same auto-open behaviour for every corridor↔room doorway
      doorways.forEach(function (d) {
        var k = d.ax + ',' + d.ay + ',' + d.bx + ',' + d.by;
        var mx = (d.ax + d.bx) / 2, my = (d.ay + d.by) / 2;
        var dn = Math.hypot(vet.x - mx, vet.y - my) < 1.6 ||
                 visitors.some(function (v) { return Math.hypot(v.x - mx, v.y - my) < 1.6; });
        var tg = dn ? 1 : 0, cur = doorOpen[k] || 0;
        cur += (tg - cur) * Math.min(1, dt * 9);
        if (Math.abs(cur - tg) < 0.002) cur = tg;
        doorOpen[k] = cur;
      });
    }

    function isNearDoor(x, y) {
      return Math.hypot(x - DOOR_MID, y - (ROOM - 0.5)) < 2.0;
    }

    // Processing-station rings drawn on the floor behind the desk — one per line
    // that has someone waiting, on that line's side.
    function drawDeskCircles() {
      if (!hasDesk()) return;
      var d = deskAnchor(), f = FRONT[d.rot || 0], tiles = deskLineTiles(d);
      for (var L = 0; L < 2; L++) {
        if (!queue[L].some(function (v) { return v.phase === 'queuing'; })) continue;
        var s = iso(tiles[L].x - f.x, tiles[L].y - f.y);   // one tile behind the desk
        var on = vetAtStation(L);          // vet standing on this station's circle
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, TILE_HW * 0.6, TILE_HH * 0.6, 0, 0, Math.PI * 2);
        ctx.fillStyle = on ? 'rgba(80,210,130,0.32)' : 'rgba(60,190,165,0.20)'; ctx.fill();
        ctx.lineWidth = on ? 4 : 3;
        ctx.strokeStyle = on ? 'rgba(70,205,120,1)' : 'rgba(55,179,163,0.95)'; ctx.stroke();
        ctx.restore();
      }
    }

    // Puddles left by clients who couldn't hold it, with a clean-up progress bar.
    function drawPuddles() {
      puddles.forEach(function (p) {
        var s = iso(p.x, p.y);
        if (p.kind === 'litter') {           // crumpled litter: paper scrap + a food bit
          ctx.fillStyle = 'rgba(20,40,30,0.16)';
          ctx.beginPath(); ctx.ellipse(s.x, s.y + 4, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#e2e6dd';
          ctx.beginPath();
          ctx.moveTo(s.x - 6, s.y + 2); ctx.lineTo(s.x - 1, s.y - 4); ctx.lineTo(s.x + 5, s.y - 1);
          ctx.lineTo(s.x + 6, s.y + 4); ctx.lineTo(s.x, s.y + 5); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = 'rgba(120,130,120,0.6)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(s.x - 2, s.y - 2); ctx.lineTo(s.x + 2, s.y + 2);
          ctx.moveTo(s.x + 3, s.y - 1); ctx.lineTo(s.x - 1, s.y + 3); ctx.stroke();
          ctx.fillStyle = '#d9a23c';
          ctx.beginPath(); ctx.ellipse(s.x + 4, s.y + 3, 2.4, 1.3, 0.5, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(226,206,74,0.55)';
          ctx.beginPath(); ctx.ellipse(s.x, s.y + 3, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(202,178,40,0.5)';
          ctx.beginPath(); ctx.ellipse(s.x + 3, s.y + 4, 4, 2, 0, 0, Math.PI * 2); ctx.fill();
        }
      });
    }

    // Clean-up bars float above whoever is mopping (drawn over the actors).
    function drawCleanBars() {
      puddles.forEach(function (p) {
        if (!(p.clean > 0)) return;
        var s = iso(p.x, p.y), bw = 22, bx = s.x - bw / 2, by = s.y - 60;
        ctx.fillStyle = 'rgba(15,20,30,0.6)'; roundRect(ctx, bx - 1.5, by - 1.5, bw + 3, 6, 3); ctx.fill();
        ctx.fillStyle = '#5ad17a'; roundRect(ctx, bx, by, bw * Math.min(1, p.clean / messGoal(p)), 3, 2); ctx.fill();
      });
    }

    // Floating "+10" coin pop-ups above served clients.
    function drawFloaters() {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '800 16px Nunito, sans-serif';
      floaters.forEach(function (fl) {
        if (!fl.v) return;
        var s = iso(fl.v.x, fl.v.y), y = s.y - 48 - fl.t * 34, txt = '+' + (fl.amt || 10);
        ctx.globalAlpha = Math.max(0, 1 - fl.t / 1.2);
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(20,30,20,0.55)';
        ctx.strokeText(txt, s.x, y);
        ctx.fillStyle = '#ffd24a';
        ctx.fillText(txt, s.x, y);
      });
      ctx.restore();
    }

    // ---- Render -----------------------------------------------------------
    function draw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(bg, 0, 0);

      // ONE painter's pass over everything on the floor — walls, doors, furniture,
      // characters — sorted by foot depth (gx+gy). The lower an object's foot, the
      // nearer it is, so it paints last/on top. This replaces the old bg/fg raster
      // split + inside/outside buckets, which couldn't interleave walls with items.
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

      // floor decals first, under everyone
      drawPuddles();                        // accidents on the floor
      examRooms.forEach(function (rm) {     // exam circles
        var k = examKeyTiles(rm.gx, rm.gy, rm.rot);
        drawExamCircle(ctx, k.circle.x, k.circle.y, vetAtExam(rm) || roomVetWorking(rm));
      });
      xrayRooms.forEach(function (rm) {     // X-ray operator circles
        var k = examKeyTiles(rm.gx, rm.gy, rm.rot);
        drawExamCircle(ctx, k.circle.x, k.circle.y, vetAtXray(rm) || roomVetWorking(rm));
      });
      pharmacies.forEach(function (ph) {    // pharmacy counter circles
        pharmStations(ph.gx, ph.gy, ph.rot).forEach(function (sec, idx) {
          drawExamCircle(ctx, sec.circle.x, sec.circle.y, playerAtPharm(ph, idx) || ph.stations[idx].pharm);
        });
      });

      var scene = wallSegs.slice();         // walls + doors + decorations + entrance frame
      if (!placing) {                       // animated doors share their opening's depth
        scene.push({ d: DOOR_MID + (ROOM - 0.5), fn: function () { drawSlidingDoors(ctx, door.open); } });
        doorways.forEach(function (dr) {    // animated doors at corridor↔room junctions
          var dop = doorOpen[dr.ax + ',' + dr.ay + ',' + dr.bx + ',' + dr.by] || 0;
          scene.push({ d: (dr.ax + dr.ay + dr.bx + dr.by) / 2, fn: function () {
            if (dr.style === 'brown') drawBrownDoor(ctx, dr, dop);   // hinged wooden room door
            else drawDoorwayPanels(ctx, dr, dop);                    // glass sliding corridor door
          } });
        });
      }
      scene.push({ d: vet.x + vet.y, who: 'player', fn: drawVet });
      placed.forEach(function (f) {
        var def = FURN_BY_ID[f.id];
        var ew = ((f.rot || 0) & 1) ? def.h : def.w, eh = ((f.rot || 0) & 1) ? def.w : def.h;
        var cx = f.gx + (ew - 1) / 2, cy = f.gy + (eh - 1) / 2;
        scene.push({ d: cx + cy, fn: function () { def.draw(ctx, f.gx, f.gy, f.rot || 0); } });
      });
      visitors.forEach(function (v) {
        // seated visitors get a depth nudge so they draw in front of their own
        // seating furniture (a 2x1 bench's centre sits between its two tiles).
        scene.push({ d: v.x + v.y + (v.seated ? 0.6 : 0), who: 'visitor', fn: function () { drawVisitor(v); } });
      });
      if (hasDesk()) staff.forEach(function (st) {       // receptionists at their stations
        var L = (staff.length === 1) ? loneStaffLine() : st.line;   // lone one stands at the queue it's serving
        var p = stationTile(L);
        scene.push({ d: p.x + p.y, who: 'receptionist', fn: function () { drawReceptionist(ctx, p.x, p.y); } });
      });
      restrooms.forEach(function (rm) {                  // toilet fixture inside the walled room
        var tl = rm.toilet;
        scene.push({ d: tl.x + tl.y, fn: function () { drawToilet(ctx, tl.x, tl.y, rm.face); } });
      });
      examRooms.forEach(function (rm) {                  // exam-room furniture
        var k = examKeyTiles(rm.gx, rm.gy, rm.rot);
        var pet = (rm.occupant && rm.occupant.phase === 'inExam') ? rm.occupant : null;
        scene.push({ d: k.table.x + k.table.y, fn: function () { drawExamTable(ctx, k.table.x, k.table.y, pet); } });
      });
      xrayRooms.forEach(function (rm) {                  // X-ray-room furniture
        var k = examKeyTiles(rm.gx, rm.gy, rm.rot);
        scene.push({ d: k.desk.x + k.desk.y, fn: function () { drawExamDesk(ctx, k.desk.x, k.desk.y, rm.rot); } });
        var xpet = (rm.occupant && rm.occupant.phase === 'inXray') ? rm.occupant : null;
        scene.push({ d: k.table.x + k.table.y, fn: function () { drawXrayMachine(ctx, k.table.x, k.table.y, xpet); } });
      });
      vets.forEach(function (vt) {                       // roaming hired vets
        scene.push({ d: vt.x + vt.y, who: 'vet', fn: function () { drawVetStaff(ctx, vt.x, vt.y, vt.room ? (vt.room.rot || 0) : 0, vt.moving ? vt.dir : null); } });
      });
      cleaners.forEach(function (cl) {                   // roaming cleaners
        scene.push({ d: cl.x + cl.y, who: 'cleaner', fn: function () { drawCleaner(ctx, cl.x, cl.y); } });
      });
      pharmacies.forEach(function (ph) {                 // pharmacy counters + hired pharmacists
        pharmStations(ph.gx, ph.gy, ph.rot).forEach(function (sec, idx) {
          scene.push({ d: sec.counter.x + sec.counter.y, fn: function () { drawPharmCounter(ctx, sec.counter.x, sec.counter.y); } });
          if (ph.stations[idx].pharm) scene.push({ d: sec.circle.x + sec.circle.y, who: 'pharmacist', fn: function () { drawReceptionist(ctx, sec.circle.x, sec.circle.y); } });
        });
      });

      scene.sort(function (a, b) { return a.d - b.d; });
      scene.forEach(function (a) {
        // Hovering a Staff card dims every person except staff of that type.
        var dim = hoverStaff && a.who && a.who !== hoverStaff;
        if (dim) ctx.globalAlpha = 0.2;
        a.fn();
        if (dim) ctx.globalAlpha = 1;
      });

      drawDeskCircles();                    // station rings, drawn on top of the desk counter
      drawGhost();                          // placement preview floats on top
      drawCleanBars();                      // mop-up progress, above whoever's cleaning
      drawFloaters();                       // +10 coin pops on top of everyone

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // gentle vignette for focus
      ctx.fillStyle = gradR(ctx, canvas.width / 2, canvas.height / 2,
        Math.min(canvas.width, canvas.height) * 0.35, canvas.width / 2, canvas.height / 2,
        Math.max(canvas.width, canvas.height) * 0.72, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.22)']]);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    var last = 0;
    function frame(ts) {
      if (!last) last = ts;
      var dt = Math.min((ts - last) / 1000, 0.05);
      last = ts;
      update(dt);
      if (staticDirty) { staticDirty = false; renderStatic(); }   // one coalesced static redraw per frame
      draw();
      requestAnimationFrame(frame);
    }

    // ---- Input: keyboard --------------------------------------------------
    var KEYMAP = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right'
    };
    // Don't steal keystrokes for movement while the player is typing in a field
    // (e.g. naming their hospital) — let w/a/s/d type normally.
    function typingInField(e) {
      var t = e.target;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    }
    window.addEventListener('keydown', function (e) {
      if (typingInField(e)) return;
      var k = KEYMAP[e.key]; if (k) { input[k] = true; e.preventDefault(); }
    });
    window.addEventListener('keyup', function (e) {
      if (typingInField(e)) return;
      var k = KEYMAP[e.key]; if (k) { input[k] = false; e.preventDefault(); }
    });

    // ---- Input: drag-anywhere virtual joystick ----------------------------
    var origin = null;
    var panning = null;                      // mouse drag-to-pan: {x,y,camX,camY}
    var lastTap = { t: -1e9, x: 0, y: 0 };   // for double-click/tap pick-up
    function getPoint(e) { var t = e.touches ? e.touches[0] : e; return { x: t.clientX, y: t.clientY }; }
    function setPointer(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      var g = screenToGrid(clientX - rect.left, clientY - rect.top);
      pointer.gx = Math.round(g.gx); pointer.gy = Math.round(g.gy); pointer.on = true;
    }
    function dragStart(e) {
      if (placing && (placing.item.kind === 'corridor' || placing.item.kind === 'blank')) {  // corridor/blank brush: drag
        var cp = getPoint(e); setPointer(cp.x, cp.y);
        corridorDrag = { sx: pointer.gx, sy: pointer.gy };
        e.preventDefault(); return;
      }
      if (placing) {                       // build mode: position the ghost (and, for a
        var pp = getPoint(e); setPointer(pp.x, pp.y);  // mouse click, drop it right away;
        if (!e.touches) tryPlace();        // touch positions now and drops on lift)
        e.preventDefault(); return;
      }
      // double-click / double-tap on a placed item picks it up to reposition
      var tp = getPoint(e);
      if (e.timeStamp - lastTap.t < 350 && Math.abs(tp.x - lastTap.x) < 24 && Math.abs(tp.y - lastTap.y) < 24) {
        lastTap.t = -1e9;
        setPointer(tp.x, tp.y); pickUpAt(pointer.gx, pointer.gy);
        if (placing) { e.preventDefault(); return; }   // picked something up → now in move mode
      } else {
        lastTap = { t: e.timeStamp, x: tp.x, y: tp.y };
      }
      if (!e.touches) {                    // mouse: drag the background to pan the view
        panning = { x: tp.x, y: tp.y, camX: camera.x, camY: camera.y };
        canvas.style.cursor = 'grabbing';
      } else {                             // touch: drag-anywhere virtual joystick moves the player
        origin = getPoint(e); touchInput.active = true; touchInput.dx = 0; touchInput.dy = 0;
      }
      e.preventDefault();
    }
    function dragMove(e) {
      if (panning) {                        // pan the camera; defer the heavy static redraw to the frame loop
        var mp = getPoint(e);
        camera.x = panning.camX + (mp.x - panning.x);
        camera.y = panning.camY + (mp.y - panning.y);
        staticDirty = true;
        e.preventDefault(); return;
      }
      if (placing && (placing.item.kind === 'corridor' || placing.item.kind === 'blank')) {
        if (corridorDrag) { var cp = getPoint(e); setPointer(cp.x, cp.y); }
        e.preventDefault(); return;
      }
      if (placing) { var pp = getPoint(e); setPointer(pp.x, pp.y); e.preventDefault(); return; }
      if (!touchInput.active || !origin) return;
      var p = getPoint(e);
      var sx = p.x - origin.x, sy = p.y - origin.y;
      // screen drag → grid axes
      var gx = (sx / TILE_HW + sy / TILE_HH) / 2;
      var gy = (sy / TILE_HH - sx / TILE_HW) / 2;
      var len = Math.hypot(gx, gy);
      if (len < 0.12) { touchInput.dx = 0; touchInput.dy = 0; }
      else { var mag = Math.min(len / 1.2, 1); touchInput.dx = gx / len * mag; touchInput.dy = gy / len * mag; }
      e.preventDefault();
    }
    function dragEnd(e) {
      if (panning) { panning = null; canvas.style.cursor = ''; staticDirty = true; if (e && e.preventDefault) e.preventDefault(); return; }   // walls back on (next frame)
      if (placing && (placing.item.kind === 'corridor' || placing.item.kind === 'blank')) {
        if (corridorDrag) {
          if (placing.item.kind === 'blank') commitBlank(corridorDrag.sx, corridorDrag.sy, pointer.gx, pointer.gy);
          else commitCorridor(corridorDrag.sx, corridorDrag.sy, pointer.gx, pointer.gy);
          corridorDrag = null;
        }
        if (e && e.preventDefault) e.preventDefault(); return;
      }
      if (placing) { if (e && e.changedTouches) tryPlace(); if (e && e.preventDefault) e.preventDefault(); return; }
      touchInput.active = false; touchInput.dx = 0; touchInput.dy = 0; origin = null; if (e && e.preventDefault) e.preventDefault();
    }
    canvas.addEventListener('touchstart', dragStart, { passive: false });
    canvas.addEventListener('touchmove', dragMove, { passive: false });
    canvas.addEventListener('touchend', dragEnd, { passive: false });
    canvas.addEventListener('touchcancel', dragEnd, { passive: false });
    canvas.addEventListener('mousedown', dragStart);
    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragEnd);

    // Hover (mouse) tracks the tile under the cursor for the placement ghost.
    window.addEventListener('mousemove', function (e) {
      if (e.target.closest && e.target.closest('#shopbar')) { pointer.on = false; return; }
      setPointer(e.clientX, e.clientY);
    });
    // Esc / right-click cancels an in-progress placement.
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && placing) cancelPlacing(); });
    window.addEventListener('contextmenu', function (e) { if (placing) { e.preventDefault(); cancelPlacing(); } });
    // Mouse wheel rotates the item being placed by 90°.
    window.addEventListener('wheel', function (e) {
      if (!placing) return;
      placing.rot = (placing.rot + (e.deltaY > 0 ? 1 : 3)) % 4;
      e.preventDefault();
    }, { passive: false });

    // ---- Save / Load (local named hospitals) -----------------------------
    // A save captures only the persistent layout + economy; transient visitor /
    // progress state is reset on load so the clinic resumes with fresh arrivals.
    var LS_SAVES = 'grindyvet.saves', LS_CURRENT = 'grindyvet.current';
    var currentName = (function () { try { return localStorage.getItem(LS_CURRENT) || ''; } catch (e) { return ''; } })();
    var AUTOSAVE_NAME = 'Autosave', AUTOSAVE_PERIOD = 60;  // autosave: slot name + seconds between writes
    var autoSaveTimer = 0;

    function lsAvailable() {
      try { var k = '__gv__'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; }
      catch (e) { return false; }
    }
    function readAll() { try { return JSON.parse(localStorage.getItem(LS_SAVES) || '{}') || {}; } catch (e) { return {}; } }
    function writeAll(map) { try { localStorage.setItem(LS_SAVES, JSON.stringify(map)); return true; } catch (e) { return false; } }
    function listSaves() {
      var m = readAll(), out = [];
      for (var n in m) if (m.hasOwnProperty(n)) out.push(m[n]);
      out.sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
      return out;
    }
    function readSave(name) { return readAll()[name] || null; }
    function deleteSave(name) { var m = readAll(); delete m[name]; writeAll(m); }
    function writeSave(name) {
      var m = readAll(); m[name] = buildSave(name);
      if (!writeAll(m)) return false;
      currentName = name;
      try { localStorage.setItem(LS_CURRENT, name); } catch (e) {}
      return true;
    }

    // Snapshot of persistent state only (transient fields excluded by construction).
    function buildSave(name) {
      return {
        v: 1, name: name, savedAt: Date.now(), money: money,
        skills: {
          speed:      { val: skills.speed.val,      cost: skills.speed.cost },
          processing: { val: skills.processing.val, cost: skills.processing.cost }
        },
        placed: (placed || []).map(function (p) { return { id: p.id, gx: p.gx, gy: p.gy, rot: p.rot || 0 }; }),
        corridor: Object.keys(corridor || {}),
        examRooms:  (examRooms || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0 }; }),
        xrayRooms:  (xrayRooms || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0, vet: !!r.vet }; }),
        restrooms:  (restrooms || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0 }; }),
        pharmacies: (pharmacies || []).map(function (r) {
          return { gx: r.gx, gy: r.gy, rot: r.rot || 0,
                   stations: (r.stations || []).map(function (s) { return { pharm: !!s.pharm }; }) };
        }),
        staff: (staff || []).map(function (s) { return { type: s.type, line: s.line }; }),
        vets:  (vets || []).map(function (v) { return { x: v.x, y: v.y, speed: v.speed }; }),
        cleaners: (cleaners || []).map(function (c) { return { x: c.x, y: c.y, speed: c.speed }; }),
        frq: frq
      };
    }

    // Wipe in-flight visitors / progress so a load (or new game) starts clean.
    function resetTransient() {
      visitors.length = 0;
      queue.forEach(function (q) { q.length = 0; });
      floaters.length = 0;
      puddles.length = 0;
      doorways.length = 0;
      spawnTimer = 0; visitorSeq = 0; examTicketSeq = 0; animT = 0;
      door.open = 0;
      for (var k in doorOpen) delete doorOpen[k];
      examRooms.forEach(function (r) { r.occupant = null; r.examT = 0; });
      xrayRooms.forEach(function (r) { r.occupant = null; r.xrayT = 0; });
      restrooms.forEach(function (r) { r.occupant = null; });
      pharmacies.forEach(function (p) { (p.stations || []).forEach(function (s) { s.patient = null; s.procT = 0; }); });
      vets.forEach(function (v) { v.room = null; v.working = false; v.moving = false; v.path = null; v.wp = 0; });
      cleaners.forEach(function (c) { c.target = null; c.moving = false; c.path = null; c.wp = 0; });
      placing = null; corridorDrag = null;
      try { document.body.classList.remove('placing'); } catch (e) {}
      vet.x = ROOM / 2 - 0.5; vet.y = ROOM / 2 - 0.5; vet.dir = 'SE'; vet.moving = false; vet.walkPhase = 0;
    }

    // Reset everything to a fresh, empty clinic.
    function newGame() {
      resetTransient();
      placed.length = 0; examRooms.length = 0; xrayRooms.length = 0;
      restrooms.length = 0; pharmacies.length = 0; staff.length = 0; vets.length = 0; cleaners.length = 0;
      for (var k in corridor) delete corridor[k];
      for (var k2 in occupied) delete occupied[k2];
      money = 1000;
      skills.speed.val = 1.0; skills.speed.cost = 10;
      skills.processing.val = 1.0; skills.processing.cost = 10;
      frq = 30; spawnTimer = 0; autoSaveTimer = 0;
      currentName = '';
      try { localStorage.removeItem(LS_CURRENT); } catch (e) {}
      renderStatic(); renderMoney(); updateHospitalLabel();
    }

    // Rebuild the clinic from a save snapshot. Order matters: corridor before the
    // room place-functions (their door-finders scan the corridor map), occupied
    // cleared before furniture/rooms repopulate it.
    function applySave(data) {
      if (!data || data.v !== 1) return false;
      resetTransient();
      placed.length = 0; examRooms.length = 0; xrayRooms.length = 0;
      restrooms.length = 0; pharmacies.length = 0; staff.length = 0; vets.length = 0; cleaners.length = 0;
      for (var k in corridor) delete corridor[k];
      for (var k2 in occupied) delete occupied[k2];

      money = (typeof data.money === 'number') ? data.money : 1000;
      if (data.skills) {
        skills.speed.val = data.skills.speed.val; skills.speed.cost = data.skills.speed.cost;
        skills.processing.val = data.skills.processing.val; skills.processing.cost = data.skills.processing.cost;
      }
      frq = (typeof data.frq === 'number') ? data.frq : 30;

      (data.corridor || []).forEach(function (key) { corridor[key] = true; });
      (data.placed || []).forEach(function (p) {
        placed.push({ id: p.id, gx: p.gx, gy: p.gy, rot: p.rot || 0 });
        var def = FURN_BY_ID[p.id];
        if (def) footprintTiles(def, p.gx, p.gy, p.rot || 0).forEach(function (t) { occupied[t.x + ',' + t.y] = true; });
      });
      _suspendStatic = true;                    // bake once after all rooms (below), not per room
      if (typeof placeExam === 'function')     (data.examRooms || []).forEach(function (r) { placeExam(r.gx, r.gy, r.rot || 0); });
      if (typeof placeXray === 'function')     (data.xrayRooms || []).forEach(function (r) { placeXray(r.gx, r.gy, r.rot || 0); });
      if (typeof placeRestroom === 'function') (data.restrooms || []).forEach(function (r) { placeRestroom(r.gx, r.gy, r.rot || 0); });
      if (typeof placePharmacy === 'function') (data.pharmacies || []).forEach(function (r) { placePharmacy(r.gx, r.gy, r.rot || 0); });
      _suspendStatic = false;
      // per-room persistent extras, by index (push order matches save order)
      (data.xrayRooms || []).forEach(function (r, i) { if (xrayRooms[i]) xrayRooms[i].vet = !!r.vet; });
      (data.pharmacies || []).forEach(function (r, i) {
        if (pharmacies[i]) (r.stations || []).forEach(function (s, j) {
          if (pharmacies[i].stations[j]) pharmacies[i].stations[j].pharm = !!s.pharm;
        });
      });
      (data.staff || []).forEach(function (s) { staff.push({ type: s.type, line: s.line }); });
      (data.vets || []).forEach(function (v) {
        vets.push({ x: v.x, y: v.y, room: null, working: false, speed: v.speed || 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0 });
      });
      (data.cleaners || []).forEach(function (c) {
        cleaners.push({ x: c.x, y: c.y, speed: c.speed || 2.3, dir: 'SE', walkPhase: 0, moving: false, target: null, path: null, wp: 0 });
      });

      resetTransient();                       // clear anything the place-fns seeded
      renderStatic(); renderMoney();
      currentName = data.name || '';
      autoSaveTimer = 0;                       // fresh minute from the moment of load
      try { localStorage.setItem(LS_CURRENT, currentName); } catch (e) {}
      updateHospitalLabel();
      return true;
    }

    // ---- Save / Load UI --------------------------------------------------
    var hospEl = document.getElementById('hospName');
    var saveModal = document.getElementById('saveModal');
    var saveListEl = document.getElementById('saveList');
    var saveNameEl = document.getElementById('saveName');

    function updateHospitalLabel() {
      if (!hospEl) return;
      hospEl.textContent = currentName ? '🏥 ' + currentName : '';
      hospEl.style.display = currentName ? '' : 'none';
    }
    function openSaveModal() {
      if (placing) cancelPlacing();
      input.up = input.down = input.left = input.right = false;   // no stuck movement while typing
      saveNameEl.value = currentName || '';
      renderSaveList();
      saveModal.hidden = false;
      try { saveNameEl.focus(); } catch (e) {}
    }
    function closeSaveModal() { saveModal.hidden = true; }
    function renderSaveList() {
      saveListEl.innerHTML = '';
      if (!lsAvailable()) { saveListEl.innerHTML = '<div class="modal-empty">Saving is unavailable (storage blocked).</div>'; return; }
      var saves = listSaves();
      if (!saves.length) { saveListEl.innerHTML = '<div class="modal-empty">No saved hospitals yet.</div>'; return; }
      saves.forEach(function (s) {
        var rooms = (s.examRooms || []).length + (s.xrayRooms || []).length + (s.pharmacies || []).length + (s.restrooms || []).length;
        var when = '';
        try { when = new Date(s.savedAt || 0).toLocaleDateString(); } catch (e) {}
        var row = document.createElement('div');
        row.className = 'save-row' + (s.name === currentName ? ' current' : '');
        row.innerHTML = '<div class="save-meta"><div class="nm"></div><div class="sub">$' + (s.money || 0) + ' · ' + rooms + (rooms === 1 ? ' room · ' : ' rooms · ') + when + '</div></div>' +
                        '<button class="save-load">Load</button><button class="save-del">Delete</button>';
        row.querySelector('.nm').textContent = s.name;
        row.querySelector('.save-load').addEventListener('click', function () { applySave(readSave(s.name)); closeSaveModal(); });
        row.querySelector('.save-del').addEventListener('click', function () {
          if (confirm('Delete "' + s.name + '"? This cannot be undone.')) { deleteSave(s.name); renderSaveList(); }
        });
        saveListEl.appendChild(row);
      });
    }
    document.getElementById('savesBtn').addEventListener('click', openSaveModal);
    document.getElementById('saveClose').addEventListener('click', closeSaveModal);
    saveModal.addEventListener('click', function (e) { if (e.target === saveModal) closeSaveModal(); });
    document.getElementById('saveBtn').addEventListener('click', function () {
      var name = (saveNameEl.value || '').trim();
      if (!name) { try { saveNameEl.focus(); } catch (e) {} return; }
      if (!lsAvailable() || !writeSave(name)) { alert('Could not save — storage is full or blocked.'); return; }
      updateHospitalLabel(); renderSaveList();
    });
    saveNameEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('saveBtn').click(); });
    document.getElementById('newGameBtn').addEventListener('click', function () {
      if (confirm('Start a new game? Unsaved progress in the current hospital will be lost.')) { newGame(); closeSaveModal(); }
    });

    // ---- Boot -------------------------------------------------------------
    window.addEventListener('resize', resize);
    resize();
    renderMoney();                          // paint money + shop cards
    requestAnimationFrame(frame);
    // Auto-resume the most recent hospital (prefer the last active name); the
    // Saves panel lets the player pick another save or start a new game.
    (function () {
      updateHospitalLabel();
      var data = currentName ? readSave(currentName) : null;
      if (!data) { var all = listSaves(); if (all.length) data = all[0]; }
      if (data) applySave(data);
    })();
    // ---- Test harness ----------------------------------------------------
    // window.__t is the headless test/debug API. It drives the sim without the
    // UI so deterministic parity runs can build clinics, hire staff, spawn and
    // step visitors, and read state. Freeze the loop (override
    // requestAnimationFrame) + seed Math.random for reproducible runs; t.load()
    // resets to a clean clinic. Key entries:
    //   step(n), spawn(), draw()              — drive / render
    //   money(), frq(), visitors(), emojis()  — read state
    //   exams()/xrays()/pharms()/restroomList(), corridors()
    //   place(id,gx,gy,r), buildCorridor, buildBlank, buildRestroom
    //   placeExam/placeXray/placePharm + can{Exam,Xray,Pharm,Restroom}
    //   hireReceptionist(line)/hireVet()/hirePharmacists()/hireCleaner()
    //   save(name)/load(data)                 — round-trip the save schema
    window.__t = {
      draw: draw,
      step: function (n) { for (var i = 0; i < (n || 1); i++) update(1 / 30); },
      money: function () { return money; },
      frq: function () { return frq; },
      spawn: spawnVisitor,
      place: function (id, gx, gy, r) { placed.push({ id: id, gx: gx, gy: gy, rot: r || 0 }); footprintTiles(FURN_BY_ID[id], gx, gy, r || 0).forEach(function (t) { occupied[t.x + ',' + t.y] = true; }); },
      placeDesk: function (gx, gy, r) { window.__t.place('desk', gx, gy, r); },
      placeChair: function (gx, gy, r) { window.__t.place('chair', gx, gy, r); },
      vet: function (x, y) { if (x != null) { vet.x = x; vet.y = y; } return { x: vet.x, y: vet.y }; },
      visitors: function () { return visitors.map(function (v) { return { phase: v.phase, seated: !!v.seated, pet: v.pet, patience: Math.round(v.patience * 10) / 10, x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, chair: v.chair || null }; }); },
      buildCorridor: function (sx, sy, ex, ey) { commitCorridor(sx, sy, ex, ey); return Object.keys(corridor); },
      buildBlank: function (sx, sy, ex, ey) { commitBlank(sx, sy, ex, ey); return Object.keys(openRoom); },
      canExam: function (gx, gy) { return canPlaceExam(gx, gy); },
      canXray: function (gx, gy) { return canPlaceXray(gx, gy); },
      canPharm: function (gx, gy) { return canPlacePharmacy(gx, gy); },
      canRestroom: function (gx, gy, rot) { return canPlaceRestroom(gx, gy, rot || 0); },
      placeExam: function (gx, gy, rot) { placeExam(gx, gy, rot); return examKeyTiles(gx, gy, rot || 0); },
      placeXray: function (gx, gy, rot) { placeXray(gx, gy, rot); return examKeyTiles(gx, gy, rot || 0); },
      exams: function () { return examRooms.map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot, occupied: !!r.occupant, vet: !!r.vet, examT: Math.round((r.examT||0)*10)/10 }; }); },
      xrays: function () { return xrayRooms.map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot, occupied: !!r.occupant, vet: !!r.vet }; }); },
      pharms: function () { return pharmacies.map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot, stations: r.stations.map(function (s) { return { pharm: !!s.pharm, busy: !!s.patient }; }) }; }); },
      placePharm: function (gx, gy, rot) { if (!canPlacePharmacy(gx, gy)) return false; placePharmacy(gx, gy, rot || 0); return pharmacies[pharmacies.length - 1]; },
      save: function (name) { return buildSave(name || 'test'); },
      load: function (d) { return applySave(d); },
      corridors: function () { return Object.keys(corridor); },
      setInput: function (k, v) { input[k] = v; },
      can: function (id, gx, gy, rot) { return canPlace(FURN_BY_ID[id], gx, gy, rot || 0); },
      buildRestroom: function (gx, gy, rot) { if (!canPlaceRestroom(gx, gy, rot || 0)) return false; placeRestroom(gx, gy, rot || 0); return restrooms[restrooms.length - 1]; },
      restroomList: function () { return restrooms.map(function (r) { return { gx: r.gx, gy: r.gy, toilet: r.toilet, stand: r.stand, door: r.door, occ: !!r.occupant }; }); },
      emojis: function () { return visitors.map(function (v) { return { phase: v.phase, served: !!v.served, examined: !!v.examined, happy: !!v.happy, emoji: visitorEmoji(v) }; }); },
      hireReceptionist: function (line) { staff.push({ type: 'receptionist', line: line || 0 }); return staff.length; },
      hireVet: function () { vets.push({ x: ROOM / 2 - 0.5, y: ROOM - 1.5, room: null, working: false, speed: 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0 }); return vets.length; },
      hirePharmacists: function () { pharmacies.forEach(function (ph) { ph.stations.forEach(function (s) { s.pharm = true; }); }); return pharmacies.length; },
      hireCleaner: function () { cleaners.push({ x: ROOM / 2 - 0.5, y: ROOM - 1.5, speed: 2.3, dir: 'SE', walkPhase: 0, moving: false, target: null, path: null, wp: 0 }); return cleaners.length; },
      overlaps: function () { var occ = {}, n = 0; visitors.forEach(function (v) { if (v.moving) return; var k = Math.round(v.x) + ',' + Math.round(v.y); if (occ[k]) n++; occ[k] = 1; }); return n; },
      overlapInfo: function () { var occ = {}, hits = []; visitors.forEach(function (v) { if (v.moving) return; var k = Math.round(v.x) + ',' + Math.round(v.y); if (occ[k]) hits.push({ tile: k, a: occ[k], b: v.phase }); else occ[k] = v.phase; }); return hits; },
      qat: function (x, y) { return visitors.filter(function (v) { return Math.round(v.x) === x && Math.round(v.y) === y; }).map(function (v) { return { ph: v.phase, line: v.line, idx: (v.line != null && queue[v.line]) ? queue[v.line].indexOf(v) : '-', slot: v.phase === 'queuing' ? slotPos(v) : null, mv: !!v.moving }; }); }
    };
