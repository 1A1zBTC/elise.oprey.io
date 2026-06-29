/* Shared helpers for "Elise and Luke's Games".
   Loaded by every game as <script src="/shared/game.js"></script> placed
   BEFORE the game's own inline <script> (no defer) so window.EL exists when
   the game runs. These are drop-in replacements (identical semantics) for the
   small utilities that used to be copy-pasted into each game.

   Migration pattern in a game: delete the local copies and either call EL.*
   directly or alias once, e.g.  var pick = EL.pick, clamp = EL.clamp; */
(function () {
  'use strict';

  var EL = {};

  // ---- Shared player names (edited on the launcher, stored under one key) ----
  // Returns the trimmed name for player i, or `fallback` if blank/missing.
  EL.playerName = function (i, fallback) {
    try {
      var a = JSON.parse(localStorage.getItem('elise.playerNames'));
      var n = (a && a[i] != null ? String(a[i]) : '').trim();
      return n || fallback;
    } catch (e) { return fallback; }
  };

  // ---- Per-game best/high-score store ----
  // EL.best('mygame.best') -> { load(): number, save(v): void }
  EL.best = function (key) {
    return {
      load: function () { try { return parseInt(localStorage.getItem(key) || '0', 10) || 0; } catch (e) { return 0; } },
      save: function (v) { try { localStorage.setItem(key, String(v)); } catch (e) {} }
    };
  };

  // ---- Math / RNG ----
  EL.rnd = function (a, b) { return a + Math.random() * (b - a); };        // float in [a, b)
  EL.rint = function (a, b) { return Math.floor(EL.rnd(a, b + 1)); };      // int in [a, b] inclusive
  EL.pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
  EL.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  EL.lerp = function (a, b, t) { return a + (b - a) * t; };
  EL.dist2 = function (ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  // In-place Fisher–Yates shuffle; returns the same array for convenience.
  EL.shuffle = function (a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  // ---- Pointer position mapped into a canvas's intrinsic W x H coordinates ----
  EL.canvasPos = function (canvas, e, W, H) {
    var rect = canvas.getBoundingClientRect();
    var t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0]
          : ((e.touches && e.touches[0]) ? e.touches[0] : e);
    return { x: (t.clientX - rect.left) / rect.width * W, y: (t.clientY - rect.top) / rect.height * H };
  };

  window.EL = EL;
})();
