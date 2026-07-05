(function () {
    'use strict';

    // NOTE: loaded as a CLASSIC script (not type=module) so the game still works
    // when opened directly from disk via file:// — browsers block ES-module
    // loading over file://. Constants + pure helpers are inlined here rather than
    // imported for the same reason.

    // ---- Isometric world + layout constants ------------------------------
    var TILE_W = 64, TILE_H = 32;          // 2:1 isometric tile footprint
    var TILE_HW = TILE_W / 2, TILE_HH = TILE_H / 2;
    var WALL_H = 62;                       // tall back walls
    var FRONT_WALL_H = 30;                 // short front walls (see over them)
    var ROOM = 8;                          // floor grid is ROOM x ROOM
    var DOOR_A = 2.5, DOOR_B = 4.5, DOOR_MID = 3.5;   // sliding entry doors (tiles 3-4)
    var DOOR_H = WALL_H;                    // doors rise to full ceiling height
    var BASE_SPEED = 3.3;                   // player's base movement (Speed skill adds to it)
    var FRONT = [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }];  // customer-facing dir per rotation

    // ---- Pure helpers ----------------------------------------------------
    function isoRaw(gx, gy) { return { x: (gx - gy) * TILE_HW, y: (gx + gy) * TILE_HH }; }
    function hash(x, y) {                   // deterministic 0..1 (stable texture on resize)
      var n = (x | 0) * 374761393 + (y | 0) * 668265263;
      n = (n ^ (n >> 13)) * 1274126177;
      return ((n ^ (n >> 16)) >>> 0) / 4294967295;
    }
    function diamondPath(c, cx, cy) {       // trace one tile's diamond at screen (cx,cy)
      c.beginPath();
      c.moveTo(cx, cy - TILE_HH);
      c.lineTo(cx + TILE_HW, cy);
      c.lineTo(cx, cy + TILE_HH);
      c.lineTo(cx - TILE_HW, cy);
      c.closePath();
    }
    function shade(hex, f) {                 // multiply #rrggbb by f -> 'rgb(...)'
      var n = parseInt(hex.slice(1), 16);
      var r = Math.min(255, ((n >> 16) & 255) * f) | 0;
      var g = Math.min(255, ((n >> 8) & 255) * f) | 0;
      var b = Math.min(255, (n & 255) * f) | 0;
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }
    function chooseDir(mx, my) {             // movement vector -> isometric facing
      if (Math.abs(mx) > Math.abs(my)) return mx > 0 ? 'SE' : 'NW';
      return my > 0 ? 'SW' : 'NE';
    }

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
    // D() in collectWalls() registers its opening in `doorways` (rebuilt by
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
    // ---- Difficulty ------------------------------------------------------
    // One row per mode. Easy == the original game (untouched). Higher modes start
    // poorer + lower-rated, give clients less patience, and tune the rating engine
    // harder: `up` is how much a happy client speeds arrivals (rating up), `down` is
    // how much an unhappy one slows them (rating down). So on Hard each lost client
    // really stings, forcing the player to build a solid clinic before opening up.
    // money/frq/wait below are just the *starting* values; rating climbs from play.
    var DIFFICULTY = {
      easy:   { label: 'Easy',   money: 1000, frq: 30, wait: 50, up: 1.0, down: 1.5 },
      medium: { label: 'Medium', money: 600,  frq: 45, wait: 42, up: 0.7, down: 2.5 },
      hard:   { label: 'Hard',   money: 300,  frq: 60, wait: 34, up: 0.5, down: 4.0 }
    };
    var difficulty = 'easy';               // current mode (persisted per save; legacy saves → easy)
    function diff() { return DIFFICULTY[difficulty] || DIFFICULTY.easy; }
    // ---- Visitor journey balance ----------------------------------------
    // Every visitor checks in at reception, then rolls ONE primary intent with
    // these FIXED weights — deliberately NOT gated on whether the facility is
    // built or free: a client whose service is missing/full waits, drains
    // patience, and leaves UNHAPPY, pressuring the player to build it out.
    // Must sum to 1; rollIntent walks it in insertion order.
    var INTENT_WEIGHTS = { exam: 0.55, pharm: 0.13, park: 0.12, shop: 0.10, groom: 0.10 };
    // Follow-up chances chained after a completed service (same not-gated rule).
    var FOLLOWUP = { examXray: 0.20, examMeds: 0.30, examGroom: 0.08, xrayMeds: 0.40, surgMeds: 0.50, parkGroom: 0.30, parkMeds: 0.20 };
    function rollIntent() {
      var r = Math.random(), acc = 0;
      for (var k in INTENT_WEIGHTS) { acc += INTENT_WEIGHTS[k]; if (r < acc) return k; }
      return 'exam';
    }
    var ROOM_DIRTY_USES = 3;               // an operating room (exam/X-ray) grimes up after this many procedures
    var ROOM_GRIME_TIME = 45;              // a non-operating room (shop/pharmacy) grimes up after ~this many seconds of use
    var ROOM_CLEAN_TIME = 20;              // seconds to scrub a dirty room clean (at Cleaning skill 1.0)
    var spawnTimer = 0;                    // first visitor arrives immediately, then every `frq` seconds
    var visitors = [];
    var visitorSeq = 0;
    var examTicketSeq = 0;                  // monotonic check-in number → exam order
    // Visitors queue in two lines in front of EACH reception desk (one per desk
    // tile). queue[L] is an ordered array of visitors (index 0 = front); line L
    // belongs to desk L>>1, side L&1. ensureQueues() keeps the list sized to the
    // desks on the floor.
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
    var staffSurcharge = 0;                // +$50 to every staff hire per staff member already hired — each new hire costs more than the last
    // The price to hire/build an item right now: staff carry an escalating surcharge
    // (see staffSurcharge) on top of their base cost; everything else is just base cost.
    function itemCost(item) { return item.cost + (item.cat === 'staff' ? staffSurcharge : 0); }
    // Pay for a staff hire, then bump the surcharge so the NEXT hire (of any kind)
    // costs $50 more than this one did.
    function chargeStaffHire(item) { money -= itemCost(item); staffSurcharge += 50; renderMoney(); }
    var placed = [];                       // [{id, gx, gy}] furniture in the room
    var occupied = {};                     // "gx,gy" -> true (a placed footprint tile)
    var staff = [];                        // [{type:'receptionist', line, name, gender}] hired staff at desk circles
    var placing = null;                    // { item } while positioning a purchase
    var pointer = { gx: 0, gy: 0, on: false }; // snapped tile under the cursor

    // ---- Staff identity (name + gender) ----------------------------------
    // Every hired staffer carries a `gender` ('male'/'female', drives the sprite)
    // and a `name` (empty until the player names them via the overlay; the in-game
    // label only shows once named). Pharmacists are stored as a `pharm` OBJECT on a
    // counter station (was a boolean) so they can carry the same fields.
    var _idSeq = 0;                        // spreads default genders so consecutive hires vary
    function randGender() {                // dedicated integer mixer (the texture `hash` is biased low for small ints)
      var h = (++_idSeq * 2654435761) >>> 0;
      h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13; h = (h * 3266489917) >>> 0; h ^= h >>> 16;
      return ((h >>> 0) / 4294967296) < 0.5 ? 'female' : 'male';
    }
    function newStaffId() { return { name: '', gender: randGender() }; }   // {name,gender} for a fresh hire
    function newPharm() { var s = newStaffId(); return { name: s.name, gender: s.gender }; }

    // ---- Rooms / corridors -----------------------------------------------
    // The clinic is the fixed ROOM×ROOM grid. The player can also buy
    // "corridors": lines of grass squares (outside the clinic) turned into
    // floor, walled in, and joined to whatever room they touch via a doorway.
    // Stored as a set of "gx,gy" keys lying outside the clinic bounds.
    var corridor = {};                     // "gx,gy" -> true (a built corridor tile)
    var corridorDrag = null;               // { sx, sy } while dragging out a line
    var openRoom = {};                     // "gx,gy" corridor tiles that are open rooms (no lane rule)
    var park = {};                         // "gx,gy" tiles that are open-air Dog Park grass (a subset of corridor+openRoom, rendered as turf + fenced)

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
    // A tile a walled room may be carved on: clear grass, the original clinic floor,
    // OR open (blank) room floor — anything with nothing on it. So rooms can be built
    // inside the clinic or a blank room, provided they don't clash with any
    // furniture/fixtures sitting there.
    function isRoomBuildable(x, y) {
      if (occupied[x + ',' + y]) return false;
      return isGrassBuildable(x, y) || !!openRoom[x + ',' + y] || isClinic(x, y);
    }
    function adjacentToRoom(x, y) {
      return isRoomFloor(x - 1, y) || isRoomFloor(x + 1, y) ||
             isRoomFloor(x, y - 1) || isRoomFloor(x, y + 1);
    }
    // A "plain corridor" is a corridor tile that is NOT part of any built room
    // (exam/X-ray/pharmacy/blank/restroom) — an actual passage. Operating-room doors
    // open onto an OPEN tile (a plain corridor or a blank room), never onto a walled
    // room (see isOpenAdj). Rooms MAY sit wall-to-wall against each other; the shared
    // wall stays solid because doors only ever open onto an OPEN tile.
    // A WALLED room tile (exam/X-ray/pharmacy/restroom) — a room with its own walls
    // and a single doorway, as opposed to an open blank room or a plain corridor.
    function inWalledRoom(x, y) {
      if (examRooms.some(function (rm) { return x >= rm.gx && x < rm.gx + 3 && y >= rm.gy && y < rm.gy + 3; })) return true;
      if (xrayRooms.some(function (rm) { return x >= rm.gx && x < rm.gx + 3 && y >= rm.gy && y < rm.gy + 4; })) return true;
      if (pharmacies.some(function (ph) { return x >= ph.gx && x < ph.gx + PHARM_W && y >= ph.gy && y < ph.gy + PHARM_H; })) return true;
      if (shops.some(function (sh) { return x >= sh.gx && x < sh.gx + SHOP_W && y >= sh.gy && y < sh.gy + SHOP_H; })) return true;
      if (groomings.some(function (gm) { return x >= gm.gx && x < gm.gx + GROOM_W && y >= gm.gy && y < gm.gy + GROOM_H; })) return true;
      if (hotels.some(function (h) { return x >= h.gx && x < h.gx + HOTEL_W && y >= h.gy && y < h.gy + HOTEL_H; })) return true;
      if (surgeries.some(function (sg) { return x >= sg.gx && x < sg.gx + SURG_W && y >= sg.gy && y < sg.gy + SURG_H; })) return true;
      if (restrooms.some(function (rm) { return footprintTiles(FURN_BY_ID.restroom, rm.gx, rm.gy, rm.rot).some(function (t) { return t.x === x && t.y === y; }); })) return true;
      return false;
    }
    function inRoomFootprint(x, y) { return !!openRoom[x + ',' + y] || inWalledRoom(x, y); }
    function isPlainCorridor(x, y) { return isCorridor(x, y) && !inRoomFootprint(x, y); }
    // Open rooms (blank rooms + the clinic) join corridors with no wall/door, and a
    // room's door may open onto any of them. The clinic counts as open wherever it
    // isn't itself part of a carved-in room footprint.
    function isOpenAdj(x, y) { return isPlainCorridor(x, y) || !!openRoom[x + ',' + y] || (isClinic(x, y) && !inRoomFootprint(x, y)); }
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

    // ---- Dog Park --------------------------------------------------------
    // A drag-out rectangle of grass, $20/square, that touches the building. Park
    // tiles are walkable (tagged in corridor+openRoom so pathing/openness just work)
    // but render as turf with a fence instead of vinyl + walls. Some visitors come
    // only for the park; others detour to it on the way out (see parkAppeal).
    function parkRectTiles(sx, sy, ex, ey) {
      var x0 = Math.min(sx, ex), x1 = Math.max(sx, ex), y0 = Math.min(sy, ey), y1 = Math.max(sy, ey);
      var tiles = [], touches = false;
      for (var y = y0; y <= y1; y++)
        for (var x = x0; x <= x1; x++) {
          if (!isGrassBuildable(x, y)) return { tiles: [], cost: 0, ok: false };
          tiles.push({ x: x, y: y });
          if (adjacentToRoom(x, y)) touches = true;
        }
      var cost = tiles.length * 20;
      return { tiles: tiles, cost: cost, ok: touches && cost <= money };
    }
    function commitPark(sx, sy, ex, ey) {
      var res = parkRectTiles(sx, sy, ex, ey);
      if (!res.ok) return;
      res.tiles.forEach(function (t) { var k = t.x + ',' + t.y; corridor[k] = true; openRoom[k] = true; park[k] = true; });
      money -= res.cost;
      renderStatic();
      renderMoney();
    }
    function isPark(x, y) { return !!park[x + ',' + y]; }
    function parkSize() { return Object.keys(park).length; }
    // ---- Cat park: any blank room furnished with cat items works like a dog park
    // for cats. Blank-room floor = openRoom minus park (commitPark tags grass into
    // openRoom too). The whole dog-park pipeline below takes an optional zone
    // ('dog' default / 'cat') so both share one state machine.
    function isCatFloor(x, y) { var k = x + ',' + y; return !!openRoom[k] && !park[k]; }
    function catFloorSize() { var n = 0; for (var k in openRoom) { if (openRoom.hasOwnProperty(k) && !park[k]) n++; } return n; }
    function zoneFloor(zone, x, y) { return zone === 'cat' ? isCatFloor(x, y) : isPark(x, y); }
    // "Niceness": sum of the quality of every placed park item (they only sit on park
    // tiles, gated in canPlace), so adding toys makes the park more attractive.
    function parkQuality(zone) {
      var q = 0, flag = zone === 'cat' ? 'catItem' : 'parkItem';
      for (var i = 0; i < placed.length; i++) { var d = FURN_BY_ID[placed[i].id]; if (d && d[flag]) q += (d.quality || 0); }
      return q;
    }
    // Park tiles a visitor can stand on (turf with nothing built on it).
    function parkStandTiles(zone) {
      var out = [], set = zone === 'cat' ? openRoom : park;
      for (var k in set) { if (!set.hasOwnProperty(k)) continue; if (zone === 'cat' && park[k]) continue; var p = k.split(','), x = +p[0], y = +p[1]; if (!occupied[x + ',' + y]) out.push({ x: x, y: y }); }
      return out;
    }
    // A free standing spot in the park (not occupied, not targeted by another
    // park-goer, not under the player), or null. When `from` is given, only return
    // a spot the visitor can actually WALK to — toys can enclose a tile that is
    // "free" but unreachable, and routing a visitor there wedges them against a toy.
    function freeParkSpot(from, zone) {
      var spots = parkStandTiles(zone);
      if (!spots.length) return null;
      var taken = {};
      visitors.forEach(function (v) { if (v.parkSpot) taken[v.parkSpot.x + ',' + v.parkSpot.y] = true; });
      var vtx = Math.round(vet.x), vty = Math.round(vet.y);
      for (var i = 0; i < spots.length; i++) {
        var s = spots[i];
        if (taken[s.x + ',' + s.y]) continue;
        if (s.x === vtx && s.y === vty) continue;
        if (from) { examRoute(from.x, from.y, s.x, s.y); if (!examRouteReached) continue; }   // skip toy-enclosed / unreachable tiles
        return { x: s.x, y: s.y };
      }
      return null;
    }
    function parkGoers(zone) { var n = 0; for (var i = 0; i < visitors.length; i++) { var v = visitors[i], ph = v.phase; if ((ph === 'toDogPark' || ph === 'inDogPark') && (v.parkZone || 'dog') === (zone || 'dog')) n++; } return n; }
    function parkBusy(zone) { var cap = parkStandTiles(zone).length; return cap ? Math.min(1, parkGoers(zone) / cap) : 1; }
    // Pull of the park: rises with size + niceness, falls as it fills up. Capped at
    // 0.5 (the "Medium" tuning). Returns 0 when there is no park (for the cat zone
    // that also means no cat items — a furniture-only blank room attracts nobody).
    function parkAppeal(zone) {
      var size = zone === 'cat' ? catFloorSize() : parkSize();
      if (!size) return 0;
      if (zone === 'cat' && !parkQuality('cat')) return 0;
      var raw = size * 0.012 + parkQuality(zone) * 0.03;
      return Math.min(0.5, raw) * (1 - parkBusy(zone));
    }
    // Send visitor v into the park: claim a spot, route there, start the visit.
    function startDogPark(v, zone) {
      var spot = freeParkSpot(v, zone);      // reachable from where the visitor stands
      if (!spot) return false;
      v.parkZone = zone || 'dog';
      v.parkSpot = { x: spot.x, y: spot.y };
      v.path = examRoute(v.x, v.y, spot.x, spot.y); v.wp = 0;
      v.phase = 'toDogPark'; v.dogT = 8; v.patience = baseWait();   // longer dwell so the off-leash play is visible
      return true;
    }

    // ---- Off-leash park dogs ---------------------------------------------
    // While the owner stands at their spot, a DOG (not a cat — those ride in a
    // carrier) is let off the leash and roams the park on its own: it runs to the
    // toys, sniffs the other dogs, does zoomies, and usually leaves one or more
    // messes a cleaner has to mop. The dog lives on `v.dog = {x,y,tx,ty,...}` for the park visit only.
    var PARK_DOG_SPEED = 3.0;              // tiles/sec — a happy run, faster than a person walks
    // Centre points of every placed park toy (frisbee, ball pit, seesaw, …).
    function parkToyTargets(zone) {
      var out = [], flag = zone === 'cat' ? 'catItem' : 'parkItem';
      placed.forEach(function (it) {
        var def = FURN_BY_ID[it.id]; if (!def || !def[flag]) return;
        var ew = ((it.rot || 0) & 1) ? def.h : def.w, eh = ((it.rot || 0) & 1) ? def.w : def.h;
        out.push({ x: it.gx + (ew - 1) / 2, y: it.gy + (eh - 1) / 2 });
      });
      return out;
    }
    // A point ~`off` tiles from (tx,ty) that's still on park turf — so the dog ends
    // up beside a toy / another dog rather than on top of it.
    function nearPark(tx, ty, off, zone) {
      for (var a = 0; a < 6; a++) {
        var ang = Math.random() * Math.PI * 2, nx = tx + Math.cos(ang) * off, ny = ty + Math.sin(ang) * off;
        if (zoneFloor(zone || 'dog', Math.round(nx), Math.round(ny))) return { x: nx, y: ny };
      }
      return { x: tx, y: ty };
    }
    // Pick the dog's next destination: 40% a toy, 30% another park dog, else zoomies.
    function pickParkDogTarget(v) {
      var d = v.dog, r = Math.random(), tgt = null, list, zone = v.parkZone || 'dog';
      if (r < 0.4) { list = parkToyTargets(zone); if (list.length) { var t = list[(Math.random() * list.length) | 0]; tgt = nearPark(t.x, t.y, 0.85, zone); } }
      else if (r < 0.7) {
        list = visitors.filter(function (o) { return o !== v && o.phase === 'inDogPark' && o.dog && (o.parkZone || 'dog') === zone; });
        if (list.length) { var o = list[(Math.random() * list.length) | 0].dog; tgt = nearPark(o.x, o.y, 0.7, zone); }
      }
      if (!tgt) { var sp = parkStandTiles(zone); if (sp.length) { var s = sp[(Math.random() * sp.length) | 0]; tgt = { x: s.x, y: s.y }; } }
      if (tgt) { d.tx = tgt.x; d.ty = tgt.y; }
    }
    // Spin up the off-leash pet when its owner reaches the park. Dogs roam the turf;
    // in a cat park the CAT comes out of the carrier and roams the blank room. Most
    // will need the toilet partway through the visit (and may go again — see updateParkDog).
    function startParkDog(v) {
      var zone = v.parkZone || 'dog';
      if (zone === 'dog' && v.pet.charAt(0) !== 'd') return;   // cats stay in their carrier at the DOG park
      if (zone === 'cat' && v.pet !== 'cat') return;
      v.dog = { x: v.x, y: v.y, tx: v.x, ty: v.y, face: 1, gait: 0, wag: 0, pause: 0.3, squat: 0, moving: false };
      if (Math.random() < 0.8) v.dog.pooT = 1.2 + Math.random() * Math.max(0.6, v.dogT - 2.5);
      pickParkDogTarget(v);
    }
    // Drop a poo on a clean, walkable park tile at/near the dog (so a cleaner can
    // reach it). Reuses the puddle system; messGoal('poo') makes it a 10s job.
    function dropPoo(d, zone) {
      var cands = [{ x: Math.round(d.x), y: Math.round(d.y) }];
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (n) { cands.push({ x: Math.round(d.x) + n[0], y: Math.round(d.y) + n[1] }); });
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (zoneFloor(zone || 'dog', c.x, c.y) && !occupied[c.x + ',' + c.y] && !messAt(c.x, c.y)) { puddles.push({ x: c.x, y: c.y, clean: 0, kind: 'poo' }); return; }
      }
    }
    // Nearest free blank-room tile beside a placed litter box: where the cat squats
    // and where the scoop-me mess lands (ON a walkable tile so cleaners can reach it).
    function nearestLitterBox(d) {
      var best = null, bd = 1e9;
      placed.forEach(function (it) {
        if (it.id !== 'litterbox') return;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (n) {
          var x = it.gx + n[0], y = it.gy + n[1];
          if (!isCatFloor(x, y) || occupied[x + ',' + y]) return;
          var dist = Math.abs(x - d.x) + Math.abs(y - d.y);
          if (dist < bd) { bd = dist; best = { x: x, y: y, box: it }; }
        });
      });
      return best;
    }
    // Every 2nd use the box is full and a cleaner has to scoop it. `uses` is
    // transient (not saved) — resetting on load is fine, like dirty puddles.
    function useLitterBox(t) {
      t.box.uses = (t.box.uses || 0) + 1;
      if (t.box.uses >= 2 && !messAt(t.x, t.y)) { t.box.uses = 0; puddles.push({ x: t.x, y: t.y, clean: 0, kind: 'litterbox' }); }
    }
    // Advance one off-leash dog: poop timer, then run toward its target, pausing to
    // sniff/play on arrival and repicking. At the end of the visit it's recalled to
    // the owner so they leave together.
    function updateParkDog(v, dt) {
      var d = v.dog; if (!d) return;
      var zone = v.parkZone || 'dog';
      if (d.pooT != null) { d.pooT -= dt; if (d.pooT <= 0) {
        var box = (zone === 'cat') ? nearestLitterBox(d) : null;
        if (box) { d.toBox = box; d.tx = box.x; d.ty = box.y; d.pause = 0; d.pooT = null; }   // hold it: run to the litter box
        else { dropPoo(d, zone); d.squat = 1.3;
          d.pooT = (Math.random() < 0.5) ? 1.5 + Math.random() * 3 : null; } } }   // may squat again for a second/third mess
      if (d.squat > 0) { d.squat -= dt; d.moving = false; d.gait = 0; return; }   // squatting to poo
      d.wag += dt;
      if (d.toBox && Math.hypot(d.x - d.toBox.x, d.y - d.toBox.y) < 0.2) {
        useLitterBox(d.toBox); d.toBox = null; d.squat = 1.3;
        d.pooT = (Math.random() < 0.5) ? 1.5 + Math.random() * 3 : null;   // may need to go again
        return;
      }
      if (d.recall) { d.tx = v.x; d.ty = v.y; }
      else if (!d.toBox && d.pause > 0) { d.pause -= dt; d.moving = false; d.gait = 0; if (d.pause <= 0) pickParkDogTarget(v); return; }
      var dx = d.tx - d.x, dy = d.ty - d.y, dist = Math.hypot(dx, dy);
      if (dist < 0.14) {
        d.moving = false; d.gait = 0;
        if (!d.recall && !d.toBox) d.pause = 0.5 + Math.random() * 1.7;   // arrived → sniff / play a beat
        return;
      }
      var step = Math.min(PARK_DOG_SPEED * dt, dist), nx = d.x + dx / dist * step, ny = d.y + dy / dist * step;
      if (zoneFloor(zone, Math.round(nx), Math.round(ny))) { d.x = nx; d.y = ny; }
      else if (d.toBox) { d.toBox = null; dropPoo(d, zone); d.squat = 1.3; }   // box unreachable → accident on the spot
      else { pickParkDogTarget(v); }
      d.moving = true; d.gait += dt * 16; d.face = dx >= 0 ? 1 : -1;
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
    // A dirty restroom can't be used at all (unlike exam/X-ray, which stay usable
    // while grimy), so skip both occupied and dirty ones.
    function freeRestroom() {
      for (var i = 0; i < restrooms.length; i++) if (!restrooms[i].occupant && !restrooms[i].dirty) return restrooms[i];
      return null;
    }
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
    // A 4-wide × 4-deep room with 2 counter sections; at each, a patient stands on
    // the front tile and the player (or a hired Pharmacist) stands on the circle
    // behind to fill the prescription. Fixed orientation (like the X-ray room).
    // The back row stays clear so the medicine shelving on the two tall back walls
    // reads as the stock the pharmacist picks from. Built on grass touching a
    // corridor, like other rooms.
    var PHARM_W = 4, PHARM_H = 4;          // across × down
    var pharmacies = [];                   // [{gx,gy,rot,door,stations:[{patient,procT,pharm}x2]}]
    function pharmTiles(gx, gy) {          // all 16 floor tiles (4 wide × 4 deep)
      var t = [];
      for (var j = 0; j < PHARM_H; j++) for (var i = 0; i < PHARM_W; i++) t.push({ x: gx + i, y: gy + j });
      return t;
    }
    // 2 sections, each {counter, patient(front), circle(back)}, centred in the
    // 4-wide room (columns 1 & 2). Columns 0 & 3 stay open as walking lanes. The
    // staff stand on the back row right in front of the wall shelving (picking
    // stock off it), leaving two open rows ahead of the counter for clients.
    function pharmStations(gx, gy) {
      return [1, 2].map(function (cx) {
        return {
          counter: { x: gx + cx, y: gy + 1 },
          patient: { x: gx + cx, y: gy + 2 },   // front tile (toward viewer)
          circle:  { x: gx + cx, y: gy + 0 }    // staff tile (back, against the shelves)
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

    // ---- Shop ------------------------------------------------------------
    // A 5×5 retail room with no staff or service queue. Instead, a low fraction
    // of clients on their way OUT detour through it and spend a little. Goods sit
    // on the two back walls; a display island runs across the middle row.
    var SHOP_W = 5, SHOP_H = 5;
    var shops = [];                        // [{gx,gy,rot,door}]
    var SHOP_CHANCE = 0.12;                // chance a departing client browses the shop
    function shopTiles(gx, gy) {           // all 25 floor tiles
      var t = [];
      for (var j = 0; j < SHOP_H; j++) for (var i = 0; i < SHOP_W; i++) t.push({ x: gx + i, y: gy + j });
      return t;
    }
    // The central display island: 3 solid tiles across the middle row, leaving
    // aisles front and back and a clear lane down each side. The middle tile is the
    // checkout counter (register); the cashier stands on the tile directly behind it.
    function shopIslandTiles(gx, gy) {
      return [{ x: gx + 1, y: gy + 2 }, { x: gx + 2, y: gy + 2 }, { x: gx + 3, y: gy + 2 }];
    }
    // The cashier's standing tile: centre of the back aisle, right behind the register
    // counter. A fixture, so browsers never claim it and nobody walks through it.
    function shopCashierTile(gx, gy) { return { x: gx + 2, y: gy + 1 }; }
    // Where a browsing client stands: the aisle tiles in front of and behind the
    // island (never a fixture, never an edge, so the doorway always stays reachable),
    // minus the cashier's spot in the back aisle.
    function shopBrowseSpots(s) {
      var cash = shopCashierTile(s.gx, s.gy), r = [];
      for (var x = s.gx + 1; x <= s.gx + 3; x++) {
        if (x !== cash.x) r.push({ x: x, y: s.gy + 1 });   // back aisle (skip cashier tile)
        r.push({ x: x, y: s.gy + 3 });                     // front aisle
      }
      return r;
    }
    function canPlaceShop(gx, gy) { return canPlaceRoom('shop', gx, gy); }
    function placeShop(gx, gy, rot) { return placeRoom('shop', gx, gy, rot); }
    // Random spend $20–$200, skewed low — pow(r,2.4) bunches most spends near $20,
    // with the odd big splurge toward $200. Rounded to the nearest $5.
    function shopSpend() { return Math.round((20 + Math.pow(Math.random(), 2.4) * 180) / 5) * 5; }
    // The shop only rings up sales while a Worker mans it (post keys 'shop:k:s');
    // a 2nd and 3rd clerk upsell: spend x1 / x1.25 / x1.5. Zero clerks → browsers
    // walk out without buying.
    function shopWorkersAssigned(s) {
      var pre = 'shop:' + shops.indexOf(s) + ':', n = 0;
      for (var i = 0; i < workers.length; i++) if (workers[i].post && workers[i].post.indexOf(pre) === 0) n++;
      return n;
    }
    function shopWorkersPresent(s) {
      var pre = 'shop:' + shops.indexOf(s) + ':', n = 0;
      for (var i = 0; i < workers.length; i++) { var w = workers[i]; if (w.post && w.working && w.post.indexOf(pre) === 0) n++; }
      return n;
    }
    function shopSpendMult(n) { return n >= 3 ? 1.5 : n === 2 ? 1.25 : n === 1 ? 1 : 0; }
    // A free aisle spot in some shop for a departing client, or null. Skips spots
    // another client is already heading to / standing on, and any blocked tile.
    function claimShopSpot() {
      if (!shops.length) return null;
      var taken = {};
      visitors.forEach(function (v) { if (v.shopTile) taken[v.shopTile.x + ',' + v.shopTile.y] = true; });
      for (var s = 0; s < shops.length; s++) {
        var sp = shopBrowseSpots(shops[s]);
        for (var i = 0; i < sp.length; i++)
          if (!taken[sp[i].x + ',' + sp[i].y] && !tileBlocked(sp[i].x, sp[i].y))
            return { shop: shops[s], x: sp[i].x, y: sp[i].y };
      }
      return null;
    }

    // ---- Grooming --------------------------------------------------------
    // A 3-wide × 6-deep parlour with two stations stacked down the centre column:
    // a Shower (back) then a Blow-Dry (front). A dog showers first, walks to the
    // dry station, is blow-dried, then leaves — a successful groom pays $80. Each
    // station is operated by the player standing on its circle (full rate) or a
    // hired Worker (half rate); with no operator the dog's wait drains and it
    // leaves unpaid. Fixed orientation, like the pharmacy/shop. Side columns are
    // open walking lanes so the dog can route around the solid fixtures.
    var GROOM_W = 3, GROOM_H = 6;
    var groomings = [];                    // [{gx,gy,rot,door,occupant,showerT,dryT}]
    function groomTiles(gx, gy) {          // all 18 floor tiles (3 wide × 6 deep)
      var t = [];
      for (var j = 0; j < GROOM_H; j++) for (var i = 0; i < GROOM_W; i++) t.push({ x: gx + i, y: gy + j });
      return t;
    }
    // Two stations, each {fixture(solid, back), dogSpot(walkable), circle(operator,
    // front)}. The dog always stands in FRONT of its fixture (higher depth) so the
    // shower head / dryer never occludes it; the operator stands in front of the dog.
    function groomStations(gx, gy) {
      return [
        { kind: 'shower', fixture: { x: gx + 1, y: gy + 0 }, dogSpot: { x: gx + 1, y: gy + 1 }, circle: { x: gx + 1, y: gy + 2 } },
        { kind: 'dry',    fixture: { x: gx + 1, y: gy + 3 }, dogSpot: { x: gx + 1, y: gy + 4 }, circle: { x: gx + 1, y: gy + 5 } }
      ];
    }
    function groomDoor(gx, gy) { return roomDoorFor(groomTiles(gx, gy)); }
    function canPlaceGrooming(gx, gy) { return canPlaceRoom('grooming', gx, gy); }
    function placeGrooming(gx, gy, rot) { return placeRoom('grooming', gx, gy, rot); }
    function freeGroomRoom() { return freeRoom('grooming'); }

    // ---- Pet Hotel ---------------------------------------------------------
    // A 6x5 boarding hotel. Owners drop their pet at the desk and leave; the pet
    // sleeps in a bed in its species' wing (dog wing west, cat wing east, 3 beds
    // each), takes play trips to the dog park / cat rooms, and is collected by a
    // returning owner who pays a fee scaled to the stay length. Needs 3 Workers
    // on post (reception + one per wing) to accept new check-ins; below that the
    // hotel keeps caring for pets already boarded. Each wing gets dirty on its
    // own while occupied and blocks new check-ins for that species until scrubbed.
    var HOTEL_W = 6, HOTEL_H = 5;
    var HOTEL_STAY_MIN = 60, HOTEL_STAY_SPAN = 180;   // stay 60-240s → fee $120-$300
    var HOTEL_WORKERS_NEEDED = 3;
    var hotels = [];   // [{gx,gy,rot,door,wings:{dog:{dirty,cleanProg,grimeT},cat:{...}},pets:[]}]
    function hotelTiles(gx, gy) {
      var t = [];
      for (var j = 0; j < HOTEL_H; j++) for (var i = 0; i < HOTEL_W; i++) t.push({ x: gx + i, y: gy + j });
      return t;
    }
    // Beds line the back wall (all visible under the PET HOTEL sign): dog wing
    // cols 0-2, cat wing cols 3-5, back row (solid).
    function hotelBeds(h, species) {
      var c0 = species === 'dog' ? h.gx : h.gx + 3, out = [];
      for (var i = 0; i < 3; i++) out.push({ x: c0 + i, y: h.gy });
      return out;
    }
    function bedTile(h, p) { return hotelBeds(h, p.species)[p.bed]; }
    // The walkable lane tile in front of a bed (where pets step on/off and path from).
    function bedLaneTile(h, p) { var b = bedTile(h, p); return { x: b.x, y: h.gy + 1 }; }
    function hotelDeskTiles(gx, gy) { return [{ x: gx + 2, y: gy + 3 }, { x: gx + 3, y: gy + 3 }]; }
    function hotelPlantTiles(gx, gy) { return [{ x: gx, y: gy + 4 }, { x: gx + 5, y: gy + 4 }]; }
    // Worker posts: reception behind the desk + a minder at each wing's side.
    function hotelWorkTiles(h) { return [{ x: h.gx + 2, y: h.gy + 2 }, { x: h.gx, y: h.gy + 2 }, { x: h.gx + 5, y: h.gy + 2 }]; }
    function hotelDropTile(h) { return { x: h.gx + 2, y: h.gy + 4 }; }   // in front of the desk
    function hotelWingTiles(h, species) {
      var c0 = species === 'dog' ? h.gx : h.gx + 3, out = [];
      for (var j = 0; j < 3; j++) for (var i = 0; i < 3; i++) out.push({ x: c0 + i, y: h.gy + j });
      return out;
    }
    function hotelWingScrub(h, species) { return { x: species === 'dog' ? h.gx + 1 : h.gx + 4, y: h.gy + 1 }; }
    function canPlaceHotel(gx, gy) { return canPlaceRoom('hotel', gx, gy); }
    function placeHotel(gx, gy, rot) { return placeRoom('hotel', gx, gy, rot); }
    function hotelAt(x, y) {
      for (var i = 0; i < hotels.length; i++) { var h = hotels[i]; if (x >= h.gx && x < h.gx + HOTEL_W && y >= h.gy && y < h.gy + HOTEL_H) return h; }
      return null;
    }
    // Warm cream/tan wall faces (per edge: [face-top, face-bottom, cap, trim]) so
    // the hotel reads as a cosy lobby, not another teal clinic room.
    var HOTEL_PAL = {
      w: ['#fdf8ee', '#efe1c8', '#fffbf2', '#b98a4e'],
      n: ['#f4ead7', '#decbab', '#f9f1e1', '#a87c42'],
      e: ['#ecdfc9', '#d6c3a2', '#f3ead7', '#a87c42'],
      s: ['#f8f2e5', '#e6d7bd', '#fcf6eb', '#b98a4e']
    };
    // Workers on hotel posts (post keys 'hotel:<index>:<slot>'), and whether the
    // hotel is currently taking new guests of a species.
    function hotelWorkersAssigned(h) {
      var pre = 'hotel:' + hotels.indexOf(h) + ':', n = 0;
      for (var i = 0; i < workers.length; i++) if (workers[i].post && workers[i].post.indexOf(pre) === 0) n++;
      return n;
    }
    function hotelFreeBed(h, species) {
      var used = {};
      h.pets.forEach(function (p) { if (p.species === species) used[p.bed] = true; });
      visitors.forEach(function (v) {                 // beds promised to owners already walking in
        if (v.hotelRoom === h && v.phase === 'toHotel' && petSpecies(v.pet) === species) used[v.hotelBed] = true;
      });
      for (var b = 0; b < 3; b++) if (!used[b]) return b;
      return -1;
    }
    function petSpecies(kind) { return kind.charAt(0) === 'd' ? 'dog' : 'cat'; }
    function hotelTaking(h, species) {
      return hotelWorkersAssigned(h) >= HOTEL_WORKERS_NEEDED && !h.wings[species].dirty && hotelFreeBed(h, species) >= 0;
    }
    function hotelAccepts(kind) {
      var sp = petSpecies(kind);
      for (var i = 0; i < hotels.length; i++) if (hotelTaking(hotels[i], sp)) return hotels[i];
      return null;
    }

    // ---- Surgery ---------------------------------------------------------
    // A 4×5 operating theatre — the most expensive ($1500) and slowest (18×
    // procTime = 90s at base skill) room in the game. 35% of X-rayed pets need
    // surgery. Uniquely it needs THREE staff at once: two vets flanking the
    // table plus one worker (nurse) behind it; the timer only advances while
    // all three circles are manned (the player standing on any circle fills
    // that slot). Fixed orientation like the pharmacy/shop/grooming; column
    // gx+3 and rows gy+0 / gy+4 stay open as walking lanes.
    var SURG_W = 4, SURG_H = 5;
    var surgeries = [];                    // [{gx,gy,rot,occupant,surgT,door,uses,dirty,cleanProg}]
    function surgeryTiles(gx, gy) {        // all 20 floor tiles (4 wide × 5 deep)
      var t = [];
      for (var j = 0; j < SURG_H; j++) for (var i = 0; i < SURG_W; i++) t.push({ x: gx + i, y: gy + j });
      return t;
    }
    function surgeryKeyTiles(gx, gy) {
      return {
        table:   { x: gx + 1, y: gy + 2 },   // operating table (solid; pet lies on it)
        vetA:    { x: gx + 0, y: gy + 2 },   // surgeon circle, left flank
        vetB:    { x: gx + 2, y: gy + 2 },   // surgeon circle, right flank
        worker:  { x: gx + 1, y: gy + 1 },   // nurse circle, behind the table
        visitor: { x: gx + 1, y: gy + 3 },   // owner + pet spot, in front of the table
        monitor: { x: gx + 0, y: gy + 1 },   // ECG cart (solid)
        trolley: { x: gx + 2, y: gy + 1 },   // instrument trolley (solid)
        circle:  { x: gx + 1, y: gy + 1 }    // scrub anchor for dirtyRooms (= nurse tile)
      };
    }
    function surgeryDoor(gx, gy) { return roomDoorFor(surgeryTiles(gx, gy)); }
    function canPlaceSurgery(gx, gy) { return canPlaceRoom('surgery', gx, gy); }
    function placeSurgery(gx, gy, rot) { return placeRoom('surgery', gx, gy, rot); }
    function freeSurgeryRoom() { return freeRoom('surgery'); }

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
          return { room: { gx: gx, gy: gy, rot: rot, door: L.door, entry: L.entry, toilet: L.toilet, stand: L.stand, face: L.face, occupant: null, dirty: false, cleanProg: 0 }, solid: [L.toilet] };
        }
      },
      exam: {
        list: examRooms,
        tiles: function (gx, gy) { return examTiles(gx, gy); },
        make: function (gx, gy, rot, door) {
          var k = examKeyTiles(gx, gy, rot);
          return { room: { gx: gx, gy: gy, rot: rot, occupant: null, examT: 0, door: door, uses: 0, dirty: false, cleanProg: 0 }, solid: [k.table] };
        },
        // occupant-claim service flow (see claimRoomGeneric/assignRoomGeneric):
        timer: 'examT', vRoom: 'examRoom', toPhase: 'toExam',
        waiting: function (v) {
          // Only exam-INTENT clients queue for exams — park/shop/pharm intents
          // wait for their own service (or leave unhappy), never divert here.
          return v.served && (v.intent == null || v.intent === 'exam') &&
            !v.examined && !v.examRoom && !v.wantsGroom && !v.wantsHotel &&
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
          return { room: { gx: gx, gy: gy, rot: rot, occupant: null, xrayT: 0, door: door, vet: false, uses: 0, dirty: false, cleanProg: 0 }, solid: [k.table, k.desk] };
        },
        timer: 'xrayT', vRoom: 'xrayRoom', toPhase: 'toXray',
        waiting: function (v) {
          return v.needsXray && !v.xrayed && !v.xrayRoom &&
            // include 'waitXray': a pet that found no free room right after its exam
            // loiters in that phase and must still be pulled in when one frees up
            // (mirrors how assignPharmacies handles 'waitMeds').
            (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated' || v.phase === 'waitXray');
        },
        // X-ray takes 2x an exam (6x procTime) and pays 200; happy-leaves on done.
        inPhase: 'inXray', waitField: 'xrayWait', duration: 6, payout: 200,
        operator: function (rm) { return vetAtXray(rm) || roomVetWorking(rm); },
        fullRate: function (rm) { return vetAtXray(rm) ? 1 : 0.5; },
        release: function (v) { releaseXray(v); },
        // Post-X-ray chain: 35% turn out to need surgery; otherwise some need
        // meds (FOLLOWUP.xrayMeds of the rest); the remainder leave happy.
        // ONE draw with cumulative thresholds (constant RNG count).
        onDone: function (v) {
          v.xrayed = true; releaseXray(v);
          var r = Math.random();
          if (r < 0.35) {
            v.needsSurgery = true;
            if (!claimSurgery(v)) waitAside(v, 'waitSurgery');   // no free/reachable theatre → loiter for one
          } else if (r < 0.35 + FOLLOWUP.xrayMeds * (1 - 0.35)) {
            medsOrWait(v);                   // imaging → prescription to fill
          } else { v.happy = true; leaveOutbound(v); }
        }
      },
      pharmacy: {
        list: pharmacies,
        tiles: function (gx, gy) { return pharmTiles(gx, gy); },
        make: function (gx, gy, rot, door) {
          var st = pharmStations(gx, gy, rot);
          return { room: { gx: gx, gy: gy, rot: rot, door: door, stations: [{ patient: null, procT: 0, pharm: false }, { patient: null, procT: 0, pharm: false }], dirty: false, cleanProg: 0, grimeT: null }, solid: st.map(function (s) { return s.counter; }) };
        }
      },
      shop: {
        list: shops,
        tiles: function (gx, gy) { return shopTiles(gx, gy); },
        make: function (gx, gy, rot, door) {
          return { room: { gx: gx, gy: gy, rot: rot, door: door, cashierGender: randGender(), dirty: false, cleanProg: 0, grimeT: null },
                   solid: shopIslandTiles(gx, gy).concat([shopCashierTile(gx, gy)]) };
        }
      },
      grooming: {
        list: groomings,
        tiles: function (gx, gy) { return groomTiles(gx, gy); },
        make: function (gx, gy, rot, door) {
          var st = groomStations(gx, gy);
          return { room: { gx: gx, gy: gy, rot: rot, door: door, occupant: null, showerT: 0, dryT: 0, dirty: false, cleanProg: 0, grimeT: null },
                   solid: [st[0].fixture, st[1].fixture] };
        }
      },
      hotel: {
        list: hotels,
        tiles: function (gx, gy) { return hotelTiles(gx, gy); },
        make: function (gx, gy, rot, door) {
          var h = { gx: gx, gy: gy, rot: rot, door: door,
                    wings: { dog: { dirty: false, cleanProg: 0, grimeT: null },
                             cat: { dirty: false, cleanProg: 0, grimeT: null } },
                    pets: [] };
          return { room: h,
                   solid: hotelBeds(h, 'dog').concat(hotelBeds(h, 'cat'), hotelDeskTiles(gx, gy), hotelPlantTiles(gx, gy)) };
        }
      },
      surgery: {
        list: surgeries,
        tiles: function (gx, gy) { return surgeryTiles(gx, gy); },
        key: surgeryKeyTiles,
        make: function (gx, gy, rot, door) {
          var k = surgeryKeyTiles(gx, gy);
          return { room: { gx: gx, gy: gy, rot: rot, occupant: null, surgT: 0, door: door, uses: 0, dirty: false, cleanProg: 0 },
                   solid: [k.table, k.monitor, k.trolley] };
        },
        timer: 'surgT', vRoom: 'surgeryRoom', toPhase: 'toSurgery',
        waiting: function (v) {
          return v.needsSurgery && !v.operated && !v.surgeryRoom &&
            (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' ||
             v.phase === 'seated' || v.phase === 'waitSurgery');
        },
        // Surgery: 2 vets + 1 worker at once; 18× procTime (3× an X-ray) and the
        // top payout. Full staffing IS the price of admission — no half-rate.
        inPhase: 'inSurgery', waitField: 'surgWait', duration: 18, payout: 400,
        operator: function (rm) { return surgeryStaffed(rm); },
        fullRate: function () { return 1; },
        release: function (v) { releaseSurgery(v); },
        // Post-op: half go home with a prescription (meds chain); the rest leave happy.
        onDone: function (v) {
          v.operated = true; releaseSurgery(v);
          if (Math.random() < FOLLOWUP.surgMeds) medsOrWait(v);
          else { v.happy = true; leaveOutbound(v); }
        }
      }
    };
    // The corridor/clinic/blank tile a room's footprint opens onto, or null. The
    // INNER footprint tile at the doorway must be walkable (not a fixture): otherwise
    // the door can open straight onto e.g. the X-ray desk and the room is unenterable
    // (pathing fails, the patient jams at the wall). `solid` lists the room's fixture
    // tiles to skip as door positions.
    function roomDoorFor(tiles, solid) {
      var blocked = {}, inRoom = {};
      if (solid) solid.forEach(function (t) { blocked[t.x + ',' + t.y] = true; });
      // The room's own footprint can never be its door. Without this, a door
      // candidate INSIDE the room can win whenever the footprint already reads
      // as open floor at door-pick time — on save-load (footprints are saved in
      // `corridor` and restored before the room re-places) or when a room is
      // carved inside a blank room — leaving the room fully walled/unenterable.
      tiles.forEach(function (t) { inRoom[t.x + ',' + t.y] = true; });
      var n = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var i = 0; i < tiles.length; i++) {
        if (blocked[tiles[i].x + ',' + tiles[i].y]) continue;   // inner tile is a fixture — can't enter here
        for (var j = 0; j < 4; j++) {
          var dx = tiles[i].x + n[j][0], dy = tiles[i].y + n[j][1];
          if (inRoom[dx + ',' + dy]) continue;                  // own floor, not a doorway
          if (isOpenAdj(dx, dy)) return { x: dx, y: dy };
        }
      }
      return null;
    }
    // A room's fixture (solid) tiles, from its descriptor — these depend only on
    // (gx,gy,rot), so they're known before a door is chosen. make() has no side effects.
    function roomSolids(type, gx, gy, rot) { return ROOM_TYPES[type].make(gx, gy, rot, null).solid; }
    // Any existing room's door tile? Building on a doorway seals that room forever
    // (patients can't enter and its dirt can never be scrubbed — cleaners would
    // idle-loop on the unreachable job), so placement treats door tiles as off-limits.
    function isAnyRoomDoor(x, y) {
      for (var type in ROOM_TYPES) {
        if (!ROOM_TYPES.hasOwnProperty(type)) continue;
        var L = ROOM_TYPES[type].list;
        for (var i = 0; i < L.length; i++) { var d = L[i].door; if (d && d.x === x && d.y === y) return true; }
      }
      return false;
    }
    // Re-derive the door of any room whose doorway got sealed (layouts built before
    // the door guard, or save load orders that shadow an earlier room's door).
    // Restrooms are skipped — their door/entry/stand come from restroomLayout(rot)
    // and can't be re-picked freely.
    function repairRoomDoors() {
      var changed = false;
      for (var type in ROOM_TYPES) {
        if (!ROOM_TYPES.hasOwnProperty(type) || type === 'restroom') continue;
        var d = ROOM_TYPES[type];
        d.list.forEach(function (rm) {
          if (rm.door && isOpenAdj(rm.door.x, rm.door.y)) return;   // doorway still opens onto walkable floor
          var ts = d.tiles(rm.gx, rm.gy, rm.rot || 0);
          var nd = roomDoorFor(ts, roomSolids(type, rm.gx, rm.gy, rm.rot || 0));
          if (nd && (!rm.door || nd.x !== rm.door.x || nd.y !== rm.door.y)) { rm.door = nd; changed = true; }
        });
      }
      return changed;
    }
    function canPlaceRoom(type, gx, gy, rot) {
      rot = rot || 0;
      var ts = ROOM_TYPES[type].tiles(gx, gy, rot);
      // Every tile must be clear grass or unoccupied blank-room floor (rooms may sit
      // wall-to-wall, or be carved inside a blank room as long as nothing clashes),
      // must not pave over another room's doorway (that would seal it)...
      for (var i = 0; i < ts.length; i++) {
        if (!isRoomBuildable(ts[i].x, ts[i].y)) return false;
        if (isAnyRoomDoor(ts[i].x, ts[i].y)) return false;
      }
      return !!roomDoorFor(ts, roomSolids(type, gx, gy, rot));   // ...and must open (walkably) onto a corridor/blank
    }
    function placeRoom(type, gx, gy, rot) {
      rot = rot || 0;
      var d = ROOM_TYPES[type], ts = d.tiles(gx, gy, rot), door = roomDoorFor(ts, roomSolids(type, gx, gy, rot));
      var m = d.make(gx, gy, rot, door);
      ts.forEach(function (t) { corridor[t.x + ',' + t.y] = true; delete openRoom[t.x + ',' + t.y]; });   // walkable room floor; no longer open (it's walled now)
      m.solid.forEach(function (t) { occupied[t.x + ',' + t.y] = true; }); // fixtures block movement
      d.list.push(m.room);
      repairRoomDoors();                                    // a new room can shadow an old doorway (legacy layouts)
      renderStatic();                                       // floor + walls around the new room
      return m.room;
    }
    // A dirty room is still usable (with penalties); a room mid-clean is NOT — it
    // refuses new patients until the 20s scrub finishes (or is abandoned).
    function beingCleaned(rm) { return (rm.cleanProg || 0) > 0; }
    function freeRoom(type) {                                // occupant-based rooms (not pharmacy)
      var L = ROOM_TYPES[type].list;
      for (var i = 0; i < L.length; i++) if (!L[i].occupant && !beingCleaned(L[i])) return L[i];
      return null;
    }

    // Catalog: the single source for the shop rows AND placement. `cat` picks the
    // shop tab; `kind:'staff'` items snap to a desk action-circle instead of a tile.
    // (drawChair/drawDesk are function declarations, hoisted, so usable here.)
    // ---- Dog-park toys (playful / agility set) ---------------------------
    function drawFrisbee(c, gx, gy) {
      furnShadow(c, gx - 0.3, gy - 0.3, gx + 0.3, gy + 0.3);
      isoBox(c, gx - 0.07, gy - 0.07, gx + 0.07, gy + 0.07, 15, '#d8c089', '#b89a5e', '#a2854c'); // little stand
      var s = iso(gx, gy);
      c.fillStyle = '#e8514a'; c.beginPath(); c.ellipse(s.x, s.y - 17, 9, 4.4, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#f4a7a1'; c.beginPath(); c.ellipse(s.x, s.y - 18, 5, 2.4, 0, 0, Math.PI * 2); c.fill();
    }
    function drawBallPit(c, gx, gy) {
      furnShadow(c, gx - 0.42, gy - 0.42, gx + 0.42, gy + 0.42);
      var s = iso(gx, gy);
      c.fillStyle = '#2f7fae'; c.beginPath(); c.ellipse(s.x, s.y + 2, 18, 9.5, 0, 0, Math.PI * 2); c.fill();  // tub wall
      c.fillStyle = '#3b9ad1'; c.beginPath(); c.ellipse(s.x, s.y - 1, 17, 9, 0, 0, Math.PI * 2); c.fill();    // rim
      c.fillStyle = '#aee0f5'; c.beginPath(); c.ellipse(s.x, s.y - 2, 13, 6.5, 0, 0, Math.PI * 2); c.fill();  // interior
      var cols = ['#e8514a', '#f4c542', '#4cc46a', '#5aa0e8', '#e87fc0'];
      for (var b = 0; b < 10; b++) {
        var h = hash(gx * 9 + b, gy * 5 - b);
        var bx = s.x + (h - 0.5) * 22, by = s.y - 3 + (hash(gx + b, gy - b) - 0.5) * 9;
        c.fillStyle = cols[(h * cols.length) | 0]; c.beginPath(); c.arc(bx, by, 2.6, 0, Math.PI * 2); c.fill();
      }
    }
    function drawSeesaw(c, gx, gy, rot) {
      rot = rot || 0;
      var ew = (rot & 1) ? 1 : 2, eh = (rot & 1) ? 2 : 1;
      furnShadow(c, gx - 0.4, gy - 0.4, gx + (ew - 1) + 0.4, gy + (eh - 1) + 0.4);
      var cx = gx + (ew - 1) / 2, cy = gy + (eh - 1) / 2;
      isoBox(c, cx - 0.14, cy - 0.14, cx + 0.14, cy + 0.14, 10, '#c23b54', '#9a2f44', '#86283a'); // fulcrum
      var e0 = iso(gx, gy), e1 = iso(gx + (ew - 1), gy + (eh - 1));   // the two ends along the long axis
      c.strokeStyle = '#f4c542'; c.lineWidth = 5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(e0.x, e0.y - 17); c.lineTo(e1.x, e1.y - 5); c.stroke();
      c.lineCap = 'butt';
      c.fillStyle = '#e8514a';
      c.beginPath(); c.arc(e0.x, e0.y - 19, 2.4, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(e1.x, e1.y - 7, 2.4, 0, Math.PI * 2); c.fill();
    }
    function drawTunnel(c, gx, gy, rot) {
      rot = rot || 0;
      var ew = (rot & 1) ? 1 : 2, eh = (rot & 1) ? 2 : 1;
      furnShadow(c, gx - 0.4, gy - 0.4, gx + (ew - 1) + 0.4, gy + (eh - 1) + 0.4);
      var a = iso(gx, gy), b = iso(gx + (ew - 1), gy + (eh - 1));    // the two open ends
      c.strokeStyle = '#4f93da'; c.lineWidth = 20; c.lineCap = 'round';
      c.beginPath(); c.moveTo(a.x, a.y - 11); c.lineTo(b.x, b.y - 11); c.stroke();   // tube body
      c.strokeStyle = '#6aa8ea'; c.lineWidth = 12;
      c.beginPath(); c.moveTo(a.x, a.y - 13); c.lineTo(b.x, b.y - 13); c.stroke();   // highlight ridge
      c.lineCap = 'butt';
      c.fillStyle = '#1f3b57'; c.beginPath(); c.ellipse(a.x, a.y - 11, 5, 9, 0, 0, Math.PI * 2); c.fill(); // dark mouth
    }
    function drawPool(c, gx, gy) {
      furnShadow(c, gx - 0.45, gy - 0.45, gx + 1.45, gy + 1.45);
      var s = iso(gx + 0.5, gy + 0.5);
      c.fillStyle = '#2f7fae'; c.beginPath(); c.ellipse(s.x, s.y + 3, 30, 16, 0, 0, Math.PI * 2); c.fill();   // outer wall
      c.fillStyle = '#7fd0ec'; c.beginPath(); c.ellipse(s.x, s.y, 28, 14.5, 0, 0, Math.PI * 2); c.fill();      // rim
      c.fillStyle = '#bfeaf8'; c.beginPath(); c.ellipse(s.x, s.y, 23, 11.5, 0, 0, Math.PI * 2); c.fill();       // water
      c.strokeStyle = 'rgba(255,255,255,0.6)'; c.lineWidth = 1.4;
      c.beginPath(); c.ellipse(s.x - 5, s.y - 1, 7, 3.2, 0, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.ellipse(s.x + 7, s.y + 2, 5, 2.4, 0, 0, Math.PI * 2); c.stroke();
    }
    // ---- Cat-park items (blank rooms become a cat playground) --------------
    function drawLitterBox(c, gx, gy) {
      furnShadow(c, gx - 0.3, gy - 0.3, gx + 0.3, gy + 0.3);
      isoBox(c, gx - 0.36, gy - 0.36, gx + 0.36, gy + 0.36, 8, '#7d5bbe', '#64489c', '#553d85'); // plastic tray
      var s = iso(gx, gy);
      c.fillStyle = '#e6d7ae'; c.beginPath(); c.ellipse(s.x, s.y - 8, 12, 6, 0, 0, Math.PI * 2); c.fill(); // sand
      for (var i = 0; i < 5; i++) {                                            // scattered grains
        var h = hash(gx * 7 + i, gy * 3 - i);
        c.fillStyle = h < 0.5 ? '#d4c295' : '#c9b684';
        c.beginPath(); c.arc(s.x + (h - 0.5) * 16, s.y - 8 + (hash(gx + i, gy - i) - 0.5) * 6, 1.2, 0, Math.PI * 2); c.fill();
      }
    }
    function drawCardboardBox(c, gx, gy) {
      furnShadow(c, gx - 0.3, gy - 0.3, gx + 0.3, gy + 0.3);
      isoBox(c, gx - 0.34, gy - 0.34, gx + 0.34, gy + 0.34, 13, '#caa368', '#a8834f', '#93713f'); // carton
      var s = iso(gx, gy);
      c.fillStyle = '#3a2c1c'; c.beginPath(); c.ellipse(s.x, s.y - 13, 9, 4.4, 0, 0, Math.PI * 2); c.fill(); // open top
      c.strokeStyle = '#e0bd85'; c.lineWidth = 2;                              // open flaps
      c.beginPath(); c.moveTo(s.x - 10, s.y - 14); c.lineTo(s.x - 14, s.y - 20); c.stroke();
      c.beginPath(); c.moveTo(s.x + 10, s.y - 14); c.lineTo(s.x + 14, s.y - 20); c.stroke();
    }
    function drawScratchPost(c, gx, gy) {
      furnShadow(c, gx - 0.3, gy - 0.3, gx + 0.3, gy + 0.3);
      isoBox(c, gx - 0.3, gy - 0.3, gx + 0.3, gy + 0.3, 6, '#8a8f98', '#6d727b', '#5e636b');   // base
      isoBox(c, gx - 0.1, gy - 0.1, gx + 0.1, gy + 0.1, 34, '#d8c089', '#b89a5e', '#a2854c');  // sisal post
      var s = iso(gx, gy);
      c.strokeStyle = '#93783f'; c.lineWidth = 1;                              // rope wraps
      for (var i = 0; i < 5; i++) { c.beginPath(); c.moveTo(s.x - 4, s.y - 10 - i * 5); c.lineTo(s.x + 4, s.y - 12 - i * 5); c.stroke(); }
    }
    function drawCatnip(c, gx, gy) {
      furnShadow(c, gx - 0.28, gy - 0.28, gx + 0.28, gy + 0.28);
      isoBox(c, gx - 0.26, gy - 0.26, gx + 0.26, gy + 0.26, 10, '#c96f4a', '#a55538', '#8f4930'); // terracotta pot
      var s = iso(gx, gy);
      c.fillStyle = '#4cc46a';                                                 // leafy clump
      c.beginPath(); c.ellipse(s.x, s.y - 15, 9, 5.5, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#6fdc8b';
      c.beginPath(); c.ellipse(s.x - 3, s.y - 18, 5, 3.2, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(s.x + 4, s.y - 17, 4, 2.6, 0, 0, Math.PI * 2); c.fill();
    }
    function drawCatTree(c, gx, gy) {
      furnShadow(c, gx - 0.34, gy - 0.34, gx + 0.34, gy + 0.34);
      isoBox(c, gx - 0.32, gy - 0.32, gx + 0.32, gy + 0.32, 6, '#b9a08a', '#997f69', '#856d59'); // base
      isoBox(c, gx - 0.09, gy - 0.09, gx + 0.09, gy + 0.09, 44, '#d8c089', '#b89a5e', '#a2854c'); // trunk
      var s = iso(gx, gy);
      c.fillStyle = '#7d5bbe'; c.beginPath(); c.ellipse(s.x - 6, s.y - 26, 8, 4, 0, 0, Math.PI * 2); c.fill(); // low perch
      c.fillStyle = '#9678d0'; c.beginPath(); c.ellipse(s.x + 2, s.y - 44, 10, 5, 0, 0, Math.PI * 2); c.fill(); // top perch
      c.strokeStyle = '#d94f6e'; c.lineWidth = 1.2;                            // dangling toy
      c.beginPath(); c.moveTo(s.x + 8, s.y - 43); c.lineTo(s.x + 8, s.y - 34); c.stroke();
      c.fillStyle = '#e8514a'; c.beginPath(); c.arc(s.x + 8, s.y - 32, 2.4, 0, Math.PI * 2); c.fill();
    }
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
      { id: 'pharmacy', name: 'Pharmacy', cost: 400, w: 4, h: 4, icon: '💊', cat: 'rooms', kind: 'pharmacy' },
      { id: 'shop', name: 'Shop', cost: 500, w: 5, h: 5, icon: '🛒', cat: 'rooms', kind: 'shop' },
      { id: 'grooming', name: 'Grooming', cost: 450, w: 3, h: 6, icon: '🛁', cat: 'rooms', kind: 'grooming' },
      { id: 'hotel', name: 'Pet Hotel', cost: 1100, w: 6, h: 5, icon: '🏨', cat: 'rooms', kind: 'hotel' },
      { id: 'surgery', name: 'Surgery', cost: 1500, w: 4, h: 5, icon: '⚕️', cat: 'rooms', kind: 'surgery' },
      { id: 'pharmacist', name: 'Pharmacist', cost: 600, w: 1, h: 1, icon: '🧑‍🔬', cat: 'staff', kind: 'pharmstaff' },
      { id: 'cleaner', name: 'Cleaner', cost: 400, w: 1, h: 1, icon: '🧹', cat: 'staff', kind: 'cleaner' },
      { id: 'worker', name: 'Worker', cost: 350, w: 1, h: 1, icon: '🧼', cat: 'staff', kind: 'worker' },
      { id: 'dogpark', name: 'Dog Park', cost: 20, icon: '🐾', cat: 'park', kind: 'park', perSquare: true },
      { id: 'frisbee', name: 'Frisbee Stand', cost: 40,  w: 1, h: 1, icon: '🥏', cat: 'park', parkItem: true, quality: 2, draw: drawFrisbee },
      { id: 'ballpit', name: 'Ball Pit',      cost: 70,  w: 1, h: 1, icon: '🔴', cat: 'park', parkItem: true, quality: 3, draw: drawBallPit },
      { id: 'seesaw',  name: 'Seesaw',        cost: 80,  w: 2, h: 1, icon: '🛝', cat: 'park', parkItem: true, quality: 4, draw: drawSeesaw },
      { id: 'tunnel',  name: 'Tunnel',        cost: 90,  w: 2, h: 1, icon: '🛢️', cat: 'park', parkItem: true, quality: 4, draw: drawTunnel },
      { id: 'pool',    name: 'Paddling Pool', cost: 120, w: 2, h: 2, icon: '🏊', cat: 'park', parkItem: true, quality: 6, draw: drawPool },
      // Cat Room: the cat-side counterpart of Dog Park — same blank-room brush
      // (kind 'blank'), surfaced in the Park tab's Cats column for discoverability.
      { id: 'catroom', name: 'Cat Room', cost: 10, icon: '🐱', cat: 'park', kind: 'blank', perSquare: true, catItem: true },
      { id: 'litterbox', name: 'Litter Box',      cost: 40,  w: 1, h: 1, icon: '🚽', cat: 'park', catItem: true, quality: 2, draw: drawLitterBox },
      { id: 'catbox',    name: 'Cardboard Box',   cost: 45,  w: 1, h: 1, icon: '📦', cat: 'park', catItem: true, quality: 2, draw: drawCardboardBox },
      { id: 'scratcher', name: 'Scratching Post', cost: 60,  w: 1, h: 1, icon: '🪵', cat: 'park', catItem: true, quality: 3, draw: drawScratchPost },
      { id: 'catnip',    name: 'Catnip Planter',  cost: 80,  w: 1, h: 1, icon: '🪴', cat: 'park', catItem: true, quality: 4, draw: drawCatnip },
      { id: 'cattree',   name: 'Cat Tree',        cost: 120, w: 1, h: 1, icon: '🐈', cat: 'park', catItem: true, quality: 6, draw: drawCatTree }
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
    // The static layer (grass/road/floor) is procedurally heavy, so we bake it once
    // into `bg`. To pan smoothly we bake it into a buffer PADDED by STATIC_PAD px on
    // every side and just translate that cached bitmap by the camera delta each frame
    // — re-baking only when a drag scrolls past the padding (see draw()/dragMove()).
    var STATIC_PAD = 220;
    var staticCamX = 0, staticCamY = 0;    // camera position at the last renderStatic() bake
    var bg = document.createElement('canvas'), bgx = bg.getContext('2d');
    var fg = document.createElement('canvas'), fgx = fg.getContext('2d');
    var ghostC = document.createElement('canvas'), ghostCtx = ghostC.getContext('2d'); // for tinting the placement preview
    // The vignette is screen-anchored and never changes except on resize, so we
    // bake it once here and blit it each frame instead of rasterising a full-canvas
    // radial-gradient fill every frame (see draw()).
    var vig = document.createElement('canvas'), vigx = vig.getContext('2d');
    function buildVignette() {
      vig.width = canvas.width; vig.height = canvas.height;
      var cx = canvas.width / 2, cy = canvas.height / 2;
      var g = vigx.createRadialGradient(cx, cy, Math.min(canvas.width, canvas.height) * 0.35,
                                        cx, cy, Math.max(canvas.width, canvas.height) * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
      vigx.clearRect(0, 0, vig.width, vig.height);
      vigx.fillStyle = g; vigx.fillRect(0, 0, vig.width, vig.height);
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      view.w = rect.width; view.h = rect.height; view.dpr = dpr;
      canvas.width = ghostC.width = Math.round(rect.width * dpr);
      canvas.height = ghostC.height = Math.round(rect.height * dpr);
      // bg/fg carry STATIC_PAD of pre-rendered margin so panning has room to translate.
      bg.width = fg.width = Math.round((rect.width + 2 * STATIC_PAD) * dpr);
      bg.height = fg.height = Math.round((rect.height + 2 * STATIC_PAD) * dpr);
      // Centre the room; nudge up so the front path has room below.
      var c = isoRaw(ROOM / 2 - 0.5, ROOM / 2 - 0.5);
      camera.x = view.w / 2 - c.x;
      camera.y = view.h / 2 - c.y - 28;
      buildVignette();
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
      c.fillStyle = light ? '#ffffff' : '#f1f3f5';
      c.fill();
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      // faint per-tile shade variance (neutral grey, no blue cast)
      c.fillStyle = 'rgba(150,152,158,' + (0.03 + h * 0.05).toFixed(3) + ')';
      c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      // glossy vinyl sheen sweeping down from the top corner
      var hg = c.createLinearGradient(s.x, s.y - TILE_HH, s.x, s.y + TILE_HH);
      hg.addColorStop(0, 'rgba(255,255,255,0.30)');
      hg.addColorStop(0.5, 'rgba(255,255,255,0.05)');
      hg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = hg;
      c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      // a few mineral specks + the occasional scuff mark
      fleck(c, s, gx, gy, 5, 0.7, 1.2, function () { return 'rgba(168,170,176,0.22)'; });
      if (hash(gx * 7 + 5, gy * 7 + 9) > 0.9) {
        c.strokeStyle = 'rgba(138,140,148,0.25)'; c.lineWidth = 1.4;
        c.beginPath(); c.arc(s.x + (h - 0.5) * 14, s.y + (h - 0.4) * 7, 4, 0.2, 2.2); c.stroke();
      }
      c.restore();
      // bevelled polished tile + grout
      bevel(c, s, 1, 'rgba(255,255,255,0.32)', 'rgba(170,172,178,0.35)');
      c.strokeStyle = 'rgba(176,178,184,0.55)';
      c.lineWidth = 1;
      diamondPath(c, s.x, s.y); c.stroke();
    }

    // Restroom floors: classic ceramic checkerboard. Each grid square splits
    // into a 2×2 grid of half-size tiles alternating white and blue, so the
    // pattern runs continuously across the whole room at half-tile scale.
    function restroomTile(c, gx, gy) {
      var s = iso(gx, gy);
      for (var i = 0; i < 2; i++) {
        for (var j = 0; j < 2; j++) {
          var q = iso(gx - 0.25 + i * 0.5, gy - 0.25 + j * 0.5);
          c.beginPath();
          c.moveTo(q.x, q.y - TILE_HH / 2);
          c.lineTo(q.x + TILE_HW / 2, q.y);
          c.lineTo(q.x, q.y + TILE_HH / 2);
          c.lineTo(q.x - TILE_HW / 2, q.y);
          c.closePath();
          c.fillStyle = ((i + j) % 2 === 0) ? '#ffffff' : '#7db3d8';
          c.fill();
          c.strokeStyle = 'rgba(105,140,165,0.45)'; c.lineWidth = 1;
          c.stroke();
        }
      }
      // glossy ceramic sheen sweeping down from the top corner
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      var hg = c.createLinearGradient(s.x, s.y - TILE_HH, s.x, s.y + TILE_HH);
      hg.addColorStop(0, 'rgba(255,255,255,0.28)');
      hg.addColorStop(0.5, 'rgba(255,255,255,0.05)');
      hg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = hg;
      c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      c.restore();
      // grout line around the full grid square
      c.strokeStyle = 'rgba(105,140,165,0.55)'; c.lineWidth = 1;
      diamondPath(c, s.x, s.y); c.stroke();
    }

    // Plain corridors get a soft teal runner so passages read clearly differently
    // from the glossy white vinyl of the clinic, blank rooms and exam rooms.
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

    // Hotel lobby floor: warm honey parquet-style tiles overdrawn on the room's
    // footprint (like the restroom ceramic), with a pale rug across the centre.
    function hotelFloorTile(c, gx, gy) {
      var s = iso(gx, gy);
      var h = hash(gx + 31, gy + 17);
      diamondPath(c, s.x, s.y);
      c.fillStyle = ((gx + gy) % 2 === 0) ? '#e4c99a' : '#dcbf8e';
      c.fill();
      c.save();
      diamondPath(c, s.x, s.y); c.clip();
      c.fillStyle = 'rgba(122,84,40,' + (0.04 + h * 0.05).toFixed(3) + ')';
      c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      // plank grain
      c.strokeStyle = 'rgba(122,84,40,0.18)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(s.x - TILE_HW * 0.5, s.y - TILE_HH * 0.25); c.lineTo(s.x + TILE_HW * 0.5, s.y + TILE_HH * 0.25); c.stroke();
      c.restore();
      bevel(c, s, 1, 'rgba(255,250,238,0.30)', 'rgba(122,84,40,0.28)');
      c.strokeStyle = 'rgba(140,100,50,0.4)'; c.lineWidth = 1;
      diamondPath(c, s.x, s.y); c.stroke();
    }
    function hotelRugTile(c, gx, gy) {
      var s = iso(gx, gy);
      diamondPath(c, s.x, s.y);
      c.fillStyle = ((gx + gy) % 2 === 0) ? '#c96f4a' : '#c2683f';
      c.fill();
      c.save(); diamondPath(c, s.x, s.y); c.clip();
      fleck(c, s, gx + 5, gy + 9, 10, 0.7, 1.0, function () { return 'rgba(255,236,214,0.16)'; });
      c.restore();
      bevel(c, s, 1, 'rgba(255,236,214,0.25)', 'rgba(120,50,28,0.30)');
    }

    // Dog-park turf: the lawn base + a faint mowed stripe so it reads as a tended
    // park rather than the wild grass outside.
    function parkTile(c, gx, gy) {
      grassTile(c, gx, gy);
      var s = iso(gx, gy);
      c.save(); diamondPath(c, s.x, s.y); c.clip();
      c.fillStyle = ((gx + gy) % 2 === 0) ? 'rgba(255,255,255,0.07)' : 'rgba(36,84,40,0.09)';
      c.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      c.restore();
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
    // A low white picket fence along a tile edge a→b (the open-air Dog Park border).
    function drawParkFence(c, ax, ay, bx, by) {
      var a = iso(ax, ay), b = iso(bx, by), H = 17;
      c.strokeStyle = '#c2cbb2'; c.lineWidth = 2;                               // two rails
      c.beginPath(); c.moveTo(a.x, a.y - H + 5); c.lineTo(b.x, b.y - H + 5); c.stroke();
      c.beginPath(); c.moveTo(a.x, a.y - 4); c.lineTo(b.x, b.y - 4); c.stroke();
      for (var i = 0; i <= 2; i++) {                                            // three pickets
        var t = i / 2, px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        c.strokeStyle = '#eef2e6'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(px, py - H); c.lineTo(px, py); c.stroke();
      }
    }
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
      // NOTE: pure drawing only — the doorway is registered in `doorways` by D()
      // at collect time. Registering here (per draw call) leaked a duplicate entry
      // every frame, growing update()'s door scan and draw()'s scene unboundedly.
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
    // Content ceiling (screen px above the floor line) for segments that carry a
    // shelf/decor billboard — taller than the wall itself (shelf pill caps, the
    // X-ray board's glow) so their sprite bbox covers everything drawn on the wall.
    var BILLBOARD_H = 78;
    function collectWalls() {
      // Every wall / door / wall-decoration / entrance-frame segment becomes a
      // depth-sorted scene item drawn live in draw(), so walls interleave with
      // furniture and characters by their foot depth (no more baked bg/fg split).
      // d = midpoint grid-sum ((ax+ay+bx+by)/2) — the SAME scale as an actor's
      // gx+gy, so a back wall sorts just behind, a front wall just in front of, an
      // actor sharing its tile, and nearer structures always paint over farther.
      wallSegs.length = 0;
      // _ax/_ay/_bx/_by/_htop tag each segment with its wall edge + content height so
      // the bake pass at the end can sprite-cache it; _key identifies the CONTENT so
      // identical segments (same look, same edge shape) share one cached sprite
      // (wall pixels are translation-invariant — see bakeWallSprites below).
      function W(isTall, ax, ay, bx, by, H, c1, c2, c3, c4) {
        wallSegs.push({ d: (ax + ay + bx + by) / 2, _ax: ax, _ay: ay, _bx: bx, _by: by, _htop: H,
          _key: 'W' + H + c1 + c2 + c3 + c4,
          fn: function () { wallFace(ctx, ax, ay, bx, by, H, c1, c2, c3, c4); } });
      }
      function D(isTall, ax, ay, bx, by, H, opts) {
        // register the animated doorway ONCE here (collect time), never in the draw fn
        doorways.push({ ax: ax, ay: ay, bx: bx, by: by, H: H,
                        style: (opts && opts.style) || 'slide', inx: (opts && opts.inx) || 0, iny: (opts && opts.iny) || 0 });
        wallSegs.push({ d: (ax + ay + bx + by) / 2, _ax: ax, _ay: ay, _bx: bx, _by: by, _htop: H,
          _key: 'D' + H + ((opts && opts.style) || '') + ((opts && opts.inx) || 0) + ((opts && opts.iny) || 0),
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
        if (park[key]) continue;             // dog-park tiles get a fence, not walls (below)
        var p = key.split(','), x = +p[0], y = +p[1];
        var hp = hotelAt(x, y) ? HOTEL_PAL : null;   // hotel perimeter walls keep the warm palette
        if (!isRoomFloor(x - 1, y)) { var c1 = hp ? hp.w : ['#fbfdfe', '#e2ecf1', '#ffffff', '#37b3a3']; W(true,  x - 0.5, y - 0.5, x - 0.5, y + 0.5, WALL_H, c1[0], c1[1], c1[2], c1[3]); }
        if (!isRoomFloor(x, y - 1)) { var c2 = hp ? hp.n : ['#e4edf2', '#cad9e2', '#eef4f7', '#2f9e90']; W(true,  x - 0.5, y - 0.5, x + 0.5, y - 0.5, WALL_H, c2[0], c2[1], c2[2], c2[3]); }
        if (!isRoomFloor(x + 1, y)) { var c3 = hp ? hp.e : ['#dbe7ed', '#c2d3dd', '#e9f1f4', '#2f9e90']; W(false, x + 0.5, y - 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, c3[0], c3[1], c3[2], c3[3]); }
        if (!isRoomFloor(x, y + 1)) { var c4 = hp ? hp.s : ['#eef5f8', '#d7e4eb', '#f6fafb', '#37b3a3']; W(false, x - 0.5, y + 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, c4[0], c4[1], c4[2], c4[3]); }
      }
      // dog-park borders: a low fence on each edge that faces open grass (edges
      // facing the building stay open so visitors can walk in). Pushed as scene
      // items so the fence depth-sorts with everyone like the walls do.
      for (var pk in park) {
        if (!park.hasOwnProperty(pk)) continue;
        var pp = pk.split(','), px = +pp[0], py = +pp[1];
        (function (x, y) {
          if (!isRoomFloor(x - 1, y)) wallSegs.push({ d: x - 0.5 + y, fn: function () { drawParkFence(ctx, x - 0.5, y - 0.5, x - 0.5, y + 0.5); } });
          if (!isRoomFloor(x, y - 1)) wallSegs.push({ d: x + y - 0.5, fn: function () { drawParkFence(ctx, x - 0.5, y - 0.5, x + 0.5, y - 0.5); } });
          if (!isRoomFloor(x + 1, y)) wallSegs.push({ d: x + 0.5 + y, fn: function () { drawParkFence(ctx, x + 0.5, y - 0.5, x + 0.5, y + 0.5); } });
          if (!isRoomFloor(x, y + 1)) wallSegs.push({ d: x + y + 0.5, fn: function () { drawParkFence(ctx, x - 0.5, y + 0.5, x + 0.5, y + 0.5); } });
        })(px, py);
      }
      // Walled rooms (exam / xray / restroom / pharmacy): wall every corridor-
      // facing edge, punching a brown doorway at the room's door tile. One generic
      // pass over the room registry — membership is a tile-set lookup so it works
      // for any footprint (rectangular or rotated). Order matches the registry so
      // equal-depth segments sort identically to before.
      function roomWalls(rm, tiles, pal) {
        var door = rm.door, set = {};
        var pw = (pal && pal.w) || ['#fbfdfe', '#e2ecf1', '#ffffff', '#37b3a3'];
        var pn = (pal && pal.n) || ['#e4edf2', '#cad9e2', '#eef4f7', '#2f9e90'];
        var pe = (pal && pal.e) || ['#dbe7ed', '#c2d3dd', '#e9f1f4', '#2f9e90'];
        var ps = (pal && pal.s) || ['#eef5f8', '#d7e4eb', '#f6fafb', '#37b3a3'];
        tiles.forEach(function (t) { set[t.x + ',' + t.y] = true; });
        function mine(x, y) { return !!set[x + ',' + y]; }
        function isDoor(x, y) { return door && door.x === x && door.y === y; }
        tiles.forEach(function (t) {
          var x = t.x, y = t.y;
          if (!mine(x - 1, y) && isRoomFloor(x - 1, y)) { if (isDoor(x - 1, y)) D(true, x - 0.5, y - 0.5, x - 0.5, y + 0.5, WALL_H, { style: 'brown', inx: 1, iny: 0 }); else W(true, x - 0.5, y - 0.5, x - 0.5, y + 0.5, WALL_H, pw[0], pw[1], pw[2], pw[3]); }
          if (!mine(x, y - 1) && isRoomFloor(x, y - 1)) { if (isDoor(x, y - 1)) D(true, x - 0.5, y - 0.5, x + 0.5, y - 0.5, WALL_H, { style: 'brown', inx: 0, iny: 1 }); else W(true, x - 0.5, y - 0.5, x + 0.5, y - 0.5, WALL_H, pn[0], pn[1], pn[2], pn[3]); }
          if (!mine(x + 1, y) && isRoomFloor(x + 1, y)) { if (isDoor(x + 1, y)) D(false, x + 0.5, y - 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, { style: 'brown', inx: -1, iny: 0 }); else W(false, x + 0.5, y - 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, pe[0], pe[1], pe[2], pe[3]); }
          if (!mine(x, y + 1) && isRoomFloor(x, y + 1)) { if (isDoor(x, y + 1)) D(false, x - 0.5, y + 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, { style: 'brown', inx: 0, iny: -1 }); else W(false, x - 0.5, y + 0.5, x + 0.5, y + 0.5, FRONT_WALL_H, ps[0], ps[1], ps[2], ps[3]); }
        });
      }
      ['exam', 'xray', 'restroom', 'pharmacy', 'shop', 'grooming', 'surgery'].forEach(function (type) {
        var d = ROOM_TYPES[type];
        d.list.forEach(function (rm) { roomWalls(rm, d.tiles(rm.gx, rm.gy, rm.rot || 0)); });
      });
      hotels.forEach(function (rm) { roomWalls(rm, hotelTiles(rm.gx, rm.gy), HOTEL_PAL); });   // warm lobby tones
      // Pharmacy: shelving billboarded on the two TALL back walls — the north edge
      // (each tile's y-1 neighbour) and the west edge (x-1 neighbour). The
      // back-right (north) wall carries the apothecary-jar/bottle supply shelves;
      // the back-left (west) wall the colourful medicine boxes — so the two walls
      // read distinctly. One scene item per back-wall tile, at that wall's exact
      // depth, so a pharmacist standing in front occludes the shelves behind them.
      // Shelved on EVERY back-wall tile except the doorway, so a pharmacy is
      // stocked the same way wherever it sits. Where a back edge faces open
      // grass/perimeter (roomWalls drew no wall), a matching tall wall is added
      // first so the shelves always have a surface.
      pharmacies.forEach(function (ph) {
        var gx = ph.gx, gy = ph.gy, dr = ph.door;
        function isDoor(nx, ny) { return dr && dr.x === nx && dr.y === ny; }
        for (var i = 0; i < PHARM_W; i++) (function (x) {      // back-right (north) wall — supplies
          if (isDoor(x, gy - 1)) return;
          if (!isRoomFloor(x, gy - 1)) W(true, x - 0.5, gy - 0.5, x + 0.5, gy - 0.5, WALL_H, '#e4edf2', '#cad9e2', '#eef4f7', '#2f9e90');
          wallSegs.push({ d: x + gy - 0.5, _ax: x - 0.5, _ay: gy - 0.5, _bx: x + 0.5, _by: gy - 0.5, _htop: BILLBOARD_H, _key: 'sup' + (x + gy), fn: function () {
            drawSupplyShelf(ctx, x - 0.5, gy - 0.5, x + 0.5, gy - 0.5, x + gy);
          } });
        })(gx + i);
        for (var j = 0; j < PHARM_H; j++) (function (y) {      // back-left (west) wall — medicine
          if (isDoor(gx - 1, y)) return;
          if (!isRoomFloor(gx - 1, y)) W(true, gx - 0.5, y - 0.5, gx - 0.5, y + 0.5, WALL_H, '#fbfdfe', '#e2ecf1', '#ffffff', '#37b3a3');
          wallSegs.push({ d: gx + y - 0.5, _ax: gx - 0.5, _ay: y - 0.5, _bx: gx - 0.5, _by: y + 0.5, _htop: BILLBOARD_H, _key: 'med' + (gx + y + 3), fn: function () {
            drawMedShelf(ctx, gx - 0.5, y - 0.5, gx - 0.5, y + 0.5, gx + y + 3);
          } });
        })(gy + j);
      });
      // Shop: retail-goods shelving on both TALL back walls, every tile except the
      // doorway, with a fallback wall where a back edge faces open grass/perimeter.
      shops.forEach(function (sh) {
        var gx = sh.gx, gy = sh.gy, dr = sh.door;
        function isDoor(nx, ny) { return dr && dr.x === nx && dr.y === ny; }
        for (var i = 0; i < SHOP_W; i++) (function (x) {       // back-right (north) wall
          if (isDoor(x, gy - 1)) return;
          if (!isRoomFloor(x, gy - 1)) W(true, x - 0.5, gy - 0.5, x + 0.5, gy - 0.5, WALL_H, '#e4edf2', '#cad9e2', '#eef4f7', '#2f9e90');
          wallSegs.push({ d: x + gy - 0.5, _ax: x - 0.5, _ay: gy - 0.5, _bx: x + 0.5, _by: gy - 0.5, _htop: BILLBOARD_H, _key: 'shp' + (x + gy), fn: function () {
            drawShopShelf(ctx, x - 0.5, gy - 0.5, x + 0.5, gy - 0.5, x + gy);
          } });
        })(gx + i);
        for (var j = 0; j < SHOP_H; j++) (function (y) {       // back-left (west) wall
          if (isDoor(gx - 1, y)) return;
          if (!isRoomFloor(gx - 1, y)) W(true, gx - 0.5, y - 0.5, gx - 0.5, y + 0.5, WALL_H, '#fbfdfe', '#e2ecf1', '#ffffff', '#37b3a3');
          wallSegs.push({ d: gx + y - 0.5, _ax: gx - 0.5, _ay: y - 0.5, _bx: gx - 0.5, _by: y + 0.5, _htop: BILLBOARD_H, _key: 'shp' + (gx + y + 2), fn: function () {
            drawShopShelf(ctx, gx - 0.5, y - 0.5, gx - 0.5, y + 0.5, gx + y + 2);
          } });
        })(gy + j);
      });
      // Hotel (6 × 5): PET HOTEL sign + awning centred on the back-right wall,
      // flanked by paw plaques, a clock and framed pet portraits; the back-left
      // (dog-wing) wall carries a dog portrait and a paw plaque.
      hotels.forEach(function (h) {
        hangBackWall(h, HOTEL_W, HOTEL_H,
          [drawDogPortrait, drawPawPlaque, drawHotelSign, drawWallClock, drawPawPlaque, drawCatPortrait],
          [drawDogPortrait, null, drawPawPlaque, null, null], HOTEL_PAL);
      });
      // X-ray rooms (3 wide × 4 deep): the light-up viewing box is the centrepiece
      // of the back-right wall, flanked by a radiation sign + clock; the back-left
      // wall carries a lead apron and a film cabinet.
      xrayRooms.forEach(function (rm) {
        hangBackWall(rm, 3, 4,
          [drawRadSign, drawXrayBoard, drawWallClock],
          [drawLeadApron, function cabinetPlain(c, P) { drawCabinet(c, P, false); }, null, null]);
      });
      // Surgery theatres (4 wide × 5 deep): anatomy chart + red-cross cabinet on
      // the back-right wall with a clock; certificate, health poster and a plain
      // supply cabinet down the back-left wall.
      surgeries.forEach(function (rm) {
        hangBackWall(rm, SURG_W, SURG_H,
          [drawCertificate, drawAnatomyPoster, function cabinetCross2(c, P) { drawCabinet(c, P, true); }, drawWallClock],
          [drawHealthPoster, null, function cabinetPlain2(c, P) { drawCabinet(c, P, false); }, null, null]);
      });
      // Exam rooms (3 × 3): an anatomy chart centred on the back-right wall, framed
      // by a diploma + clock; the back-left wall has a red-cross supply cabinet and
      // a health poster.
      examRooms.forEach(function (rm) {
        hangBackWall(rm, 3, 3,
          [drawCertificate, drawAnatomyPoster, drawWallClock],
          [function cabinetCross(c, P) { drawCabinet(c, P, true); }, drawHealthPoster, null]);
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
      // (wall-mounted decorations — window, certificate, clock, vet-cross poster —
      // removed for now per request; the rLB/rRB billboard helpers above are kept
      // for when they come back.)
      // entrance frame: front perimeter (gy = ROOM-0.5), so it draws in front of
      // the clinic interior just like the short front walls it sits on.
      wallSegs.push({ d: DOOR_MID + (ROOM - 0.5), fn: function () { drawDoorFrame(ctx); } });
      bakeWallSprites();
    }

    // Sprite-cache every tagged wall segment: rasterize its procedural drawing ONCE
    // (here, at collect time) into a small offscreen canvas and swap its per-frame
    // fn for a single drawImage blit. Depth-sorting in draw() is untouched — only
    // each fn's body changes — so walls still interleave with actors correctly.
    // Untagged segments (park fences, the entrance frame) stay live: they're few
    // and cheap. The camera is a pure translation (no zoom), so sprite pixels are
    // camera-invariant relative to their grid anchor: ox/oy/bw/bh below are all
    // camera-free deltas, and the blit re-reads the live camera through iso() —
    // pans need NO re-bake. (If zoom is ever added, re-run collectWalls on zoom.)
    // Baking works by swapping the module `ctx` var — every draw fn reads it at
    // call time — so the original closures render into the sprite unchanged.
    var wallSpritesOn = true;              // debug/benchmark switch (see __t.setWallSprites)
    // Sprite cache shared ACROSS collectWalls() runs. Wall pixels are translation-
    // invariant, so the cache key is content (_key) + edge DELTA + height + dpr —
    // not absolute position. Every identical wall/shelf/door in the clinic shares
    // ONE sprite, and rebuilding walls (placement toggles, far pans, room moves)
    // re-rasterizes nothing that was seen before — no re-bake hitch.
    var wallSpriteCache = {};              // key -> {spr, ox, oy, bw, bh}
    function bakeWallSprites() {
      if (!wallSpritesOn) return;          // benchmark mode: leave the live vector fns
      var MARGIN = 16, TOPMARGIN = 16, BOTMARGIN = 8;
      var realCtx = ctx, dpr = view.dpr;
      // dpr changed (window moved between monitors) → every entry is stale; drop all.
      if (wallSpriteCache._dpr !== dpr) wallSpriteCache = { _dpr: dpr };
      for (var si = 0; si < wallSegs.length; si++) {
        var seg = wallSegs[si];
        if (seg._ax === undefined) continue;           // untagged → keeps its live fn
        var key = seg._key + '|' + (seg._bx - seg._ax) + ',' + (seg._by - seg._ay) + '|' + seg._htop;
        var hit = wallSpriteCache[key];
        if (!hit) {
          var A = iso(seg._ax, seg._ay), B = iso(seg._bx, seg._by);
          var sx0 = Math.min(A.x, B.x) - MARGIN;
          var sy0 = Math.min(A.y, B.y) - seg._htop - TOPMARGIN;
          var bw = (Math.max(A.x, B.x) + MARGIN) - sx0;
          var bh = (Math.max(A.y, B.y) + BOTMARGIN) - sy0;
          var spr = document.createElement('canvas');
          spr.width = Math.ceil(bw * dpr); spr.height = Math.ceil(bh * dpr);
          var sctx = spr.getContext('2d');
          // Map the fn's live screen coords (isoRaw + bake camera) into sprite px.
          sctx.setTransform(dpr, 0, 0, dpr, -sx0 * dpr, -sy0 * dpr);
          ctx = sctx; seg.fn(); ctx = realCtx;         // vector draw → sprite, once ever
          // ox/oy are camera-free deltas from the segment's A endpoint — and they
          // depend only on the edge delta, so they're valid for every segment
          // sharing this key regardless of where it sits on the grid.
          hit = wallSpriteCache[key] = { spr: spr, ox: sx0 - A.x, oy: sy0 - A.y, bw: bw, bh: bh };
        }
        (function (seg, s, ax, ay) {
          seg.fn = function () {                       // per-frame: one blit
            var P = iso(ax, ay);
            ctx.drawImage(s.spr, P.x + s.ox, P.y + s.oy, s.bw, s.bh);  // dest size in CSS px — mandatory under the dpr transform
          };
        })(seg, hit, seg._ax, seg._ay);
      }
    }

    // ---- Character sprite cache -------------------------------------------
    // Same idea as bakeWallSprites, for people/pets: the procedurally-drawn body
    // is rasterized ONCE per (variant, facing, pose-bucket) into a small offscreen
    // canvas and blitted per frame. Continuous walk/gait sines are quantized into
    // buckets (≤ ~0.5px difference per bucket — invisible at this art scale), and
    // everything genuinely dynamic (shadows tied to bars, patience bars, emoji
    // bubbles, anger steam, leashes to a moving hand, carried-lift transforms,
    // ghosts) stays live. Lazily baked on first use; the whole cache is wiped when
    // it hits the cap (rebakes are ~0.1ms each) or when dpr changes.
    var charSpritesOn = true;              // debug/benchmark switch (see __t.setCharSprites)
    var CHAR_CACHE_MAX = 600;
    var charSpriteCache = {}, charSpriteN = 0, charSpriteDpr = 0;
    // local bounds around the anchor (feet / ground centre), CSS px
    var VIS_BOX     = { x0: -16, y0: -66, w: 32, h: 72 };   // visitor body (torso/head/legs)
    var SHADOW_BOX  = { x0: -16, y0: -9,  w: 32, h: 18 };   // shared ground shadow
    var BUBBLE_BOX  = { x0: -13, y0: -13, w: 26, h: 28 };   // emoji status bubble
    var PET_BOX     = { x0: -22, y0: -32, w: 44, h: 44 };   // dog or cat incl. leash/tail/shadow
    var CARRIER_BOX = { x0: -12, y0: -10, w: 24, h: 28 };   // held/set-down cat carrier
    var STAFF_BOX   = { x0: -22, y0: -70, w: 44, h: 82 };   // staff figure incl. mop/brush props
    // paint(c) draws in anchor-local coords (anchor at 0,0) into the sprite ctx.
    function charSprite(key, box, paint) {
      if (charSpriteDpr !== view.dpr) { charSpriteCache = {}; charSpriteN = 0; charSpriteDpr = view.dpr; }
      var spr = charSpriteCache[key];
      if (!spr) {
        if (charSpriteN >= CHAR_CACHE_MAX) { charSpriteCache = {}; charSpriteN = 0; }
        var dpr = view.dpr;
        spr = document.createElement('canvas');
        spr.width = Math.ceil(box.w * dpr); spr.height = Math.ceil(box.h * dpr);
        var sc = spr.getContext('2d');
        sc.setTransform(dpr, 0, 0, dpr, -box.x0 * dpr, -box.y0 * dpr);
        var real = ctx; ctx = sc;          // draw fns read the module ctx at call time
        paint(sc);
        ctx = real;
        charSpriteCache[key] = spr; charSpriteN++;
      }
      return spr;
    }
    function blitChar(spr, box, x, y) { ctx.drawImage(spr, x + box.x0, y + box.y0, box.w, box.h); }
    // Cached blit for a staff figure whose draw fn renders at iso(gx,gy) screen
    // coords: the bake shifts those into anchor-local space (translate by -iso),
    // and the blit follows the live iso(gx,gy) — so roaming staff move for free.
    // No staff figure animates its legs; the only axes are kind/gender/facing,
    // which the caller encodes in `key`.
    function staffSprite(key, gx, gy, paint) {
      if (!charSpritesOn) return paint(ctx, gx, gy);
      var spr = charSprite(key, STAFF_BOX, function (c) {
        var s0 = iso(gx, gy);
        c.translate(-s0.x, -s0.y);
        paint(c, gx, gy);
      });
      var s = iso(gx, gy);
      blitChar(spr, STAFF_BOX, s.x, s.y);
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
      staticCamX = camera.x; staticCamY = camera.y;   // remember where this bake was centred
      // Shift the bake by STATIC_PAD so screen coord (x,y) lands at buffer pixel (x+PAD,y+PAD),
      // leaving a pre-rendered margin on every side for the pan to translate into.
      var P = STATIC_PAD * view.dpr;
      bgx.setTransform(view.dpr, 0, 0, view.dpr, P, P);
      fgx.setTransform(view.dpr, 0, 0, view.dpr, P, P);
      bgx.clearRect(-STATIC_PAD, -STATIC_PAD, view.w + 2 * STATIC_PAD, view.h + 2 * STATIC_PAD);
      fgx.clearRect(-STATIC_PAD, -STATIC_PAD, view.w + 2 * STATIC_PAD, view.h + 2 * STATIC_PAD);
      doorways.length = 0;                  // rebuilt by D() as collectWalls() runs (below)
      wallSegs.length = 0;                   // cleared so walls vanish while placing (collectWalls rebuilds)

      // 1) grass: cover the whole padded viewport (grid bbox of the 4 padded corners)
      var corners = [screenToGrid(-STATIC_PAD, -STATIC_PAD), screenToGrid(view.w + STATIC_PAD, -STATIC_PAD),
                     screenToGrid(-STATIC_PAD, view.h + STATIC_PAD), screenToGrid(view.w + STATIC_PAD, view.h + STATIC_PAD)];
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
        if (park[ckey]) parkTile(bgx, cgx, cgy);                    // dog park → grass turf
        else if (isPlainCorridor(cgx, cgy)) carpetTile(bgx, cgx, cgy);   // passages → carpet runner
        else floorTile(bgx, cgx, cgy);                             // blank/exam/etc → vinyl
      }
      // restrooms overdraw their footprint (clinic floor or corridor) with
      // the white/blue ceramic checkerboard
      restrooms.forEach(function (rm) {
        footprintTiles(FURN_BY_ID.restroom, rm.gx, rm.gy, rm.rot || 0).forEach(function (t) {
          restroomTile(bgx, t.x, t.y);
        });
      });
      // hotels overdraw warm parquet + a rug strip in front of the desk
      hotels.forEach(function (h) {
        hotelTiles(h.gx, h.gy).forEach(function (t) { hotelFloorTile(bgx, t.x, t.y); });
        hotelRugTile(bgx, h.gx + 2, h.gy + 2); hotelRugTile(bgx, h.gx + 3, h.gy + 2);
      });
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
      if (v.wantsHotel || v.phase === 'toHotel' || v.phase === 'toHotelPickup') return '🏨';
      if (v.phase === 'toShop' || v.phase === 'inShop') return '🛍️';
      if (v.phase === 'toDogPark' || v.phase === 'inDogPark') return '🐾';
      if (v.wantsGroom && !v.groomed) return '🛁'; // wants / getting a groom
      if (!v.served) return '💻';                 // arriving / in line → needs reception
      if (!v.examined) return '🩺';               // seen reception → needs an exam room
      if (v.needsXray && !v.xrayed) return '🩻';  // examined → needs an X-ray
      if (v.needsSurgery && !v.operated) return '⚕️'; // X-rayed → needs surgery
      if (v.needsMeds && !v.medicated) return '💊'; // examined → needs medicine
      return null;
    }

    // The visitor's body (legs/torso/head/face) in FOOT-LOCAL coordinates — the
    // caller positions it (translate or sprite-blit at cx/baseY). Pure function of
    // its arguments, so it can be sprite-cached; everything time-varying beyond the
    // quantized walk `step` (bob, jitter, bars, bubbles, pets) is handled outside.
    function drawVisitorBody(c, v, seated, step, front, mirror, angry) {
      // legs + shoes
      if (seated) {
        // sitting pose: thighs rest forward on the seat, shins drop to the floor
        // in front, so the figure reads as sitting in (not standing on) the chair.
        c.fillStyle = v.legs;
        roundRect(c, -7, -13, 14, 7, 3); c.fill();   // lap / thighs on the seat
        c.fillRect(-6, -7, 5, 8);                    // left shin
        c.fillRect(1, -7, 5, 8);                     // right shin
        c.fillStyle = '#2a2a30';
        c.fillRect(-7, 0, 6, 3);                     // shoes on the floor in front
        c.fillRect(1, 0, 6, 3);
      } else {
        c.fillStyle = v.legs;
        c.fillRect(-6, -14, 5, 14 + step * 1.4);
        c.fillRect(1, -14, 5, 14 - step * 1.4);
        c.fillStyle = '#2a2a30';
        c.fillRect(-7, -2 + step * 1.4, 6, 3);
        c.fillRect(1, -2 - step * 1.4, 6, 3);
      }

      // torso (shirt)
      var bodyTop = -40;
      c.fillStyle = gradL(c, 0, bodyTop, 0, -12, [[0, shade(v.shirt, 1.12)], [1, v.shirt]]);
      roundRect(c, -11, bodyTop, 22, 28, 7); c.fill();
      // sleeves
      c.fillStyle = shade(v.shirt, 0.9);
      roundRect(c, -14, bodyTop + 2, 5, 13, 2.5); c.fill();
      roundRect(c, 9, bodyTop + 2, 5, 13, 2.5); c.fill();
      // hands
      c.fillStyle = v.skin;
      c.fillRect(-14, bodyTop + 14, 5, 4);
      c.fillRect(9, bodyTop + 14, 5, 4);
      if (!front) { // back seam
        c.strokeStyle = 'rgba(0,0,0,0.08)'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(0, bodyTop + 3); c.lineTo(0, -13); c.stroke();
      }

      // neck + head
      c.fillStyle = shade(v.skin, 0.94);
      c.fillRect(-3, bodyTop - 4, 6, 5);
      var hy = bodyTop - 13;
      c.fillStyle = v.skin;
      c.beginPath(); c.arc(0, hy, 8.5, 0, Math.PI * 2); c.fill();
      // hair
      c.fillStyle = v.hair;
      c.beginPath(); c.arc(0, hy - 1, 8.5, Math.PI * (front ? 1.02 : 0.05), Math.PI * (front ? 1.98 : 0.95), false); c.fill();
      if (!front) { c.beginPath(); c.arc(0, hy + 1, 8, Math.PI * 0.04, Math.PI * 0.96, false); c.fill(); }

      if (front) {
        // eyes (a frown-y angle when cross)
        c.fillStyle = '#2b2b33';
        c.beginPath();
        c.arc(-3 * mirror, hy, 1.3, 0, Math.PI * 2);
        c.arc(3 * mirror, hy, 1.3, 0, Math.PI * 2);
        c.fill();
        if (angry) {
          // angry eyebrows + frown
          c.strokeStyle = '#2b2b33'; c.lineWidth = 1.3;
          c.beginPath(); c.moveTo(-5, hy - 3); c.lineTo(-1.5, hy - 1.5);
          c.moveTo(5, hy - 3); c.lineTo(1.5, hy - 1.5); c.stroke();
          c.strokeStyle = '#9a5f44';
          c.beginPath(); c.arc(0, hy + 6, 2.4, 1.15 * Math.PI, 1.85 * Math.PI); c.stroke();
        } else {
          c.strokeStyle = '#9a5f44'; c.lineWidth = 1.2;
          c.beginPath(); c.arc(0, hy + 3, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
        }
      }
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
                     v.phase === 'waitXray' || v.phase === 'waitMeds' || v.phase === 'waitSurgery');
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

      // ground shadow — identical for every visitor, so it's one shared sprite
      // (the per-frame createRadialGradient here used to be a real cost × crowd)
      if (charSpritesOn) {
        blitChar(charSprite('shadow', SHADOW_BOX, function (c) { drawVisitorShadow(c, 0, 0); }), SHADOW_BOX, s.x, s.y);
      } else {
        drawVisitorShadow(ctx, s.x, s.y);
      }

      // a dog walks alongside; draw it first if it's "behind" (waiting/leaving facing
      // camera). When seated the pet is placed in front of the owner instead (below).
      var isDog = v.pet.charAt(0) === 'd';
      // In the park the dog is off the leash and drawn separately at its own
      // position (see the off-leash scene pass), so don't also draw it beside the
      // owner. A boarded pet is at the hotel — the owner walks without it.
      var dogLoose = isDog && ((v.phase === 'inDogPark' && !!v.dog) || !!v.petBoarded);
      if (isDog && !dogLoose && front && !seated) cachedDog(v, cx - 17 * mirror, s.y + 3, mirror > 0);

      // Body: sprite-cached per (variant, facing, pose bucket) — see drawVisitorBody.
      // The walk sine is quantized to 7 buckets (≤0.5px leg delta per bucket); bob
      // and the anger jitter stay live via the blit position (baseY / cx).
      var sq = v.moving ? Math.round(step * 3) : 0;
      if (charSpritesOn) {
        var bkey = 'v' + v.shirt + v.legs + v.skin + v.hair + (front ? 'f' : 'b') + mirror +
                   (seated ? 's' : sq) + (angry && front ? 'a' : '');
        blitChar(charSprite(bkey, VIS_BOX, function (c) {
          drawVisitorBody(c, v, seated, sq / 3, front, mirror, angry);
        }), VIS_BOX, cx, baseY);
      } else {
        ctx.save(); ctx.translate(cx, baseY);
        drawVisitorBody(ctx, v, seated, step, front, mirror, angry);
        ctx.restore();
      }

      if (seated) {
        // pet set down on the floor in front of the seated owner (at their feet)
        if (isDog && !dogLoose) cachedDog(v, cx + 9, s.y + 13, false);
        else if (!isDog && !v.petBoarded) cachedCarrier(cx, s.y + 2, v.carrier, mirror);
      } else {
        // cat carrier held in front of the body (empty-handed while the cat boards)
        if (!isDog && !v.petBoarded) cachedCarrier(cx, baseY - 14, v.carrier, mirror);
        // dog drawn after the body when it should appear in front (walking up, back to us)
        if (isDog && !dogLoose && !front) cachedDog(v, cx - 16 * mirror, s.y + 4, mirror > 0);
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
      if (v.phase === 'inSurgery' && v.surgeryRoom) {
        var sw2 = 26, sx2 = cx - sw2 / 2, sy2 = baseY - 66;
        ctx.fillStyle = 'rgba(15,20,30,0.65)';
        roundRect(ctx, sx2 - 1.5, sy2 - 1.5, sw2 + 3, 7, 3); ctx.fill();
        if (v.processing) {                    // surgical pink so the long op reads differently
          var sprog = Math.min(1, (v.surgeryRoom.surgT || 0) / (18 * procTime()));
          ctx.fillStyle = '#e05a8a';
          roundRect(ctx, sx2, sy2, Math.max(0, sw2 * sprog), 4, 2); ctx.fill();
        } else {                               // waiting for the full 2-vet + nurse team
          var sp2 = Math.max(0, (v.surgWait || 0) / baseWait());
          ctx.fillStyle = sp2 > 0.6 ? '#4cc46a' : sp2 > 0.33 ? '#e8c34a' : '#e0563f';
          roundRect(ctx, sx2, sy2, Math.max(0, sw2 * sp2), 4, 2); ctx.fill();
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
      if ((v.phase === 'inGroomShower' || v.phase === 'inGroomDry') && v.groomRoom) {
        var gw = 26, gxx = cx - gw / 2, gyy = baseY - 66;
        var isShower = v.phase === 'inGroomShower';
        ctx.fillStyle = 'rgba(15,20,30,0.65)';
        roundRect(ctx, gxx - 1.5, gyy - 1.5, gw + 3, 7, 3); ctx.fill();
        if (v.processing) {
          var gprog = Math.min(1, ((isShower ? v.groomRoom.showerT : v.groomRoom.dryT) || 0) / (GROOM_DURATION * procTime()));
          ctx.fillStyle = isShower ? '#36b3f5' : '#eec23c'; roundRect(ctx, gxx, gyy, Math.max(0, gw * gprog), 4, 2); ctx.fill();
        } else {
          var gp = Math.max(0, (v.groomWait || 0) / baseWait());
          ctx.fillStyle = gp > 0.6 ? '#4cc46a' : gp > 0.33 ? '#e8c34a' : '#e0563f';
          roundRect(ctx, gxx, gyy, Math.max(0, gw * gp), 4, 2); ctx.fill();
        }
      }

      // status bubble: the service this visitor still needs, or 🙂/😠 on the way out.
      // Cached per emoji — fillText rasterizes the glyph every call otherwise.
      var emo = visitorEmoji(v);
      if (emo) {
        var by3 = baseY - 90;
        if (charSpritesOn) {
          blitChar(charSprite('emo' + emo, BUBBLE_BOX, function (c) { drawEmojiBubble(c, 0, 0, emo); }), BUBBLE_BOX, cx, by3);
        } else {
          drawEmojiBubble(ctx, cx, by3, emo);
        }
      }
    }

    // The visitor's soft ground shadow at (x,y) — one radial-gradient ellipse.
    function drawVisitorShadow(c, x, y) {
      var sh = c.createRadialGradient(x, y, 2, x, y, 16);
      sh.addColorStop(0, 'rgba(20,40,30,0.28)'); sh.addColorStop(1, 'rgba(20,40,30,0)');
      c.fillStyle = sh;
      c.beginPath(); c.ellipse(x, y, 15, 7, 0, 0, Math.PI * 2); c.fill();
    }
    // A white speech bubble with a tail, holding one status emoji, centred at (x,y).
    function drawEmojiBubble(c, x, y, emo) {
      c.save();
      c.fillStyle = 'rgba(255,255,255,0.94)';
      c.beginPath(); c.arc(x, y, 11, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.moveTo(x - 4, y + 8); c.lineTo(x + 4, y + 8); c.lineTo(x, y + 13); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(15,20,30,0.22)'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(x, y, 11, 0, Math.PI * 2); c.stroke();
      c.font = '15px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(emo, x, y + 1);
      c.restore();
    }

    // Side-profile dog on a leash. (cx,cy) is the dog's centre on the ground.
    // `opts` (optional): { leash:false } draws the dog off the leash (no lead line),
    // `run` is a gait phase that swings the legs, `wag` wags the tail. Defaults keep
    // the on-leash, still pose for dogs walking beside their owner.
    function drawDog(v, cx, cy, faceRight, opts) {
      opts = opts || {};
      var sz = DOG_SIZE[v.pet] || 1, col = DOG_COLOR[v.pet] || '#9c6b43';
      var f = faceRight ? 1 : -1;
      var sw = opts.run ? Math.sin(opts.run) * 2.4 * sz : 0;        // leg swing while running
      var tw = opts.wag ? Math.sin(opts.wag * 9) * 3 * sz : 0;      // tail wag
      // shadow
      ctx.fillStyle = 'rgba(20,40,30,0.22)';
      ctx.beginPath(); ctx.ellipse(cx, cy, 11 * sz, 4 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // legs (swing fore/aft when running)
      ctx.fillStyle = shade(col, 0.85);
      ctx.fillRect(cx - 7 * sz + sw, cy - 7 * sz, 2.4 * sz, 7 * sz);
      ctx.fillRect(cx + 4 * sz - sw, cy - 7 * sz, 2.4 * sz, 7 * sz);
      // body
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(cx, cy - 8 * sz, 9 * sz, 5.5 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // tail (wags when happy)
      ctx.strokeStyle = col; ctx.lineWidth = 2.4 * sz; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - 8 * sz * f, cy - 9 * sz); ctx.lineTo(cx - 12 * sz * f, cy - 13 * sz - tw); ctx.stroke();
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
      // leash up to the owner's hand (skipped when off the leash in the park)
      if (opts.leash !== false) {
        ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(hx - 3 * sz * f, hy + 1 * sz);
        ctx.lineTo(cx + (faceRight ? 12 : -12), cy - 28); ctx.stroke();
      }
    }

    // Side-profile cat, out of its carrier in the cat park. Same contract as
    // drawDog ({ run, wag } opts) but smaller, grey, pointy-eared, upright tail.
    function drawCat(v, cx, cy, faceRight, opts) {
      opts = opts || {};
      var sz = 0.75, col = '#8a8f98';
      var f = faceRight ? 1 : -1;
      var sw = opts.run ? Math.sin(opts.run) * 2.4 * sz : 0;        // leg swing while running
      var tw = opts.wag ? Math.sin(opts.wag * 6) * 2.5 * sz : 0;    // lazy tail sway
      // shadow
      ctx.fillStyle = 'rgba(20,40,30,0.22)';
      ctx.beginPath(); ctx.ellipse(cx, cy, 10 * sz, 3.6 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // legs
      ctx.fillStyle = shade(col, 0.85);
      ctx.fillRect(cx - 6 * sz + sw, cy - 6 * sz, 2.2 * sz, 6 * sz);
      ctx.fillRect(cx + 4 * sz - sw, cy - 6 * sz, 2.2 * sz, 6 * sz);
      // body
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(cx, cy - 7 * sz, 8 * sz, 4.8 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // upright curved tail (question-mark flick, sways when content)
      ctx.strokeStyle = col; ctx.lineWidth = 2 * sz; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - 7 * sz * f, cy - 8 * sz);
      ctx.quadraticCurveTo(cx - 12 * sz * f, cy - 16 * sz, cx - 9 * sz * f + tw, cy - 19 * sz); ctx.stroke();
      ctx.lineCap = 'butt';
      // head
      var hx = cx + 7 * sz * f, hy = cy - 10 * sz;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(hx, hy, 4.2 * sz, 3.8 * sz, 0, 0, Math.PI * 2); ctx.fill();
      // two triangular ears
      ctx.fillStyle = shade(col, 0.82);
      ctx.beginPath();
      ctx.moveTo(hx - 3.4 * sz * f, hy - 2 * sz); ctx.lineTo(hx - 3.6 * sz * f, hy - 6.4 * sz); ctx.lineTo(hx - 0.6 * sz * f, hy - 3.4 * sz); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(hx + 0.4 * sz * f, hy - 3.2 * sz); ctx.lineTo(hx + 1.6 * sz * f, hy - 6.8 * sz); ctx.lineTo(hx + 3.2 * sz * f, hy - 2.6 * sz); ctx.closePath(); ctx.fill();
      // eye + tiny pink nose
      ctx.fillStyle = '#23201c';
      ctx.beginPath(); ctx.arc(hx + 1.4 * sz * f, hy - 0.4 * sz, 0.8 * sz, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#d98a9c';
      ctx.beginPath(); ctx.arc(hx + 3.8 * sz * f, hy + 0.8 * sz, 0.8 * sz, 0, Math.PI * 2); ctx.fill();
      // whiskers
      ctx.strokeStyle = 'rgba(240,244,248,0.8)'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(hx + 3 * sz * f, hy + 1.4 * sz); ctx.lineTo(hx + 7 * sz * f, hy + 0.6 * sz); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hx + 3 * sz * f, hy + 2 * sz); ctx.lineTo(hx + 7 * sz * f, hy + 2.4 * sz); ctx.stroke();
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

    // Sprite-cached fronts for drawDog/drawCat/drawCarrier. The gait/wag sines are
    // quantized to 7 buckets and mapped back through asin so the baked pose is the
    // exact frame the bucket represents; leash geometry is a fixed offset from the
    // dog's anchor, so it bakes safely too. Anchor = the pet's ground centre.
    function cachedDog(v, cx, cy, faceRight, opts) {
      if (!charSpritesOn) return drawDog(v, cx, cy, faceRight, opts);
      opts = opts || {};
      var swb = opts.run ? Math.round(Math.sin(opts.run) * 3) : 0;
      var twb = opts.wag ? Math.round(Math.sin(opts.wag * 9) * 3) : 0;
      var leash = opts.leash !== false;
      var key = 'd' + v.pet + (faceRight ? 'R' : 'L') + swb + twb + (leash ? 'L' : '');
      blitChar(charSprite(key, PET_BOX, function () {
        drawDog(v, 0, 0, faceRight, { leash: leash, run: Math.asin(swb / 3), wag: Math.asin(twb / 3) / 9 });
      }), PET_BOX, cx, cy);
    }
    function cachedCat(v, cx, cy, faceRight, opts) {
      if (!charSpritesOn) return drawCat(v, cx, cy, faceRight, opts);
      opts = opts || {};
      var swb = opts.run ? Math.round(Math.sin(opts.run) * 3) : 0;
      var twb = opts.wag ? Math.round(Math.sin(opts.wag * 6) * 3) : 0;
      var key = 'c' + (faceRight ? 'R' : 'L') + swb + twb;
      blitChar(charSprite(key, PET_BOX, function () {
        drawCat(v, 0, 0, faceRight, { run: Math.asin(swb / 3), wag: Math.asin(twb / 3) / 6 });
      }), PET_BOX, cx, cy);
    }
    function cachedCarrier(cx, cy, color, mirror) {
      if (!charSpritesOn) return drawCarrier(cx, cy, color, mirror);
      blitChar(charSprite('k' + color + mirror, CARRIER_BOX, function () {
        drawCarrier(0, 0, color, mirror);
      }), CARRIER_BOX, cx, cy);
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
      if (occ) cachedDog(occ, iso(gx, gy).x, iso(gx, gy).y - H, true);   // the pet being examined
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
        if (isAnyRoomDoor(t.x, t.y)) return false;             // never block a room's doorway
        // park toys only on the grass; regular furniture never on the grass
        if (item.parkItem && !isPark(t.x, t.y)) return false;
        if (item.catItem && !isCatFloor(t.x, t.y)) return false;   // cat items only on blank-room floor
        if (!item.parkItem && isPark(t.x, t.y)) return false;
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
      drawReceptionist(ghostCtx, st.x, st.y, undefined, deskForLine(st.line).rot || 0);
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

    // Ghost for the Dog Park drag-rectangle: green turf tiles + running $cost when
    // valid, red when the rect hits something or can't be afforded.
    function drawParkGhost() {
      var st = corridorDrag || { sx: pointer.gx, sy: pointer.gy };
      var res = parkRectTiles(st.sx, st.sy, pointer.gx, pointer.gy);
      ctx.save();
      if (res.tiles.length && res.ok) {
        res.tiles.forEach(function (t) {
          var p = iso(t.x, t.y); diamondPath(ctx, p.x, p.y);
          ctx.fillStyle = 'rgba(118,196,86,0.45)'; ctx.fill();
          ctx.strokeStyle = 'rgba(96,170,66,0.95)'; ctx.lineWidth = 2; ctx.stroke();
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

    // ---- Surgery theatre furniture ----------------------------------------
    // Operating table: steel slab with a sterile teal drape, the patient lying
    // on it, and an overhead surgical lamp that lights up mid-procedure.
    function drawSurgTable(c, gx, gy, occ) {
      var H = 16;
      furnShadow(c, gx - 0.42, gy - 0.42, gx + 0.42, gy + 0.42);
      c.fillStyle = '#b8c2cc';                 // legs
      [[-0.32, -0.32], [0.32, -0.32], [0.32, 0.32], [-0.32, 0.32]].forEach(function (o) {
        var p = iso(gx + o[0], gy + o[1]); c.fillRect(p.x - 1.5, p.y - H, 3, H);
      });
      var T = iso(gx - 0.42, gy - 0.42), R = iso(gx + 0.42, gy - 0.42), F = iso(gx + 0.42, gy + 0.42), L = iso(gx - 0.42, gy + 0.42);
      c.fillStyle = '#4e5a66';                 // slab thickness (front faces)
      c.beginPath(); c.moveTo(L.x, L.y - H); c.lineTo(F.x, F.y - H); c.lineTo(F.x, F.y - H + 5); c.lineTo(L.x, L.y - H + 5); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(F.x, F.y - H); c.lineTo(R.x, R.y - H); c.lineTo(R.x, R.y - H + 5); c.lineTo(F.x, F.y - H + 5); c.closePath(); c.fill();
      c.fillStyle = '#39ac97';                 // sterile drape
      c.beginPath(); c.moveTo(T.x, T.y - H); c.lineTo(R.x, R.y - H); c.lineTo(F.x, F.y - H); c.lineTo(L.x, L.y - H); c.closePath(); c.fill();
      var m = iso(gx, gy);
      if (occ) cachedDog(occ, m.x, m.y - H, true);   // the patient under the lamp
      // overhead lamp: post at the back corner, arm over the table, wide dome
      var base = iso(gx + 0.5, gy - 0.5);
      c.strokeStyle = '#8b97a3'; c.lineWidth = 4; c.lineJoin = 'round'; c.lineCap = 'round';
      c.beginPath(); c.moveTo(base.x, base.y - 2); c.lineTo(base.x, base.y - 58); c.lineTo(m.x, m.y - 54); c.stroke();
      c.lineCap = 'butt';
      if (occ) {                               // warm light cone while operating
        var lg = c.createLinearGradient(m.x, m.y - 48, m.x, m.y - H);
        lg.addColorStop(0, 'rgba(255,240,190,0.4)'); lg.addColorStop(1, 'rgba(255,240,190,0)');
        c.fillStyle = lg;
        c.beginPath(); c.moveTo(m.x - 7, m.y - 48); c.lineTo(m.x + 7, m.y - 48);
        c.lineTo(m.x + 22, m.y - H); c.lineTo(m.x - 22, m.y - H); c.closePath(); c.fill();
      }
      c.fillStyle = '#dde5ea';                 // lamp dome
      c.beginPath(); c.ellipse(m.x, m.y - 52, 10, 5.5, 0, Math.PI, Math.PI * 2); c.closePath(); c.fill();
      c.fillStyle = occ ? '#fff3c2' : '#aeb9c2';
      c.beginPath(); c.ellipse(m.x, m.y - 50.5, 7, 3, 0, 0, Math.PI); c.fill();   // lamp face, lit mid-op
    }
    // ECG monitor cart: pole-mounted screen with a green heartbeat trace.
    function drawSurgMonitor(c, gx, gy) {
      var s = iso(gx, gy), H = 26;
      furnShadow(c, gx - 0.3, gy - 0.3, gx + 0.3, gy + 0.3);
      c.fillStyle = '#9aa6b0'; c.beginPath(); c.ellipse(s.x, s.y, 8, 3.5, 0, 0, Math.PI * 2); c.fill();   // base
      c.fillStyle = '#8b97a3'; c.fillRect(s.x - 2, s.y - H + 2, 4, H - 2);                                // pole
      c.fillStyle = '#232b33'; roundRect(c, s.x - 12, s.y - H - 10, 24, 16, 2); c.fill();                 // casing
      c.fillStyle = '#0c211a'; c.fillRect(s.x - 10, s.y - H - 8, 20, 12);                                 // screen
      c.strokeStyle = '#57e389'; c.lineWidth = 1.2; c.lineCap = 'round';
      c.beginPath(); c.moveTo(s.x - 9, s.y - H - 2); c.lineTo(s.x - 4, s.y - H - 2);
      c.lineTo(s.x - 2, s.y - H - 7); c.lineTo(s.x, s.y - H + 1); c.lineTo(s.x + 2, s.y - H - 2);
      c.lineTo(s.x + 9, s.y - H - 2); c.stroke();                                                          // heartbeat
      c.lineCap = 'butt';
    }
    // Instrument trolley: a steel tray with tools laid out on a cloth.
    function drawSurgTrolley(c, gx, gy) {
      var H = 14;
      furnShadow(c, gx - 0.34, gy - 0.34, gx + 0.34, gy + 0.34);
      c.fillStyle = '#b8c2cc';                 // legs
      [[-0.26, -0.26], [0.26, -0.26], [0.26, 0.26], [-0.26, 0.26]].forEach(function (o) {
        var p = iso(gx + o[0], gy + o[1]); c.fillRect(p.x - 1.2, p.y - H, 2.4, H);
      });
      var T = iso(gx - 0.34, gy - 0.34), R = iso(gx + 0.34, gy - 0.34), F = iso(gx + 0.34, gy + 0.34), L = iso(gx - 0.34, gy + 0.34);
      c.fillStyle = '#cfd8de';                 // tray
      c.beginPath(); c.moveTo(T.x, T.y - H); c.lineTo(R.x, R.y - H); c.lineTo(F.x, F.y - H); c.lineTo(L.x, L.y - H); c.closePath(); c.fill();
      var m = iso(gx, gy), ty = m.y - H;
      c.fillStyle = '#eef8f4';                 // sterile cloth
      c.beginPath(); c.moveTo(m.x - 10, ty); c.lineTo(m.x + 2, ty - 5); c.lineTo(m.x + 10, ty - 1); c.lineTo(m.x - 2, ty + 4); c.closePath(); c.fill();
      c.strokeStyle = '#8b97a3'; c.lineWidth = 1.4; c.lineCap = 'round';
      c.beginPath(); c.moveTo(m.x - 5, ty + 1); c.lineTo(m.x + 1, ty - 2); c.stroke();   // forceps
      c.beginPath(); c.moveTo(m.x - 2, ty + 2); c.lineTo(m.x + 4, ty - 1); c.stroke();   // scalpel shaft
      c.fillStyle = '#e0563f'; c.fillRect(m.x + 3, ty - 3, 3, 2);                        // scalpel handle
      c.lineCap = 'butt';
    }
    // Ghost for the 4×5 surgery: footprint tint + table/monitor/trolley and the
    // THREE staff circles (two surgeon flanks + the nurse spot).
    function drawSurgeryGhost(rot) {
      var ok = canPlaceSurgery(pointer.gx, pointer.gy);
      var k = surgeryKeyTiles(pointer.gx, pointer.gy);
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.34)' : 'rgba(224,86,63,0.42)';
      surgeryTiles(pointer.gx, pointer.gy).forEach(function (t) { var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill(); });
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawExamCircle(ghostCtx, k.vetA.x, k.vetA.y, false);
      drawExamCircle(ghostCtx, k.vetB.x, k.vetB.y, false);
      drawExamCircle(ghostCtx, k.worker.x, k.worker.y, false);
      drawSurgMonitor(ghostCtx, k.monitor.x, k.monitor.y);
      drawSurgTrolley(ghostCtx, k.trolley.x, k.trolley.y);
      drawSurgTable(ghostCtx, k.table.x, k.table.y, null);
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
      if (occ) cachedDog(occ, iso(gx, gy).x, iso(gx, gy).y - H, true);   // the pet being scanned
      // overhead C-arm: post at the back corner, arm over the bed, emitter above the pet
      var base = iso(gx - 0.5, gy - 0.5), ctr = iso(gx, gy);
      c.strokeStyle = '#8b97a3'; c.lineWidth = 4; c.lineJoin = 'round'; c.lineCap = 'round';
      c.beginPath(); c.moveTo(base.x, base.y - 2); c.lineTo(base.x, base.y - 50); c.lineTo(ctr.x, ctr.y - 50); c.stroke();
      c.lineCap = 'butt';
      c.fillStyle = '#3a444e'; roundRect(c, ctr.x - 6, ctr.y - 50, 12, 9, 2); c.fill();   // emitter head
      c.fillStyle = '#6fd4e6'; c.fillRect(ctr.x - 3, ctr.y - 42, 6, 2);                    // lens
    }

    // ---- Back-wall decorations (exam + X-ray rooms) ----------------------
    // These hang on the two TALL back walls of a room. Each drawer takes a `P`
    // helper: P(t,h) maps a param t in [0,1] along the one-tile wall edge and a
    // screen-height h above the floor to a point. Content is drawn UPRIGHT in
    // screen space (centred on the tile), matching the billboarded pharmacy
    // shelving, so it reads cleanly on either back wall.
    function wallEdgeP(ax, ay, bx, by) {
      var A = iso(ax, ay), B = iso(bx, by);
      return function (t, h) { return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t - h }; };
    }
    function wallPanel(c, P, t0, t1, hTop, hBot, fill) {
      var p0 = P(t0, hTop), p1 = P(t1, hTop), p2 = P(t1, hBot), p3 = P(t0, hBot);
      c.fillStyle = fill; c.beginPath();
      c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.lineTo(p3.x, p3.y);
      c.closePath(); c.fill();
    }
    // A filled rectangle that lies IN the wall plane: centred at (tc along, hc up),
    // half-extents dt (in tile-fraction along the wall) and dh (screen-px up).
    // Mapping every corner through P shears it to the wall's isometric slope.
    function wallTile(c, P, tc, hc, dt, dh, fill) {
      var p0 = P(tc - dt, hc + dh), p1 = P(tc + dt, hc + dh), p2 = P(tc + dt, hc - dh), p3 = P(tc - dt, hc - dh);
      c.fillStyle = fill; c.beginPath();
      c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.lineTo(p3.x, p3.y);
      c.closePath(); c.fill();
    }
    // A medical cross painted ON the wall: a vertical arm (narrow along, tall up)
    // plus a horizontal arm (wide along, short up). Both arms map through P, so the
    // horizontal arm slants with the wall instead of reading as a flat sticker.
    function wallCross(c, P, tc, hc, s, fill) {
      wallTile(c, P, tc, hc, 0.045 * s, 5 * s, fill);     // vertical arm
      wallTile(c, P, tc, hc, 0.13 * s, 1.7 * s, fill);    // horizontal arm
    }
    // The hero: a wall-mounted light box (negatoscope) glowing behind a chest
    // film — skull, spine and ribs — with a green power LED.
    function drawXrayBoard(c, P) {
      wallPanel(c, P, 0.13, 0.87, 55, 22, '#232b33');          // dark casing
      var m = P(0.5, 39);
      c.save();
      c.shadowColor = 'rgba(150,225,255,0.95)'; c.shadowBlur = 13;
      wallPanel(c, P, 0.17, 0.83, 52, 25, '#e8f6ff');          // glowing film
      c.restore();
      wallPanel(c, P, 0.17, 0.83, 52, 44, '#c7ebfd');          // cooler top band
      c.strokeStyle = 'rgba(58,92,120,0.8)'; c.lineWidth = 1.5; c.lineCap = 'round';
      c.fillStyle = 'rgba(58,92,120,0.5)';
      c.beginPath(); c.ellipse(m.x, m.y - 12, 4.4, 3.5, 0, 0, Math.PI * 2); c.fill();   // skull
      c.beginPath(); c.moveTo(m.x, m.y - 8); c.lineTo(m.x, m.y + 12); c.stroke();        // spine
      for (var r = 0; r < 4; r++) {                                                      // rib pairs
        var ry = m.y - 5 + r * 4.4;
        c.beginPath(); c.moveTo(m.x, ry); c.quadraticCurveTo(m.x - 7, ry + 1.5, m.x - 8, ry + 5); c.stroke();
        c.beginPath(); c.moveTo(m.x, ry); c.quadraticCurveTo(m.x + 7, ry + 1.5, m.x + 8, ry + 5); c.stroke();
      }
      c.lineCap = 'butt';
      var led = P(0.8, 24); c.fillStyle = '#7CFC9A';
      c.beginPath(); c.arc(led.x, led.y, 1.5, 0, Math.PI * 2); c.fill();
    }
    // Yellow radiation-warning trefoil.
    function drawRadSign(c, P) {
      var m = P(0.5, 40);
      c.fillStyle = '#f2c200';
      c.beginPath(); c.moveTo(m.x, m.y - 9); c.lineTo(m.x + 9, m.y + 7); c.lineTo(m.x - 9, m.y + 7); c.closePath(); c.fill();
      c.strokeStyle = '#2b2b2b'; c.lineWidth = 1.3; c.lineJoin = 'round'; c.stroke();
      c.fillStyle = '#2b2b2b'; var cy = m.y + 1.5;
      c.beginPath(); c.arc(m.x, cy, 1.5, 0, Math.PI * 2); c.fill();
      for (var a = 0; a < 3; a++) {
        var ang = -Math.PI / 2 + a * (2 * Math.PI / 3);
        c.beginPath(); c.moveTo(m.x, cy); c.arc(m.x, cy, 4.8, ang - 0.5, ang + 0.5); c.closePath(); c.fill();
      }
    }
    // A simple round wall clock with a teal bezel.
    function drawWallClock(c, P) {
      var m = P(0.5, 41);
      c.fillStyle = '#fbfdfe'; c.beginPath(); c.arc(m.x, m.y, 7.5, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#2f9e90'; c.lineWidth = 2; c.stroke();
      c.strokeStyle = '#33414d'; c.lineWidth = 1.4; c.lineCap = 'round';
      c.beginPath(); c.moveTo(m.x, m.y); c.lineTo(m.x, m.y - 5); c.stroke();
      c.beginPath(); c.moveTo(m.x, m.y); c.lineTo(m.x + 3.5, m.y + 1.5); c.stroke();
      c.lineCap = 'butt';
      c.fillStyle = '#33414d'; c.beginPath(); c.arc(m.x, m.y, 1, 0, Math.PI * 2); c.fill();
    }
    // A lead apron hanging on a hook (X-ray PPE).
    function drawLeadApron(c, P) {
      var t = P(0.5, 50);
      c.strokeStyle = '#9aa6b0'; c.lineWidth = 2;
      c.beginPath(); c.arc(t.x, t.y + 2, 2.5, Math.PI, 0); c.stroke();
      c.fillStyle = '#3f6f8c';
      c.beginPath();
      c.moveTo(t.x - 5, t.y + 4); c.lineTo(t.x + 5, t.y + 4);
      c.lineTo(t.x + 8, t.y + 24); c.quadraticCurveTo(t.x, t.y + 28, t.x - 8, t.y + 24);
      c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.18)'; c.lineWidth = 1; c.stroke();
      c.fillStyle = '#345d76'; c.fillRect(t.x - 2.5, t.y + 4, 5, 9);
    }
    // A wall storage cabinet; `cross` paints a red medical cross on one door.
    function drawCabinet(c, P, cross) {
      wallPanel(c, P, 0.21, 0.79, 50, 27, '#e7eef2');
      wallPanel(c, P, 0.21, 0.79, 50, 47, '#cfdae1');          // top shade
      var a = P(0.5, 49), b = P(0.5, 28), m = P(0.5, 38);
      c.strokeStyle = '#aebcc6'; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      c.fillStyle = '#8fa0ab'; c.fillRect(m.x - 4, m.y - 1, 2, 5); c.fillRect(m.x + 2, m.y - 1, 2, 5);
      if (cross) wallCross(c, P, 0.37, 39, 0.9, '#e0563f');   // red cross on the left door
    }
    // A framed pet-anatomy chart: dog silhouette + label pointer lines.
    function drawAnatomyPoster(c, P) {
      wallPanel(c, P, 0.19, 0.81, 52, 23, '#37b3a3');          // teal frame
      wallPanel(c, P, 0.225, 0.775, 49, 26, '#f3f8fa');        // paper
      var m = P(0.5, 38);
      c.fillStyle = '#cfe0e6';
      c.beginPath(); c.ellipse(m.x - 1, m.y, 8, 4.4, 0, 0, Math.PI * 2); c.fill();        // body
      c.beginPath(); c.arc(m.x + 8, m.y - 3, 3.2, 0, Math.PI * 2); c.fill();              // head
      c.fillRect(m.x - 6, m.y + 2, 1.6, 5); c.fillRect(m.x + 4, m.y + 2, 1.6, 5);          // legs
      c.strokeStyle = '#9bb8c0'; c.lineWidth = 0.8;
      c.beginPath(); c.moveTo(m.x - 9, m.y - 7); c.lineTo(m.x - 2, m.y - 2); c.stroke();
      c.beginPath(); c.moveTo(m.x + 11, m.y - 8); c.lineTo(m.x + 7, m.y - 4); c.stroke();
    }
    // A small health poster with a red cross header.
    function drawHealthPoster(c, P) {
      wallPanel(c, P, 0.3, 0.7, 50, 27, '#fbfdfe');           // paper
      wallPanel(c, P, 0.3, 0.7, 50, 46, '#37b3a3');           // header band
      var m = P(0.5, 40);
      wallCross(c, P, 0.5, 40, 0.85, '#e0563f');
      c.strokeStyle = '#c4d2da'; c.lineWidth = 0.8;
      [6, 9].forEach(function (dy) { c.beginPath(); c.moveTo(m.x - 6, m.y + dy); c.lineTo(m.x + 6, m.y + dy); c.stroke(); });
    }
    // A framed diploma with a wax seal.
    function drawCertificate(c, P) {
      wallPanel(c, P, 0.31, 0.69, 49, 29, '#caa45a');         // gold frame
      wallPanel(c, P, 0.345, 0.655, 47, 31, '#fdfaf0');       // parchment
      var m = P(0.5, 40);
      c.strokeStyle = '#d9c7a0'; c.lineWidth = 0.8;
      [-4, -1, 2].forEach(function (dy) { c.beginPath(); c.moveTo(m.x - 5, m.y + dy); c.lineTo(m.x + 5, m.y + dy); c.stroke(); });
      c.fillStyle = '#c0392b'; c.beginPath(); c.arc(m.x + 3.5, m.y + 6, 2.2, 0, Math.PI * 2); c.fill();
    }
    // Hang a room's per-wall decorations on its two TALL back walls (north =
    // each tile's y-1 neighbour, west = x-1), one item per wall tile at that
    // wall's exact depth so a vet in front occludes it. Decorations go on EVERY
    // back-wall tile except the doorway, so every room is decorated the same way
    // regardless of placement. Where roomWalls drew no wall (a back edge facing
    // open grass/perimeter rather than room floor), we add a matching tall wall
    // first, so the room is enclosed and the decoration always has a surface.
    // `north`/`west` are arrays of drawer fns (or null to skip a slot).
    // ---- Hotel wall decor (billboarded on the back walls) ------------------
    function drawHotelSign(c, P) {
      // awning strip + the PET HOTEL plaque
      for (var i = 0; i < 4; i++) wallPanel(c, P, 0.06 + i * 0.22, 0.06 + i * 0.22 + 0.22, 62, 54, i % 2 ? '#fdf6ec' : '#c96f4a');
      wallPanel(c, P, 0.08, 0.92, 50, 26, '#8a5a2b');
      wallPanel(c, P, 0.11, 0.89, 48, 28, '#fdf6ec');
      var m = P(0.5, 37);
      c.fillStyle = '#8a5a2b'; c.font = 'bold 6.5px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('PET HOTEL', m.x, m.y);
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    }
    function drawPawPlaque(c, P) {
      wallPanel(c, P, 0.26, 0.74, 52, 24, '#b98a4e');
      wallPanel(c, P, 0.30, 0.70, 49, 27, '#fdf6ec');
      var m = P(0.5, 38);
      c.fillStyle = '#c96f4a';
      c.beginPath(); c.ellipse(m.x, m.y + 3, 4, 3.2, 0, 0, Math.PI * 2); c.fill();  // pad
      c.beginPath(); c.arc(m.x - 4.5, m.y - 2, 1.7, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(m.x - 1.5, m.y - 4, 1.7, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(m.x + 1.5, m.y - 4, 1.7, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(m.x + 4.5, m.y - 2, 1.7, 0, Math.PI * 2); c.fill();
    }
    function drawDogPortrait(c, P) {
      wallPanel(c, P, 0.28, 0.72, 54, 24, '#8a5a2b');
      wallPanel(c, P, 0.32, 0.68, 51, 27, '#cfe4dd');
      var m = P(0.5, 39);
      c.fillStyle = '#9c6b43';
      c.beginPath(); c.ellipse(m.x, m.y + 2, 4.4, 3.6, 0, 0, Math.PI * 2); c.fill();  // head
      c.beginPath(); c.ellipse(m.x - 3.6, m.y - 2.2, 1.6, 2.6, -0.5, 0, Math.PI * 2); c.fill();  // floppy ears
      c.beginPath(); c.ellipse(m.x + 3.6, m.y - 2.2, 1.6, 2.6, 0.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#23201c';
      c.beginPath(); c.arc(m.x - 1.4, m.y + 1, 0.7, 0, Math.PI * 2); c.arc(m.x + 1.4, m.y + 1, 0.7, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(m.x, m.y + 3.4, 1, 0, Math.PI * 2); c.fill();
    }
    function drawCatPortrait(c, P) {
      wallPanel(c, P, 0.28, 0.72, 54, 24, '#8a5a2b');
      wallPanel(c, P, 0.32, 0.68, 51, 27, '#f2dfd3');
      var m = P(0.5, 39);
      c.fillStyle = '#8a8f98';
      c.beginPath(); c.ellipse(m.x, m.y + 2, 4.2, 3.4, 0, 0, Math.PI * 2); c.fill();  // head
      c.beginPath(); c.moveTo(m.x - 3.6, m.y); c.lineTo(m.x - 4.4, m.y - 4.4); c.lineTo(m.x - 1.2, m.y - 2.4); c.closePath(); c.fill();  // ears
      c.beginPath(); c.moveTo(m.x + 3.6, m.y); c.lineTo(m.x + 4.4, m.y - 4.4); c.lineTo(m.x + 1.2, m.y - 2.4); c.closePath(); c.fill();
      c.fillStyle = '#23201c';
      c.beginPath(); c.arc(m.x - 1.4, m.y + 1, 0.7, 0, Math.PI * 2); c.arc(m.x + 1.4, m.y + 1, 0.7, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#d98a9c'; c.beginPath(); c.arc(m.x, m.y + 3.2, 0.8, 0, Math.PI * 2); c.fill();
    }
    function hangBackWall(rm, w, h, north, west, pal) {
      var gx = rm.gx, gy = rm.gy, dr = rm.door;
      var fn2 = (pal && pal.n) || ['#e4edf2', '#cad9e2', '#eef4f7', '#2f9e90'];   // fallback wall colors
      var fw2 = (pal && pal.w) || ['#fbfdfe', '#e2ecf1', '#ffffff', '#37b3a3'];
      function isDoor(nx, ny) { return dr && dr.x === nx && dr.y === ny; }
      function fallback(ax, ay, bx, by, ft, fb, cap, trim) {
        wallSegs.push({ d: (ax + ay + bx + by) / 2, _ax: ax, _ay: ay, _bx: bx, _by: by, _htop: BILLBOARD_H, _key: 'W' + WALL_H + ft + fb + cap + trim + 'bb', fn: function () {
          wallFace(ctx, ax, ay, bx, by, WALL_H, ft, fb, cap, trim);
        } });
      }
      for (var i = 0; i < w; i++) (function (i) {
        var x = gx + i; if (isDoor(x, gy - 1)) return;       // doorway: stays open, no decor
        if (!isRoomFloor(x, gy - 1)) fallback(x - 0.5, gy - 0.5, x + 0.5, gy - 0.5, fn2[0], fn2[1], fn2[2], fn2[3]);
        var fn = north[i]; if (!fn) return;
        wallSegs.push({ d: x + gy - 0.5, _ax: x - 0.5, _ay: gy - 0.5, _bx: x + 0.5, _by: gy - 0.5, _htop: BILLBOARD_H, _key: 'bb' + fn.name, fn: function () {
          fn(ctx, wallEdgeP(x - 0.5, gy - 0.5, x + 0.5, gy - 0.5));
        } });
      })(i);
      for (var j = 0; j < h; j++) (function (j) {
        var y = gy + j; if (isDoor(gx - 1, y)) return;
        if (!isRoomFloor(gx - 1, y)) fallback(gx - 0.5, y - 0.5, gx - 0.5, y + 0.5, fw2[0], fw2[1], fw2[2], fw2[3]);
        var fn = west[j]; if (!fn) return;
        wallSegs.push({ d: gx + y - 0.5, _ax: gx - 0.5, _ay: y - 0.5, _bx: gx - 0.5, _by: y + 0.5, _htop: BILLBOARD_H, _key: 'bb' + fn.name, fn: function () {
          fn(ctx, wallEdgeP(gx - 0.5, y - 0.5, gx - 0.5, y + 0.5));
        } });
      })(j);
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

    // Grooming shower station: a tiled back panel + chrome shower arm; runs water
    // when a dog is being washed (`active`).
    function drawGroomShower(c, gx, gy, active) {
      furnShadow(c, gx - 0.42, gy - 0.4, gx + 0.42, gy + 0.42);
      isoBox(c, gx - 0.4, gy - 0.28, gx + 0.4, gy + 0.4, 16, '#dfeef2', '#b9d2da', '#a7c3cc'); // base cabinet
      var m = iso(gx, gy), topY = m.y - 16;
      c.fillStyle = '#cfe6ee'; c.fillRect(m.x - 15, topY - 46, 30, 46);                          // tall tiled panel
      c.fillStyle = '#bcd8e2';
      for (var yy = 0; yy < 5; yy++) for (var xx = 0; xx < 3; xx++) c.fillRect(m.x - 14 + xx * 10, topY - 44 + yy * 9, 9, 8);
      c.fillStyle = '#eef7fa'; c.fillRect(m.x - 15, topY - 46, 30, 3);                            // top trim
      c.strokeStyle = '#9fb3bd'; c.lineWidth = 3; c.lineCap = 'round';                            // chrome arm
      c.beginPath(); c.moveTo(m.x, topY - 40); c.lineTo(m.x, topY - 30); c.lineTo(m.x + 2, topY - 22); c.stroke();
      c.fillStyle = '#c7d4da'; c.beginPath(); c.ellipse(m.x + 2, topY - 20, 6, 3, 0, 0, Math.PI * 2); c.fill(); // head
      c.lineCap = 'butt';
      if (active) {
        c.strokeStyle = 'rgba(150,205,235,0.78)'; c.lineWidth = 1.4;
        for (var w = 0; w < 6; w++) {
          var ph = (animT * 3 + w * 0.6) % 1, wx = m.x - 5 + w * 2.2;
          c.beginPath(); c.moveTo(wx, topY - 18); c.lineTo(wx - 1, topY - 18 + 10 + ph * 8); c.stroke();
        }
        c.fillStyle = 'rgba(150,205,235,0.32)'; c.beginPath(); c.ellipse(m.x + 3, m.y - 2, 12, 5, 0, 0, Math.PI * 2); c.fill();
      }
    }
    // Grooming blow-dry station: a padded pedestal + a dryer on a boom arm; blows
    // warm-air lines when a dog is being dried (`active`).
    function drawGroomDryer(c, gx, gy, active) {
      furnShadow(c, gx - 0.4, gy - 0.4, gx + 0.42, gy + 0.42);
      isoBox(c, gx - 0.34, gy - 0.2, gx + 0.34, gy + 0.34, 20, '#e7d8c6', '#c9b299', '#b89f84'); // pedestal
      var m = iso(gx, gy), topY = m.y - 20;
      c.strokeStyle = '#8c98a2'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(m.x - 10, topY); c.lineTo(m.x - 10, topY - 34); c.stroke();          // pole
      c.beginPath(); c.moveTo(m.x - 10, topY - 34); c.lineTo(m.x + 4, topY - 30); c.stroke();      // boom arm
      c.fillStyle = '#eec23c'; roundRect(c, m.x + 2, topY - 36, 14, 10, 4); c.fill();              // dryer body
      c.fillStyle = '#d9a92a'; roundRect(c, m.x + 13, topY - 33, 5, 5, 2); c.fill();               // nozzle
      if (active) {
        c.strokeStyle = 'rgba(255,224,150,0.72)'; c.lineWidth = 1.6; c.lineCap = 'round';
        for (var a = 0; a < 4; a++) {
          var off = (animT * 2 + a * 0.5) % 1;
          c.beginPath();
          c.moveTo(m.x + 18, topY - 30 + (a - 1.5) * 2.4);
          c.lineTo(m.x + 18 + 8 + off * 7, topY - 30 + (a - 1.5) * 3.4);
          c.stroke();
        }
        c.lineCap = 'butt';
      }
    }

    // ---- Hotel fixtures ----------------------------------------------------
    // A round wicker pet bed with a cushion; `big` for the dog wing. `seed`
    // varies the cushion colour so the row of beds isn't uniform.
    function drawPetBed(c, gx, gy, big, seed) {
      var sc = big ? 1 : 0.78;
      furnShadow(c, gx - 0.36 * sc, gy - 0.36 * sc, gx + 0.36 * sc, gy + 0.36 * sc);
      var s = iso(gx, gy);
      var cols = ['#c96f4a', '#5aa0e8', '#4cc46a', '#9678d0', '#e8c34a', '#d94f6e'];
      var cush = cols[((hash(gx * 3 + (seed || 0), gy * 7) * cols.length) | 0) % cols.length];
      c.fillStyle = '#a8834f';                                                 // wicker rim
      c.beginPath(); c.ellipse(s.x, s.y - 2, 15 * sc, 8.5 * sc, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#93713f';
      c.beginPath(); c.ellipse(s.x, s.y - 4, 13.5 * sc, 7.4 * sc, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(120,84,40,0.5)'; c.lineWidth = 1;                  // weave lines
      for (var i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(s.x + i * 5 * sc, s.y - 9 * sc); c.lineTo(s.x + i * 5 * sc + 2, s.y + 3 * sc); c.stroke(); }
      c.fillStyle = cush;                                                       // cushion
      c.beginPath(); c.ellipse(s.x, s.y - 5, 11 * sc, 5.8 * sc, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = shade(cush, 1.16);
      c.beginPath(); c.ellipse(s.x, s.y - 6, 8 * sc, 4 * sc, 0, 0, Math.PI * 2); c.fill();
    }
    // Two-tile warm-wood reception desk; `left` is the west half (holds the bell).
    function drawHotelDesk(c, gx, gy, left) {
      furnShadow(c, gx - 0.44, gy - 0.4, gx + 0.44, gy + 0.4);
      isoBox(c, gx - 0.46, gy - 0.34, gx + 0.46, gy + 0.34, 22, '#c79a63', '#a87c42', '#8f6a38');
      var s = iso(gx, gy);
      c.fillStyle = '#8a5a2b'; c.fillRect(s.x - 15, s.y - 24, 30, 2.4);        // counter lip
      if (left) {                                                              // service bell
        c.fillStyle = '#e8c34a'; c.beginPath(); c.arc(s.x + 4, s.y - 27, 3.2, Math.PI, 0); c.fill();
        c.fillStyle = '#c9a52e'; c.fillRect(s.x + 1, s.y - 27, 6.4, 1.6);
        c.fillStyle = '#8a5a2b'; c.beginPath(); c.arc(s.x + 4, s.y - 30, 1, 0, Math.PI * 2); c.fill();
      } else {                                                                 // guest book
        c.fillStyle = '#fdf6ec'; c.fillRect(s.x - 8, s.y - 27, 12, 6);
        c.strokeStyle = '#b0a58f'; c.lineWidth = 0.8;
        c.beginPath(); c.moveTo(s.x - 6, s.y - 25); c.lineTo(s.x + 2, s.y - 25);
        c.moveTo(s.x - 6, s.y - 23.4); c.lineTo(s.x + 2, s.y - 23.4); c.stroke();
      }
    }
    // A potted ficus for the lobby corners.
    function drawFicus(c, gx, gy) {
      furnShadow(c, gx - 0.26, gy - 0.26, gx + 0.26, gy + 0.26);
      isoBox(c, gx - 0.24, gy - 0.24, gx + 0.24, gy + 0.24, 11, '#c96f4a', '#a55538', '#8f4930'); // terracotta
      var s = iso(gx, gy);
      c.strokeStyle = '#8a6a42'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(s.x, s.y - 11); c.lineTo(s.x, s.y - 26); c.stroke();               // trunk
      c.fillStyle = '#3f9e58'; c.beginPath(); c.ellipse(s.x, s.y - 32, 9, 7, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#4cc46a'; c.beginPath(); c.ellipse(s.x - 4, s.y - 36, 6, 4.6, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#6fdc8b'; c.beginPath(); c.ellipse(s.x + 5, s.y - 35, 5, 3.8, 0, 0, Math.PI * 2); c.fill();
    }

    // One tile-wide section of pharmacy shelving, billboarded flat on a back-wall
    // edge running grid-corner (ax,ay)→(bx,by): a wood back-board, three shelves,
    // and a row of colourful medicine boxes on each. `seed` shifts the box colours
    // so neighbouring sections don't repeat. Heights are screen-px above the floor
    // line, kept just under WALL_H (62) so they sit on the tall back walls.
    function drawMedShelf(c, ax, ay, bx, by, seed) {
      var A = iso(ax, ay), B = iso(bx, by), dx = B.x - A.x, dy = B.y - A.y;
      function P(t, h) { return { x: A.x + dx * t, y: A.y + dy * t - h }; }
      function band(t0, t1, hTop, hBot, fill) {
        var p0 = P(t0, hTop), p1 = P(t1, hTop), p2 = P(t1, hBot), p3 = P(t0, hBot);
        c.fillStyle = fill; c.beginPath();
        c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.lineTo(p3.x, p3.y);
        c.closePath(); c.fill();
      }
      var botH = 8, topH = 57;
      band(0.03, 0.97, topH, botH, '#c7b08c');                  // back board
      band(0.03, 0.10, topH, botH, '#a98f68');                  // left post
      band(0.90, 0.97, topH, botH, '#a98f68');                  // right post
      var cols = ['#e0683c', '#3d8fd0', '#7d5bbe', '#3bb1a2', '#e0a93c', '#d94f8a', '#5aa897'];
      var shelfTops = [19, 34, 49];                             // surface height of each of 3 shelves
      shelfTops.forEach(function (sh, si) {
        band(0.05, 0.95, sh, sh - 2.5, '#8a7252');             // the shelf board itself
        for (var i = 0; i < 4; i++) {                          // boxes standing on this shelf
          var t = 0.16 + i * 0.225, p = P(t, sh);
          c.fillStyle = cols[(seed + si * 2 + i * 3) % cols.length];
          c.fillRect(p.x - 4, p.y - 12, 8, 12);
          c.fillStyle = 'rgba(255,255,255,0.85)';               // pale label band
          c.fillRect(p.x - 4, p.y - 8, 8, 3);
        }
      });
    }

    // A different ("other") shelving unit for the back-right wall: the same wooden
    // carcass, but stocked with apothecary jars, pill bottles and gauze rolls
    // instead of medicine boxes — so the two back walls read distinctly.
    function drawSupplyShelf(c, ax, ay, bx, by, seed) {
      var A = iso(ax, ay), B = iso(bx, by), dx = B.x - A.x, dy = B.y - A.y;
      function P(t, h) { return { x: A.x + dx * t, y: A.y + dy * t - h }; }
      function band(t0, t1, hTop, hBot, fill) {
        var p0 = P(t0, hTop), p1 = P(t1, hTop), p2 = P(t1, hBot), p3 = P(t0, hBot);
        c.fillStyle = fill; c.beginPath();
        c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.lineTo(p3.x, p3.y);
        c.closePath(); c.fill();
      }
      var botH = 8, topH = 57, caps = ['#e0563f', '#2f8fd0', '#2bb19a', '#e0a93c', '#d94f8a'];
      band(0.03, 0.97, topH, botH, '#8a7252');                  // back board (warm wood, like the med shelf)
      band(0.03, 0.10, topH, botH, '#6f5b3f');                  // left post
      band(0.90, 0.97, topH, botH, '#6f5b3f');                  // right post
      var shelfTops = [19, 34, 49];
      shelfTops.forEach(function (sh, si) {
        band(0.05, 0.95, sh, sh - 2.5, '#6f5b3f');             // shelf board
        for (var i = 0; i < 4; i++) {
          var t = 0.16 + i * 0.225, p = P(t, sh), kind = (seed + si * 3 + i) % 3;
          if (kind === 0) {                                     // amber apothecary jar
            c.fillStyle = '#b9741f'; roundRect(c, p.x - 4.5, p.y - 12, 9, 12, 2.5); c.fill();
            c.fillStyle = 'rgba(255,240,200,0.45)'; c.fillRect(p.x - 3.5, p.y - 11, 2.5, 9); // glass highlight
            c.fillStyle = '#5e4316'; roundRect(c, p.x - 5, p.y - 14, 10, 3, 1.5); c.fill();  // dark lid
          } else if (kind === 1) {                              // pill bottle, bold cap + label
            c.fillStyle = '#f4f8fa'; roundRect(c, p.x - 4, p.y - 12, 8, 12, 2); c.fill();
            c.strokeStyle = '#b9c6cd'; c.lineWidth = 0.8; roundRect(c, p.x - 4, p.y - 12, 8, 12, 2); c.stroke();
            c.fillStyle = caps[(seed + i) % caps.length];
            roundRect(c, p.x - 4, p.y - 14.5, 8, 3.5, 1.5); c.fill();                        // cap
            c.fillRect(p.x - 4, p.y - 7, 8, 4);                                              // colour label band
          } else {                                              // gauze / bandage roll
            c.fillStyle = '#f7f4ec'; c.beginPath(); c.arc(p.x, p.y - 6, 5.5, 0, Math.PI * 2); c.fill();
            c.strokeStyle = '#c9c2b2'; c.lineWidth = 1; c.stroke();
            c.fillStyle = '#e0563f';                                                          // red cross on the roll
            c.fillRect(p.x - 1, p.y - 8.6, 2, 5.2); c.fillRect(p.x - 2.6, p.y - 7, 5.2, 2);
          }
        }
      });
    }

    // One tile-wide section of SHOP shelving: a light retail-wood carcass stocked
    // with a mix of product boxes, toy balls and food bags, so it reads as a store
    // rather than a clinic shelf. `seed` shifts the goods so sections don't repeat.
    function drawShopShelf(c, ax, ay, bx, by, seed) {
      var A = iso(ax, ay), B = iso(bx, by), dx = B.x - A.x, dy = B.y - A.y;
      function P(t, h) { return { x: A.x + dx * t, y: A.y + dy * t - h }; }
      function band(t0, t1, hTop, hBot, fill) {
        var p0 = P(t0, hTop), p1 = P(t1, hTop), p2 = P(t1, hBot), p3 = P(t0, hBot);
        c.fillStyle = fill; c.beginPath();
        c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.lineTo(p3.x, p3.y);
        c.closePath(); c.fill();
      }
      var botH = 8, topH = 57, cols = ['#e0563f', '#3d8fd0', '#7d5bbe', '#3bb1a2', '#e0a93c', '#d94f8a', '#5aa897', '#f08a3c'];
      band(0.03, 0.97, topH, botH, '#b9967a');                  // back board (warm retail wood)
      band(0.03, 0.10, topH, botH, '#94725a');                  // left post
      band(0.90, 0.97, topH, botH, '#94725a');                  // right post
      var shelfTops = [19, 34, 49];
      shelfTops.forEach(function (sh, si) {
        band(0.05, 0.95, sh, sh - 2.5, '#7d6450');             // shelf board
        for (var i = 0; i < 4; i++) {
          var t = 0.16 + i * 0.225, p = P(t, sh), kind = (seed + si * 2 + i) % 3, col = cols[(seed + si * 3 + i * 2) % cols.length];
          if (kind === 0) {                                     // FOOD — a bag of pet food (sack)
            c.fillStyle = col; c.beginPath();
            c.moveTo(p.x - 3.5, p.y); c.lineTo(p.x + 3.5, p.y); c.lineTo(p.x + 4.5, p.y - 11); c.lineTo(p.x - 4.5, p.y - 11); c.closePath(); c.fill();
            c.fillStyle = 'rgba(255,255,255,0.82)'; c.fillRect(p.x - 4, p.y - 7, 9, 3);   // label
          } else if (kind === 1) {                              // TOYS — a toy ball
            c.fillStyle = col; c.beginPath(); c.arc(p.x, p.y - 5, 5, 0, Math.PI * 2); c.fill();
            c.fillStyle = 'rgba(255,255,255,0.5)'; c.beginPath(); c.arc(p.x - 1.6, p.y - 6.4, 1.5, 0, Math.PI * 2); c.fill();
          } else {                                              // CLOTHES — a folded stack of garments
            c.fillStyle = col; c.fillRect(p.x - 5, p.y - 4, 10, 4);                       // lower garment
            c.fillStyle = cols[(seed + si + i + 3) % cols.length]; c.fillRect(p.x - 5, p.y - 8, 10, 4); // upper garment (contrasting)
            c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 0.8;
            c.beginPath(); c.moveTo(p.x - 5, p.y - 6); c.lineTo(p.x + 5, p.y - 6); c.stroke(); // fold line
          }
        }
      });
    }
    // One tile of the shop's central display island: a waist-high counter with
    // goods on top, or a cash register on the middle tile (`reg`).
    function drawShopIsland(c, gx, gy, reg) {
      var H = 20;
      furnShadow(c, gx - 0.46, gy - 0.46, gx + 0.46, gy + 0.46);
      isoBox(c, gx - 0.46, gy - 0.46, gx + 0.46, gy + 0.46, H, '#eef2f4', '#c4d2da', '#b0c0c9');
      var m = iso(gx, gy), topY = m.y - H, cols = ['#e0563f', '#3d8fd0', '#7d5bbe', '#3bb1a2', '#e0a93c'];
      if (reg) {                                               // cash register
        c.fillStyle = '#3a444e'; roundRect(c, m.x - 6, topY - 12, 12, 12, 2); c.fill();
        c.fillStyle = '#6fd4e6'; c.fillRect(m.x - 4, topY - 10, 8, 4);          // screen
        c.fillStyle = '#aeb8c0'; c.fillRect(m.x - 5, topY - 4, 10, 3);          // keys
      } else {                                                 // goods on the counter: folded clothes + a toy ball
        c.fillStyle = cols[(Math.round(gx) * 2) % cols.length];                            // folded garment stack
        c.fillRect(m.x - 10, topY - 8, 9, 8);
        c.fillStyle = cols[(Math.round(gx) * 2 + 2) % cols.length]; c.fillRect(m.x - 10, topY - 8, 9, 3);
        c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 0.8;
        c.beginPath(); c.moveTo(m.x - 10, topY - 5); c.lineTo(m.x - 1, topY - 5); c.stroke();
        c.fillStyle = cols[(Math.round(gx) * 2 + 4) % cols.length];                        // toy ball
        c.beginPath(); c.arc(m.x + 6, topY - 4, 4, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.5)'; c.beginPath(); c.arc(m.x + 4.6, topY - 5, 1.2, 0, Math.PI * 2); c.fill();
      }
    }
    // Ghost for the 5×5 shop: footprint tint + a preview of the display island.
    function drawShopGhost(rot) {
      var ok = canPlaceShop(pointer.gx, pointer.gy);
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.34)' : 'rgba(224,86,63,0.42)';
      shopTiles(pointer.gx, pointer.gy).forEach(function (t) { var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill(); });
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      shopIslandTiles(pointer.gx, pointer.gy).forEach(function (t, i) { drawShopIsland(ghostCtx, t.x, t.y, i === 1); });
      var gct = shopCashierTile(pointer.gx, pointer.gy); drawCashier(ghostCtx, gct.x, gct.y, 'male');
      if (!ok) { ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop'; ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // Ghost for the 4×4 pharmacy: footprint tint + previews of the 2 counters/circles.
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
    // Shoulder-length side locks framing the face — the "female" gender cue. Drawn in
    // the figure's local space (origin at the feet, head centred at (0,hy)), in the
    // staffer's hair colour, just after the head so headwear still sits on top.
    function drawLongHair(c, hy, color) {
      c.fillStyle = color;
      c.beginPath();                                   // left lock
      c.moveTo(-8, hy - 3); c.quadraticCurveTo(-12, hy + 4, -9.5, hy + 13);
      c.lineTo(-5.5, hy + 13); c.quadraticCurveTo(-7, hy + 4, -6, hy - 3); c.closePath(); c.fill();
      c.beginPath();                                   // right lock
      c.moveTo(8, hy - 3); c.quadraticCurveTo(12, hy + 4, 9.5, hy + 13);
      c.lineTo(5.5, hy + 13); c.quadraticCurveTo(7, hy + 4, 6, hy - 3); c.closePath(); c.fill();
    }

    function drawCleaner(c, gx, gy, gender) {
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
      if (gender === 'female') drawLongHair(c, hy, '#7a5a3a');
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

    // A hired Worker: teal grooming smock + apron, yellow rubber gloves, a polka-dot
    // bandana and a slicker brush — reads distinct from the vet/cleaner at a glance.
    function drawWorker(c, gx, gy, gender) {
      var s = iso(gx, gy);
      c.fillStyle = 'rgba(20,40,30,0.26)';
      c.beginPath(); c.ellipse(s.x, s.y, 13, 6, 0, 0, Math.PI * 2); c.fill();
      c.save(); c.translate(s.x, s.y);
      c.fillStyle = '#3a4652'; c.fillRect(-6, -14, 5, 14); c.fillRect(1, -14, 5, 14);   // legs
      c.fillStyle = '#22252b'; c.fillRect(-7, -3, 6, 4); c.fillRect(1, -3, 6, 4);        // shoes
      var bt = -40;
      c.fillStyle = gradL(c, 0, bt, 0, -12, [[0, '#3fb9a6'], [1, '#2b8f80']]); roundRect(c, -11, bt, 22, 28, 7); c.fill(); // teal smock
      c.fillStyle = '#2b8f80'; roundRect(c, -14, bt + 2, 5, 13, 2.5); c.fill(); roundRect(c, 9, bt + 2, 5, 13, 2.5); c.fill(); // sleeves
      c.fillStyle = '#eaf6f3'; roundRect(c, -7, bt + 6, 14, 18, 3); c.fill();            // apron panel
      c.fillStyle = '#cfe8e2'; c.fillRect(-6, bt + 15, 12, 5);                            // apron pocket
      c.fillStyle = '#f2c94c'; c.fillRect(-14, bt + 14, 5, 5); c.fillRect(9, bt + 14, 5, 5); // rubber gloves
      c.fillStyle = '#e7bd98'; c.fillRect(-3, bt - 4, 6, 5);                              // neck
      var hy = bt - 13;
      c.fillStyle = '#f0c8a4'; c.beginPath(); c.arc(0, hy, 8.5, 0, Math.PI * 2); c.fill(); // head
      if (gender === 'female') drawLongHair(c, hy, '#5a3f2a');
      c.fillStyle = '#5a3f2a'; c.fillRect(-8.5, hy + 1, 17, 4);                           // hair under bandana
      c.fillStyle = '#2f9e90';                                                            // teal bandana
      c.beginPath(); c.arc(0, hy - 1, 9, Math.PI, Math.PI * 2, false); c.closePath(); c.fill();
      c.fillRect(-9, hy - 2, 18, 3);
      c.fillStyle = '#fff';                                                               // polka dots
      c.beginPath(); c.arc(-4, hy - 4, 1.1, 0, Math.PI * 2); c.arc(3, hy - 5, 1.1, 0, Math.PI * 2); c.arc(6, hy - 2, 1.1, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#2b2b33';                                                            // eyes
      c.beginPath(); c.arc(-3, hy + 1.5, 1.3, 0, Math.PI * 2); c.arc(3, hy + 1.5, 1.3, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#9a5f44'; c.lineWidth = 1.2;                                       // smile
      c.beginPath(); c.arc(0, hy + 4, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
      c.fillStyle = '#9a6a3a'; roundRect(c, 12, -26, 4, 9, 2); c.fill();                  // brush handle
      c.fillStyle = '#d8dee3'; c.fillRect(11, -18, 6, 3);                                 // brush bristles
      c.restore();
    }
    function drawWorkerGhost() {
      var ok = canPlaceCleaner(pointer.gx, pointer.gy), s = iso(pointer.gx, pointer.gy);
      ctx.save();
      ctx.beginPath(); ctx.ellipse(s.x, s.y, TILE_HW * 0.55, TILE_HH * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.3)' : 'rgba(224,86,63,0.4)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = ok ? 'rgba(70,205,120,1)' : 'rgba(224,86,63,0.95)'; ctx.stroke();
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawWorker(ghostCtx, pointer.gx, pointer.gy);
      if (!ok) { ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop'; ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }
    // Ghost for the 3×6 grooming parlour: footprint tint + previews of both stations.
    function drawGroomGhost(rot) {
      var ok = canPlaceGrooming(pointer.gx, pointer.gy), st = groomStations(pointer.gx, pointer.gy);
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.34)' : 'rgba(224,86,63,0.42)';
      groomTiles(pointer.gx, pointer.gy).forEach(function (t) { var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill(); });
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      drawGroomShower(ghostCtx, st[0].fixture.x, st[0].fixture.y, false);
      drawGroomDryer(ghostCtx, st[1].fixture.x, st[1].fixture.y, false);
      st.forEach(function (s) { drawExamCircle(ghostCtx, s.circle.x, s.circle.y, false); });
      if (!ok) { ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop'; ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }
    function drawHotelGhost() {
      var gx = pointer.gx, gy = pointer.gy, ok = canPlaceHotel(gx, gy);
      var fake = { gx: gx, gy: gy };
      ctx.save();
      ctx.fillStyle = ok ? 'rgba(76,196,106,0.34)' : 'rgba(224,86,63,0.42)';
      hotelTiles(gx, gy).forEach(function (t) { var s = iso(t.x, t.y); diamondPath(ctx, s.x, s.y); ctx.fill(); });
      ctx.restore();
      ghostCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ghostCtx.clearRect(0, 0, view.w, view.h);
      hotelBeds(fake, 'dog').forEach(function (t) { drawPetBed(ghostCtx, t.x, t.y, true, 0); });
      hotelBeds(fake, 'cat').forEach(function (t) { drawPetBed(ghostCtx, t.x, t.y, false, 0); });
      hotelDeskTiles(gx, gy).forEach(function (t, i) { drawHotelDesk(ghostCtx, t.x, t.y, i === 0); });
      hotelPlantTiles(gx, gy).forEach(function (t) { drawFicus(ghostCtx, t.x, t.y); });
      if (!ok) { ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop'; ghostCtx.fillStyle = 'rgba(222,58,44,0.6)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    function drawGhost() {
      if (!placing) return;
      var item = placing.item, rot = placing.rot || 0;
      if (item.kind === 'corridor') { if (pointer.on || corridorDrag) drawCorridorGhost(); return; }
      if (item.kind === 'blank') { if (pointer.on || corridorDrag) drawBlankGhost(); return; }
      if (item.kind === 'park') { if (pointer.on || corridorDrag) drawParkGhost(); return; }
      if (!pointer.on) return;
      if (item.kind === 'staff') { drawStaffGhost(); return; }
      if (item.kind === 'examstaff') { drawVetStaffGhost(); return; }
      if (item.kind === 'restroom') { drawRestroomGhost(rot); return; }
      if (item.kind === 'exam') { drawExamGhost(rot); return; }
      if (item.kind === 'xray') { drawXrayGhost(rot); return; }
      if (item.kind === 'pharmacy') { drawPharmGhost(rot); return; }
      if (item.kind === 'shop') { drawShopGhost(rot); return; }
      if (item.kind === 'grooming') { drawGroomGhost(rot); return; }
      if (item.kind === 'hotel') { drawHotelGhost(); return; }
      if (item.kind === 'surgery') { drawSurgeryGhost(rot); return; }
      if (item.kind === 'pharmstaff') { drawPharmStaffGhost(); return; }
      if (item.kind === 'cleaner') { drawCleanerGhost(); return; }
      if (item.kind === 'worker') { drawWorkerGhost(); return; }
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
      for (i = shops.length - 1; i >= 0; i--) if (inTiles(shopTiles(shops[i].gx, shops[i].gy))) return { kind: 'shop', room: shops[i], arr: shops, idx: i };
      for (i = groomings.length - 1; i >= 0; i--) if (inTiles(groomTiles(groomings[i].gx, groomings[i].gy))) return { kind: 'grooming', room: groomings[i], arr: groomings, idx: i };
      for (i = hotels.length - 1; i >= 0; i--) if (inTiles(hotelTiles(hotels[i].gx, hotels[i].gy))) return { kind: 'hotel', room: hotels[i], arr: hotels, idx: i };
      for (i = surgeries.length - 1; i >= 0; i--) if (inTiles(surgeryTiles(surgeries[i].gx, surgeries[i].gy))) return { kind: 'surgery', room: surgeries[i], arr: surgeries, idx: i };
      for (i = restrooms.length - 1; i >= 0; i--) if (inTiles(footprintTiles(FURN_BY_ID.restroom, restrooms[i].gx, restrooms[i].gy, restrooms[i].rot || 0))) return { kind: 'restroom', room: restrooms[i], arr: restrooms, idx: i };
      return null;
    }
    // A room with a patient (or pharmacy customer / shop browser) in/incoming
    // can't be moved.
    function roomBusy(rh) {
      if (rh.kind === 'pharmacy') return rh.room.stations.some(function (s) { return s.patient; });
      if (rh.kind === 'shop') return visitors.some(function (v) { return v.shopRoom === rh.room; });
      if (rh.kind === 'hotel') return rh.room.pets.length > 0 || visitors.some(function (v) { return v.hotelRoom === rh.room; });
      return !!rh.room.occupant;
    }
    // Free a room's floor + fixtures and drop it from its array (reverse of place*).
    function removeRoom(rh) {
      var r = rh.room, k = examKeyTiles(r.gx, r.gy, r.rot);
      function clearFloor(ts) { ts.forEach(function (t) { delete corridor[t.x + ',' + t.y]; }); }
      if (rh.kind === 'exam') { clearFloor(examTiles(r.gx, r.gy)); delete occupied[k.table.x + ',' + k.table.y]; }
      else if (rh.kind === 'xray') { clearFloor(xrayTiles(r.gx, r.gy)); delete occupied[k.table.x + ',' + k.table.y]; delete occupied[k.desk.x + ',' + k.desk.y]; }
      else if (rh.kind === 'pharmacy') { clearFloor(pharmTiles(r.gx, r.gy)); pharmStations(r.gx, r.gy, r.rot).forEach(function (s) { delete occupied[s.counter.x + ',' + s.counter.y]; }); }
      else if (rh.kind === 'shop') { clearFloor(shopTiles(r.gx, r.gy)); shopIslandTiles(r.gx, r.gy).concat([shopCashierTile(r.gx, r.gy)]).forEach(function (t) { delete occupied[t.x + ',' + t.y]; }); }
      else if (rh.kind === 'grooming') { clearFloor(groomTiles(r.gx, r.gy)); groomStations(r.gx, r.gy).forEach(function (s) { delete occupied[s.fixture.x + ',' + s.fixture.y]; }); }
      else if (rh.kind === 'hotel') { clearFloor(hotelTiles(r.gx, r.gy)); hotelBeds(r, 'dog').concat(hotelBeds(r, 'cat'), hotelDeskTiles(r.gx, r.gy), hotelPlantTiles(r.gx, r.gy)).forEach(function (t) { delete occupied[t.x + ',' + t.y]; }); }
      else if (rh.kind === 'surgery') { var sk = surgeryKeyTiles(r.gx, r.gy); clearFloor(surgeryTiles(r.gx, r.gy)); [sk.table, sk.monitor, sk.trolley].forEach(function (t) { delete occupied[t.x + ',' + t.y]; }); }
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
          staff.push({ type: item.id, line: st.line, name: '', gender: randGender() });
          chargeStaffHire(item);
          cancelPlacing();
        }
        return;
      }
      if (item.kind === 'examstaff') {      // assign a Vet to an exam room's circle
        var ec = nearestExamCircle();
        if (pointer.on && ec && ec.ok) {
          vets.push({ x: ec.x, y: ec.y, room: null, working: false, speed: 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0, name: '', gender: randGender() });
          chargeStaffHire(item);
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
      if (item.kind === 'pharmacy') {       // 4x4 walkable room with 2 medicine counters
        if (pointer.on && canPlacePharmacy(pointer.gx, pointer.gy)) {
          placePharmacy(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'shop') {           // 5x5 retail room — clients browse it on the way out
        if (pointer.on && canPlaceShop(pointer.gx, pointer.gy)) {
          placeShop(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'grooming') {       // 3x6 parlour with a shower + blow-dry station
        if (pointer.on && canPlaceGrooming(pointer.gx, pointer.gy)) {
          placeGrooming(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'hotel') {          // 6x5 boarding hotel: two bed wings + desk
        if (pointer.on && canPlaceHotel(pointer.gx, pointer.gy)) {
          placeHotel(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'surgery') {        // 4x5 operating theatre (2 vets + 1 worker to run)
        if (pointer.on && canPlaceSurgery(pointer.gx, pointer.gy)) {
          placeSurgery(pointer.gx, pointer.gy, rot);
          if (!placing.moving) { money -= item.cost; renderMoney(); }
          placing.origRoom = null; cancelPlacing();
        }
        return;
      }
      if (item.kind === 'pharmstaff') {     // hire a Pharmacist onto a counter circle
        var pc = nearestPharmCircle();
        if (pointer.on && pc && pc.ok) {
          pc.station.pharm = newPharm();
          chargeStaffHire(item);
          cancelPlacing();
        }
        return;
      }
      if (item.kind === 'cleaner') {        // drop a roaming cleaner on clear room floor
        if (pointer.on && canPlaceCleaner(pointer.gx, pointer.gy)) {
          cleaners.push({ x: pointer.gx, y: pointer.gy, speed: 2.3, dir: 'SE', walkPhase: 0, moving: false, target: null, path: null, wp: 0, name: '', gender: randGender() });
          chargeStaffHire(item);
          cancelPlacing();
        }
        return;
      }
      if (item.kind === 'worker') {         // drop a roaming worker on clear room floor
        if (pointer.on && canPlaceCleaner(pointer.gx, pointer.gy)) {
          workers.push({ x: pointer.gx, y: pointer.gy, room: null, working: false, speed: 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0, shopTarget: null, post: null, name: '', gender: randGender() });
          chargeStaffHire(item);
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
        else if (rr.kind === 'shop') placeShop(rr.gx, rr.gy, rr.rot);
        else if (rr.kind === 'grooming') placeGrooming(rr.gx, rr.gy, rr.rot);
        else if (rr.kind === 'hotel') placeHotel(rr.gx, rr.gy, rr.rot);
        else if (rr.kind === 'surgery') placeSurgery(rr.gx, rr.gy, rr.rot);
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

    // Staff shop icons rendered from the SAME sprite draw fns used in-world, so each
    // card shows the actual character (front-facing) instead of a generic emoji.
    // Cached as a data-URL <img> the first time a staff card is built.
    var staffIconCache = {};
    function staffIconURL(id) {
      if (staffIconCache[id]) return staffIconCache[id];
      var W = 48, H = 74, fx = 23, fy = 66;            // foot anchor inside the icon canvas
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var c = cv.getContext('2d');
      // invert iso() so the figure's feet land on (fx,fy) within THIS canvas
      var ax = (fx - camera.x) / TILE_HW, ay = (fy - camera.y) / TILE_HH;
      var gx = (ax + ay) / 2, gy = (ay - ax) / 2;
      if (id === 'receptionist')    drawReceptionist(c, gx, gy, 'male');
      else if (id === 'vet')        drawVetStaff(c, gx, gy, 0, 'SE', 'male');
      else if (id === 'pharmacist') drawPharmacist(c, gx, gy, 'male');
      else if (id === 'cleaner')    drawCleaner(c, gx, gy, 'male');
      else if (id === 'worker')     drawWorker(c, gx, gy, 'male');
      else return null;
      staffIconCache[id] = '<img class="staff-ic" src="' + cv.toDataURL() + '" alt="" style="height:42px;width:auto;display:block">';
      return staffIconCache[id];
    }
    function shopIcon(item) { return (item.cat === 'staff' && staffIconURL(item.id)) || item.icon; }
    function shopCard(item) {
      var cost = itemCost(item);
      var afford = money >= cost;
      var card = document.createElement('div');
      card.className = 'shop-item' + (afford ? '' : ' disabled') +
                       (placing && placing.item.id === item.id ? ' selected' : '');
      if (item.cat === 'staff') card.setAttribute('data-staff', item.id);  // hover → highlight this staff type
      card.innerHTML = '<div class="ic">' + shopIcon(item) + '</div>' +
                       '<div class="nm">' + item.name + '</div>' +
                       '<div class="pr">$' + cost + (item.perSquare ? '/sq' : '') + '</div>';
      card.addEventListener('click', function () {
        if (money < itemCost(item)) return;
        placing = (placing && placing.item.id === item.id) ? null : { item: item, rot: 0 };
        corridorDrag = null;
        document.body.classList.toggle('placing', !!placing);
        renderStatic();                      // toggle walls off (placing) / on (deselected)
        renderShop();
      });
      return card;
    }
    function renderShop() {
      if (activeTab === 'skills') { renderSkillCards(); return; }
      shopItemsEl.innerHTML = '';
      var items = FURNITURE.filter(function (item) { return (item.cat || 'reception') === activeTab; });
      if (activeTab === 'park') {
        // Park tab splits into two labeled columns: dog-park items left, cat items right.
        [{ label: 'Dog Park', items: items.filter(function (i) { return !i.catItem; }) },
         { label: 'Cats',     items: items.filter(function (i) { return i.catItem; }) }
        ].forEach(function (g) {
          var group = document.createElement('div');
          group.className = 'shop-group';
          group.innerHTML = '<div class="shop-group-label">' + g.label + '</div>';
          var row = document.createElement('div');
          row.className = 'shop-group-items';
          g.items.forEach(function (item) { row.appendChild(shopCard(item)); });
          group.appendChild(row);
          shopItemsEl.appendChild(group);
        });
        return;
      }
      items.forEach(function (item) { shopItemsEl.appendChild(shopCard(item)); });
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
    // Visitors queue at the reception desks (or a back-of-room fallback before
    // one is bought). Every desk hosts TWO lines on its front side, so line
    // indices are global: line L belongs to desk L>>1 and is its side L&1.
    function deskList() { return placed.filter(function (f) { return f.id === 'desk'; }); }
    function deskAnchor(i) {
      var ds = deskList();
      if (ds.length) return ds[Math.min(i || 0, ds.length - 1)];
      return { gx: 3, gy: 1, rot: 0 };
    }
    function deskForLine(L) { return deskAnchor((L || 0) >> 1); }
    function numLines() { return 2 * Math.max(1, deskList().length); }
    // Keep one queue pair per desk. Desks can be bought, moved, or picked up at
    // any time, so the line list is resynced each frame: visitors caught in a
    // removed line rejoin the shortest surviving one, and receptionists on a
    // removed station step to the first free surviving station.
    function ensureQueues() {
      var n = numLines();
      while (queue.length < n) queue.push([]);
      if (queue.length > n) {
        var orphans = [];
        while (queue.length > n) orphans = orphans.concat(queue.pop());
        orphans.forEach(function (v) { v.line = shortestLine(); queue[v.line].push(v); });
        staff.forEach(function (s) {
          if ((s.line || 0) >= n) { s.line = freeLine(); s.curLine = s.line; }
        });
      }
    }
    function shortestLine() {
      var best = 0;
      for (var L = 1; L < queue.length; L++) if (queue[L].length < queue[best].length) best = L;
      return best;
    }
    function freeLine() {
      for (var L = 0; L < numLines(); L++)
        if (!staff.some(function (s) { return (s.line || 0) === L; })) return L;
      return 0;
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
      var d = deskForLine(v.line), f = FRONT[d.rot || 0];
      var base = deskLineTiles(d)[v.line & 1], idx = (queue[v.line] || []).indexOf(v);
      if (idx < 0) idx = 0;
      var sx = base.x + f.x * (1 + idx), sy = base.y + f.y * (1 + idx);
      return { x: sx, y: sy };   // no clamp: long lines extend out in front, not stacked on the edge tile
    }

    function spawnVisitor() {
      var seq = visitorSeq++;
      // join the shortest line across every desk (random among ties)
      ensureQueues();
      var best = 1e9, ties = [];
      for (var L = 0; L < queue.length; L++) {
        if (queue[L].length < best) { best = queue[L].length; ties = [L]; }
        else if (queue[L].length === best) ties.push(L);
      }
      var line = ties.length > 1 ? ties[Math.floor(Math.random() * ties.length)] : ties[0];
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
      // EVERY visitor checks in at reception first — their journey (exam, park,
      // shop, pharmacy, groom) is rolled at the desk (see serveVisitor/rollIntent).
      queue[line].push(v);
      visitors.push(v);
    }

    var departStats = { happy: 0, unhappy: 0 };   // running tally of rated departures (debug/balance)
    function leaveOutbound(v) {
      if (!v.left) {                        // tune arrival rate once per departure, by reason
        v.left = true;
        var rBefore = ratingValue();
        departStats[(v.happy && !v.peed) ? 'happy' : 'unhappy']++;
        if (v.happy && !v.peed) {
          // happy = the client COMPLETED their whole journey (intent + every
          // follow-up terminal sets v.happy) → arrivals speed up — UNLESS they had
          // to use a dirty room, which cancels the positive effect (stays flat).
          // As a clinic gets great (low frq), each happy visit speeds arrivals
          // MORE, so an excellent clinic can ride the pace all the way to ~1/sec.
          if (!v.usedDirtyRoom) { var boost = frq < 12 ? 1 + (12 - frq) / 12 : 1; frq = Math.max(1, frq - diff().up * boost); }
        } else frq = Math.min(100, frq + diff().down);          // unhappy (gave up / accident / service never completed — even if the room was never built) → arrivals slow down. This is the SELF-REGULATOR: an over-promising clinic gets pushed back to a rate it can actually serve.
        renderRating();                                         // arrival rate changed → refresh rating
        floatRatingDelta(ratingValue() - rBefore);              // animate the +/- change out of the chip
      }
      v.sideIdx = -1;                      // release any side spot
      if (v.chair) {                       // stand up off the seat onto its clear front tile
        v.x = v.chair.fx; v.y = v.chair.fy; v.seated = false; v.chair = null;
      }
      var qi = queue[v.line] ? queue[v.line].indexOf(v) : -1;   // drop out of the queue so others advance
      if (qi >= 0) queue[v.line].splice(qi, 1);
      // Chance to detour to the dog park on the way out — scales with how big + nice
      // it is and shrinks as it fills up (parkAppeal). Once per visit (!parkDone).
      // Cat owners detour to the cat park (a furnished blank room) instead.
      // Detours are for CHECKED-IN clients only — a queue give-up who never
      // reached the desk walks straight out (everyone checks in before service).
      if (v.served && !v.parkDone && v.pet === 'cat' && parkAppeal('cat') > 0 && Math.random() < parkAppeal('cat')) {
        if (startDogPark(v, 'cat')) return; // off to the cat playground instead of leaving
      }
      if (v.served && !v.parkDone && parkSize() && Math.random() < parkAppeal()) {
        if (startDogPark(v)) return;        // off to the grass instead of leaving
      }
      // Low chance to detour through the shop on the way out (once per visit). If a
      // free aisle spot is found, head there to browse; otherwise just leave.
      if (v.served && !v.shopped && shops.length && Math.random() < SHOP_CHANCE) {
        if (tryShop(v)) return;              // browse on the way out (rating already recorded above)
      }
      headForExit(v);
    }
    // Route a departing client out through the doors and off down the sidewalk.
    function headForExit(v) {
      v.phase = 'leaving';
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
    // True if moving a→b crosses a tile boundary through a wall: an internal room
    // wall (roomWallEdge) or the outer room-floor boundary — which is walled
    // everywhere except the front-entrance door gap (tiles x 3/4 at the clinic's
    // south edge). Walls are physically solid for EVERY actor; only doors pass.
    function wallStep(ax, ay, bx, by) {
      ax = Math.round(ax); ay = Math.round(ay); bx = Math.round(bx); by = Math.round(by);
      if (ax === bx && ay === by) return false;              // same tile → nothing crossed
      if (roomWallEdge(ax, ay, bx, by)) return true;
      var fa = isRoomFloor(ax, ay), fb = isRoomFloor(bx, by);
      if (fa === fb) return false;                           // both inside or both outside
      var doorGap = (ax === bx) && (ax === 3 || ax === 4) && // entrance columns through the sliding doors
                    Math.min(ay, by) === ROOM - 1 && Math.max(ay, by) === ROOM;
      return !doorGap;
    }
    // Axis-separated move so actors slide along furniture instead of stopping dead.
    // `blocked` defaults to furniture-only (visitors walk the path/road too).
    // If the actor is already standing ON a blocked tile (e.g. a seated client on a
    // bench/chair), let them move freely so they can escape it — otherwise the tile
    // they occupy blocks every step and they get stuck getting up. Walls are always
    // solid — even an escaping actor may never cross one (wallStep).
    function moveActor(a, nx, ny, blocked) {
      blocked = blocked || tileBlocked;
      var escaping = blocked(a.x, a.y);
      if ((escaping || !blocked(nx, a.y)) && !wallStep(a.x, a.y, nx, a.y)) a.x = nx;
      if ((escaping || !blocked(a.x, ny)) && !wallStep(a.x, a.y, a.x, ny)) a.y = ny;
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
    // `blocked` overrides the default collision test — roaming staff pass vetBlocked
    // so a crowd can never shove them off the room floor (which would teleport them).
    function stepToward(v, tx, ty, dt, eps, blocked) {
      var dx = tx - v.x, dy = ty - v.y, dist = Math.hypot(dx, dy);
      if (dist < (eps || 0.05)) return true;
      var ux = dx / dist, uy = dy / dist;
      // Clamp the step to the remaining distance: a fast actor (e.g. a cleaner
      // at high Cleaning skill, speed = 2.3×val) otherwise overshoots the
      // waypoint every frame and ping-pongs around it forever, since one step
      // can be far larger than the eps arrival radius.
      var step = Math.min(v.speed * dt, dist);
      moveActor(v, v.x + ux * step, v.y + uy * step,
                blocked || function (x, y) { return tileBlocked(x, y) || visitorOn(v, x, y); });
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
          if (roomWallEdge(c.x, c.y, nx, ny)) continue;             // seat paths respect walls too
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
      var d = deskForLine(line), f = FRONT[d.rot || 0], t = deskLineTiles(d)[line & 1];
      return { x: t.x - f.x, y: t.y - f.y };
    }
    function vetAtStation(line) {
      if (!hasDesk()) return false;
      var s = stationTile(line);
      return Math.round(vet.x) === s.x && Math.round(vet.y) === s.y;
    }
    // A hired receptionist mans a line's station. With both of a desk's stations
    // manned each receptionist covers their own line; a desk's LONE receptionist
    // alternates between its two lines (their `curLine` toggles after each
    // client — see updateReceptionist / serveVisitor), so they serve both queues
    // instead of leaving one starved.
    function deskStaff(di) {
      return staff.filter(function (s) { return ((s.line || 0) >> 1) === di; });
    }
    function staffLine(s) {
      var line = s.line || 0;
      var lone = deskStaff(line >> 1).length === 1;
      return (lone && s.curLine != null && (s.curLine >> 1) === (line >> 1)) ? s.curLine : line;
    }
    function staffAtStation(line) {
      return staff.some(function (s) { return staffLine(s) === line; });
    }
    // A desk's lone receptionist switches to its other queue when their current
    // one runs out (so they never sit idle while clients wait on the other side).
    function updateReceptionist() {
      staff.forEach(function (s) {
        var di = (s.line || 0) >> 1;
        if (deskStaff(di).length !== 1) return;
        if (s.curLine == null || (s.curLine >> 1) !== di) s.curLine = (s.line || 0);
        var other = di * 2 + (1 - (s.curLine & 1));
        if ((queue[s.curLine] || []).length === 0 && (queue[other] || []).length > 0) s.curLine = other;
      });
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
      for (i = 0; i < shops.length; i++) { rm = shops[i];
        if (crosses(rm.door, ax >= rm.gx && ax < rm.gx + SHOP_W && ay >= rm.gy && ay < rm.gy + SHOP_H,
                             bx >= rm.gx && bx < rm.gx + SHOP_W && by >= rm.gy && by < rm.gy + SHOP_H)) return true; }
      for (i = 0; i < groomings.length; i++) { rm = groomings[i];
        if (crosses(rm.door, ax >= rm.gx && ax < rm.gx + GROOM_W && ay >= rm.gy && ay < rm.gy + GROOM_H,
                             bx >= rm.gx && bx < rm.gx + GROOM_W && by >= rm.gy && by < rm.gy + GROOM_H)) return true; }
      for (i = 0; i < surgeries.length; i++) { rm = surgeries[i];
        if (crosses(rm.door, ax >= rm.gx && ax < rm.gx + SURG_W && ay >= rm.gy && ay < rm.gy + SURG_H,
                             bx >= rm.gx && bx < rm.gx + SURG_W && by >= rm.gy && by < rm.gy + SURG_H)) return true; }
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
    var examRouteReached = false;   // did the LAST examRoute actually connect to its target? (false = fallback)
    // When set (by the anti-stuck recovery, for one call), examRoute also treats
    // tiles under OTHER stationary visitors as blocked, so a wedged walker gets a
    // path AROUND whoever is parked on their old route. Normal routing stays
    // visitor-blind (cheap, and walkers usually flow past each other fine).
    var routeAvoidFor = null;
    function examRoute(sx, sy, tx, ty) {
      sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
      var key = function (x, y) { return x + ',' + y; };
      var standing = null;
      if (routeAvoidFor) {
        standing = {};
        for (var vi = 0; vi < visitors.length; vi++) {
          var ov = visitors[vi];
          if (ov === routeAvoidFor || ov.moving) continue;
          standing[Math.round(ov.x) + ',' + Math.round(ov.y)] = true;
        }
      }
      var pass = function (x, y) {
        return isRoomFloor(x, y) && !occupied[key(x, y)] &&
               !(standing && standing[key(x, y)] && !(x === tx && y === ty));
      };
      examRouteReached = false;
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
      examRouteReached = true;
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
    // A room type's key tiles (table/circle/visitor/...): the exam 3×3 layout by
    // default, or the descriptor's own `key` fn (surgery's 4×5 theatre).
    function roomKey(type, rm) { return (ROOM_TYPES[type].key || examKeyTiles)(rm.gx, rm.gy, rm.rot); }
    function claimRoomGeneric(v, type) {
      // Try every free room of the type, ROUTE FIRST, and only claim one the
      // visitor can actually reach — an unreachable room (door blocked, floor
      // disconnected) must never be occupied by someone who can't get there.
      var d = ROOM_TYPES[type], L = d.list;
      for (var i = 0; i < L.length; i++) {
        var rm = L[i];
        if (rm.occupant || beingCleaned(rm)) continue;
        var k = roomKey(type, rm);
        // BFS a real route over connected room floor (clinic → corridors → room),
        // around furniture, so clients don't beeline into walls and jam.
        var path = examRoute(v.x, v.y, k.visitor.x, k.visitor.y);
        if (!examRouteReached) continue;    // can't reach this room → try the next
        rm.occupant = v; rm[d.timer] = 0; v[d.vRoom] = rm;
        if (rm.dirty) v.usedDirtyRoom = true;  // visiting a grimy room: faster frustration + no rating bonus
        v.seated = false; v.chair = null; v.sideIdx = -1;
        v.patience = baseWait();            // fresh patience for the stage (restroom need persists)
        v.path = path; v.wp = 0; v.phase = d.toPhase;
        return true;
      }
      return false;
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
      // A failed claim means every free room is unreachable from that visitor —
      // stop for this frame (one BFS sweep, retried next frame) instead of
      // re-running the same failing search for everyone behind them.
      for (var i = 0; i < waiting.length && freeRoom(type); i++)
        if (!claimRoomGeneric(waiting[i], type)) break;
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

    // ---- Surgery flow (mirrors X-ray, but staffed by 2 vets + 1 worker) ----
    function claimSurgery(v) { return claimRoomGeneric(v, 'surgery'); }
    function releaseSurgery(v) { releaseRoomGeneric(v, 'surgery'); }
    function assignSurgeries() { assignRoomGeneric('surgery'); }
    // A vet slot is filled by the player OR any hired vet standing on the tile.
    function vetOnTile(t) {
      if (playerAtTile(t)) return true;
      for (var i = 0; i < vets.length; i++)
        if (Math.round(vets[i].x) === t.x && Math.round(vets[i].y) === t.y) return true;
      return false;
    }
    // Fully staffed = both surgeon circles + the nurse circle manned. One body
    // per tile, so three slots always means three people (player counts as one).
    function surgeryStaffed(rm) {
      var k = surgeryKeyTiles(rm.gx, rm.gy);
      return vetOnTile(k.vetA) && vetOnTile(k.vetB) &&
             (playerAtTile(k.worker) || workerAtTile(k.worker));
    }

    // ---- Pharmacy patient flow ------------------------------------------
    function playerAtPharm(ph, idx) {
      var sec = pharmStations(ph.gx, ph.gy, ph.rot)[idx];
      return Math.round(vet.x) === sec.circle.x && Math.round(vet.y) === sec.circle.y;
    }
    function claimPharmacy(v) {
      // Route first, claim only a reachable counter (mirrors claimRoomGeneric).
      for (var p = 0; p < pharmacies.length; p++) {
        var ph = pharmacies[p];
        for (var j = 0; j < ph.stations.length; j++) {
          if (ph.stations[j].patient) continue;
          var sec = pharmStations(ph.gx, ph.gy, ph.rot)[j];
          var path = examRoute(v.x, v.y, sec.patient.x, sec.patient.y);
          if (!examRouteReached) continue;   // unreachable counter → try the next
          ph.stations[j].patient = v; ph.stations[j].procT = 0;
          v.pharmacy = ph; v.pharmIdx = j;
          v.seated = false; v.chair = null; v.sideIdx = -1; v.patience = baseWait();
          v.path = path; v.wp = 0; v.phase = 'toPharm';
          return true;
        }
      }
      return false;
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
      for (var i = 0; i < waiting.length && freePharmStation(); i++)
        if (!claimPharmacy(waiting[i])) break;   // all free counters unreachable → retry next frame
    }

    // ---- Grooming patient flow -------------------------------------------
    // A grooming room takes one dog at a time: it enters, showers, walks to the
    // dry station, is blow-dried, then leaves — a full groom pays $80. Each station
    // fills at procTime rate while an operator stands on its circle (the player at
    // full rate, a hired Worker at half). No operator → the wait timer drains and
    // the dog leaves unpaid, pressuring you to staff (or work) the parlour.
    var GROOM_DURATION = 3;                 // ×procTime per station
    function playerAtTile(t) { return Math.round(vet.x) === t.x && Math.round(vet.y) === t.y; }
    function workerAtTile(t) { for (var i = 0; i < workers.length; i++) { var w = workers[i]; if (Math.round(w.x) === t.x && Math.round(w.y) === t.y) return true; } return false; }
    function claimGrooming(v) {
      // Route first, claim only a reachable parlour (mirrors claimRoomGeneric).
      for (var i = 0; i < groomings.length; i++) {
        var rm = groomings[i];
        if (rm.occupant || beingCleaned(rm)) continue;
        var st = groomStations(rm.gx, rm.gy);
        var path = examRoute(v.x, v.y, st[0].dogSpot.x, st[0].dogSpot.y);
        if (!examRouteReached) continue;    // unreachable parlour → try the next
        rm.occupant = v; rm.showerT = 0; rm.dryT = 0;
        v.groomRoom = rm; v.wantsGroom = true;
        v.seated = false; v.chair = null; v.sideIdx = -1; v.patience = baseWait();
        v.path = path; v.wp = 0; v.phase = 'toGroomShower';
        return true;
      }
      return false;
    }
    function releaseGroom(v) {
      if (v.groomRoom) { if (v.groomRoom.occupant === v) { v.groomRoom.occupant = null; v.groomRoom.showerT = 0; v.groomRoom.dryT = 0; } v.groomRoom = null; }
    }
    // Fill free grooming rooms with clients that rolled "wants a groom" (at reception
    // or after the dog park), in check-in order — mirrors assignPharmacies.
    function assignGrooming() {
      // NOTE: no demolished-parlour fallback — a groom-seeker with no parlour
      // waits, drains patience, and leaves UNHAPPY (missing facility = failed
      // journey, by design).
      if (!freeRoom('grooming')) return;
      var waiting = visitors.filter(function (v) {
        return v.wantsGroom && !v.groomed && v.groomRoom == null &&
          (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated' || v.phase === 'waitGroom');
      }).sort(function (a, b) { return (a.ticket || 0) - (b.ticket || 0); });
      for (var i = 0; i < waiting.length && freeRoom('grooming'); i++)
        if (!claimGrooming(waiting[i])) break;   // all free parlours unreachable → retry next frame
    }
    // Send waiting park-INTENT clients out to their zone (dogs → the turf, cats →
    // the furnished cat room). No zone / bare cat room / zone full → they keep
    // waiting and patience bails them out unhappy. Per-zone fail latch so a full
    // cat room doesn't waste BFS on every dog behind it (and vice versa).
    function assignParks() {
      var full = { dog: false, cat: false };
      var waiting = visitors.filter(function (v) {
        return v.intent === 'park' && !v.parkDone && !v.parkSpot &&
          (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated');
      }).sort(function (a, b) { return (a.ticket || 0) - (b.ticket || 0); });
      for (var i = 0; i < waiting.length; i++) {
        var v = waiting[i], zone = v.pet === 'cat' ? 'cat' : 'dog';
        if (full[zone]) continue;
        if (zone === 'cat' && !parkQuality('cat')) { full.cat = true; continue; }  // a bare blank room attracts no cats
        if (!freeParkSpot(null, zone)) { full[zone] = true; continue; }            // cheap pre-check before the BFS
        if (startDogPark(v, zone)) { v.seated = false; v.chair = null; v.sideIdx = -1; }
        else full[zone] = true;              // free spots all unreachable → retry next frame
      }
    }
    // Claim a free, REACHABLE shop aisle spot and route v there (route-before-
    // claim, like every other service). Shared by the shop intent and the
    // on-the-way-out browse detour in leaveOutbound.
    function tryShop(v) {
      var spot = claimShopSpot();
      if (!spot) return false;
      var sp = examRoute(v.x, v.y, spot.x, spot.y);
      if (!examRouteReached) return false;
      v.shopped = true; v.shopTile = { x: spot.x, y: spot.y }; v.shopRoom = spot.shop;
      v.seated = false; v.chair = null; v.sideIdx = -1;
      v.path = sp; v.wp = 0; v.phase = 'toShop'; v.shopBrowseT = 2.4;
      return true;
    }
    // Send waiting shop-INTENT clients to a free aisle spot to browse and buy.
    function assignShops() {
      var waiting = visitors.filter(function (v) {
        return v.intent === 'shop' && !v.shopped &&
          (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated');
      }).sort(function (a, b) { return (a.ticket || 0) - (b.ticket || 0); });
      for (var i = 0; i < waiting.length; i++)
        if (!tryShop(waiting[i])) break;     // no free/reachable aisle → retry next frame
    }

    // ---- Hotel boarding flow ----------------------------------------------
    // Owners flagged wantsHotel walk to the desk, hand the pet over and leave; the
    // pet lives on h.pets (persisted) and naps/plays until its stay runs out, when
    // a pickup owner spawns, walks in, collects it and pays the stay fee.
    function claimHotel(v) {
      var sp = petSpecies(v.pet);
      for (var i = 0; i < hotels.length; i++) {
        var h = hotels[i];
        if (!hotelTaking(h, sp)) continue;
        var drop = hotelDropTile(h);
        var path = examRoute(v.x, v.y, drop.x, drop.y);
        if (!examRouteReached) continue;
        v.hotelRoom = h; v.hotelBed = hotelFreeBed(h, sp);
        v.seated = false; v.chair = null; v.sideIdx = -1; v.patience = baseWait();
        v.path = path; v.wp = 0; v.phase = 'toHotel';
        return true;
      }
      return false;
    }
    function assignHotels() {
      var boarders = visitors.filter(function (v) {
        return v.wantsHotel && !v.hotelRoom &&
          (v.phase === 'served' || v.phase === 'idle' || v.phase === 'toChair' || v.phase === 'seated');
      }).sort(function (a, b) { return (a.ticket || 0) - (b.ticket || 0); });
      for (var i = 0; i < boarders.length; i++) {
        var v = boarders[i];
        if (!hotelAccepts(v.pet)) { v.wantsHotel = false; continue; }   // no hotel can take them → exam path instead
        claimHotel(v);                                                   // unreachable desk → retry next frame
      }
    }
    // Spawn the returning owner for pet p — idempotent (no-op while one is inbound),
    // so give-ups, demolished corridors and save/loads all self-heal.
    function spawnHotelPickup(h, p) {
      for (var i = 0; i < visitors.length; i++) if (visitors[i].hotelPet === p) return;
      var seq = visitorSeq++;
      var v = {
        id: seq, line: 0,
        x: ROOM + 5, y: ROOM + 5,
        speed: 1.7 + (seq % 3) * 0.12,
        dir: 'NE', moving: true, walkPhase: (seq % 2) * Math.PI,
        phase: 'toHotelPickup',
        patience: baseWait(),
        shirt: V_SHIRT[seq % V_SHIRT.length], legs: V_LEGS[seq % V_LEGS.length],
        skin: V_SKIN[seq % V_SKIN.length], hair: V_HAIR[seq % V_HAIR.length],
        pet: p.kind, carrier: CARRIER[seq % CARRIER.length],
        served: true, happy: true, petBoarded: true, parkDone: true, shopped: true,
        hotelRoom: h, hotelPet: p
      };
      var drop = hotelDropTile(h);
      v.path = [
        { x: DOOR_MID, y: ROOM + 5 },
        { x: DOOR_MID, y: ROOM + 0.2 },
        { x: DOOR_MID, y: ROOM - 1.4 }
      ].concat(examRoute(DOOR_MID, ROOM - 1.4, drop.x, drop.y) || []);
      v.wp = 0;
      visitors.push(v);
    }
    // Advance every boarded pet: stay countdown, park/cat-room play trips (reusing
    // the whole off-leash roaming system via a tiny host shim whose x/y sit at the
    // hotel door — d.recall then IS the walk-home trigger), and pickup spawning.
    function updateHotels(dt) {
      for (var i = 0; i < hotels.length; i++) {
        var h = hotels[i], door = h.door || hotelDropTile(h);
        for (var j = 0; j < h.pets.length; j++) {
          var p = h.pets[j];
          p.stayT -= dt;
          if (p.state === 'inBed') {
            if (p.stayT <= 0) { spawnHotelPickup(h, p); continue; }
            p.tripT -= dt;
            if (p.tripT <= 0) {
              p.tripT = 6;
              var zone = p.species === 'cat' ? 'cat' : 'dog';
              var parkOk = zone === 'dog' ? parkSize() > 0 : (catFloorSize() > 0 && parkQuality('cat') > 0);
              if (parkOk && p.stayT > 25 && Math.random() < 0.5) {   // guards before the draw (RNG parity)
                var lane = bedLaneTile(h, p);
                var spot = freeParkSpot({ x: lane.x, y: lane.y }, zone);
                if (spot) {
                  var path = examRoute(lane.x, lane.y, spot.x, spot.y);
                  if (examRouteReached) {
                    var b0 = bedTile(h, p);
                    p.x = b0.x; p.y = b0.y; p.path = path; p.wp = 0; p.state = 'toPark'; p.zone = zone;
                  }
                }
              }
            }
          } else if (p.state === 'toPark' || p.state === 'toHome') {
            if (p.path && p.wp < p.path.length) {
              var t = p.path[p.wp], dx = t.x - p.x, dy = t.y - p.y, dist = Math.hypot(dx, dy);
              var step = Math.min(PARK_DOG_SPEED * dt, dist);
              if (dist < 0.1) p.wp++;
              else { p.x += dx / dist * step; p.y += dy / dist * step; p.face = dx >= 0 ? 1 : -1; }
            }
            if (!p.path || p.wp >= p.path.length) {
              if (p.state === 'toPark') {
                p.state = 'atPark'; p.playT = 8 + Math.random() * 8;
                p.host = { x: door.x, y: door.y, parkZone: p.zone, pet: p.kind, phase: 'inDogPark',
                           dog: { x: p.x, y: p.y, tx: p.x, ty: p.y, face: 1, gait: 0, wag: 0, pause: 0.3, squat: 0, moving: false } };
                if (Math.random() < 0.8) p.host.dog.pooT = 1.2 + Math.random() * 4;   // same messes as any park pet
                pickParkDogTarget(p.host);
              } else {
                var b1 = bedTile(h, p);
                p.x = b1.x; p.y = b1.y; p.path = null; p.state = 'inBed';
              }
            }
          } else if (p.state === 'atPark') {
            updateParkDog(p.host, dt);
            var d = p.host.dog;
            p.x = d.x; p.y = d.y;
            p.playT -= dt;
            if ((p.playT <= 0 || p.stayT <= 10) && !(d.squat > 0)) {   // playtime over → trot home
              var lane2 = bedLaneTile(h, p);
              var home = examRoute(Math.round(d.x), Math.round(d.y), lane2.x, lane2.y);
              p.host = null;
              if (examRouteReached) { p.path = home; p.wp = 0; p.state = 'toHome'; }
              else { p.path = null; p.state = 'inBed'; var b2 = bedTile(h, p); p.x = b2.x; p.y = b2.y; }   // wedged → pop back to bed
            }
          }
          // 'out' (walking to the pickup owner) is advanced by the owner's phase handler
        }
      }
    }

    // ---- Cleaners --------------------------------------------------------
    function canPlaceCleaner(gx, gy) { return isRoomFloor(gx, gy) && !occupied[gx + ',' + gy]; }
    // Clean-up time for a mess: litter wipes in 2s, an accident takes 5s.
    function messGoal(p) { return p.kind === 'litter' ? 2 : p.kind === 'litterbox' ? 8 : p.kind === 'poo' ? 10 : 5; }
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
    // Every dirty room, paired with a walkable tile you scrub it from and the
    // seconds it takes to scrub (`goal`). Operating rooms (exam/X-ray) scrub from
    // their circle; non-operating rooms (pharmacy/shop) from an open interior lane;
    // restrooms from the user's stand tile and take twice as long. Used by both the
    // scrub loop and the cleaner's job-finder.
    function dirtyRooms() {
      var out = [];
      ['exam', 'xray', 'surgery'].forEach(function (type) {
        ROOM_TYPES[type].list.forEach(function (rm) {
          if (rm.dirty) { var k = roomKey(type, rm); out.push({ rm: rm, x: k.circle.x, y: k.circle.y, goal: ROOM_CLEAN_TIME }); }
        });
      });
      pharmacies.forEach(function (rm) { if (rm.dirty) out.push({ rm: rm, x: rm.gx, y: rm.gy + 2, goal: ROOM_CLEAN_TIME }); });   // column-0 lane, front row
      shops.forEach(function (rm) { if (rm.dirty) out.push({ rm: rm, x: rm.gx + 2, y: rm.gy + 3, goal: ROOM_CLEAN_TIME }); });    // centre of the front aisle
      restrooms.forEach(function (rm) { if (rm.dirty) out.push({ rm: rm, x: rm.stand.x, y: rm.stand.y, goal: ROOM_CLEAN_TIME * 2 }); });
      hotels.forEach(function (h) {          // each wing is its own scrub job (they dirty independently)
        if (h.wings.dog.dirty) { var sd = hotelWingScrub(h, 'dog'); out.push({ rm: h.wings.dog, x: sd.x, y: sd.y, goal: ROOM_CLEAN_TIME }); }
        if (h.wings.cat.dirty) { var sc = hotelWingScrub(h, 'cat'); out.push({ rm: h.wings.cat, x: sc.x, y: sc.y, goal: ROOM_CLEAN_TIME }); }
      });
      return out;
    }
    // A dirty room scrubs clean while the player or a cleaner stands on its scrub
    // tile (Cleaning skill speeds it, mirroring puddles). On done: dirty clears, the
    // use-count and grime timer reset.
    function updateRoomDirt(dt) {
      var rate = skills.cleaning.val;
      dirtyRooms().forEach(function (j) {
        var rm = j.rm;
        var scrub = (Math.round(vet.x) === j.x && Math.round(vet.y) === j.y) ||
                    cleaners.some(function (c) { return Math.round(c.x) === j.x && Math.round(c.y) === j.y; });
        if (scrub) {
          rm.cleanProg = (rm.cleanProg || 0) + dt * rate;
          if (rm.cleanProg >= j.goal) { rm.dirty = false; rm.uses = 0; rm.cleanProg = 0; rm.grimeT = null; }
        } else if (rm.cleanProg > 0) {
          rm.cleanProg = Math.max(0, rm.cleanProg - dt * 0.5);   // un-scrubs if the cleaner wanders off, like a puddle
        }
      });
    }
    // Non-operating rooms (pharmacy/shop) accumulate grime over time and turn dirty
    // once their grime timer runs out — regardless of how much they're used.
    function updateRoomGrime(dt) {
      pharmacies.concat(shops).forEach(function (rm) {
        if (rm.dirty) return;
        if (rm.grimeT == null) rm.grimeT = ROOM_GRIME_TIME * (0.7 + Math.random() * 0.6);
        rm.grimeT -= dt;
        if (rm.grimeT <= 0) rm.dirty = true;
      });
      // Hotel wings grime up only while they have guests (an empty wing stays
      // clean); a dirty wing stops taking that species until a cleaner scrubs it.
      hotels.forEach(function (h) {
        ['dog', 'cat'].forEach(function (sp) {
          var wing = h.wings[sp];
          if (wing.dirty) return;
          var occupied2 = h.pets.some(function (p) { return p.species === sp; });
          if (!occupied2) return;                      // timer pauses while the wing is empty
          if (wing.grimeT == null) wing.grimeT = ROOM_GRIME_TIME * (0.5 + Math.random() * 0.4);
          wing.grimeT -= dt;
          if (wing.grimeT <= 0) wing.dirty = true;
        });
      });
    }
    // The clean jobs a cleaner can take: every puddle plus every dirty room's
    // circle. Each carries a back-ref so the cleaner knows when its job is done.
    function cleanTargets() {
      var jobs = [];
      puddles.forEach(function (pd) { jobs.push({ x: pd.x, y: pd.y, pd: pd }); });
      dirtyRooms().forEach(function (j) { jobs.push({ x: j.x, y: j.y, room: j.rm }); });
      return jobs;
    }
    function targetGone(t) {
      if (!t) return true;
      if (t.pd) return puddles.indexOf(t.pd) < 0;     // puddle mopped away
      if (t.room) return !t.room.dirty;               // room scrubbed clean
      return true;
    }
    // A hired cleaner walks to the nearest REACHABLE mess — puddle or dirty room —
    // and scrubs it (the scrubbing itself is handled by updatePuddles/updateRoomDirt
    // once they're standing on the spot). An unreachable job is skipped WITHOUT
    // claiming it, so one blocked mess can never freeze the whole cleaning staff.
    function updateCleaner(c, dt) {
      if (targetGone(c.target)) { c.target = null; c.path = null; }
      if (!c.target) {
        c.retryT = (c.retryT || 0) - dt;
        if (c.retryT > 0) { c.moving = false; return; }
        // Skip any mess/room another cleaner has already claimed, so only ONE
        // cleaner ever heads to a given job (extra cleaners idle or pick elsewhere).
        var claimed = [];
        cleaners.forEach(function (o) { if (o !== c && o.target) claimed.push(o.target.pd || o.target.room); });
        var jobs = cleanTargets().filter(function (j) { return claimed.indexOf(j.pd || j.room) < 0; })
          .sort(function (a, b) {
            return (Math.abs(c.x - a.x) + Math.abs(c.y - a.y)) - (Math.abs(c.x - b.x) + Math.abs(c.y - b.y));
          });
        for (var i = 0; i < jobs.length; i++) {   // nearest job the cleaner can actually walk to
          var path = examRoute(c.x, c.y, jobs[i].x, jobs[i].y);
          if (examRouteReached) { c.target = jobs[i]; c.path = path; c.wp = 0; break; }
        }
        if (!c.target) c.retryT = 1;              // nothing reachable → rescan in 1s, hold no claim
      }
      if (c.target && c.path && c.wp < c.path.length) {
        var t = c.path[c.wp], cpx = c.x, cpy = c.y;
        if (stepToward(c, t.x, t.y, dt, 0.06,
            function (x, y) { return vetBlocked(x, y) || visitorOn(c, x, y); })) c.wp++;
        // Wedged en route (crowd/wall) for ~2.5s → drop the claim so another job
        // (or another cleaner) can proceed; rescan shortly.
        if (Math.hypot(c.x - cpx, c.y - cpy) < c.speed * dt * 0.15) {
          c.stuckT = (c.stuckT || 0) + dt;
          if (c.stuckT > 2.5) { c.stuckT = 0; c.target = null; c.path = null; c.retryT = 0.5; }
        } else c.stuckT = 0;
      } else { c.moving = false; }
    }
    // The desk station nearest the cursor (over EVERY desk, for placing a
    // receptionist), with validity.
    function nearestStation() {
      if (!hasDesk()) return null;
      var best = null, bd = 1e9;
      for (var L = 0; L < numLines(); L++) {
        var s = stationTile(L), d = Math.abs(pointer.gx - s.x) + Math.abs(pointer.gy - s.y);
        if (d < bd) { bd = d; best = { line: L, x: s.x, y: s.y }; }
      }
      best.ok = best.x >= 0 && best.y >= 0 && best.x < ROOM && best.y < ROOM && !staffAtStation(best.line);
      return best;
    }

    // A receptionist figure (headset + name badge) standing at a desk station.
    // `rot` is the desk's rotation (which way to face); defaults to the first desk.
    function drawReceptionist(c, gx, gy, gender, rot) {
      var s = iso(gx, gy);
      var f = FRONT[(rot != null ? rot : deskAnchor().rot) || 0];
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
      if (gender === 'female') drawLongHair(c, hy, '#3a2c22');
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

    // A hired Pharmacist: white lab coat over a green shirt, square glasses and a
    // green medical-cross badge — deliberately distinct from the headset-wearing
    // receptionist (same desk pose, so they read as a different role at a glance).
    function drawPharmacist(c, gx, gy, gender) {
      var s = iso(gx, gy);
      var f = FRONT[deskAnchor().rot || 0];
      var dir = chooseDir(f.x, f.y);              // face the customers
      var front = (dir === 'SE' || dir === 'SW');
      var mirror = (dir === 'SW' || dir === 'NW') ? -1 : 1;
      c.fillStyle = 'rgba(20,40,30,0.26)';
      c.beginPath(); c.ellipse(s.x, s.y, 13, 6, 0, 0, Math.PI * 2); c.fill();
      c.save(); c.translate(s.x, s.y);
      c.fillStyle = '#3a4250'; c.fillRect(-6, -14, 5, 14); c.fillRect(1, -14, 5, 14); // legs (grey slacks)
      c.fillStyle = '#23262d'; c.fillRect(-7, -2, 6, 3); c.fillRect(1, -2, 6, 3);      // shoes
      var bt = -40;                                                                    // torso (white lab coat)
      c.fillStyle = gradL(c, 0, bt, 0, -12, [[0, '#ffffff'], [1, '#dfe6ec']]); roundRect(c, -11, bt, 22, 28, 7); c.fill();
      c.fillStyle = '#eef2f6'; roundRect(c, -14, bt + 2, 5, 13, 2.5); c.fill(); roundRect(c, 9, bt + 2, 5, 13, 2.5); c.fill(); // sleeves
      c.fillStyle = '#f0c8a4'; c.fillRect(-14, bt + 14, 5, 4); c.fillRect(9, bt + 14, 5, 4); // hands
      if (front) {
        c.fillStyle = '#2f9e90';                                                       // green shirt down the coat opening
        c.beginPath(); c.moveTo(-4, bt); c.lineTo(0, bt + 22); c.lineTo(4, bt); c.closePath(); c.fill();
        c.strokeStyle = '#cdd6de'; c.lineWidth = 1;                                     // lab-coat lapels framing the shirt
        c.beginPath(); c.moveTo(-4, bt - 1); c.lineTo(-1.5, bt + 12); c.moveTo(4, bt - 1); c.lineTo(1.5, bt + 12); c.stroke();
        c.fillStyle = '#3cba54'; c.fillRect(-9, bt + 5, 5, 5);                          // green cross badge
        c.fillStyle = '#fff'; c.fillRect(-7.4, bt + 5.8, 1.8, 3.4); c.fillRect(-8.6, bt + 7, 4.2, 1.4);
      }
      c.fillStyle = '#e7bd98'; c.fillRect(-3, bt - 4, 6, 5);                            // neck
      var hy = bt - 13;
      c.fillStyle = '#f0c8a4'; c.beginPath(); c.arc(0, hy, 8.5, 0, Math.PI * 2); c.fill();
      if (gender === 'female') drawLongHair(c, hy, '#4a3a2a');
      c.fillStyle = '#4a3a2a'; c.beginPath(); c.arc(0, hy - 1, 8.5, Math.PI * (front ? 1.02 : 0.05), Math.PI * (front ? 1.98 : 0.95), false); c.fill();
      if (front) {
        c.fillStyle = '#2b2b33';                                                        // eyes
        c.beginPath(); c.arc(-3 * mirror, hy, 1.3, 0, Math.PI * 2); c.arc(3 * mirror, hy, 1.3, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#3b4654'; c.lineWidth = 1.1;                                    // square glasses
        roundRect(c, -5.4 * mirror, hy - 2.2, 4.4, 4.4, 1); c.stroke();
        roundRect(c, 1 * mirror, hy - 2.2, 4.4, 4.4, 1); c.stroke();
        c.beginPath(); c.moveTo(-1 * mirror, hy); c.lineTo(1 * mirror, hy); c.stroke();
        c.strokeStyle = '#9a5f44'; c.lineWidth = 1.2;                                    // smile
        c.beginPath(); c.arc(0, hy + 4, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
      }
      c.restore();
    }

    // The shop cashier: a retail clerk in a warm apron and a flat cap, standing behind
    // the checkout counter facing the customers. Always front-on (no lab coat/glasses,
    // so it reads as a shopkeeper, not a pharmacist).
    function drawCashier(c, gx, gy, gender) {
      var s = iso(gx, gy);
      c.fillStyle = 'rgba(20,40,30,0.26)';
      c.beginPath(); c.ellipse(s.x, s.y, 13, 6, 0, 0, Math.PI * 2); c.fill();
      c.save(); c.translate(s.x, s.y);
      c.fillStyle = '#33506b'; c.fillRect(-6, -14, 5, 14); c.fillRect(1, -14, 5, 14);     // legs (denim)
      c.fillStyle = '#23262d'; c.fillRect(-7, -2, 6, 3); c.fillRect(1, -2, 6, 3);          // shoes
      var bt = -40;
      c.fillStyle = gradL(c, 0, bt, 0, -12, [[0, '#f3f6f8'], [1, '#dbe2e8']]); roundRect(c, -11, bt, 22, 28, 7); c.fill(); // light shirt
      c.fillStyle = '#eef2f6'; roundRect(c, -14, bt + 2, 5, 13, 2.5); c.fill(); roundRect(c, 9, bt + 2, 5, 13, 2.5); c.fill(); // sleeves
      c.fillStyle = '#f0c8a4'; c.fillRect(-14, bt + 14, 5, 4); c.fillRect(9, bt + 14, 5, 4);   // hands
      c.fillStyle = '#e07b39'; c.beginPath();                                              // warm retail apron
      c.moveTo(-8, bt + 6); c.lineTo(8, bt + 6); c.lineTo(9, bt + 26); c.lineTo(-9, bt + 26); c.closePath(); c.fill();
      c.fillStyle = '#c5662b'; c.fillRect(-7, bt + 16, 14, 6);                             // apron pocket
      c.strokeStyle = '#c5662b'; c.lineWidth = 1.4;                                        // neck strap
      c.beginPath(); c.moveTo(-5, bt + 6); c.lineTo(-2, bt - 2); c.moveTo(5, bt + 6); c.lineTo(2, bt - 2); c.stroke();
      c.fillStyle = '#e7bd98'; c.fillRect(-3, bt - 4, 6, 5);                               // neck
      var hy = bt - 13;
      c.fillStyle = '#f0c8a4'; c.beginPath(); c.arc(0, hy, 8.5, 0, Math.PI * 2); c.fill(); // head
      if (gender === 'female') drawLongHair(c, hy, '#3a2c22');
      c.fillStyle = '#3a2c22'; c.beginPath(); c.arc(0, hy - 1, 8.5, Math.PI * 1.02, Math.PI * 1.98, false); c.fill(); // hair
      c.fillStyle = '#2f9e90'; c.beginPath(); c.arc(0, hy - 2, 9, Math.PI, 0, false); c.fill(); // flat cap crown
      c.fillRect(-9, hy - 2, 18, 2);
      c.fillStyle = '#27867a'; c.fillRect(-11, hy - 1, 7, 2.4);                            // cap brim
      c.fillStyle = '#2b2b33';                                                             // eyes
      c.beginPath(); c.arc(-3, hy, 1.3, 0, Math.PI * 2); c.arc(3, hy, 1.3, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#9a5f44'; c.lineWidth = 1.2;                                        // smile
      c.beginPath(); c.arc(0, hy + 4, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
      c.restore();
    }

    // A hired Vet figure (teal scrubs, blue surgical cap, stethoscope) standing on
    // an exam room circle, facing the table. `rot` is the room's rotation.
    function drawVetStaff(c, gx, gy, rot, dirOverride, gender) {
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
      if (gender === 'female') drawLongHair(c, hy, '#6b4a32');
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
      drawPharmacist(ghostCtx, pc.x, pc.y);
      if (!pc.ok) { ghostCtx.save(); ghostCtx.globalCompositeOperation = 'source-atop'; ghostCtx.fillStyle = 'rgba(222,58,44,0.62)'; ghostCtx.fillRect(0, 0, view.w, view.h); ghostCtx.restore(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.72; ctx.drawImage(ghostC, 0, 0);
      ctx.globalAlpha = 1; ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    // ---- Unified staff handle ---------------------------------------------
    // The four staff kinds are stored four different ways (staff[]/vets[]/cleaners[]
    // arrays + a `pharm` object on a pharmacy station). eachStaffHandle() is the ONE
    // place that knows those shapes: it yields a uniform handle per staffer so the
    // hit-test, name label, overlay, drag/relocate and test API never branch 4 ways.
    function staffRefundCost(kind) { var d = FURN_BY_ID[kind]; return d ? d.cost : 0; }   // kind === FURN id
    // canDropFn (non-mutating: is the current pointer a valid drop target?) is split from
    // applyFn so the carry preview can tint the tile green/red without moving anyone.
    function makeStaffHandle(kind, data, tileFn, canDropFn, applyFn, removeFn) {
      var cost = staffRefundCost(kind);
      return {
        kind: kind, cost: cost, data: data,
        getName: function () { return data.name || ''; },
        setName: function (n) { data.name = n || ''; },
        getGender: function () { return data.gender || 'male'; },
        setGender: function (g) { data.gender = (g === 'female') ? 'female' : 'male'; },
        tile: tileFn,                       // -> {x,y} grid tile where the figure is drawn
        is: function (ref) { return data === ref; },
        canDrop: canDropFn,                 // -> bool: pointer is a valid relocation target
        relocate: function () { if (!canDropFn()) return false; applyFn(); return true; },
        fire: function () { removeFn(); return Math.floor(cost * 0.5); }
      };
    }
    function eachStaffHandle(cb) {
      // receptionists (only when a desk exists — matches draw())
      if (hasDesk()) staff.forEach(function (st) {
        cb(makeStaffHandle('receptionist', st,
          function () { return stationTile(staffLine(st)); },
          function () { var s = nearestStation(); return !!(s && s.ok); },
          function () { var s = nearestStation(); if (s && s.ok) { st.line = s.line; st.curLine = s.line; } },
          function () { var i = staff.indexOf(st); if (i >= 0) staff.splice(i, 1); }));
      });
      // roaming vets — drop on any clear floor tile
      vets.forEach(function (vt) {
        cb(makeStaffHandle('vet', vt,
          function () { return { x: Math.round(vt.x), y: Math.round(vt.y) }; },
          function () { return canPlaceCleaner(pointer.gx, pointer.gy); },
          function () { vt.x = pointer.gx; vt.y = pointer.gy; vt.room = null; vt.path = null; vt.wp = 0; vt.working = false; vt.moving = false; },
          function () { var i = vets.indexOf(vt); if (i >= 0) vets.splice(i, 1); }));
      });
      // roaming cleaners — drop on any clear floor tile
      cleaners.forEach(function (cl) {
        cb(makeStaffHandle('cleaner', cl,
          function () { return { x: Math.round(cl.x), y: Math.round(cl.y) }; },
          function () { return canPlaceCleaner(pointer.gx, pointer.gy); },
          function () { cl.x = pointer.gx; cl.y = pointer.gy; cl.target = null; cl.path = null; cl.wp = 0; cl.moving = false; },
          function () { var i = cleaners.indexOf(cl); if (i >= 0) cleaners.splice(i, 1); }));
      });
      // roaming workers — drop on any clear floor tile
      workers.forEach(function (wk) {
        cb(makeStaffHandle('worker', wk,
          function () { return { x: Math.round(wk.x), y: Math.round(wk.y) }; },
          function () { return canPlaceCleaner(pointer.gx, pointer.gy); },
          function () { wk.x = pointer.gx; wk.y = pointer.gy; wk.room = null; wk.path = null; wk.wp = 0; wk.working = false; wk.moving = false; wk.shopTarget = null; wk.post = null; },
          function () { var i = workers.indexOf(wk); if (i >= 0) workers.splice(i, 1); }));
      });
      // pharmacists — the `pharm` object on a manned counter station
      pharmacies.forEach(function (ph) {
        pharmStations(ph.gx, ph.gy).forEach(function (sec, idx) {
          var station = ph.stations[idx];
          if (!station.pharm) return;
          var pharmObj = station.pharm;
          cb(makeStaffHandle('pharmacist', pharmObj,
            function () { return { x: sec.circle.x, y: sec.circle.y }; },
            function () { var pc = nearestPharmCircle(); return !!(pc && pc.ok); },
            function () { var pc = nearestPharmCircle(); if (pc && pc.ok) { pc.station.pharm = pharmObj; station.pharm = false; } },
            function () { station.pharm = false; }));
        });
      });
    }
    // The staffer whose drawn tile sits under (gx,gy), if any (topmost-ish by kind order).
    function staffAt(gx, gy) {
      var found = null;
      eachStaffHandle(function (h) {
        if (found) return;
        var t = h.tile();
        if (Math.round(t.x) === gx && Math.round(t.y) === gy) found = h;
      });
      return found;
    }
    // The grid spot a staffer is actually DRAWN at: roaming vets/cleaners carry live
    // float coords, desk/pharmacy staff stand on their station tile.
    function staffGridPos(h) {
      var d = h.data;
      if (typeof d.x === 'number' && typeof d.y === 'number') return { x: d.x, y: d.y };
      return h.tile();
    }
    // Pixel hit-test over a staffer's FULL drawn body (+ a little slop), in canvas
    // pixels. Used in dragStart layered ABOVE the drag-to-pan handler, so a click
    // anywhere on the figure grabs them instead of starting a pan — the tile-only
    // test missed the body, which floats well above its foot tile in iso. The body
    // spans roughly x∈[-15,15], y∈[-62,+6] around the foot anchor; pad generously.
    function staffAtPixel(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      var cx = clientX - rect.left, cy = clientY - rect.top;
      var best = null, bestDepth = -1e9;
      eachStaffHandle(function (h) {
        var gp = staffGridPos(h), s = iso(gp.x, gp.y);
        if (cx >= s.x - 18 && cx <= s.x + 18 && cy >= s.y - 66 && cy <= s.y + 10) {
          var depth = gp.x + gp.y;            // frontmost (drawn last/on top) wins overlaps
          if (depth > bestDepth) { bestDepth = depth; best = h; }
        }
      });
      return best;
    }
    // A teal selection ring under a staffer that's hovered or being grabbed, so it
    // reads as draggable / double-clickable before you commit to the gesture.
    function drawStaffHighlight(gx, gy) {
      var s = iso(gx, gy);
      ctx.save();
      ctx.fillStyle = 'rgba(55,179,163,0.20)';
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 17, 8.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(55,179,163,0.95)'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 17, 8.5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
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
      else if (v.needsSurgery && !v.operated) surgeries.forEach(function (rm) { rooms.push({ x: rm.gx + 1.5, y: rm.gy + 2 }); });
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
    // A patient assigned to (walking into or sitting in) a dirty operating room
    // loses patience twice as fast — the grime doubles their wait frustration.
    function inDirtyRoom(v) { var rm = v.examRoom || v.xrayRoom || v.surgeryRoom; return !!(rm && rm.dirty); }
    function drainMult(v) { return (nearTV(v) ? 0.5 : 1) * (nearPee(v) ? 2 : 1) * (inDirtyRoom(v) ? 2 : 1); }

    // A reception client is served: pay out, pop a +10, give a fresh wait bar so
    // the queue advances. If a chair is free they head over to sit; otherwise
    // they step aside to a side spot as before.
    function serveVisitor(v) {
      money += 10; renderMoney();
      floaters.push({ v: v, t: 0 });
      var qi = queue[v.line] ? queue[v.line].indexOf(v) : -1; if (qi >= 0) queue[v.line].splice(qi, 1);
      // a desk's lone receptionist hands the next turn to its other queue (alternation)
      var di = (v.line || 0) >> 1, ds = deskStaff(di), otherL = di * 2 + (1 - (v.line & 1));
      if (ds.length === 1 && !vetAtStation(v.line) && staffLine(ds[0]) === v.line && (queue[otherL] || []).length > 0) {
        ds[0].curLine = otherL;
      }
      v.served = true;                       // checked in (rating needs v.happy too — set only when the whole journey completes)
      v.ticket = examTicketSeq++;            // check-in order → examined first-come-first-served
      v.procT = 0; v.patience = baseWait();
      // ~55% of clients will need the loo, 20–50s into their wait. Unlike patience
      // (which refills each phase), this need is a single persistent countdown — so
      // it actually fires before a comfortable (seated/TV) client is examined.
      v.bladder = Math.random() < 0.55 ? 20 + Math.random() * 30 : null;
      // Roll the client's PRIMARY intent — one unconditional draw (facility-
      // independent RNG count), fixed weights from INTENT_WEIGHTS. pharm/groom
      // just set the existing flags; the central assigners take it from there.
      // park/shop get their own assigners (assignParks/assignShops).
      v.intent = rollIntent();
      if (v.intent === 'pharm') v.needsMeds = true;
      if (v.intent === 'groom') v.wantsGroom = true;
      // 15% of exam-goers board their pet at the hotel instead (needs 3 workers
      // on post, a clean wing + free bed). Guards sit BEFORE the draw so
      // hotel-less games keep an identical RNG stream.
      if (v.intent === 'exam' && hotels.length && hotelAccepts(v.pet) && Math.random() < 0.15) v.wantsHotel = true;
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
      if (v.litterT == null) v.litterT = 4 + Math.random() * 10;
      if (v.phase !== 'queuing' && v.phase !== 'idle' && v.phase !== 'seated' && v.phase !== 'served' && v.phase !== 'waitXray') return;
      v.litterT -= dt;
      if (v.litterT > 0) return;
      v.litterT = 6 + Math.random() * 12;
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
          var rm = v[d.vRoom], k = roomKey(type, rm);
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
          rm.uses = (rm.uses || 0) + 1;                          // count this procedure; grime builds up
          if (rm.uses >= ROOM_DIRTY_USES) rm.dirty = true;       // 3 uses → dirty until scrubbed
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
      else {
        v.moving = false;
        // Done drifting: take a free seat instead of standing around. The wait is
        // carried by the needs flags (needsXray/needsMeds/…), not the phase, and
        // every assigner's waiting() accepts seated/toChair clients — so they're
        // still pulled in the moment their room frees up, just comfier meanwhile.
        if (v.noSeatT > 0) v.noSeatT -= dt;   // cooling off after an unreachable seat
        var os = v.noSeatT > 0 ? null : freeSeat(v);
        if (os) {
          v.chair = { gx: os.gx, gy: os.gy, fx: os.fx, fy: os.fy, mult: os.mult };
          headToSeat(v);
          return;
        }
      }
      v.patience -= dt * drainMult(v);
      if (v.patience <= 0) { v.patience = 0; leaveOutbound(v); }
    }
    // After an exam the pet may need follow-up care, rolled regardless of whether
    // that room exists yet — if none is free, the client waits and eventually
    // leaves unhappy, pressuring you to build it. (Roll order is load-bearing for
    // determinism — keep the 0.2 then 0.4 sequence.)
    // Step aside to a free spot and loiter in `phase` until the wanted service
    // frees up (the central assigners re-grab from the wait phases) or patience
    // runs out (→ unhappy departure). Shared by every follow-up chain.
    function waitAside(v, phase) {
      v.phase = phase; v.patience = baseWait();
      var seat = v.noSeatT > 0 ? null : freeSeat(v);
      if (seat) {                            // sit while waiting rather than stand aside
        v.chair = { gx: seat.gx, gy: seat.gy, fx: seat.fx, fy: seat.fy, mult: seat.mult };
        v.path = null; v.wp = 0;
        headToSeat(v);
        return;
      }
      var s = sideSpot();
      v.path = examRoute(v.x, v.y, s.x, s.y);
      v.wp = 0;
    }
    function medsOrWait(v)  { v.needsMeds = true; if (!claimPharmacy(v)) waitAside(v, 'waitMeds'); }
    function groomOrWait(v) { if (!claimGrooming(v)) { v.wantsGroom = true; waitAside(v, 'waitGroom'); } }
    // After an exam the pet may need follow-up care, rolled regardless of whether
    // that facility exists yet — if none is free, the client waits and eventually
    // leaves unhappy, pressuring you to build it. ONE cumulative draw over the
    // FOLLOWUP thresholds keeps the RNG draw count constant (determinism-friendly).
    function examFollowUp(v) {
      var r = Math.random();
      if (r < FOLLOWUP.examXray) {
        v.needsXray = true;
        if (!claimXray(v)) waitAside(v, 'waitXray');
      } else if (r < FOLLOWUP.examXray + FOLLOWUP.examMeds) {
        medsOrWait(v);
      } else if (r < FOLLOWUP.examXray + FOLLOWUP.examMeds + FOLLOWUP.examGroom) {
        groomOrWait(v);
      } else {
        v.happy = true; leaveOutbound(v);    // journey complete → leaves happy
      }
    }

    // ---- Grooming care (shower → blow-dry) -------------------------------
    // Walk to the current station's dog spot; on arrival, stand and face the
    // fixture, and start the "waiting to be worked" timer. Drain patience en
    // route; give up (releasing the room) if it runs out.
    function groomWalk(v, dt) {
      var rm = v.groomRoom;
      if (!rm) { leaveOutbound(v); return; }
      var idx = v.phase === 'toGroomShower' ? 0 : 1;
      var st = groomStations(rm.gx, rm.gy)[idx], t = v.path[v.wp];
      if (stepToward(v, t.x, t.y, dt, 0.06)) {
        v.wp++;
        if (v.wp >= v.path.length) {
          v.x = st.dogSpot.x; v.y = st.dogSpot.y; v.moving = false;
          v.phase = idx === 0 ? 'inGroomShower' : 'inGroomDry';
          v.patience = baseWait(); v.groomWait = baseWait();
          v.dir = chooseDir(st.fixture.x - v.x, st.fixture.y - v.y);   // face the shower/dryer
        }
      }
      v.patience -= dt * drainMult(v);
      if (v.patience <= 0) { releaseGroom(v); leaveOutbound(v); }
    }
    // At a station: an operator (player on the circle at full rate, or a Worker at
    // half) fills the station timer. Shower done → walk to the dryer; dry done →
    // pay $80 and leave happy. No operator → the wait timer drains and they leave.
    function groomServe(v, dt, idx) {
      v.moving = false;
      var rm = v.groomRoom;
      if (!rm) { leaveOutbound(v); return; }
      var st = groomStations(rm.gx, rm.gy)[idx];
      var full = playerAtTile(st.circle);
      v.processing = full || workerAtTile(st.circle);
      if (v.processing) {
        var tf = idx === 0 ? 'showerT' : 'dryT';
        rm[tf] = (rm[tf] || 0) + dt * (full ? 1 : 0.5);
        if (rm[tf] >= GROOM_DURATION * procTime()) {
          if (idx === 0) {                    // showered → head to the blow-dry station
            var d1 = groomStations(rm.gx, rm.gy)[1];
            v.path = examRoute(v.x, v.y, d1.dogSpot.x, d1.dogSpot.y);
            v.wp = 0; v.phase = 'toGroomDry'; v.patience = baseWait();
          } else {                            // fully groomed → pay out and leave happy
            money += 80; renderMoney();
            floaters.push({ v: v, t: 0, amt: 80 });
            v.groomed = true; v.happy = true; v.served = true;
            releaseGroom(v); leaveOutbound(v);
          }
        }
      } else {
        if (v.groomWait == null) v.groomWait = baseWait();
        v.groomWait -= dt * drainMult(v);
        if (v.groomWait <= 0) { releaseGroom(v); leaveOutbound(v); return; }
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
        if (!v.rm) {                       // claim a free, clean, REACHABLE restroom and route into it
          v.moving = false;                // squirm in place until one is claimed
          v.rmRetryT = (v.rmRetryT || 0) - dt;
          if (v.rmRetryT > 0) { if (v.relief <= 0) peeAndLeave(v); return; }
          v.rmRetryT = 0.5;                // rescan at most twice a second (each scan BFSes per restroom)
          for (var ri = 0; ri < restrooms.length; ri++) {
            var rm = restrooms[ri];
            if (rm.occupant || rm.dirty) continue;
            // route internally over connected floor (clinic → corridor → restroom),
            // around furniture — same as exam rooms, not out the front doors
            var rp = examRoute(v.x, v.y, rm.stand.x, rm.stand.y);
            if (!examRouteReached) continue;   // unreachable → try the next restroom
            rm.occupant = v; v.rm = rm; v.path = rp; v.wp = 0;
            break;
          }                                // none claimable → relief keeps draining → peeAndLeave
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
          if (v.rm) { v.rm.dirty = true; v.rm.occupant = null; v.rm = null; }   // one use → dirty; unusable until a cleaner scrubs it
          v.relief = null; v.bladder = null;     // relieved for the rest of this visit
          var s = sideSpot();
          v.phase = 'served'; v.sideIdx = s.idx; v.sideX = s.x; v.sideY = s.y; v.patience = baseWait();
          // Route back out through the restroom DOOR (walls are solid) — the
          // 'served' handler walks this path first, then beelines to the spot.
          v.path = examRoute(v.x, v.y, s.x, s.y); v.wp = 0;
        }
        return;
      }
      if (v.phase === 'toHotel') {         // walking to the hotel desk to drop the pet off
        var hst = v.path[v.wp];
        if (stepToward(v, hst.x, hst.y, dt, 0.08)) {
          v.wp++;
          if (v.wp >= v.path.length) {
            var hh = v.hotelRoom, hsp = petSpecies(v.pet);
            var bed = v.hotelBed;
            var bedTaken = hh.pets.some(function (q) { return q.species === hsp && q.bed === bed; });
            v.hotelRoom = null; v.wantsHotel = false;
            if (bedTaken || hh.wings[hsp].dirty || hotelWorkersAssigned(hh) < HOTEL_WORKERS_NEEDED) { v.phase = 'idle'; return; }   // lost the bed → back to the floor
            var stay = HOTEL_STAY_MIN + Math.random() * HOTEL_STAY_SPAN;
            var bt = hotelBeds(hh, hsp)[bed];
            hh.pets.push({ kind: v.pet, species: hsp, bed: bed,
                           stayT: stay, fee: 60 + Math.round(stay / 5) * 5,
                           state: 'inBed', x: bt.x, y: bt.y, path: null, wp: 0, tripT: 6, playT: 0, host: null });
            v.petBoarded = true; v.parkDone = true;   // their pet is boarded — no odd petless park detour
            v.happy = true;
            leaveOutbound(v);
          }
        }
        v.patience -= dt * drainMult(v);    // safety net: blocked walk → give up rather than freeze
        if (v.patience <= 0) { v.hotelRoom = null; v.wantsHotel = false; leaveOutbound(v); }   // failed journey → rated unhappy
        return;
      }
      if (v.phase === 'toHotelPickup') {   // returning owner: collect the pet, pay the stay
        var pkt = v.path[v.wp];
        if (v.wp < v.path.length && stepToward(v, pkt.x, pkt.y, dt, 0.08)) v.wp++;
        if (v.wp >= v.path.length) {
          v.moving = false; v.dir = 'NE';
          var pet = v.hotelPet, hr = v.hotelRoom;
          if (!pet || hr.pets.indexOf(pet) < 0) { headForExit(v); return; }   // pet gone (edge) → just leave
          if (pet.state === 'inBed') {                 // call the pet over
            pet.state = 'out';
            var b = bedTile(hr, pet); pet.x = b.x; pet.y = b.y; pet.path = null;
          }
          if (pet.state === 'out') {                   // pet trots to its owner
            var pdx = v.x - pet.x, pdy = v.y - pet.y, pdist = Math.hypot(pdx, pdy);
            if (pdist > 0.6) {
              var pstep = Math.min(PARK_DOG_SPEED * dt, pdist);
              pet.x += pdx / pdist * pstep; pet.y += pdy / pdist * pstep; pet.face = pdx >= 0 ? 1 : -1;
            } else {                                   // reunited → pay and go
              money += pet.fee; renderMoney();
              floaters.push({ v: v, t: 0, amt: pet.fee });
              hr.pets.splice(hr.pets.indexOf(pet), 1);
              v.petBoarded = false; v.hotelPet = null; v.hotelRoom = null;   // pet back on the leash / in the carrier
              v.served = true; v.happy = true;   // pickup completed → a happy departure
              leaveOutbound(v);
            }
          }
          // pets still at the park walk themselves home first (updateHotels recalls
          // them once stayT runs low); the owner just waits at the desk meanwhile
        }
        return;                             // no patience drain: the pet may still be trotting back
      }
      if (v.phase === 'toShop') {          // detouring into the shop on the way out
        var sst = v.path[v.wp];
        if (stepToward(v, sst.x, sst.y, dt, 0.08)) {
          v.wp++;
          if (v.wp >= v.path.length) {
            v.x = v.shopTile.x; v.y = v.shopTile.y; v.moving = false; v.dir = 'SE';
            v.phase = 'inShop';
          }
        }
        return;
      }
      if (v.phase === 'inShop') {          // browsing: dwell, spend, then continue out
        v.moving = false;
        v.shopBrowseT -= dt;
        if (v.shopBrowseT <= 0) {
          // shopSpend() is ALWAYS drawn (RNG parity); an unmanned shop just voids the sale
          var spend = Math.round(shopSpend() * shopSpendMult(shopWorkersPresent(v.shopRoom)) / 5) * 5;
          if (spend > 0) {
            money += spend; renderMoney();
            floaters.push({ v: v, t: 0, amt: spend });   // +$ pop over the shopper
          }
          v.shopTile = null; v.shopRoom = null;
          if (spend > 0) v.happy = true;     // a real purchase completes the journey (voided sale ≠ served)
          if (!v.left) leaveOutbound(v);     // shop-INTENT client: record the rating (+ exit garnish rolls)
          else headForExit(v);               // exit-detour browser: already rated, just leave
        }
        return;
      }
      if (v.phase === 'toDogPark') {        // walking out to their spot of grass
        var dpt = v.path[v.wp];
        if (stepToward(v, dpt.x, dpt.y, dt, 0.08)) {
          v.wp++;
          if (v.wp >= v.path.length) {
            v.x = v.parkSpot.x; v.y = v.parkSpot.y; v.moving = false; v.dir = 'SE';
            v.phase = 'inDogPark';
            startParkDog(v);                // let the dog off the leash
            return;
          }
        }
        v.patience -= dt * drainMult(v);    // safety net: if something blocks the walk, give up rather than freeze
        if (v.patience <= 0) {
          v.parkSpot = null;
          if (v.left) headForExit(v);        // exit-detour parker: already rated, just leave
          else { v.parkDone = true; leaveOutbound(v); }  // park-intent: failed journey → rated unhappy (parkDone stops a re-detour bounce)
        }
        return;
      }
      if (v.phase === 'inDogPark') {        // the dog roams off-leash; owner waits, pays $20, then leaves
        v.moving = false;
        if (v.dog) updateParkDog(v, dt);
        if (v.dogT > 0) {                   // still enjoying the park
          v.dogT -= dt;
          if (v.dogT <= 0 && v.dog) v.dog.recall = true;   // time's up → call the dog back
          return;
        }
        // time's up: wait for the dog to trot back to its owner before leaving —
        // but never forever: if the recall drags past ~6s (dog wedged on a toy,
        // squat loop, etc.) the owner just scoops the dog up and moves on.
        if (v.dog && (v.dog.squat > 0 || Math.hypot(v.dog.x - v.x, v.dog.y - v.y) > 0.6)) {
          v.recallT = (v.recallT || 0) + dt;
          if (v.recallT < 6) return;
        }
        v.recallT = 0;
        v.dog = null;
        money += 20; renderMoney();
        floaters.push({ v: v, t: 0, amt: 20 });
        v.served = true; v.parkDone = true; v.parkSpot = null;   // a paying customer
        // Post-park chain (ONE draw, cumulative FOLLOWUP thresholds; NOT gated on
        // the facility existing — a missing parlour means an unhappy wait-out):
        // some head for a groom, some pick up meds, the rest leave happy.
        var pr = Math.random();
        if (pr < FOLLOWUP.parkGroom) groomOrWait(v);
        else if (pr < FOLLOWUP.parkGroom + FOLLOWUP.parkMeds) medsOrWait(v);
        else { v.happy = true; leaveOutbound(v); }
        return;
      }
      // Occupant-room care (exam + X-ray) runs through the generic walk / serve /
      // wait handlers, parameterized by the room descriptor. The waitXray and
      // waitMeds "loiter until a room frees up" states are identical.
      if (v.phase === 'toExam') { toRoomGeneric(v, dt, 'exam'); return; }
      if (v.phase === 'inExam') { inRoomGeneric(v, dt, 'exam'); return; }
      if (v.phase === 'toXray') { toRoomGeneric(v, dt, 'xray'); return; }
      if (v.phase === 'inXray') { inRoomGeneric(v, dt, 'xray'); return; }
      if (v.phase === 'toSurgery') { toRoomGeneric(v, dt, 'surgery'); return; }
      if (v.phase === 'inSurgery') { inRoomGeneric(v, dt, 'surgery'); return; }
      if (v.phase === 'waitXray' || v.phase === 'waitMeds' || v.phase === 'waitSurgery') { waitRoomGeneric(v, dt); return; }
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
      // Grooming: loiter until a room frees, walk to the shower, wash, walk to the
      // dryer, blow-dry, then leave. Each station needs an operator (player/Worker).
      if (v.phase === 'waitGroom') { waitRoomGeneric(v, dt); return; }
      if (v.phase === 'toGroomShower' || v.phase === 'toGroomDry') { groomWalk(v, dt); return; }
      if (v.phase === 'inGroomShower') { groomServe(v, dt, 0); return; }
      if (v.phase === 'inGroomDry') { groomServe(v, dt, 1); return; }
      if (v.phase === 'queuing') {
        var t = slotPos(v);
        var reached = stepToward(v, t.x, t.y, dt);
        if (reached) {
          var f = FRONT[(deskForLine(v.line).rot || 0)];
          v.x = t.x; v.y = t.y; v.moving = false; v.dir = chooseDir(-f.x, -f.y); // face the desk
        }
        v.patience -= dt * drainMult(v);                  // tick down while in line
        if (v.patience <= 0) { v.patience = 0; leaveOutbound(v); return; }
        // the front-of-line client is processed while the vet stands on the desk's
        // action circle for that line, OR a hired receptionist mans it; bar fills.
        v.processing = (reached && (queue[v.line] || [])[0] === v && (vetAtStation(v.line) || staffAtStation(v.line)));
        if (v.processing) {
          // the player works at full speed; a hired receptionist is 50% as effective
          v.procT = (v.procT || 0) + dt * (vetAtStation(v.line) ? 1 : 0.5);
          if (v.procT >= procTime()) serveVisitor(v);
        }
        return;
      }
      if (v.phase === 'served') {          // walk aside after being served
        // If a wall-aware path is set (e.g. exiting a restroom through its door),
        // drain it first — the direct beeline below can't cross walls anymore.
        if (v.path && v.wp < v.path.length) {
          var svt = v.path[v.wp];
          if (stepToward(v, svt.x, svt.y, dt, 0.08)) v.wp++;
          return;
        }
        if (stepToward(v, v.sideX, v.sideY, dt)) {
          v.x = v.sideX; v.y = v.sideY; v.moving = false; v.dir = 'SE';
          v.phase = 'idle'; v.patience = baseWait();  // bar resets and starts again
        }
        return;
      }
      if (v.phase === 'idle') {            // standing aside, fresh wait bar
        if (v.noSeatT > 0) v.noSeatT -= dt;  // cooling off after an unreachable seat — don't re-grab it
        var openSeat = v.noSeatT > 0 ? null : freeSeat(v);
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
          if (v.phase === 'arriving') {
            v.phase = 'queuing';           // everyone checks in: queuing handler walks them to their slot
          }
          else { v.dead = true; }          // finished leaving → remove
        }
      }
    }

    // Recover a visitor the watchdog caught wedged (blocked by a wall, a crowd,
    // or a stale/fallback path). Phase-appropriate: re-route path-followers around
    // the obstruction; give beeliners a fresh routed target; despawn a leaver that
    // stays stuck (e.g. stranded outside the walls by a pre-fix save).
    function unstickVisitor(v) {
      routeAvoidFor = v;                       // route AROUND parked visitors, not just furniture
      if (v.phase === 'toChair') {             // seat unreachable → give it up, stand aside
        v.chair = null; v.seatPath = null; v.seated = false;
        v.noSeatT = 8;                         // don't re-grab a (likely still unreachable) seat at once
        var cs = sideSpot();
        v.phase = 'served'; v.sideIdx = cs.idx; v.sideX = cs.x; v.sideY = cs.y;
        v.path = examRoute(v.x, v.y, cs.x, cs.y); v.wp = 0;
      } else if (v.phase === 'served' && !(v.path && v.wp < v.path.length)) {
        var ss = sideSpot();                   // beeline blocked → routed walk to a fresh spot
        v.sideIdx = ss.idx; v.sideX = ss.x; v.sideY = ss.y;
        v.path = examRoute(v.x, v.y, ss.x, ss.y); v.wp = 0;
      } else if (v.phase === 'leaving') {      // re-route to the exit; stuck twice → despawn off-screen
        if (v.unstuckOnce) { v.dead = true; routeAvoidFor = null; return; }
        v.unstuckOnce = true;
        headForExit(v);
      } else if (v.phase === 'waitXray' || v.phase === 'waitMeds' || v.phase === 'waitGroom' || v.phase === 'waitSurgery') {
        var ws = sideSpot();                   // old drift spot occupied → loiter somewhere fresh
        v.path = examRoute(v.x, v.y, ws.x, ws.y); v.wp = 0;
      } else if (v.path && v.path.length) {    // generic: re-route to the path's own endpoint
        var end = v.path[v.path.length - 1];
        var rp = examRoute(v.x, v.y, end.x, end.y);
        if (examRouteReached) { v.path = rp; v.wp = 0; }
        // no visitor-avoiding route either → hold position; patience/relief
        // timers (every routed phase has one) bail them out if it never clears
      }
      routeAvoidFor = null;
    }

    // ---- Update -----------------------------------------------------------
    // ---- Roaming hired vets ----------------------------------------------
    // A hired Vet isn't pinned to one room: it walks to the nearest room it can
    // work (exam or X-ray) that has a patient and no other vet, works there, then
    // moves on. A room "has a vet" now means one is standing on its circle.
    var vets = [];   // [{x,y,room,working,speed,dir,walkPhase,moving,path,wp}]
    var workers = []; // [{x,y,room,working,speed,dir,walkPhase,moving,path,wp,shopTarget}] roaming groomers
    function vetRooms() { return examRooms.concat(xrayRooms, surgeries); }
    function roomNeedsVet(rm) {
      return !!rm.occupant && (rm.occupant.phase === 'inExam' || rm.occupant.phase === 'inXray' || rm.occupant.phase === 'inSurgery');
    }
    function roomVetWorking(rm) {
      for (var i = 0; i < vets.length; i++) if (vets[i].room === rm && vets[i].working) return true;
      return false;
    }
    // Surgery seats TWO vets (one per flank circle); everything else seats one.
    function isSurgeryRoom(rm) { return surgeries.indexOf(rm) >= 0; }
    function roomVetSlots(rm) { return isSurgeryRoom(rm) ? 2 : 1; }
    function roomClaimed(rm, self) {
      var n = 0;
      for (var i = 0; i < vets.length; i++) if (vets[i] !== self && vets[i].room === rm) n++;
      return n >= roomVetSlots(rm);
    }
    // Where a vet stands to work rm. For surgery each claimant takes a free flank
    // (slot 0 = vetA, 1 = vetB), remembered on the vet so both don't fight over one
    // tile; pass v=null for a neutral distance probe (uses flank A).
    function vetCircle(rm, v) {
      if (!isSurgeryRoom(rm)) return examKeyTiles(rm.gx, rm.gy, rm.rot).circle;
      var k = surgeryKeyTiles(rm.gx, rm.gy);
      if (v && v.slot == null) {
        var used = {};
        for (var i = 0; i < vets.length; i++) if (vets[i] !== v && vets[i].room === rm && vets[i].slot != null) used[vets[i].slot] = true;
        v.slot = used[0] ? 1 : 0;
      }
      return (v && v.slot === 1) ? k.vetB : k.vetA;
    }
    function updateVets(dt) {
      var rooms = vetRooms();
      for (var i = 0; i < vets.length; i++) {
        var v = vets[i];
        if (v.room && (rooms.indexOf(v.room) < 0 || !roomNeedsVet(v.room))) {
          v.room = null; v.slot = null; v.working = false; v.path = null;   // patient finished / room gone
        }
        if (!isRoomFloor(Math.round(v.x), Math.round(v.y))) { v.x = ROOM / 2 - 0.5; v.y = ROOM - 1.5; v.path = null; v.working = false; }  // stranded (room moved) -> back to clinic
        if (!v.room) {
          // Pick the nearest room that needs a vet AND is actually reachable on foot.
          // Skipping unreachable rooms means a vet never claims a room it can't walk
          // to (which would jam that room and used to send the vet beelining off the
          // map back to the clinic). Rooms are few, so routing each candidate is cheap.
          var best = null, bd = 1e9, bestPath = null;
          for (var j = 0; j < rooms.length; j++) {
            var rm = rooms[j];
            if (!roomNeedsVet(rm) || roomClaimed(rm, v)) continue;
            var c = vetCircle(rm, null), d = Math.abs(c.x - v.x) + Math.abs(c.y - v.y);
            if (d >= bd) continue;
            var p = examRoute(v.x, v.y, c.x, c.y);
            if (!examRouteReached) continue;                            // can't get there -> ignore
            bd = d; best = rm; bestPath = p;
          }
          if (!best) { v.moving = false; v.walkPhase = 0; continue; }   // nothing reachable needs a vet
          v.room = best; v.slot = null; v.working = false; v.path = bestPath; v.wp = 0;
        }
        var cc = vetCircle(v.room, v);
        if (Math.round(v.x) === cc.x && Math.round(v.y) === cc.y) {     // on the circle -> work
          v.x = cc.x; v.y = cc.y; v.moving = false; v.walkPhase = 0; v.working = true;
          if (isSurgeryRoom(v.room)) {                                  // face the operating table
            var st = surgeryKeyTiles(v.room.gx, v.room.gy).table;
            v.dir = chooseDir(st.x - v.x, st.y - v.y);
          } else {
            var f = FRONT[v.room.rot || 0]; v.dir = chooseDir(f.x, f.y);  // face the table
          }
        } else if (v.path && v.wp < v.path.length) {
          v.working = false;
          if (stepToward(v, v.path[v.wp].x, v.path[v.wp].y, dt, 0.12, vetBlocked)) v.wp++;   // stay on room floor, even in a crowd
        } else {
          v.path = examRoute(v.x, v.y, cc.x, cc.y); v.wp = 0;           // arrived-but-not-on-circle: recompute
          if (!examRouteReached) { v.room = null; v.slot = null; v.working = false; v.path = null; }   // room became unreachable -> release it
        }
      }
    }

    // ---- Roaming hired workers -------------------------------------------
    // One Worker pool staffs grooming, surgery, the hotel and the shop through
    // POSTS. Each room publishes posts with a stable key + priority: grooming
    // 'groom:i' and surgery 'surg:i' (pri 0 — medical first,
    // only while its client is in a groom/surgery phase, tile = the circle), hotel
    // 'hotel:h:s' (pri 1, reception + a minder per wing), shop 'shop:k:s' (pri 2,
    // up to 3 — sales need at least one, extras boost spend). Posts are filled
    // greedily in priority order by the nearest worker; a scarce worker is stolen
    // only from a strictly LOWER-priority post (shop before hotel), so a groom rush
    // pulls the shop clerk away and never the reverse. The fill pass runs ~3x/sec
    // for stickiness; vanished posts are dropped every frame.
    function groomWorkerCircle(rm) {
      if (!rm.occupant) return null;
      var ph = rm.occupant.phase, st = groomStations(rm.gx, rm.gy);
      if (ph === 'toGroomShower' || ph === 'inGroomShower') return st[0].circle;
      if (ph === 'toGroomDry' || ph === 'inGroomDry') return st[1].circle;
      return null;
    }
    // Surgery post: the nurse circle behind the table, live while a patient is
    // walking in or on the table (same medical tier as grooming, pri 0).
    function surgeryWorkerCircle(rm) {
      var o = rm.occupant;
      if (!o || (o.phase !== 'toSurgery' && o.phase !== 'inSurgery')) return null;
      return surgeryKeyTiles(rm.gx, rm.gy).worker;
    }
    // Shop posts: the two back aisles beside the register + the old front-aisle spot.
    function shopWorkTiles(s) {
      return [{ x: s.gx + 1, y: s.gy + 1 }, { x: s.gx + 3, y: s.gy + 1 }, { x: s.gx + 2, y: s.gy + 3 }];
    }
    function workerPosts() {
      var out = [], i, j;
      for (i = 0; i < groomings.length; i++) {
        var cc = groomWorkerCircle(groomings[i]);
        if (cc) out.push({ key: 'groom:' + i, pri: 0, tile: cc, room: groomings[i] });
      }
      for (i = 0; i < surgeries.length; i++) {
        var sc = surgeryWorkerCircle(surgeries[i]);
        if (sc) out.push({ key: 'surg:' + i, pri: 0, tile: sc, room: surgeries[i] });
      }
      for (i = 0; i < hotels.length; i++) {
        var wt = hotelWorkTiles(hotels[i]);
        for (j = 0; j < wt.length; j++) out.push({ key: 'hotel:' + i + ':' + j, pri: 1, tile: wt[j], room: hotels[i] });
      }
      for (i = 0; i < shops.length; i++) {
        var st = shopWorkTiles(shops[i]);
        for (j = 0; j < st.length; j++) out.push({ key: 'shop:' + i + ':' + j, pri: 2, tile: st[j], room: shops[i] });
      }
      return out;
    }
    function postIndex(posts) { var m = {}; for (var i = 0; i < posts.length; i++) m[posts[i].key] = posts[i]; return m; }
    var postScanT = 0;
    // Fill unheld posts, best (lowest pri) first. Candidates per post: free workers,
    // else the holder of a strictly lower-priority post (cheapest victim = highest
    // pri number). Holders are never moved within the same tier, so no oscillation.
    function assignWorkerPosts(posts, byKey) {
      posts = posts.slice().sort(function (a, b) { return a.pri - b.pri; });
      var claimed = {}, i, j;
      for (i = 0; i < workers.length; i++) if (workers[i].post) claimed[workers[i].post] = true;
      for (i = 0; i < posts.length; i++) {
        var p = posts[i];
        if (claimed[p.key]) continue;
        var best = null, bestCls = -1, bd = 1e9;
        for (j = 0; j < workers.length; j++) {
          var w = workers[j], cls;
          if (!w.post) cls = 99;                                        // free worker: always preferred
          else { var held = byKey[w.post]; if (!held || held.pri <= p.pri) continue; cls = held.pri; }
          var d = Math.abs(p.tile.x - w.x) + Math.abs(p.tile.y - w.y);
          if (cls > bestCls || (cls === bestCls && d < bd)) { best = w; bestCls = cls; bd = d; }
        }
        if (!best) continue;
        var path = examRoute(best.x, best.y, p.tile.x, p.tile.y);
        if (!examRouteReached) continue;                                // unreachable → retry next scan
        if (best.post) delete claimed[best.post];                       // vacated post refillable this pass
        best.post = p.key; best.room = p.room; best.working = false;
        best.path = path; best.wp = 0; best.shopTarget = p.tile.x + ',' + p.tile.y;
        claimed[p.key] = true;
      }
    }
    function updateWorkers(dt) {
      var posts = workerPosts(), byKey = postIndex(posts), i, w;
      for (i = 0; i < workers.length; i++) {                            // groom done / room demolished → free
        w = workers[i];
        if (w.post && !byKey[w.post]) { w.post = null; w.room = null; w.working = false; w.path = null; }
      }
      postScanT -= dt;
      if (postScanT <= 0) { postScanT = 0.35; assignWorkerPosts(posts, byKey); }
      for (i = 0; i < workers.length; i++) {
        w = workers[i];
        if (!isRoomFloor(Math.round(w.x), Math.round(w.y))) { w.x = ROOM / 2 - 0.5; w.y = ROOM - 1.5; w.path = null; w.working = false; }  // stranded → back to clinic
        if (!w.post) { w.moving = false; w.walkPhase = 0; continue; }   // no job → stand
        var p = byKey[w.post], t = p.tile, tk = t.x + ',' + t.y;
        if (Math.round(w.x) === t.x && Math.round(w.y) === t.y) {       // on post → work
          w.x = t.x; w.y = t.y; w.moving = false; w.walkPhase = 0; w.working = true;
          if (w.post.charAt(0) === 'g') { var dog = p.room.occupant; if (dog) w.dir = chooseDir(dog.x - w.x, dog.y - w.y); }  // face the dog
          else w.dir = 'SE';
          continue;
        }
        w.working = false;
        if (!w.path || w.wp >= w.path.length || w.shopTarget !== tk) {  // groom circle hops shower→dry: same key, new tile
          w.path = examRoute(w.x, w.y, t.x, t.y); w.wp = 0; w.shopTarget = tk;
          if (!examRouteReached) { w.post = null; w.room = null; w.path = null; continue; }
        }
        if (stepToward(w, w.path[w.wp].x, w.path[w.wp].y, dt, 0.12, vetBlocked)) w.wp++;
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
      ensureQueues();                        // sync the line list to the desks on the floor
      if (spawnTimer <= 0) { spawnVisitor(); spawnTimer += frq; }
      updateReceptionist();                  // each desk's lone receptionist picks which queue to man
      for (var i = visitors.length - 1; i >= 0; i--) {
        var wv = visitors[i], wpx = wv.x, wpy = wv.y;
        updateVisitor(wv, dt);
        // Anti-stuck watchdog: a visitor that WANTS to move (moving flag) but
        // barely displaces for ~2.5s is wedged (wall, crowd, stale path) — run a
        // phase-appropriate recovery instead of letting them freeze forever.
        if (wv.moving && Math.hypot(wv.x - wpx, wv.y - wpy) < wv.speed * dt * 0.15) {
          wv.stuckT = (wv.stuckT || 0) + dt;
          if (wv.stuckT > 2.5) { wv.stuckT = 0; unstickVisitor(wv); }
        } else wv.stuckT = 0;
        if (visitors[i].dead) visitors.splice(i, 1);
      }
      assignExams();                         // hand free exam rooms to the longest-waiting clients
      assignXrays();                         // hand free X-ray rooms to pets that need one
      assignSurgeries();                     // hand free operating theatres to pets that need one
      assignPharmacies();                    // hand free pharmacy counters to clients needing meds
      assignGrooming();                      // hand free grooming rooms to clients wanting a groom
      assignParks();                         // send park-intent clients to the turf / cat room
      assignShops();                         // send shop-intent clients to a free aisle spot
      assignHotels();                        // route boarding clients to a hotel desk
      updateVets(dt);                        // roaming vets move between rooms that need them
      updateWorkers(dt);                     // one worker pool staffs grooming, the hotel and the shop (posts)
      updateHotels(dt);                      // boarded pets: stays tick down, play trips, pickups
      cleaners.forEach(function (c) { c.speed = 2.3 * skills.cleaning.val; updateCleaner(c, dt); }); // cleaners head to messes (Cleaning skill speeds them)
      updatePuddles(dt);                     // scrub puddles the player/cleaners stand on
      updateRoomGrime(dt);                   // shops/pharmacies slowly grime up over time
      updateRoomDirt(dt);                    // scrub dirty rooms (player/cleaner on the scrub tile)
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

    // Processing-station rings drawn on the floor behind each desk — one per
    // line that has someone waiting, on that line's side.
    function drawDeskCircles() {
      if (!hasDesk()) return;
      for (var L = 0; L < queue.length; L++) {
        if (!queue[L].some(function (v) { return v.phase === 'queuing'; })) continue;
        var p = stationTile(L);
        var s = iso(p.x, p.y);                             // one tile behind the desk
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
        } else if (p.kind === 'litterbox') { // spilled clumps of used litter + stink lines
          ctx.fillStyle = 'rgba(20,40,30,0.18)';
          ctx.beginPath(); ctx.ellipse(s.x, s.y + 4, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#d8c89a'; ctx.beginPath(); ctx.ellipse(s.x, s.y + 2, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#c2ae7d'; ctx.beginPath(); ctx.ellipse(s.x, s.y, 4.4, 2.4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#a89465'; ctx.beginPath(); ctx.ellipse(s.x, s.y - 1.8, 2.8, 1.7, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(150,160,120,0.55)'; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(s.x - 2, s.y - 3); ctx.quadraticCurveTo(s.x - 3.5, s.y - 6, s.x - 1.5, s.y - 9);
          ctx.moveTo(s.x + 2, s.y - 3); ctx.quadraticCurveTo(s.x + 3.5, s.y - 6, s.x + 1.5, s.y - 9);
          ctx.stroke();
        } else if (p.kind === 'poo') {       // a little coiled dog mess + stink lines
          ctx.fillStyle = 'rgba(20,40,30,0.18)';
          ctx.beginPath(); ctx.ellipse(s.x, s.y + 4, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#4f3318'; ctx.beginPath(); ctx.ellipse(s.x, s.y + 2, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#6b4824'; ctx.beginPath(); ctx.ellipse(s.x, s.y, 4.4, 2.4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#7d562d'; ctx.beginPath(); ctx.ellipse(s.x, s.y - 1.8, 2.8, 1.7, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(150,160,120,0.55)'; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(s.x - 2, s.y - 3); ctx.quadraticCurveTo(s.x - 3.5, s.y - 6, s.x - 1.5, s.y - 9);
          ctx.moveTo(s.x + 2, s.y - 3); ctx.quadraticCurveTo(s.x + 3.5, s.y - 6, s.x + 1.5, s.y - 9);
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(226,206,74,0.55)';
          ctx.beginPath(); ctx.ellipse(s.x, s.y + 3, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(202,178,40,0.5)';
          ctx.beginPath(); ctx.ellipse(s.x + 3, s.y + 4, 4, 2, 0, 0, Math.PI * 2); ctx.fill();
        }
      });
    }

    // A grimy brown wash + dirt flecks over one tile of a dirty room.
    function washDirtTile(t) {
      var s = iso(t.x, t.y);
      ctx.save();
      diamondPath(ctx, s.x, s.y); ctx.clip();
      ctx.fillStyle = 'rgba(86,70,40,0.30)';                  // grimy brown wash
      ctx.fillRect(s.x - TILE_HW, s.y - TILE_HH, TILE_W, TILE_H);
      fleck(ctx, s, t.x, t.y, 6, 0.92, 2, function (h) { return h < 0.5 ? 'rgba(58,44,22,0.55)' : 'rgba(120,150,70,0.4)'; });
      ctx.restore();
    }
    // Wash every tile of every dirty room — operating rooms (grimy from use),
    // non-operating rooms (grimy over time) and restrooms (dirty after one use) —
    // so a filthy room reads as visibly filthy until scrubbed.
    function drawRoomDirt() {
      ['exam', 'xray', 'surgery'].forEach(function (type) {
        ROOM_TYPES[type].list.forEach(function (rm) {
          if (!rm.dirty) return;
          ROOM_TYPES[type].tiles(rm.gx, rm.gy, rm.rot || 0).forEach(washDirtTile);
        });
      });
      pharmacies.forEach(function (rm) { if (rm.dirty) pharmTiles(rm.gx, rm.gy).forEach(washDirtTile); });
      shops.forEach(function (rm) { if (rm.dirty) shopTiles(rm.gx, rm.gy).forEach(washDirtTile); });
      hotels.forEach(function (h) {                     // grime wash stays confined to the dirty wing
        if (h.wings.dog.dirty) hotelWingTiles(h, 'dog').forEach(washDirtTile);
        if (h.wings.cat.dirty) hotelWingTiles(h, 'cat').forEach(washDirtTile);
      });
      restrooms.forEach(function (rm) { if (rm.dirty) footprintTiles(FURN_BY_ID.restroom, rm.gx, rm.gy, rm.rot).forEach(washDirtTile); });
    }

    // Clean-up bars float above whoever is mopping (drawn over the actors).
    function drawCleanBars() {
      puddles.forEach(function (p) {
        if (!(p.clean > 0)) return;
        var s = iso(p.x, p.y), bw = 22, bx = s.x - bw / 2, by = s.y - 60;
        ctx.fillStyle = 'rgba(15,20,30,0.6)'; roundRect(ctx, bx - 1.5, by - 1.5, bw + 3, 6, 3); ctx.fill();
        ctx.fillStyle = '#5ad17a'; roundRect(ctx, bx, by, bw * Math.min(1, p.clean / messGoal(p)), 3, 2); ctx.fill();
      });
      dirtyRooms().forEach(function (j) {                     // scrub progress over a room being cleaned
        if (!(j.rm.cleanProg > 0)) return;
        var s = iso(j.x, j.y), bw = 26, bx = s.x - bw / 2, by = s.y - 30;
        ctx.fillStyle = 'rgba(15,20,30,0.6)'; roundRect(ctx, bx - 1.5, by - 1.5, bw + 3, 6, 3); ctx.fill();
        ctx.fillStyle = '#5ad17a'; roundRect(ctx, bx, by, bw * Math.min(1, j.rm.cleanProg / j.goal), 3, 2); ctx.fill();
      });
    }

    // Floating "+10" coin pop-ups above served clients.
    // A staffer's name tag, below their feet. Only shown once named (hires start blank);
    // a ♀/♂ glyph prefixes the name as the gender cue. Reuses the floater text style.
    function drawStaffLabel(gx, gy, name, gender) {
      if (!name) return;
      var s = iso(gx, gy), y = s.y + 15;
      var txt = name;                                  // name only — gender is shown by the sprite, not the tag
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '800 11px Nunito, sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(18,26,34,0.7)';
      ctx.strokeText(txt, s.x, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, s.x, y);
      ctx.restore();
    }
    // The grabbed staffer, lifted off the ground and slightly pinched, following the
    // cursor — with a green/red ring on the destination tile showing drop validity.
    function drawCarried() {
      if (!carrying) return;
      var s = iso(pointer.gx, pointer.gy);
      var ease = 1 - (1 - carryT) * (1 - carryT);   // ease-out
      var lift = 20 * ease + 2 * Math.sin(animT * 7);
      var sc = 1 + 0.08 * ease;
      var ok = carrying.canDrop();
      ctx.save();                                    // destination ring
      ctx.fillStyle = ok ? 'rgba(60,180,90,0.34)' : 'rgba(210,70,55,0.34)';
      ctx.beginPath(); ctx.ellipse(s.x, s.y, TILE_HW * 0.55, TILE_HH * 0.55, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.save();                                    // lifted + pinched figure (scaled about its feet)
      ctx.translate(0, -lift);
      ctx.translate(s.x, s.y); ctx.scale(sc, sc); ctx.translate(-s.x, -s.y);
      var g = carrying.getGender();
      if (carrying.kind === 'vet') drawVetStaff(ctx, pointer.gx, pointer.gy, 0, 'SE', g);
      else if (carrying.kind === 'cleaner') drawCleaner(ctx, pointer.gx, pointer.gy, g);
      else if (carrying.kind === 'pharmacist') drawPharmacist(ctx, pointer.gx, pointer.gy, g);
      else drawReceptionist(ctx, pointer.gx, pointer.gy, g);
      ctx.restore();
    }
    // One pass over all staff, drawn above the scene so a desk/counter can't occlude a tag.
    function drawStaffLabels() {
      eachStaffHandle(function (h) {
        if (carrying && carrying.is(h.data)) return;     // the carried one's tag rides the lift sprite
        var t = h.tile();
        drawStaffLabel(t.x, t.y, h.getName(), h.getGender());
      });
    }

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
      // Blit the padded static buffer, offset by how far the camera has moved since the
      // bake. While panning this just translates the cached bitmap (cheap) instead of
      // re-running the procedural tile render; the margin keeps the edges covered.
      var dx = camera.x - staticCamX, dy = camera.y - staticCamY;
      ctx.drawImage(bg, (-STATIC_PAD + dx) * view.dpr, (-STATIC_PAD + dy) * view.dpr);

      // ONE painter's pass over everything on the floor — walls, doors, furniture,
      // characters — sorted by foot depth (gx+gy). The lower an object's foot, the
      // nearer it is, so it paints last/on top. This replaces the old bg/fg raster
      // split + inside/outside buckets, which couldn't interleave walls with items.
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

      // floor decals first, under everyone
      drawPuddles();                        // accidents on the floor
      drawRoomDirt();                       // grime wash over dirty operating-room floors (under the circles)
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
      groomings.forEach(function (rm) {     // grooming station circles (lit when an operator is on them)
        groomStations(rm.gx, rm.gy).forEach(function (st) {
          drawExamCircle(ctx, st.circle.x, st.circle.y, playerAtTile(st.circle) || workerAtTile(st.circle));
        });
      });
      surgeries.forEach(function (rm) {     // surgery: 2 surgeon flanks + the nurse circle
        var k = surgeryKeyTiles(rm.gx, rm.gy);
        drawExamCircle(ctx, k.vetA.x, k.vetA.y, vetOnTile(k.vetA));
        drawExamCircle(ctx, k.vetB.x, k.vetB.y, vetOnTile(k.vetB));
        drawExamCircle(ctx, k.worker.x, k.worker.y, playerAtTile(k.worker) || workerAtTile(k.worker));
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
        // off-leash park pet: its own depth-sorted sprite at its roaming position
        // (dogs on the turf; cats out of the carrier in a cat-park blank room)
        if (v.phase === 'inDogPark' && v.dog && (v.pet.charAt(0) === 'd' || v.parkZone === 'cat')) {
          var d = v.dog;
          scene.push({ d: d.x + d.y, who: 'visitor', fn: function () {
            var ds = iso(d.x, d.y);
            var fn = v.pet === 'cat' ? cachedCat : cachedDog;
            fn(v, ds.x, ds.y, d.face >= 0, { leash: false, run: d.moving ? d.gait : 0, wag: d.wag });
          } });
        }
      });
      if (hasDesk()) staff.forEach(function (st) {       // receptionists at their stations
        if (carrying && carrying.is(st)) return;         // the carried one rides the lift sprite instead
        var L = staffLine(st);                           // a desk's lone one stands at the queue it's serving
        var p = stationTile(L), rot = deskForLine(L).rot || 0;
        scene.push({ d: p.x + p.y, who: 'receptionist', ref: st, hx: p.x, hy: p.y, fn: function () {
          staffSprite('rec' + st.gender + rot, p.x, p.y, function (c, gx, gy) { drawReceptionist(c, gx, gy, st.gender, rot); });
        } });
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
      surgeries.forEach(function (rm) {                  // surgery-theatre furniture
        var k = surgeryKeyTiles(rm.gx, rm.gy);
        scene.push({ d: k.monitor.x + k.monitor.y, fn: function () { drawSurgMonitor(ctx, k.monitor.x, k.monitor.y); } });
        scene.push({ d: k.trolley.x + k.trolley.y, fn: function () { drawSurgTrolley(ctx, k.trolley.x, k.trolley.y); } });
        var spet = (rm.occupant && rm.occupant.phase === 'inSurgery') ? rm.occupant : null;
        scene.push({ d: k.table.x + k.table.y, fn: function () { drawSurgTable(ctx, k.table.x, k.table.y, spet); } });
      });
      vets.forEach(function (vt) {                       // roaming hired vets
        if (carrying && carrying.is(vt)) return;
        scene.push({ d: vt.x + vt.y, who: 'vet', ref: vt, hx: vt.x, hy: vt.y, fn: function () {
          var rot = vt.room ? (vt.room.rot || 0) : 0, dir = vt.moving ? vt.dir : null;
          staffSprite('vet' + vt.gender + rot + (dir || '-'), vt.x, vt.y, function (c, gx, gy) { drawVetStaff(c, gx, gy, rot, dir, vt.gender); });
        } });
      });
      cleaners.forEach(function (cl) {                   // roaming cleaners
        if (carrying && carrying.is(cl)) return;
        scene.push({ d: cl.x + cl.y, who: 'cleaner', ref: cl, hx: cl.x, hy: cl.y, fn: function () {
          staffSprite('cl' + cl.gender, cl.x, cl.y, function (c, gx, gy) { drawCleaner(c, gx, gy, cl.gender); });
        } });
      });
      workers.forEach(function (wk) {                    // roaming workers (groomers)
        if (carrying && carrying.is(wk)) return;
        scene.push({ d: wk.x + wk.y, who: 'worker', ref: wk, hx: wk.x, hy: wk.y, fn: function () {
          staffSprite('wk' + wk.gender, wk.x, wk.y, function (c, gx, gy) { drawWorker(c, gx, gy, wk.gender); });
        } });
      });
      groomings.forEach(function (rm) {                  // grooming shower + blow-dry fixtures
        groomStations(rm.gx, rm.gy).forEach(function (st, idx) {
          var active = !!(rm.occupant && rm.occupant.phase === (idx === 0 ? 'inGroomShower' : 'inGroomDry'));
          var f = st.fixture;
          scene.push({ d: f.x + f.y, fn: function () { (idx === 0 ? drawGroomShower : drawGroomDryer)(ctx, f.x, f.y, active); } });
        });
      });
      pharmacies.forEach(function (ph) {                 // pharmacy counters + hired pharmacists
        pharmStations(ph.gx, ph.gy, ph.rot).forEach(function (sec, idx) {
          scene.push({ d: sec.counter.x + sec.counter.y, fn: function () { drawPharmCounter(ctx, sec.counter.x, sec.counter.y); } });
          var pharm = ph.stations[idx].pharm;
          if (pharm && !(carrying && carrying.is(pharm))) scene.push({ d: sec.circle.x + sec.circle.y, who: 'pharmacist', ref: pharm, hx: sec.circle.x, hy: sec.circle.y, fn: function () {
            staffSprite('ph' + pharm.gender + (deskAnchor().rot || 0), sec.circle.x, sec.circle.y, function (c, gx, gy) { drawPharmacist(c, gx, gy, pharm.gender); });
          } });
        });
      });
      shops.forEach(function (sh) {                      // shop display island + cashier
        shopIslandTiles(sh.gx, sh.gy).forEach(function (t, idx) {
          scene.push({ d: t.x + t.y, fn: function () { drawShopIsland(ctx, t.x, t.y, idx === 1); } });
        });
        var ct = shopCashierTile(sh.gx, sh.gy);          // behind the register; counter (higher d) draws in front
        if (shopWorkersAssigned(sh) > 0)                 // cashier appears only while the shop is staffed
          scene.push({ d: ct.x + ct.y, fn: function () {
            staffSprite('ca' + (sh.cashierGender || 'male'), ct.x, ct.y, function (c, gx, gy) { drawCashier(c, gx, gy, sh.cashierGender || 'male'); });
          } });
      });
      hotels.forEach(function (h) {                      // hotel beds (+ sleeping guests), desk, plants, roaming pets
        ['dog', 'cat'].forEach(function (sp) {
          hotelBeds(h, sp).forEach(function (b, bi) {
            var guest = null;
            for (var pi = 0; pi < h.pets.length; pi++) { var q = h.pets[pi]; if (q.species === sp && q.bed === bi && q.state === 'inBed') { guest = q; break; } }
            scene.push({ d: b.x + b.y, fn: function () {
              drawPetBed(ctx, b.x, b.y, sp === 'dog', bi);
              if (guest) {                               // snoozing on the cushion, gently breathing
                var gs = iso(b.x, b.y), bob2 = Math.sin(animT * 1.6 + bi) * 0.7;
                (sp === 'dog' ? cachedDog : cachedCat)({ pet: guest.kind }, gs.x, gs.y - 6 + bob2, bi % 2 === 0, { leash: false });
              }
            } });
          });
        });
        hotelDeskTiles(h.gx, h.gy).forEach(function (t, i) {
          scene.push({ d: t.x + t.y, fn: function () { drawHotelDesk(ctx, t.x, t.y, i === 0); } });
        });
        hotelPlantTiles(h.gx, h.gy).forEach(function (t) {
          scene.push({ d: t.x + t.y, fn: function () { drawFicus(ctx, t.x, t.y); } });
        });
        h.pets.forEach(function (p) {                    // guests out and about (park trips / pickup trot)
          if (p.state === 'inBed') return;
          var px2 = p.state === 'atPark' && p.host ? p.host.dog.x : p.x;
          var py2 = p.state === 'atPark' && p.host ? p.host.dog.y : p.y;
          var moving = p.state !== 'atPark' || (p.host && p.host.dog.moving);
          var gait = p.state === 'atPark' && p.host ? (p.host.dog.moving ? p.host.dog.gait : 0) : animT * 14;
          var wag = p.state === 'atPark' && p.host ? p.host.dog.wag : 0;
          var face = p.state === 'atPark' && p.host ? p.host.dog.face >= 0 : (p.face || 1) >= 0;
          scene.push({ d: px2 + py2, fn: function () {
            var ps2 = iso(px2, py2);
            (p.species === 'dog' ? cachedDog : cachedCat)({ pet: p.kind }, ps2.x, ps2.y, face, { leash: false, run: moving ? gait : 0, wag: wag });
          } });
        });
      });

      scene.sort(function (a, b) { return a.d - b.d; });
      var hiRef = staffHover ? staffHover.data : (staffGrab ? staffGrab.handle.data : null);
      scene.forEach(function (a) {
        // Hovering a Staff card dims every person except staff of that type.
        var dim = hoverStaff && a.who && a.who !== hoverStaff;
        if (dim) ctx.globalAlpha = 0.2;
        if (a.ref && a.ref === hiRef) drawStaffHighlight(a.hx, a.hy);   // grab affordance, under the figure
        a.fn();
        if (dim) ctx.globalAlpha = 1;
      });

      drawDeskCircles();                    // station rings, drawn on top of the desk counter
      drawStaffLabels();                    // name tags below staff, above the scene so a desk can't hide them
      drawCarried();                        // the lifted staffer being dragged, on top of everyone
      drawGhost();                          // placement preview floats on top
      drawCleanBars();                      // mop-up progress, above whoever's cleaning
      drawFloaters();                       // +10 coin pops on top of everyone

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(vig, 0, 0);              // gentle vignette for focus (baked in buildVignette)
    }

    var last = 0;
    function frame(ts) {
      if (!last) last = ts;
      var dt = Math.min((ts - last) / 1000, 0.05);
      last = ts;
      update(dt);
      if (carrying) carryT = Math.min(1, carryT + dt * 7);        // ramp the pick-up lift/pinch
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
      if (e.key === ']') { money += 1000; renderMoney(); e.preventDefault(); return; }   // cheat: +$1000
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
    var staffGrab = null;                    // pending staff press: {handle, x, y} (tap→modal, drag→carry)
    var staffHover = null;                   // staffer under the mouse: lit up as a grab affordance
    var carrying = null;                     // a staff handle being dragged to a new spot
    var carryT = 0;                          // 0→1 lift/pinch animation progress while carrying
    function getPoint(e) { var t = e.touches ? e.touches[0] : e; return { x: t.clientX, y: t.clientY }; }
    function setPointer(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      var g = screenToGrid(clientX - rect.left, clientY - rect.top);
      pointer.gx = Math.round(g.gx); pointer.gy = Math.round(g.gy); pointer.on = true;
    }
    function dragStart(e) {
      if (placing && (placing.item.kind === 'corridor' || placing.item.kind === 'blank' || placing.item.kind === 'park')) {  // corridor/blank/park brush: drag
        var cp = getPoint(e); setPointer(cp.x, cp.y);
        corridorDrag = { sx: pointer.gx, sy: pointer.gy };
        e.preventDefault(); return;
      }
      if (placing) {                       // build mode: position the ghost (and, for a
        var pp = getPoint(e); setPointer(pp.x, pp.y);  // mouse click, drop it right away;
        if (!e.touches) tryPlace();        // touch positions now and drops on lift)
        e.preventDefault(); return;
      }
      // grab a staffer first: a tap (no drag) opens their overlay, a drag relocates
      // them. Checked before pan/joystick so dragging staff never pans or moves the
      // player; falls through to those when nothing's under the cursor.
      var gp = getPoint(e); setPointer(gp.x, gp.y);
      var sh = staffAtPixel(gp.x, gp.y);     // full-body pixel hit, layered over the pan handler
      if (sh) { staffGrab = { handle: sh, x: gp.x, y: gp.y }; carrying = null; carryT = 0; e.preventDefault(); return; }
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
      if (staffGrab) {                      // a staffer is grabbed: track the cursor; promote to a carry past a small move
        var gp = getPoint(e); setPointer(gp.x, gp.y);
        if (!carrying && Math.hypot(gp.x - staffGrab.x, gp.y - staffGrab.y) > 8) { carrying = staffGrab.handle; carryT = 0; }
        e.preventDefault(); return;
      }
      if (panning) {                        // pan the camera by translating the cached static buffer
        var mp = getPoint(e);
        camera.x = panning.camX + (mp.x - panning.x);
        camera.y = panning.camY + (mp.y - panning.y);
        // Only re-bake when the pan nears the pre-rendered margin (else the edge would
        // run dry); in between, draw() just translates the existing bitmap — buttery.
        if (Math.abs(camera.x - staticCamX) > STATIC_PAD - 8 ||
            Math.abs(camera.y - staticCamY) > STATIC_PAD - 8) staticDirty = true;
        e.preventDefault(); return;
      }
      if (placing && (placing.item.kind === 'corridor' || placing.item.kind === 'blank' || placing.item.kind === 'park')) {
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
      if (staffGrab) {                      // released a grabbed staffer: drag→relocate (snap-back if invalid), tap→overlay
        if (carrying) { carrying.relocate(); carrying = null; }
        else openStaffModal(staffGrab.handle);
        staffGrab = null; if (e && e.preventDefault) e.preventDefault(); return;
      }
      if (panning) { panning = null; canvas.style.cursor = ''; staticDirty = true; if (e && e.preventDefault) e.preventDefault(); return; }   // walls back on (next frame)
      if (placing && (placing.item.kind === 'corridor' || placing.item.kind === 'blank' || placing.item.kind === 'park')) {
        if (corridorDrag) {
          if (placing.item.kind === 'blank') commitBlank(corridorDrag.sx, corridorDrag.sy, pointer.gx, pointer.gy);
          else if (placing.item.kind === 'park') commitPark(corridorDrag.sx, corridorDrag.sy, pointer.gx, pointer.gy);
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

    // Hover (mouse) tracks the tile under the cursor for the placement ghost, and
    // lights up a staffer under the cursor so it reads as grabbable (grab cursor too).
    window.addEventListener('mousemove', function (e) {
      if (e.target.closest && e.target.closest('#shopbar')) { pointer.on = false; staffHover = null; return; }
      setPointer(e.clientX, e.clientY);
      staffHover = (placing || panning || carrying) ? null : staffAtPixel(e.clientX, e.clientY);
      if (!panning && !carrying) canvas.style.cursor = staffHover ? 'grab' : '';
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
        v: 1, name: name, savedAt: Date.now(), money: money, staffSurcharge: staffSurcharge,
        // persist EVERY skill (speed / processing / cleaning / any future one),
        // not a hand-listed subset — so none silently reset to 1 on reload
        skills: (function () { var o = {}; for (var sk in skills) o[sk] = { val: skills[sk].val, cost: skills[sk].cost }; return o; })(),
        placed: (placed || []).map(function (p) { return { id: p.id, gx: p.gx, gy: p.gy, rot: p.rot || 0 }; }),
        corridor: Object.keys(corridor || {}),
        openRoom: Object.keys(openRoom || {}),       // blank-room tiles (else they reload as teal corridors)
        park: Object.keys(park || {}),               // dog-park grass tiles (re-tag so they reload as turf, not vinyl)
        examRooms:  (examRooms || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0, uses: r.uses || 0, dirty: !!r.dirty }; }),
        xrayRooms:  (xrayRooms || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0, vet: !!r.vet, uses: r.uses || 0, dirty: !!r.dirty }; }),
        restrooms:  (restrooms || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0 }; }),
        shops:      (shops || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0 }; }),
        groomings:  (groomings || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0 }; }),
        hotels:     (hotels || []).map(function (h) { return { gx: h.gx, gy: h.gy, rot: h.rot || 0,
          dogDirty: !!h.wings.dog.dirty, catDirty: !!h.wings.cat.dirty,
          pets: (h.pets || []).map(function (p) { return { kind: p.kind, bed: p.bed, stayT: Math.round(p.stayT * 10) / 10, fee: p.fee }; }) }; }),
        surgeries:  (surgeries || []).map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot || 0, uses: r.uses || 0, dirty: !!r.dirty }; }),
        pharmacies: (pharmacies || []).map(function (r) {
          return { gx: r.gx, gy: r.gy, rot: r.rot || 0,
                   stations: (r.stations || []).map(function (s) { return { pharm: s.pharm ? { name: s.pharm.name || '', gender: s.pharm.gender || 'male' } : false }; }) };
        }),
        staff: (staff || []).map(function (s) { return { type: s.type, line: s.line, name: s.name || '', gender: s.gender || 'male' }; }),
        vets:  (vets || []).map(function (v) { return { x: v.x, y: v.y, speed: v.speed, name: v.name || '', gender: v.gender || 'male' }; }),
        cleaners: (cleaners || []).map(function (c) { return { x: c.x, y: c.y, speed: c.speed, name: c.name || '', gender: c.gender || 'male' }; }),
        workers: (workers || []).map(function (w) { return { x: w.x, y: w.y, speed: w.speed, name: w.name || '', gender: w.gender || 'male' }; }),
        frq: frq,
        difficulty: difficulty
      };
    }

    // Wipe in-flight visitors / progress so a load (or new game) starts clean.
    function resetTransient() {
      visitors.length = 0;
      departStats.happy = 0; departStats.unhappy = 0;
      queue.forEach(function (q) { q.length = 0; });
      floaters.length = 0;
      puddles.length = 0;
      doorways.length = 0;
      spawnTimer = 0; visitorSeq = 0; examTicketSeq = 0; animT = 0;
      door.open = 0;
      for (var k in doorOpen) delete doorOpen[k];
      examRooms.forEach(function (r) { r.occupant = null; r.examT = 0; r.cleanProg = 0; });
      xrayRooms.forEach(function (r) { r.occupant = null; r.xrayT = 0; r.cleanProg = 0; });
      surgeries.forEach(function (r) { r.occupant = null; r.surgT = 0; r.cleanProg = 0; });
      restrooms.forEach(function (r) { r.occupant = null; });
      pharmacies.forEach(function (p) { (p.stations || []).forEach(function (s) { s.patient = null; s.procT = 0; }); });
      groomings.forEach(function (r) { r.occupant = null; r.showerT = 0; r.dryT = 0; });
      hotels.forEach(function (h) {           // pets stay boarded (persisted) — just settle them into bed
        h.wings.dog.cleanProg = 0; h.wings.cat.cleanProg = 0;
        h.pets.forEach(function (p) {
          p.state = 'inBed'; p.host = null; p.path = null; p.wp = 0; p.tripT = 6; p.playT = 0;
          var b = bedTile(h, p); p.x = b.x; p.y = b.y;
        });
      });
      vets.forEach(function (v) { v.room = null; v.slot = null; v.working = false; v.moving = false; v.path = null; v.wp = 0; });
      cleaners.forEach(function (c) { c.target = null; c.moving = false; c.path = null; c.wp = 0; });
      workers.forEach(function (w) { w.room = null; w.working = false; w.moving = false; w.path = null; w.wp = 0; w.shopTarget = null; w.post = null; });
      placing = null; corridorDrag = null;
      try { document.body.classList.remove('placing'); } catch (e) {}
      vet.x = ROOM / 2 - 0.5; vet.y = ROOM / 2 - 0.5; vet.dir = 'SE'; vet.moving = false; vet.walkPhase = 0;
    }

    // Reset everything to a fresh, empty clinic.
    function newGame(diffKey) {
      difficulty = DIFFICULTY[diffKey] ? diffKey : 'easy';
      var D = diff();
      resetTransient();
      placed.length = 0; examRooms.length = 0; xrayRooms.length = 0; surgeries.length = 0;
      restrooms.length = 0; pharmacies.length = 0; shops.length = 0; groomings.length = 0; hotels.length = 0; staff.length = 0; vets.length = 0; cleaners.length = 0; workers.length = 0;
      for (var k in corridor) delete corridor[k];
      for (var kor in openRoom) delete openRoom[kor];
      for (var kpk in park) delete park[kpk];
      for (var k2 in occupied) delete occupied[k2];
      money = D.money;
      staffSurcharge = 0;                   // fresh clinic → staff back to base prices
      for (var sk in skills) { skills[sk].val = 1.0; skills[sk].cost = 10; }   // reset EVERY skill (incl. cleaning) to base
      frq = D.frq; wait = D.wait; spawnTimer = 0; autoSaveTimer = 0;
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
      placed.length = 0; examRooms.length = 0; xrayRooms.length = 0; surgeries.length = 0;
      restrooms.length = 0; pharmacies.length = 0; shops.length = 0; groomings.length = 0; hotels.length = 0; staff.length = 0; vets.length = 0; cleaners.length = 0; workers.length = 0;
      for (var k in corridor) delete corridor[k];
      for (var kor in openRoom) delete openRoom[kor];
      for (var kpk in park) delete park[kpk];
      for (var k2 in occupied) delete occupied[k2];

      money = (typeof data.money === 'number') ? data.money : 1000;
      staffSurcharge = (typeof data.staffSurcharge === 'number') ? data.staffSurcharge : 0;
      if (data.skills) {                       // restore every saved skill we still have (skips unknown/removed ones)
        for (var sk in skills) if (data.skills[sk]) { skills[sk].val = data.skills[sk].val; skills[sk].cost = data.skills[sk].cost; }
      }
      difficulty = DIFFICULTY[data.difficulty] ? data.difficulty : 'easy';   // legacy saves had no difficulty → Easy
      frq = (typeof data.frq === 'number') ? data.frq : 30;
      wait = diff().wait;                                                     // patience is a difficulty knob, not saved directly

      (data.corridor || []).forEach(function (key) { corridor[key] = true; });
      // Restore blank rooms BEFORE placing walled rooms, so floor rendering, wall
      // openings, and door-finding all see them as open rooms (not plain corridors).
      (data.openRoom || []).forEach(function (key) { openRoom[key] = true; });
      (data.park || []).forEach(function (key) { park[key] = true; });   // re-tag dog-park grass
      (data.placed || []).forEach(function (p) {
        placed.push({ id: p.id, gx: p.gx, gy: p.gy, rot: p.rot || 0 });
        var def = FURN_BY_ID[p.id];
        if (def) footprintTiles(def, p.gx, p.gy, p.rot || 0).forEach(function (t) { occupied[t.x + ',' + t.y] = true; });
      });
      _suspendStatic = true;                    // bake once after all rooms (below), not per room
      if (typeof placeExam === 'function')     (data.examRooms || []).forEach(function (r) { var rm = placeExam(r.gx, r.gy, r.rot || 0); if (rm) { rm.uses = r.uses || 0; rm.dirty = !!r.dirty; } });
      if (typeof placeXray === 'function')     (data.xrayRooms || []).forEach(function (r) { var rm = placeXray(r.gx, r.gy, r.rot || 0); if (rm) { rm.uses = r.uses || 0; rm.dirty = !!r.dirty; } });
      if (typeof placeRestroom === 'function') (data.restrooms || []).forEach(function (r) { placeRestroom(r.gx, r.gy, r.rot || 0); });
      if (typeof placePharmacy === 'function') (data.pharmacies || []).forEach(function (r) { placePharmacy(r.gx, r.gy, r.rot || 0); });
      if (typeof placeShop === 'function')     (data.shops || []).forEach(function (r) { placeShop(r.gx, r.gy, r.rot || 0); });
      if (typeof placeGrooming === 'function') (data.groomings || []).forEach(function (r) { placeGrooming(r.gx, r.gy, r.rot || 0); });
      if (typeof placeHotel === 'function')    (data.hotels || []).forEach(function (r) { placeHotel(r.gx, r.gy, r.rot || 0); });
      if (typeof placeSurgery === 'function')  (data.surgeries || []).forEach(function (r) { var rm = placeSurgery(r.gx, r.gy, r.rot || 0); if (rm) { rm.uses = r.uses || 0; rm.dirty = !!r.dirty; } });
      _suspendStatic = false;
      // per-room persistent extras, by index (push order matches save order)
      (data.xrayRooms || []).forEach(function (r, i) { if (xrayRooms[i]) xrayRooms[i].vet = !!r.vet; });
      (data.hotels || []).forEach(function (r, i) {          // wings' dirty state + the boarded pets
        var h = hotels[i]; if (!h) return;
        h.wings.dog.dirty = !!r.dogDirty; h.wings.cat.dirty = !!r.catDirty;
        (r.pets || []).forEach(function (p) {
          h.pets.push({ kind: p.kind, species: petSpecies(p.kind), bed: p.bed || 0,
                        stayT: typeof p.stayT === 'number' ? p.stayT : 0, fee: p.fee || 60,
                        state: 'inBed', x: 0, y: 0, path: null, wp: 0, tripT: 6, playT: 0, host: null });
        });
      });
      (data.pharmacies || []).forEach(function (r, i) {
        if (pharmacies[i]) (r.stations || []).forEach(function (s, j) {
          // legacy saves stored pharm as a bare boolean; upgrade to a {name,gender} object
          if (pharmacies[i].stations[j]) pharmacies[i].stations[j].pharm =
            s.pharm ? (typeof s.pharm === 'object' ? { name: s.pharm.name || '', gender: s.pharm.gender || 'male' } : newPharm()) : false;
        });
      });
      (data.staff || []).forEach(function (s) { staff.push({ type: s.type, line: s.line, name: s.name || '', gender: s.gender || randGender() }); });
      (data.vets || []).forEach(function (v) {
        vets.push({ x: v.x, y: v.y, room: null, working: false, speed: v.speed || 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0, name: v.name || '', gender: v.gender || randGender() });
      });
      (data.cleaners || []).forEach(function (c) {
        cleaners.push({ x: c.x, y: c.y, speed: c.speed || 2.3, dir: 'SE', walkPhase: 0, moving: false, target: null, path: null, wp: 0, name: c.name || '', gender: c.gender || randGender() });
      });
      (data.workers || []).forEach(function (w) {
        workers.push({ x: w.x, y: w.y, room: null, working: false, speed: w.speed || 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0, shopTarget: null, post: null, name: w.name || '', gender: w.gender || randGender() });
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
      hospEl.textContent = currentName ? '🏥 ' + currentName + ' · ' + diff().label : '';
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
        var dl = (DIFFICULTY[s.difficulty] || DIFFICULTY.easy).label;
        var row = document.createElement('div');
        row.className = 'save-row' + (s.name === currentName ? ' current' : '');
        row.innerHTML = '<div class="save-meta"><div class="nm"></div><div class="sub">' + dl + ' · $' + (s.money || 0) + ' · ' + rooms + (rooms === 1 ? ' room · ' : ' rooms · ') + when + '</div></div>' +
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

    // ---- Staff customization overlay -------------------------------------
    var staffModal = document.getElementById('staffModal');
    var staffNameEl = document.getElementById('staffName');
    var staffTitleEl = document.getElementById('staffTitle');
    var staffFireEl = document.getElementById('staffFire');
    var staffGenderEl = document.getElementById('staffGender');
    var staffHandleOpen = null;            // the handle the overlay is editing
    var STAFF_TITLE = { receptionist: 'Receptionist', vet: 'Vet', cleaner: 'Cleaner', pharmacist: 'Pharmacist' };
    function syncGenderButtons(g) {
      var btns = staffGenderEl.querySelectorAll('.modal-toggle');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-g') === g);
    }
    function openStaffModal(h) {
      if (placing) cancelPlacing();
      input.up = input.down = input.left = input.right = false;   // no stuck movement while typing
      staffHandleOpen = h;
      staffTitleEl.textContent = STAFF_TITLE[h.kind] || 'Staff';
      staffNameEl.value = h.getName();
      syncGenderButtons(h.getGender());
      staffFireEl.textContent = 'Fire (+$' + Math.floor(h.cost * 0.5) + ')';
      staffModal.hidden = false;
      try { staffNameEl.focus(); } catch (e) {}
    }
    function closeStaffModal() { staffModal.hidden = true; staffHandleOpen = null; }
    staffNameEl.addEventListener('input', function () { if (staffHandleOpen) staffHandleOpen.setName(staffNameEl.value); });
    staffGenderEl.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.modal-toggle');
      if (!btn || !staffHandleOpen) return;
      var g = btn.getAttribute('data-g');
      staffHandleOpen.setGender(g); syncGenderButtons(g);
    });
    staffFireEl.addEventListener('click', function () {
      if (!staffHandleOpen) return;
      var r = staffHandleOpen.fire(); money += r; renderMoney();
      closeStaffModal();
    });
    document.getElementById('staffClose').addEventListener('click', closeStaffModal);
    staffModal.addEventListener('click', function (e) { if (e.target === staffModal) closeStaffModal(); });
    document.getElementById('saveBtn').addEventListener('click', function () {
      var name = (saveNameEl.value || '').trim();
      if (!name) { try { saveNameEl.focus(); } catch (e) {} return; }
      if (!lsAvailable() || !writeSave(name)) { alert('Could not save — storage is full or blocked.'); return; }
      updateHospitalLabel(); renderSaveList();
    });
    saveNameEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('saveBtn').click(); });
    // "+ New Game" → pick a difficulty (Easy/Medium/Hard), which then starts a fresh game.
    var difficultyModal = document.getElementById('difficultyModal');
    function openDifficultyModal() { difficultyModal.hidden = false; }
    function closeDifficultyModal() { difficultyModal.hidden = true; }
    document.getElementById('newGameBtn').addEventListener('click', openDifficultyModal);
    document.getElementById('diffClose').addEventListener('click', closeDifficultyModal);
    difficultyModal.addEventListener('click', function (e) { if (e.target === difficultyModal) closeDifficultyModal(); });
    Array.prototype.forEach.call(difficultyModal.querySelectorAll('.diff-opt'), function (btn) {
      btn.addEventListener('click', function () {
        newGame(btn.getAttribute('data-diff'));
        closeDifficultyModal(); closeSaveModal();
      });
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
      // perf probes: doorway registry size (leak check), wall-segment count, and a
      // baked/unbaked toggle so benchmarks can A/B the sprite cache on one build
      doorwayCount: function () { return doorways.length; },
      wallSegCount: function () { return wallSegs.length; },
      setWallSprites: function (on) { wallSpritesOn = !!on; renderStatic(); return wallSpritesOn; },
      setCharSprites: function (on) { charSpritesOn = !!on; charSpriteCache = {}; charSpriteN = 0; return charSpritesOn; },
      charSpriteCount: function () { return charSpriteN; },
      timeDraw: function (n) { var t0 = performance.now(); for (var i = 0; i < (n || 100); i++) draw(); return (performance.now() - t0) / (n || 100); },
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
      buildPark: function (sx, sy, ex, ey) { commitPark(sx, sy, ex, ey); return Object.keys(park); },
      parkInfo: function () { return { size: parkSize(), quality: parkQuality(), busy: Math.round(parkBusy() * 100) / 100, appeal: Math.round(parkAppeal() * 1000) / 1000, goers: parkGoers(), spots: parkStandTiles().length }; },
      catParkInfo: function () { return { size: catFloorSize(), quality: parkQuality('cat'), busy: Math.round(parkBusy('cat') * 100) / 100, appeal: Math.round(parkAppeal('cat') * 1000) / 1000, goers: parkGoers('cat'), spots: parkStandTiles('cat').length }; },
      puddleList: function () { return puddles.map(function (p) { return { x: p.x, y: p.y, kind: p.kind || 'pee', clean: Math.round((p.clean || 0) * 10) / 10 }; }); },
      setPet: function (i, p) { if (visitors[i]) { visitors[i].pet = p; return true; } return false; },
      canExam: function (gx, gy) { return canPlaceExam(gx, gy); },
      canXray: function (gx, gy) { return canPlaceXray(gx, gy); },
      canPharm: function (gx, gy) { return canPlacePharmacy(gx, gy); },
      canRestroom: function (gx, gy, rot) { return canPlaceRestroom(gx, gy, rot || 0); },
      placeExam: function (gx, gy, rot) { placeExam(gx, gy, rot); return examKeyTiles(gx, gy, rot || 0); },
      placeXray: function (gx, gy, rot) { placeXray(gx, gy, rot); return examKeyTiles(gx, gy, rot || 0); },
      exams: function () { return examRooms.map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot, occupied: !!r.occupant, vet: !!r.vet, examT: Math.round((r.examT||0)*10)/10, uses: r.uses||0, dirty: !!r.dirty, cleanProg: Math.round((r.cleanProg||0)*10)/10 }; }); },
      xrays: function () { return xrayRooms.map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot, occupied: !!r.occupant, vet: !!r.vet, uses: r.uses||0, dirty: !!r.dirty, cleanProg: Math.round((r.cleanProg||0)*10)/10 }; }); },
      pharms: function () { return pharmacies.map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot, stations: r.stations.map(function (s) { return { pharm: !!s.pharm, busy: !!s.patient }; }) }; }); },
      placePharm: function (gx, gy, rot) { if (!canPlacePharmacy(gx, gy)) return false; placePharmacy(gx, gy, rot || 0); return pharmacies[pharmacies.length - 1]; },
      canSurgery: function (gx, gy) { return canPlaceSurgery(gx, gy); },
      placeSurgery: function (gx, gy, rot) { if (!canPlaceSurgery(gx, gy)) return false; placeSurgery(gx, gy, rot || 0); return surgeryKeyTiles(gx, gy); },
      surgeries: function () { return surgeries.map(function (r) { return { gx: r.gx, gy: r.gy, occupied: !!r.occupant, surgT: Math.round((r.surgT||0)*10)/10, uses: r.uses||0, dirty: !!r.dirty, staffed: surgeryStaffed(r), door: r.door, cleanProg: Math.round((r.cleanProg||0)*10)/10 }; }); },
      surgSend: function (i) { var v = visitors[i || 0]; if (!v) return false; v.needsSurgery = true; return claimSurgery(v); },
      canShop: function (gx, gy) { return canPlaceShop(gx, gy); },
      placeShop: function (gx, gy, rot) { if (!canPlaceShop(gx, gy)) return false; placeShop(gx, gy, rot || 0); return shops[shops.length - 1]; },
      shops: function () { return shops.map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot }; }); },
      shopSpend: function () { return shopSpend(); },
      canGroom: function (gx, gy) { return canPlaceGrooming(gx, gy); },
      placeGroom: function (gx, gy, rot) { if (!canPlaceGrooming(gx, gy)) return false; placeGrooming(gx, gy, rot || 0); var rm = groomings[groomings.length - 1]; return { gx: rm.gx, gy: rm.gy, door: rm.door, stations: groomStations(rm.gx, rm.gy) }; },
      grooms: function () { return groomings.map(function (r) { return { gx: r.gx, gy: r.gy, rot: r.rot, occupied: !!r.occupant, phase: r.occupant ? r.occupant.phase : null, showerT: Math.round((r.showerT||0)*100)/100, dryT: Math.round((r.dryT||0)*100)/100 }; }); },
      hireWorker: function (gx, gy) { workers.push({ x: gx != null ? gx : ROOM / 2 - 0.5, y: gy != null ? gy : ROOM - 1.5, room: null, working: false, speed: 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0, shopTarget: null, post: null, name: '', gender: randGender() }); return workers.length; },
      workerList: function () { return workers.map(function (w) { return { x: Math.round(w.x*100)/100, y: Math.round(w.y*100)/100, working: !!w.working, room: !!w.room }; }); },
      route: function (sx, sy, tx, ty) { var p = examRoute(sx, sy, tx, ty); return { reached: examRouteReached, len: p.length, path: p }; },
      save: function (name) { return buildSave(name || 'test'); },
      load: function (d) { return applySave(d); },
      newGame: function (d) { newGame(d); return difficulty; },
      diffInfo: function () { var D = diff(); return { difficulty: difficulty, money: money, frq: frq, wait: wait, up: D.up, down: D.down, rating: Math.round((100 / frq) * 100) / 100 }; },
      corridors: function () { return Object.keys(corridor); },
      setInput: function (k, v) { input[k] = v; },
      can: function (id, gx, gy, rot) { return canPlace(FURN_BY_ID[id], gx, gy, rot || 0); },
      buildRestroom: function (gx, gy, rot) { if (!canPlaceRestroom(gx, gy, rot || 0)) return false; placeRestroom(gx, gy, rot || 0); return restrooms[restrooms.length - 1]; },
      restroomList: function () { return restrooms.map(function (r) { return { gx: r.gx, gy: r.gy, toilet: r.toilet, stand: r.stand, door: r.door, occ: !!r.occupant, dirty: !!r.dirty, cleanProg: Math.round((r.cleanProg||0)*100)/100 }; }); },
      dirtyRoomList: function () { return dirtyRooms().map(function (j) { return { x: j.x, y: j.y, goal: j.goal, cleanProg: Math.round((j.rm.cleanProg||0)*100)/100 }; }); },
      cleanerList: function () { return cleaners.map(function (c) { return { x: Math.round(c.x*100)/100, y: Math.round(c.y*100)/100, target: c.target ? { x: c.target.x, y: c.target.y } : null }; }); },
      setDirty: function (kind, n) {
        if (kind === 'hotelDog' || kind === 'hotelCat') { var hh = hotels[n || 0]; if (!hh) return false; hh.wings[kind === 'hotelDog' ? 'dog' : 'cat'].dirty = true; return true; }
        var L = kind === 'restroom' ? restrooms : kind === 'shop' ? shops : kind === 'pharmacy' ? pharmacies : kind === 'xray' ? xrayRooms : kind === 'surgery' ? surgeries : examRooms; if (L[n||0]) { L[n||0].dirty = true; return true; } return false; },
      wallEdge: function (ax, ay, bx, by) { return wallStep(ax, ay, bx, by); },
      clearGroomRooms: function () { groomings.length = 0; return 0; },
      canHotel: function (gx, gy) { return canPlaceHotel(gx, gy); },
      placeHotel: function (gx, gy, rot) { if (!canPlaceHotel(gx, gy)) return false; placeHotel(gx, gy, rot || 0); var h = hotels[hotels.length - 1]; return { gx: h.gx, gy: h.gy, door: h.door, work: hotelWorkTiles(h), drop: hotelDropTile(h) }; },
      hotelList: function () { return hotels.map(function (h) { return { gx: h.gx, gy: h.gy }; }); },
      hotelInfo: function (i) {
        var h = hotels[i || 0]; if (!h) return null;
        function wing(sp) { var used = h.pets.filter(function (p) { return p.species === sp; }).length; return { dirty: !!h.wings[sp].dirty, beds: 3, used: used, taking: hotelTaking(h, sp) }; }
        return { workersAssigned: hotelWorkersAssigned(h),
                 workersPresent: workers.filter(function (w) { return w.working && w.post && w.post.indexOf('hotel:' + hotels.indexOf(h) + ':') === 0; }).length,
                 dog: wing('dog'), cat: wing('cat'),
                 pets: h.pets.map(function (p) { return { kind: p.kind, species: p.species, bed: p.bed, stayT: Math.round(p.stayT * 10) / 10, fee: p.fee, state: p.state }; }) };
      },
      hotelCheckIn: function (i, kind, stayT, fee) {
        var h = hotels[i || 0]; if (!h) return false;
        var sp = petSpecies(kind), bed = hotelFreeBed(h, sp); if (bed < 0) return false;
        var b = hotelBeds(h, sp)[bed];
        h.pets.push({ kind: kind, species: sp, bed: bed, stayT: stayT != null ? stayT : 120, fee: fee != null ? fee : 180,
                      state: 'inBed', x: b.x, y: b.y, path: null, wp: 0, tripT: 6, playT: 0, host: null });
        return { bed: bed, pets: h.pets.length };
      },
      shopInfo: function (i) { var s = shops[i || 0]; if (!s) return null; var n = shopWorkersPresent(s); return { workersAssigned: shopWorkersAssigned(s), workersPresent: n, mult: shopSpendMult(n) }; },
      workerPostList: function () { return workers.map(function (w) { return { post: w.post, working: !!w.working, x: Math.round(w.x * 10) / 10, y: Math.round(w.y * 10) / 10 }; }); },
      setWantHotel: function (i) { if (visitors[i]) { visitors[i].wantsHotel = true; return true; } return false; },
      setBladder: function (i, s) { if (visitors[i]) { visitors[i].bladder = s; return true; } return false; },
      intents: function () { return visitors.map(function (v) { return { id: v.id, intent: v.intent || null, phase: v.phase, pet: v.pet, happy: !!v.happy, left: !!v.left, parkZone: v.parkZone || null, xrayed: !!v.xrayed, operated: !!v.operated, medicated: !!v.medicated, groomed: !!v.groomed, shopped: !!v.shopped, parkDone: !!v.parkDone, served: !!v.served }; }); },
      setIntent: function (i, k) { var v = visitors[i]; if (!v) return false; v.intent = k; if (k === 'pharm') v.needsMeds = true; if (k === 'groom') v.wantsGroom = true; return true; },
      happyStats: function () { return { happy: departStats.happy, unhappy: departStats.unhappy }; },
      setIntentWeights: function (o) { for (var k in o) INTENT_WEIGHTS[k] = o[k]; return INTENT_WEIGHTS; },
      rollIntents: function (n) { var c = {}; for (var i = 0; i < (n || 1000); i++) { var k = rollIntent(); c[k] = (c[k] || 0) + 1; } return c; },
      vpos: function () { return visitors.map(function (v) { return { id: v.id, phase: v.phase, x: v.x, y: v.y, moving: !!v.moving, seated: !!v.seated }; }); },
      setFrq: function (f) { frq = f; if (typeof renderRating === 'function') renderRating(); return { frq: frq, rating: Math.round((100 / frq) * 100) / 100 }; },
      countSpawns: function (secs) { var n0 = visitorSeq; var steps = Math.round((secs || 5) * 30); for (var i = 0; i < steps; i++) update(1 / 30); return { spawned: visitorSeq - n0, secs: secs || 5, frq: frq }; },
      staffCost: function (id) { var it = FURN_BY_ID[id]; return it ? itemCost(it) : null; },
      buyStaff: function (id) { var it = FURN_BY_ID[id]; if (!it || it.cat !== 'staff') return null; var paid = itemCost(it); chargeStaffHire(it); return { paid: paid, money: money, surcharge: staffSurcharge }; },
      emojis: function () { return visitors.map(function (v) { return { phase: v.phase, served: !!v.served, examined: !!v.examined, happy: !!v.happy, emoji: visitorEmoji(v) }; }); },
      hireReceptionist: function (line) { staff.push({ type: 'receptionist', line: line || 0, name: '', gender: randGender() }); return staff.length; },
      hireVet: function () { vets.push({ x: ROOM / 2 - 0.5, y: ROOM - 1.5, room: null, working: false, speed: 2.4, dir: 'SE', walkPhase: 0, moving: false, path: null, wp: 0, name: '', gender: randGender() }); return vets.length; },
      hirePharmacists: function () { pharmacies.forEach(function (ph) { ph.stations.forEach(function (s) { s.pharm = newPharm(); }); }); return pharmacies.length; },
      hireCleaner: function () { cleaners.push({ x: ROOM / 2 - 0.5, y: ROOM - 1.5, speed: 2.3, dir: 'SE', walkPhase: 0, moving: false, target: null, path: null, wp: 0, name: '', gender: randGender() }); return cleaners.length; },
      overlaps: function () { var occ = {}, n = 0; visitors.forEach(function (v) { if (v.moving) return; var k = Math.round(v.x) + ',' + Math.round(v.y); if (occ[k]) n++; occ[k] = 1; }); return n; },
      overlapInfo: function () { var occ = {}, hits = []; visitors.forEach(function (v) { if (v.moving) return; var k = Math.round(v.x) + ',' + Math.round(v.y); if (occ[k]) hits.push({ tile: k, a: occ[k], b: v.phase }); else occ[k] = v.phase; }); return hits; },
      qat: function (x, y) { return visitors.filter(function (v) { return Math.round(v.x) === x && Math.round(v.y) === y; }).map(function (v) { return { ph: v.phase, line: v.line, idx: (v.line != null && queue[v.line]) ? queue[v.line].indexOf(v) : '-', slot: v.phase === 'queuing' ? slotPos(v) : null, mv: !!v.moving }; }); },
      staffList: function () { var a = []; eachStaffHandle(function (h) { var t = h.tile(); a.push({ kind: h.kind, name: h.getName(), gender: h.getGender(), cost: h.cost, tile: { x: t.x, y: t.y } }); }); return a; },
      staffAt: function (gx, gy) { var h = staffAt(gx, gy); return h ? { kind: h.kind, name: h.getName(), gender: h.getGender() } : null; },
      _handle: function (kind, n) { var c = 0, out = null; eachStaffHandle(function (h) { if (h.kind === kind && c++ === (n || 0)) out = h; }); return out; },   // Nth handle of a kind
      setStaff: function (kind, n, name, gender) { var h = window.__t._handle(kind, n); if (!h) return false; if (name != null) h.setName(name); if (gender != null) h.setGender(gender); return { name: h.getName(), gender: h.getGender() }; },
      fireStaff: function (kind, n) { var h = window.__t._handle(kind, n); if (!h) return false; var r = h.fire(); money += r; renderMoney(); return r; },
      relocateStaff: function (kind, n, gx, gy) { var h = window.__t._handle(kind, n); if (!h) return false; pointer.gx = gx; pointer.gy = gy; pointer.on = true; return h.relocate(); },
      openStaff: function (kind, n) { var h = window.__t._handle(kind, n); if (!h) return false; openStaffModal(h); return true; },
      staffAtPx: function (clientX, clientY) { setPointer(clientX, clientY); var h = staffAt(pointer.gx, pointer.gy); return h ? { kind: h.kind, tile: h.tile() } : null; },
      screenOf: function (gx, gy) { var p = iso(gx, gy), r = canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; },
      carryState: function () { return { grab: !!staffGrab, carrying: carrying ? carrying.kind : null, carryT: Math.round(carryT * 100) / 100 }; }
    };
  })();
