// Pure helpers for Pet Vet — isometric math, a stable hash, colour shading,
// and direction picking. No game state; depend only on layout constants.
import { TILE_HW, TILE_HH } from './constants.js';

// Camera-independent isometric projection (screen offset added by iso() in main).
export function isoRaw(gx, gy) {
  return { x: (gx - gy) * TILE_HW, y: (gx + gy) * TILE_HH };
}

// Deterministic 0..1 hash (no Math.random — keeps texture stable on resize).
export function hash(x, y) {
  var n = (x | 0) * 374761393 + (y | 0) * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

// Trace the diamond outline of one tile centred at screen (cx, cy).
export function diamondPath(c, cx, cy) {
  c.beginPath();
  c.moveTo(cx, cy - TILE_HH);
  c.lineTo(cx + TILE_HW, cy);
  c.lineTo(cx, cy + TILE_HH);
  c.lineTo(cx - TILE_HW, cy);
  c.closePath();
}

// Multiply a #rrggbb colour by factor f (clamped) → an 'rgb(...)' string.
export function shade(hex, f) {
  var n = parseInt(hex.slice(1), 16);
  var r = Math.min(255, ((n >> 16) & 255) * f) | 0;
  var g = Math.min(255, ((n >> 8) & 255) * f) | 0;
  var b = Math.min(255, (n & 255) * f) | 0;
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// Map a movement vector to one of the four isometric facing names.
export function chooseDir(mx, my) {
  if (Math.abs(mx) > Math.abs(my)) return mx > 0 ? 'SE' : 'NW';
  return my > 0 ? 'SW' : 'NE';
}
