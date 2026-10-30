/**
 * Deterministic math helpers.
 *
 * ECMAScript only guarantees exact (IEEE-754 correctly rounded) results for
 * +, -, *, / and Math.sqrt/floor/round/abs/min/max. Math.sin, Math.cos,
 * Math.atan2, Math.exp etc. are "implementation-approximated" and differ
 * between V8 (Chrome/Node), SpiderMonkey (Firefox) and JavaScriptCore
 * (Safari). Because ranked runs are replayed on the server, the simulation
 * must only use the exact operations — so trigonometry is implemented here
 * with fixed polynomial evaluation.
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const DEG = PI / 180;

/** Wrap an angle into [-PI, PI). */
export function normAngle(a: number): number {
  return a - TWO_PI * Math.floor((a + PI) / TWO_PI);
}

// Taylor coefficients, evaluated with Horner's rule on [-PI/4, PI/4]; max abs error < 1e-12.
const S3 = -1 / 6;
const S5 = 1 / 120;
const S7 = -1 / 5040;
const S9 = 1 / 362880;
const S11 = -1 / 39916800;
const S13 = 1 / 6227020800;
const C2 = -1 / 2;
const C4 = 1 / 24;
const C6 = -1 / 720;
const C8 = 1 / 40320;
const C10 = -1 / 3628800;
const C12 = 1 / 479001600;
const C14 = -1 / 87178291200;

function sinPoly(x: number): number {
  const x2 = x * x;
  const p = S11 + x2 * S13;
  const q = S9 + x2 * p;
  const r = S7 + x2 * q;
  const s = S5 + x2 * r;
  const t = S3 + x2 * s;
  return x + x * x2 * t;
}

function cosPoly(x: number): number {
  const x2 = x * x;
  const p = C12 + x2 * C14;
  const q = C10 + x2 * p;
  const r = C8 + x2 * q;
  const s = C6 + x2 * r;
  const t = C4 + x2 * s;
  const u = C2 + x2 * t;
  return 1 + x2 * u;
}

/** Deterministic sine. Accurate to ~1e-11 for |a| up to a few thousand radians. */
export function dsin(a: number): number {
  const q = Math.round(a / HALF_PI);
  const r = a - q * HALF_PI;
  switch (q & 3) {
    case 0:
      return sinPoly(r);
    case 1:
      return cosPoly(r);
    case 2:
      return -sinPoly(r);
    default:
      return -cosPoly(r);
  }
}

/** Deterministic cosine. */
export function dcos(a: number): number {
  const q = Math.round(a / HALF_PI);
  const r = a - q * HALF_PI;
  switch (q & 3) {
    case 0:
      return cosPoly(r);
    case 1:
      return -sinPoly(r);
    case 2:
      return -cosPoly(r);
    default:
      return sinPoly(r);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return current + maxDelta >= target ? target : current + maxDelta;
  if (current > target) return current - maxDelta <= target ? target : current - maxDelta;
  return current;
}
