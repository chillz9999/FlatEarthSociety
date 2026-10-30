import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Noise3, clamp, facet, merge, paint, place, rng, smooth, srgb, taperedTube, weld } from './util';

/**
 * Procedural 3D models for every hazard, built at runtime from seeds (no model files). Sizes are in world units;
 * the scene's forward (along the course) is −z, so the side of a model facing the chase camera is +z.
 */

type C = THREE.Color;
const mixC = (a: C, b: C, t: number) => a.clone().lerp(b, clamp(t, 0, 1));

// ------------------------------------------------------------------ rock

const STONES = [
  { lit: srgb(184, 172, 152), mid: srgb(132, 122, 108), shade: srgb(84, 78, 70), base: srgb(42, 39, 35) },
  { lit: srgb(196, 160, 120), mid: srgb(146, 112, 82), shade: srgb(92, 70, 52), base: srgb(44, 34, 26) },
  { lit: srgb(150, 146, 142), mid: srgb(98, 96, 94), shade: srgb(60, 58, 58), base: srgb(26, 26, 27) },
];
const ALGAE = srgb(52, 62, 34);
const WET = srgb(24, 26, 22);
const GUANO = srgb(222, 218, 204);
const TURF = srgb(104, 122, 60);

export type RockForm = 'stack' | 'spire' | 'twin' | 'mesa';

export function rockForm(shape: number): RockForm {
  const f = rng(shape)();
  return f < 0.4 ? 'stack' : f < 0.6 ? 'spire' : f < 0.82 ? 'twin' : 'mesa';
}

interface LumpOpts {
  H: number;
  /** How much narrower the top is than the waterline. */
  taper: number;
  top: 'dome' | 'peak' | 'flat';
  crag: number;
  seed: number;
  /** Segments around (and rings scale with it). */
  segs: number;
  /** Waterline radius kept at least this. */
  minR: number;
}

/**
 * One rock column: waterline radius ≈ 1, from 0.4 below the water to height H. Cliffs cut by vertical gullies,
 * stepped by bedding ledges, with a wave-cut notch at the waterline and a broken crown.
 */
function lump(o: LumpOpts): THREE.BufferGeometry {
  const n = new Noise3(o.seed);
  const r = rng(o.seed);
  const below = 0.4;
  const segs = o.segs;
  const rings = Math.round(segs * 0.75);
  const capRings = 4;
  const leanX = (r() - 0.5) * 0.25;
  const leanZ = (r() - 0.5) * 0.2;
  const ellipse = 0.92 + r() * 0.23;
  const pos: number[] = [];
  const idx: number[] = [];
  const radius = (th: number, y: number) => {
    const k = clamp(y / o.H, 0, 1);
    let R = 1 - o.taper * k ** 1.3;
    if (o.top === 'peak') R *= 1 - 0.75 * smooth(0.45, 1, k);
    const c = Math.cos(th);
    const sn = Math.sin(th);
    // Gullies and buttresses: noise stretched up the cliff.
    const gul = n.ridged(c * 2.2, y * 0.55, sn * 2.2, 3);
    R *= 1 - o.crag * 0.32 + o.crag * 0.5 * gul + 0.035 * n.get(c * 7, y * 3, sn * 7);
    // Bedding ledges.
    const bed = y * 6.5 + n.get(c * 0.8, 3, sn * 0.8) * 1.2;
    R *= 1 - 0.075 * (bed - Math.floor(bed)) ** 2;
    // The wave-cut notch, and the rock spreading under the water.
    R *= 1 - 0.05 * Math.exp(-(((y - 0.05) / 0.05) ** 2));
    if (y < 0) R *= 1 + 0.22 * (-y / below);
    if (y > -0.25 && y < 0.2) R = Math.max(R, o.minR);
    return R;
  };
  for (let j = 0; j <= rings; j++) {
    const y = -below + (j / rings) * (o.H + below);
    for (let i = 0; i < segs; i++) {
      const th = (i / segs) * Math.PI * 2;
      const R = radius(th, y);
      const ky = Math.max(0, y);
      pos.push(Math.cos(th) * R * ellipse + leanX * ky, y, Math.sin(th) * R + leanZ * ky);
    }
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * segs + i;
      const b = j * segs + ((i + 1) % segs);
      const c = (j + 1) * segs + i;
      const d = (j + 1) * segs + ((i + 1) % segs);
      idx.push(a, c, b, b, c, d);
    }
  // The crown: rings drawing in to a broken top (domed, peaked or a flat table).
  const topBase = rings * segs;
  let prev = topBase;
  for (let q = 1; q <= capRings; q++) {
    const f = 1 - q / (capRings + 0.6);
    const start = pos.length / 3;
    for (let i = 0; i < segs; i++) {
      const th = (i / segs) * Math.PI * 2;
      const R = radius(th, o.H) * f;
      const rise = o.top === 'flat' ? 0.02 : o.top === 'peak' ? 0.3 * (1 - f) : 0.16 * (1 - f * f);
      const jag = n.get(Math.cos(th) * 3, q * 1.7, Math.sin(th) * 3) * (o.top === 'flat' ? 0.02 : 0.08);
      const y = o.H * (1 + rise + jag);
      pos.push(Math.cos(th) * R * ellipse + leanX * y, y, Math.sin(th) * R + leanZ * y);
    }
    for (let i = 0; i < segs; i++) {
      const a = prev + i;
      const b = prev + ((i + 1) % segs);
      const c = start + i;
      const d = start + ((i + 1) % segs);
      idx.push(a, c, b, b, c, d);
    }
    prev = start;
  }
  const apex = pos.length / 3;
  const topY = o.H * (o.top === 'flat' ? 1.02 : o.top === 'peak' ? 1.32 : 1.17);
  pos.push(leanX * topY, topY, leanZ * topY);
  for (let i = 0; i < segs; i++) idx.push(prev + i, apex, prev + ((i + 1) % segs));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function colourRock(geo: THREE.BufferGeometry, H: number, seed: number, mesa: boolean): void {
  const n = new Noise3(seed + 99);
  const r = rng(seed);
  const stone = STONES[r() < 0.55 ? 0 : r() < 0.6 ? 1 : 2];
  const guano = H > 1.3 && r() < 0.6;
  paint(geo, (x, y, z, _nx, ny) => {
    const v = n.get(x * 3, y * 3, z * 3);
    const band = Math.sin(y * 22 + v * 2) * 0.5 + 0.5;
    let c = mixC(stone.shade, stone.mid, smooth(-0.1, H * 0.7, y) * 0.75 + v * 0.25);
    c = mixC(c, stone.lit, Math.max(0, ny) * 0.5 + Math.max(0, v) * 0.15 + band * 0.08);
    if (y < 0.14) c = mixC(c, mixC(WET, ALGAE, smooth(-0.15, 0.1, y)), smooth(0.14, 0.03, y));
    if (guano && y > H * 0.5 && (n.get(x * 6, y * 1.2, z * 6) > 0.3 || ny > 0.7)) c = mixC(c, GUANO, ny > 0.7 ? 0.7 : 0.45);
    if (mesa && ny > 0.55 && y > H * 0.85) c = mixC(c, TURF, 0.85 + v * 0.15);
    return c;
  });
}

/** Faceted where the stone breaks, smooth across a face. */
function crease(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = toCreasedNormals(g, Math.PI / 5);
  g.dispose();
  return out;
}

/** A rock in the sea (sea stack, spire, twin crags or a turf-capped mesa), waterline radius ≈ 1, for scaling by vr. */
export function rockGeometry(variant: number, form: RockForm, detail: number): { geo: THREE.BufferGeometry; height: number } {
  const seed = 0x9e3779b1 ^ (variant * 7919 + form.length * 104729);
  const r = rng(seed);
  let H: number;
  let geo: THREE.BufferGeometry;
  if (form === 'twin') {
    H = 1.2 + r() * 0.5;
    const segs = detail >= 3 ? 30 : 16;
    const a = lump({ H, taper: 0.35, top: 'dome', crag: 0.55, seed, segs, minR: 0.6 });
    a.scale(0.6, 1, 0.68);
    a.translate(-0.36, 0, (r() - 0.5) * 0.2);
    const b = lump({ H: H * (0.62 + r() * 0.2), taper: 0.35, top: 'peak', crag: 0.55, seed: seed + 1, segs, minR: 0.6 });
    b.scale(0.55, 1, 0.64);
    b.translate(0.42, 0, (r() - 0.5) * 0.2);
    const base = lump({ H: 0.26, taper: 0.25, top: 'dome', crag: 0.4, seed: seed + 2, segs, minR: 0.97 });
    for (const g of [a, b, base]) colourRock(g, H, seed, false);
    geo = crease(merge([a, b, base]));
  } else {
    H = form === 'spire' ? 1.5 + r() * 0.5 : form === 'mesa' ? 0.75 + r() * 0.25 : 1.0 + r() * 0.75;
    const g = lump({
      H,
      taper: form === 'spire' ? 0.55 : form === 'mesa' ? 0.1 : 0.28,
      top: form === 'mesa' ? 'flat' : form === 'spire' ? 'peak' : 'dome',
      crag: form === 'mesa' ? 0.4 : 0.55,
      seed,
      segs: detail >= 3 ? 32 : 16,
      minR: 0.97,
    });
    colourRock(g, H, seed, form === 'mesa');
    geo = crease(g);
  }
  geo.computeBoundingSphere();
  return { geo, height: H };
}

// ------------------------------------------------------------------ iceberg

const ICE_TOP = srgb(240, 246, 250);
const ICE_SIDE = srgb(196, 222, 236);
const ICE_DEEP = srgb(90, 170, 196);
const ICE_NOTCH = srgb(60, 150, 170);

/** An iceberg: cleaved facets of white and blue ice. Waterline radius ≈ 1. */
export function icebergGeometry(variant: number): { geo: THREE.BufferGeometry; height: number } {
  const seed = 0x1ceb3e9 + variant * 4099;
  const r = rng(seed);
  const n = new Noise3(seed);
  const form = r();
  const tabular = form < 0.3;
  const H = tabular ? 0.9 + r() * 0.4 : 1.1 + r() * 0.9;
  const geo = weld(new THREE.IcosahedronGeometry(1, 2));
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const below = 0.35;
  const peakX = (r() - 0.5) * 0.7;
  const peakZ = (r() - 0.5) * 0.5;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const hl = Math.hypot(vx, vz);
    const t = (vy + 1) / 2;
    let y = -below + t * (H + below);
    const k = clamp(y / H, 0, 1);
    let R = tabular ? 1 - 0.08 * k : 1 - 0.62 * k ** 1.1;
    R *= hl ** (tabular ? 0.1 : 0.4);
    R *= 0.9 + 0.22 * n.get(vx * 1.3, y * 1.3, vz * 1.3);
    if (y > -0.25 && y < 0.15) R = Math.max(R, 0.95 * hl ** 0.4);
    let x = hl > 1e-5 ? (vx / hl) * R : 0;
    let z = hl > 1e-5 ? (vz / hl) * R : 0;
    if (!tabular) {
      // Lean the peak off-centre.
      x += peakX * k * k;
      z += peakZ * k * k;
    } else if (vy > 0.4) y = H * (0.96 + 0.04 * n.get(vx * 3, 1, vz * 3));
    pos.setXYZ(i, x, y, z);
  }
  // Cleave: a few random planes slice the berg into sharp faces.
  const planes = 5 + Math.floor(r() * 4);
  const p = new THREE.Vector3();
  for (let j = 0; j < planes; j++) {
    const a = r() * Math.PI * 2;
    const tilt = (r() - 0.3) * 0.9;
    const nrm = new THREE.Vector3(Math.cos(a), tilt, Math.sin(a)).normalize();
    const c = 0.75 + r() * 0.25;
    for (let i = 0; i < pos.count; i++) {
      p.set(pos.getX(i), pos.getY(i) * 0.6, pos.getZ(i));
      const d = p.dot(nrm) - c;
      if (d > 0 && pos.getY(i) > 0.2) pos.setXYZ(i, pos.getX(i) - nrm.x * d, pos.getY(i) - (nrm.y * d) / 0.6, pos.getZ(i) - nrm.z * d);
    }
  }
  geo.computeVertexNormals();
  paint(geo, (x, y, z, _nx, ny) => {
    const v = n.get(x * 4, y * 4, z * 4);
    let c = mixC(ICE_SIDE, ICE_TOP, Math.max(0, ny) * 0.8 + v * 0.15 + smooth(0, H, y) * 0.2);
    c = mixC(c, ICE_DEEP, smooth(0.35, 0.0, y) * 0.6);
    if (y < 0.06 && y > -0.12) c = mixC(c, ICE_NOTCH, 0.6);
    return c;
  });
  const out = facet(geo);
  out.computeBoundingSphere();
  return { geo: out, height: H };
}

// ------------------------------------------------------------------ ice shelf

const PENGUIN_BLACK = srgb(22, 24, 30);
const PENGUIN_WHITE = srgb(236, 236, 230);
const BEAK = srgb(230, 140, 40);

function penguin(x: number, y: number, z: number, s: number, yaw: number): THREE.BufferGeometry {
  const body = paint(new THREE.SphereGeometry(1, 8, 6), PENGUIN_BLACK);
  place(body, 0, 4.2, 0, 0, 0, 0, 2.6, 4.4, 2.4);
  const belly = paint(new THREE.SphereGeometry(1, 8, 6), PENGUIN_WHITE);
  place(belly, 0, 3.8, 0.9, 0, 0, 0, 2.1, 3.6, 1.7);
  const head = paint(new THREE.SphereGeometry(1, 8, 6), PENGUIN_BLACK);
  place(head, 0, 9.0, 0.2, 0, 0, 0, 1.8);
  const beak = paint(new THREE.ConeGeometry(0.5, 1.6, 5), BEAK);
  place(beak, 0, 8.8, 2.0, Math.PI / 2, 0, 0);
  const g = merge([body, belly, head, beak]);
  place(g, x, y, z, 0, yaw, 0, s);
  return g;
}

/**
 * A flat-topped ice shelf: sheer cliffs split by crevasses and banded with old layers of ice, a wave-cut notch at the
 * waterline, a snow cap that rises and falls along its length, and a few penguins. World units.
 */
export function shelfGeometry(shape: number, half: number): { geo: THREE.BufferGeometry; height: number } {
  const r = rng(shape);
  const n = new Noise3(shape);
  const h = 85 + r() * 40;
  const b = 56 + r() * 12;
  const a = half;
  const N = 140;
  // Crevasses: narrow notches cut into the cliffs here and there.
  const cuts: { k: number; w: number; d: number }[] = [];
  for (let i = 0; i < 6 + Math.floor(r() * 6); i++) cuts.push({ k: Math.floor(r() * N), w: 1 + r() * 2, d: 0.05 + r() * 0.08 });
  const ring: [number, number, number][] = [];
  for (let k = 0; k < N; k++) {
    const th = (k / N) * Math.PI * 2;
    const c = Math.cos(th);
    const s2 = Math.sin(th);
    const e = 5;
    const rx = a * Math.sign(c) * Math.abs(c) ** (2 / e);
    const rz = b * Math.sign(s2) * Math.abs(s2) ** (2 / e);
    let out = 1.03 + 0.04 * n.get(k * 0.25, 0, 0) + 0.025 * n.get(k * 0.9, 1, 0);
    for (const cut of cuts) {
      const dk = Math.min(Math.abs(k - cut.k), N - Math.abs(k - cut.k));
      if (dk < cut.w) out -= cut.d * (1 - dk / cut.w);
    }
    // Never inside the line the hidden collision circles draw.
    out = Math.max(out, 0.99);
    // Top height along the shelf: long swells and a step or two.
    const top = h * (0.9 + 0.08 * n.get(rx * 0.012, 4, 0) + 0.05 * Math.sign(n.get(rx * 0.006, 9, 0)));
    ring.push([rx * out, rz * out, top]);
  }
  const levels: [number, number][] = [
    [-20, 1.06],
    [0, 0.965],
    [0.1, 1.0],
    [0.35, 1.005],
    [0.6, 0.998],
    [0.82, 1.006],
    [0.97, 1.012],
    [1.0, 0.99],
  ];
  const pos: number[] = [];
  const idx: number[] = [];
  for (let l = 0; l < levels.length; l++) {
    const [lv, sc] = levels[l];
    for (let k = 0; k < N; k++) {
      const top = ring[k][2];
      const y = l === 0 ? lv : l === 1 ? 0 : lv * top;
      const jit = 1 + 0.01 * n.get(k * 1.7, l * 3.1, 0);
      pos.push(ring[k][0] * sc * jit, y + (l > 1 && l < levels.length - 1 ? n.get(k, l, 1) * 2.5 : 0), ring[k][1] * sc * jit);
    }
  }
  for (let l = 0; l < levels.length - 1; l++)
    for (let k = 0; k < N; k++) {
      const p0 = l * N + k;
      const p1 = l * N + ((k + 1) % N);
      const q0 = (l + 1) * N + k;
      const q1 = (l + 1) * N + ((k + 1) % N);
      idx.push(p0, q0, p1, p1, q0, q1);
    }
  // The top: an inner ring and a centre line of snow.
  const topL = levels.length - 1;
  const inner = pos.length / 3;
  for (let k = 0; k < N; k++) pos.push(ring[k][0] * 0.7, ring[k][2] + 2 + n.get(k * 0.3, 9, 0) * 2, ring[k][1] * 0.6);
  const centre = pos.length / 3;
  pos.push(0, h * 0.95 + 3, 0);
  for (let k = 0; k < N; k++) {
    const o0 = topL * N + k;
    const o1 = topL * N + ((k + 1) % N);
    const i0 = inner + k;
    const i1 = inner + ((k + 1) % N);
    idx.push(o0, i0, o1, o1, i0, i1);
    idx.push(i0, centre, i1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  paint(geo, (x, y, z, _nx, ny) => {
    const v = n.get(x * 0.05, y * 0.02, z * 0.05);
    if (ny > 0.55 && y > h * 0.8) return mixC(ICE_TOP, srgb(255, 252, 246), 0.5 + v * 0.3);
    // Old layers of ice: bands of white and blue down the cliff.
    const band = 0.5 + 0.5 * Math.sin(y * 0.22 + n.get(x * 0.01, 0, z * 0.01) * 3);
    let c = mixC(ICE_SIDE, ICE_TOP, smooth(0, h, y) * 0.5 + band * 0.25 + v * 0.15);
    c = mixC(c, ICE_DEEP, smooth(h * 0.3, 0, y) * 0.5 + (1 - band) * 0.12);
    if (y < 5 && y > -8) c = mixC(c, ICE_NOTCH, 0.55);
    return c;
  });
  const parts: THREE.BufferGeometry[] = [facet(geo)];
  const penguins = 4 + Math.floor(r() * 8);
  for (let i = 0; i < penguins; i++) {
    const px = (r() - 0.5) * a * 1.4;
    const pz = b * (0.15 + r() * 0.4);
    const top = h * (0.9 + 0.08 * n.get(px * 0.012, 4, 0) + 0.05 * Math.sign(n.get(px * 0.006, 9, 0))) + 1.5;
    parts.push(penguin(px, top, pz, 1.1 + r() * 0.3, (r() - 0.5) * 1.6));
  }
  const out = merge(parts);
  out.computeBoundingSphere();
  return { geo: out, height: h };
}

// ------------------------------------------------------------------ island

const SAND = srgb(196, 172, 122);
const GRASS = srgb(104, 124, 58);
const FOREST = srgb(58, 84, 40);
const CLIFF = srgb(104, 92, 76);
const TRUNK = srgb(70, 50, 32);
const WHITE = srgb(232, 228, 216);
const RED = srgb(150, 36, 30);
const STONEWALL = srgb(150, 136, 112);

export interface IslandModel {
  land: THREE.BufferGeometry;
  trees: THREE.BufferGeometry;
  stone: THREE.BufferGeometry | null;
  /** Lamp of a lighthouse (local position), if there is one. */
  lamp: THREE.Vector3 | null;
  flag: THREE.Vector3 | null;
  height: number;
}

/** An island: rocky shores and beaches, hills under trees and palms, perhaps a Society lighthouse or a fort. */
export function islandModel(shape: number, vr: number): IslandModel {
  const r = rng(shape);
  const n = new Noise3(shape);
  const Hmax = Math.min(110, vr * (0.38 + r() * 0.18));
  const peaks = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ x: (r() - 0.5) * 0.9, z: (r() - 0.5) * 0.7, s: 0.28 + r() * 0.2, h: 0.6 + r() * 0.4 }));
  const coast = (th: number) => vr * (0.97 + 0.09 * n.get(Math.cos(th) * 1.4, Math.sin(th) * 1.4, 0.5) + 0.04 * n.get(Math.cos(th) * 4, Math.sin(th) * 4, 2));
  const heightAt = (qx: number, qz: number) => {
    const q = Math.hypot(qx, qz);
    let hgt = 0;
    for (const p of peaks) hgt = Math.max(hgt, p.h * Math.exp(-((qx - p.x) ** 2 + (qz - p.z) ** 2) / (2 * p.s * p.s)));
    hgt += 0.12 * n.get(qx * 3, 0, qz * 3) + 0.05 * n.get(qx * 9, 1, qz * 9);
    hgt = Math.max(0.02, hgt);
    const shore = smooth(1.0, 0.8, q);
    return (0.06 + hgt * shore) * Hmax * smooth(1.06, 0.92, q) - 10 * smooth(0.98, 1.1, q);
  };
  const RN = 18;
  const SN = 64;
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(0, heightAt(0, 0), 0);
  for (let j = 1; j <= RN; j++) {
    const q = (j / RN) * 1.12;
    for (let k = 0; k < SN; k++) {
      const th = (k / SN) * Math.PI * 2;
      const c = coast(th);
      const qx = Math.cos(th) * q;
      const qz = Math.sin(th) * q;
      pos.push(qx * c, heightAt(qx, qz), qz * c);
    }
  }
  for (let k = 0; k < SN; k++) idx.push(0, 1 + ((k + 1) % SN), 1 + k);
  for (let j = 1; j < RN; j++)
    for (let k = 0; k < SN; k++) {
      const a = 1 + (j - 1) * SN + k;
      const b = 1 + (j - 1) * SN + ((k + 1) % SN);
      const c = 1 + j * SN + k;
      const d = 1 + j * SN + ((k + 1) % SN);
      idx.push(a, b, c, b, d, c);
    }
  const land = new THREE.BufferGeometry();
  land.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  land.setIndex(idx);
  land.computeVertexNormals();
  paint(land, (x, y, z, _nx, ny) => {
    const v = n.get(x * 0.04, y * 0.04, z * 0.04);
    if (y < 5 + v * 3) return mixC(SAND, CLIFF, smooth(0.95, 0.7, ny) * 0.6);
    let c = mixC(GRASS, FOREST, 0.5 + v * 0.5);
    c = mixC(c, CLIFF, smooth(0.82, 0.6, ny));
    return c;
  });

  // Landmarks: a lighthouse (a Society light) or a fort, facing the course.
  const lighthouse = r() < 0.4;
  const fort = !lighthouse && r() < 0.55;
  const stoneParts: THREE.BufferGeometry[] = [];
  let lamp: THREE.Vector3 | null = null;
  let flag: THREE.Vector3 | null = null;
  const lmTh = Math.PI / 2 + (r() - 0.5) * 1.2;
  const lmQ = 0.45 + r() * 0.2;
  const lmX = Math.cos(lmTh) * lmQ;
  const lmZ = Math.sin(lmTh) * lmQ;
  const lmBase = heightAt(lmX, lmZ);
  const lmPos = new THREE.Vector3(lmX * coast(lmTh), lmBase, lmZ * coast(lmTh));
  let height = Hmax;
  if (lighthouse) {
    const tower = Math.min(vr * 0.55, 200 - lmBase - 30, 105);
    const bands = 4;
    for (let i = 0; i < bands; i++) {
      const y0 = (i / bands) * tower;
      const y1 = ((i + 1) / bands) * tower;
      const r0 = 13 - 5 * (i / bands);
      const r1 = 13 - 5 * ((i + 1) / bands);
      const seg = paint(new THREE.CylinderGeometry(r1, r0, y1 - y0, 16, 1, true), i % 2 ? RED : WHITE);
      place(seg, lmPos.x, lmPos.y + (y0 + y1) / 2 - 2, lmPos.z);
      stoneParts.push(seg);
    }
    const plinth = paint(new THREE.CylinderGeometry(17, 19, 10, 16), STONEWALL);
    place(plinth, lmPos.x, lmPos.y + 1, lmPos.z);
    const gallery = paint(new THREE.CylinderGeometry(11.5, 11.5, 2.5, 16), srgb(40, 34, 30));
    place(gallery, lmPos.x, lmPos.y + tower, lmPos.z);
    const roof = paint(new THREE.ConeGeometry(8, 11, 16), srgb(60, 44, 34));
    place(roof, lmPos.x, lmPos.y + tower + 15, lmPos.z);
    stoneParts.push(plinth, gallery, roof);
    lamp = new THREE.Vector3(lmPos.x, lmPos.y + tower + 5.5, lmPos.z);
    height = Math.max(height, lmPos.y + tower + 20);
  } else if (fort) {
    const R0 = vr * 0.24;
    const wallH = 22;
    const sides = 6;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const x0 = lmPos.x + Math.cos(a0) * R0;
      const z0 = lmPos.z + Math.sin(a0) * R0;
      const x1 = lmPos.x + Math.cos(a1) * R0;
      const z1 = lmPos.z + Math.sin(a1) * R0;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = -Math.atan2(z1 - z0, x1 - x0);
      const wall = paint(new THREE.BoxGeometry(len, wallH, 6), STONEWALL);
      place(wall, (x0 + x1) / 2, lmPos.y + wallH / 2 - 4, (z0 + z1) / 2, 0, yaw, 0);
      stoneParts.push(wall);
      // Crenellations.
      for (let m = 0; m < 4; m++) {
        const t = (m + 0.5) / 4;
        const merlon = paint(new THREE.BoxGeometry(len / 9, 5, 6.5), STONEWALL);
        place(merlon, x0 + (x1 - x0) * t, lmPos.y + wallH - 1.5, z0 + (z1 - z0) * t, 0, yaw, 0);
        stoneParts.push(merlon);
      }
      const tower = paint(new THREE.CylinderGeometry(8, 9, wallH + 12, 10), mixC(STONEWALL, CLIFF, 0.3));
      place(tower, x0, lmPos.y + (wallH + 12) / 2 - 4, z0);
      stoneParts.push(tower);
    }
    const keep = paint(new THREE.BoxGeometry(R0 * 0.8, wallH + 18, R0 * 0.8), mixC(STONEWALL, WHITE, 0.2));
    place(keep, lmPos.x, lmPos.y + (wallH + 18) / 2 - 4, lmPos.z);
    const pole = paint(new THREE.CylinderGeometry(0.8, 0.8, 30, 5), TRUNK);
    place(pole, lmPos.x, lmPos.y + wallH + 28, lmPos.z);
    stoneParts.push(keep, pole);
    flag = new THREE.Vector3(lmPos.x, lmPos.y + wallH + 38, lmPos.z);
    height = Math.max(height, lmPos.y + wallH + 45);
  }

  // Trees: broad crowns and conifers on the hills, palms along the shore (stamped from prototypes).
  const stamps: Stamp[] = [];
  const count = Math.round(50 + vr * 0.6);
  const m = new THREE.Matrix4();
  const q4 = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0, tries = 0; i < count && tries < count * 4; tries++) {
    const th = r() * Math.PI * 2;
    const q = Math.sqrt(r()) * 0.92;
    const qx = Math.cos(th) * q;
    const qz = Math.sin(th) * q;
    const x = qx * coast(th);
    const z = qz * coast(th);
    const y = heightAt(qx, qz);
    if (y < 4) continue;
    if ((lighthouse || fort) && Math.hypot(x - lmPos.x, z - lmPos.z) < (fort ? vr * 0.3 : 26)) continue;
    const slope = Math.abs(heightAt(qx + 0.02, qz) - y) + Math.abs(heightAt(qx, qz + 0.02) - y);
    if (slope > 3.2) continue;
    i++;
    const shore = q > 0.72 || y < 12;
    const sc = 0.8 + r() * 0.6;
    const tint = mixC(FOREST, GRASS, r() * 0.6);
    const kind = shore && r() < 0.7 ? 2 : r() < 0.3 ? 1 : 0;
    const lean = kind === 2 ? (r() - 0.5) * 0.5 : (r() - 0.5) * 0.1;
    e.set(0, r() * Math.PI * 2, lean);
    q4.setFromEuler(e);
    m.compose(new THREE.Vector3(x, y - 1, z), q4, new THREE.Vector3(sc, sc * (0.85 + r() * 0.3), sc));
    stamps.push({ proto: treeProtos()[kind], matrix: m.clone(), tint });
  }
  const treeGeo = stamps.length ? stampGeometry(stamps) : new THREE.BufferGeometry();
  return { land, trees: treeGeo, stone: stoneParts.length ? merge(stoneParts) : null, lamp, flag, height };
}

interface Stamp {
  proto: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  /** Replaces the prototype's colour where it is foliage (painted white). */
  tint: THREE.Color;
}

let protos: THREE.BufferGeometry[] | null = null;

/** Tree prototypes (flat-shaded, coloured; white foliage is tinted per tree): broadleaf, conifer, palm. */
function treeProtos(): THREE.BufferGeometry[] {
  if (protos) return protos;
  const LEAF = new THREE.Color(1, 1, 1);
  const broad = (() => {
    const crown = paint(new THREE.IcosahedronGeometry(10, 1), LEAF);
    place(crown, 0, 12, 0, 0.3, 0.2, 0.1, 1, 0.8, 1);
    const crown2 = paint(new THREE.IcosahedronGeometry(6.5, 0), LEAF);
    place(crown2, 5, 16, 3, 0.5, 0.7, 0.2);
    const trunk = paint(new THREE.CylinderGeometry(1, 1.6, 10, 5), TRUNK);
    place(trunk, 0, 4, 0);
    return merge([crown, crown2, trunk].map(facet));
  })();
  const conifer = (() => {
    const c1 = paint(new THREE.ConeGeometry(9, 22, 7), LEAF);
    place(c1, 0, 14, 0);
    const c2 = paint(new THREE.ConeGeometry(6, 15, 7), LEAF);
    place(c2, 0, 24, 0, 0, 0.4, 0);
    const trunk = paint(new THREE.CylinderGeometry(0.9, 1.3, 6, 5), TRUNK);
    place(trunk, 0, 2, 0);
    return merge([c1, c2, trunk].map(facet));
  })();
  const palm = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const trunk = paint(new THREE.CylinderGeometry(0.9, 1.4, 22, 5), TRUNK);
    place(trunk, 0, 11, 0);
    parts.push(trunk);
    for (let f = 0; f < 6; f++) {
      const a = (f / 6) * Math.PI * 2 + f * 0.37;
      const frond = paint(new THREE.ConeGeometry(2.2, 13, 3), LEAF);
      place(frond, Math.cos(a) * 5, 20.5, Math.sin(a) * 5, Math.sin(a) * 1.9, 0, -Math.cos(a) * 1.9, 1, 1, 0.35);
      parts.push(frond);
    }
    return merge(parts.map(facet));
  })();
  protos = [broad, conifer, palm];
  return protos;
}

/** Copies of prototypes, transformed and tinted, written into one geometry (fast: no per-copy geometry objects). */
function stampGeometry(stamps: Stamp[]): THREE.BufferGeometry {
  let total = 0;
  for (const s of stamps) total += s.proto.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let o = 0;
  for (const s of stamps) {
    const P = s.proto.getAttribute('position') as THREE.BufferAttribute;
    const N = s.proto.getAttribute('normal') as THREE.BufferAttribute;
    const Cc = s.proto.getAttribute('color') as THREE.BufferAttribute;
    nm.getNormalMatrix(s.matrix);
    for (let i = 0; i < P.count; i++, o++) {
      v.set(P.getX(i), P.getY(i), P.getZ(i)).applyMatrix4(s.matrix);
      pos[o * 3] = v.x;
      pos[o * 3 + 1] = v.y;
      pos[o * 3 + 2] = v.z;
      v.set(N.getX(i), N.getY(i), N.getZ(i)).applyMatrix3(nm).normalize();
      nor[o * 3] = v.x;
      nor[o * 3 + 1] = v.y;
      nor[o * 3 + 2] = v.z;
      const r = Cc.getX(i);
      const g = Cc.getY(i);
      const b = Cc.getZ(i);
      const leaf = r > 0.9 && g > 0.9 && b > 0.9;
      col[o * 3] = leaf ? s.tint.r : r;
      col[o * 3 + 1] = leaf ? s.tint.g : g;
      col[o * 3 + 2] = leaf ? s.tint.b : b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// ------------------------------------------------------------------ hull (ship and wrecks)

const PLANK = srgb(150, 104, 60);
const PLANK_DARK = srgb(92, 60, 32);
const HULL_BELOW = srgb(46, 54, 40);
const GOLD_TRIM = srgb(200, 160, 70);

export interface HullOpts {
  length: number;
  beam: number;
  /** Below the waterline at the keel, and the rail's height above it amidships. */
  draft: number;
  freeboard: number;
  /** Extra height of the stern castle and the forecastle. */
  stern: number;
  bow: number;
  /** Only part of the hull (0 = bow, 1 = stern): for a ship broken in two. */
  from?: number;
  to?: number;
  stripes?: boolean;
}

/** A lofted wooden hull: pointed bow at −z, flat transom at +z. Returns hull + deck. */
export function hullGeometry(o: HullOpts): THREE.BufferGeometry {
  const stations = 22;
  const around = 14;
  const from = o.from ?? 0;
  const to = o.to ?? 1;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const halfW = (s: number) => {
    // Fine at the bow, full amidships, broad at the transom.
    const bow = Math.sin(Math.min(1, s / 0.55) * Math.PI * 0.5) ** 0.8;
    const sternTaper = 1 - 0.18 * smooth(0.75, 1, s);
    return (o.beam / 2) * Math.max(0.02, bow * sternTaper);
  };
  const rail = (s: number) => o.freeboard + o.stern * smooth(0.72, 0.95, s) + o.bow * smooth(0.25, 0.0, s);
  const keel = (s: number) => -o.draft * (0.35 + 0.65 * Math.sin(Math.min(1, (s + 0.05) / 0.4) * Math.PI * 0.5)) * (1 - 0.15 * smooth(0.85, 1, s));
  const zAt = (s: number) => -o.length / 2 + s * o.length;
  for (let i = 0; i <= stations; i++) {
    const s = from + (to - from) * (i / stations);
    const w = halfW(s);
    const top = rail(s);
    const bot = keel(s);
    for (let j = 0; j <= around; j++) {
      // From the port rail, down round the keel, up to the starboard rail.
      const a = (j / around) * Math.PI - Math.PI / 2;
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const x = w * sa * (1 + 0.08 * ca);
      const yy = top - (top - bot) * Math.pow(ca, 0.6);
      pos.push(x, yy, zAt(s));
      let c: C = yy < 1 ? HULL_BELOW : mixC(PLANK_DARK, PLANK, 0.5 + 0.5 * Math.sin(yy * 1.3));
      if (o.stripes !== false && yy > top - 2.2) c = GOLD_TRIM;
      else if (o.stripes !== false && Math.abs(yy - top * 0.45) < 1.2) c = srgb(30, 22, 14);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < stations; i++)
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j;
      const b = a + 1;
      const c = a + around + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  // Deck: a strip between the rails, a little below them.
  const deckStart = pos.length / 3;
  for (let i = 0; i <= stations; i++) {
    const s = from + (to - from) * (i / stations);
    const w = halfW(s) * 0.97;
    const y = rail(s) - 2.5;
    pos.push(-w, y, zAt(s), w, y, zAt(s));
    const c = mixC(srgb(150, 112, 70), srgb(120, 88, 54), i % 2);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  for (let i = 0; i < stations; i++) {
    const a = deckStart + i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  // Transom (when the stern is included): a flat panel.
  if (to >= 0.999) {
    const base = (stations) * (around + 1);
    const cIdx = pos.length / 3;
    const s = 1;
    pos.push(0, (rail(s) + keel(s)) / 2, zAt(s));
    col.push(PLANK_DARK.r, PLANK_DARK.g, PLANK_DARK.b);
    for (let j = 0; j < around; j++) idx.push(cIdx, base + j + 1, base + j);
  }
  if (from <= 0.001) {
    // nothing: the bow closes to a point.
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ debris

const BARREL = srgb(118, 78, 42);
const HOOP = srgb(40, 34, 30);
const SAILCLOTH = srgb(214, 200, 166);

/** Wreckage: barrels, a lashed raft of planks, or a broken mast with a scrap of sail. Size ≈ 1 (scale by vr). */
export function debrisGeometry(variant: number): THREE.BufferGeometry {
  const r = rng(0xdeb + variant * 131);
  const kind = variant % 3;
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 0) {
    const barrel = (x: number, z: number, s: number, yaw: number, upright: boolean) => {
      const body = paint(new THREE.CylinderGeometry(0.4 * s, 0.4 * s, 0.95 * s, 12, 4), BARREL);
      const p = body.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i) / (0.95 * s);
        const bulge = 1 + 0.18 * (1 - 4 * y * y);
        p.setX(i, p.getX(i) * bulge);
        p.setZ(i, p.getZ(i) * bulge);
      }
      body.computeVertexNormals();
      const h1 = paint(new THREE.TorusGeometry(0.44 * s, 0.035 * s, 4, 14), HOOP);
      place(h1, 0, 0.3 * s, 0, Math.PI / 2, 0, 0);
      const h2 = paint(new THREE.TorusGeometry(0.44 * s, 0.035 * s, 4, 14), HOOP);
      place(h2, 0, -0.3 * s, 0, Math.PI / 2, 0, 0);
      const g = merge([body, h1, h2]);
      if (upright) place(g, x, 0.25 * s, z, 0.15, yaw, 0.1);
      else place(g, x, 0.18 * s, z, 0, yaw, Math.PI / 2);
      parts.push(g);
    };
    barrel(-0.25, 0.1, 1.1, r() * 3, false);
    barrel(0.5, -0.25, 0.85, r() * 3, r() < 0.5);
    if (r() < 0.6) barrel(-0.6, -0.5, 0.7, r() * 3, true);
  } else if (kind === 1) {
    const planks = 5 + Math.floor(r() * 3);
    for (let i = 0; i < planks; i++) {
      const len = 1.6 + r() * 0.6;
      const p = paint(new THREE.BoxGeometry(len, 0.12, 0.26), mixC(PLANK_DARK, PLANK, r()));
      place(p, (r() - 0.5) * 0.2, 0.05 + r() * 0.05, -0.65 + i * 0.27, (r() - 0.5) * 0.1, (r() - 0.5) * 0.25, (r() - 0.5) * 0.08);
      parts.push(p);
    }
    for (const x of [-0.5, 0.5]) {
      const cross = paint(new THREE.BoxGeometry(0.18, 0.1, 1.9), PLANK_DARK);
      place(cross, x, 0.16, 0, 0, (r() - 0.5) * 0.2, 0);
      parts.push(cross);
    }
    if (r() < 0.7) {
      const crate = paint(new THREE.BoxGeometry(0.55, 0.45, 0.5), mixC(PLANK, SAILCLOTH, 0.2));
      place(crate, (r() - 0.5) * 0.6, 0.42, (r() - 0.5) * 0.5, 0, r() * 2, 0.1);
      parts.push(crate);
    }
  } else {
    const mast = paint(new THREE.CylinderGeometry(0.13, 0.17, 2.4, 8), PLANK_DARK);
    place(mast, 0, 0.12, 0, Math.PI / 2, 0, 0, 1);
    place(mast, 0, 0, 0, 0, r() * 1.2 - 0.6 + Math.PI / 2, 0.15);
    const yard = paint(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 6), PLANK_DARK);
    place(yard, 0.2, 0.15, 0.3, Math.PI / 2, 0.9, 0);
    const sail = paint(new THREE.PlaneGeometry(1.2, 0.9, 4, 3), SAILCLOTH);
    const sp = sail.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) sp.setZ(i, Math.sin(sp.getX(i) * 3 + sp.getY(i) * 2) * 0.12);
    sail.computeVertexNormals();
    place(sail, -0.1, 0.12, 0.35, -Math.PI / 2 + 0.25, 0, 0.3);
    parts.push(mast, yard, sail);
  }
  const g = merge(parts);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ wreck

export interface WreckModel {
  wood: THREE.BufferGeometry;
  cloth: THREE.BufferGeometry;
  height: number;
}

/** A wrecked galleon, broken in two and listing, its masts snapped, rags of sail hanging. */
export function wreckModel(shape: number, vr: number): WreckModel {
  const r = rng(shape);
  const L = vr * 2.0;
  const opts: HullOpts = { length: L, beam: vr * 0.62, draft: vr * 0.2, freeboard: vr * 0.26, stern: vr * 0.16, bow: vr * 0.08 };
  const yaw = (r() < 0.5 ? -1 : 1) * (0.45 + r() * 0.3);
  const bowPart = hullGeometry({ ...opts, from: 0, to: 0.52 });
  const sternPart = hullGeometry({ ...opts, from: 0.58, to: 1 });
  // Each half lists and sinks by the head where it broke.
  place(bowPart, 0, -vr * 0.08, L * 0.04, 0.12, 0, 0.42 * (r() < 0.5 ? 1 : -1));
  place(sternPart, 0, -vr * 0.06, -L * 0.04, -0.1, 0.18, -0.35);
  const wood: THREE.BufferGeometry[] = [bowPart, sternPart];
  // Exposed ribs at the break.
  for (let i = 0; i < 4; i++) {
    const rib = paint(new THREE.TorusGeometry(vr * 0.26, vr * 0.018, 4, 10, Math.PI), PLANK_DARK);
    place(rib, 0, vr * 0.05, -L * 0.02 + i * vr * 0.06, 0, 0, Math.PI + 0.3 * (r() - 0.5));
    wood.push(rib);
  }
  // Masts: one standing but snapped, one fallen across the water.
  const m1h = vr * (0.85 + r() * 0.4);
  const mast1 = paint(new THREE.CylinderGeometry(vr * 0.025, vr * 0.035, m1h, 8), PLANK_DARK);
  place(mast1, -L * 0.18, m1h / 2, 0, 0.12, 0, -0.32);
  const yard1 = paint(new THREE.CylinderGeometry(vr * 0.015, vr * 0.015, vr * 0.7, 6), PLANK_DARK);
  place(yard1, -L * 0.18 - Math.sin(0.32) * m1h * 0.7, m1h * 0.72, 0, 0, 0.3, Math.PI / 2 - 0.5);
  const mast2 = paint(new THREE.CylinderGeometry(vr * 0.025, vr * 0.03, vr * 1.1, 8), PLANK_DARK);
  place(mast2, L * 0.2, vr * 0.04, vr * 0.25, Math.PI / 2 - 0.1, 0.7, 0);
  wood.push(mast1, yard1, mast2);
  const woodGeo = merge(wood);
  place(woodGeo, 0, 0, 0, 0, yaw, 0);
  // Rags of sail on the standing mast.
  const sail = paint(new THREE.PlaneGeometry(vr * 0.55, vr * 0.42, 6, 5), SAILCLOTH);
  const sp = sail.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i);
    const y = sp.getY(i);
    sp.setZ(i, Math.sin(x * 0.08) * vr * 0.06 + Math.cos(y * 0.1) * vr * 0.03);
    // Tattered lower edge.
    if (y < -vr * 0.12) sp.setY(i, y + (r() - 0.2) * vr * 0.12);
  }
  sail.computeVertexNormals();
  place(sail, -L * 0.18 - Math.sin(0.32) * m1h * 0.55, m1h * 0.52, 0, 0.1, 0.3, -0.42);
  place(sail, 0, 0, 0, 0, yaw, 0);
  woodGeo.computeBoundingSphere();
  return { wood: woodGeo, cloth: sail, height: m1h };
}

// ------------------------------------------------------------------ the sea gate

/**
 * Height (world units) of a sea gate's pillars; the arch springs from their tops. The ship's masthead passes beneath
 * it, and the camera sails over it.
 */
export const PILLAR_HEIGHT = 156;
const MARBLE = srgb(206, 194, 168);
const MARBLE_DARK = srgb(150, 138, 116);

/** A pillar of a Society sea gate: plinth, fluted shaft with gilded bands, capital. */
export function pillarGeometry(variant: number): THREE.BufferGeometry {
  const r = rng(0x9a7e + variant);
  const parts: THREE.BufferGeometry[] = [];
  const plinth = paint(new THREE.BoxGeometry(70, 26, 70), mixC(MARBLE_DARK, MARBLE, 0.3));
  place(plinth, 0, 4, 0);
  const base = paint(new THREE.CylinderGeometry(33, 36, 10, 24), MARBLE);
  place(base, 0, 21, 0);
  const shaftH = PILLAR_HEIGHT - 26 - 16;
  const shaft = new THREE.CylinderGeometry(25, 28.5, shaftH, 32, 8);
  const sp = shaft.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i);
    const z = sp.getZ(i);
    const a = Math.atan2(z, x);
    const flute = 1 - 0.05 * Math.max(0, Math.cos(a * 16));
    sp.setX(i, x * flute);
    sp.setZ(i, z * flute);
  }
  shaft.computeVertexNormals();
  paint(shaft, (_x, y) => mixC(MARBLE_DARK, MARBLE, smooth(-shaftH / 2, shaftH / 2, y) * 0.6 + 0.4 + (r() - 0.5) * 0.05));
  place(shaft, 0, 26 + shaftH / 2, 0);
  const cap1 = paint(new THREE.CylinderGeometry(34, 26, 9, 24), MARBLE);
  place(cap1, 0, PILLAR_HEIGHT - 12, 0);
  const cap2 = paint(new THREE.BoxGeometry(74, 9, 74), MARBLE);
  place(cap2, 0, PILLAR_HEIGHT - 3.5, 0);
  parts.push(plinth, base, shaft, cap1, cap2);
  const g = merge(parts);
  g.computeBoundingSphere();
  return g;
}

/** Gilded bands on a pillar (separate, for the gold material). */
export function pillarBands(): THREE.BufferGeometry {
  const a = new THREE.TorusGeometry(28.6, 2.2, 6, 32);
  place(a, 0, 40, 0, Math.PI / 2, 0, 0);
  const b = new THREE.TorusGeometry(26, 2.2, 6, 32);
  place(b, 0, PILLAR_HEIGHT - 20, 0, Math.PI / 2, 0, 0);
  return merge([a, b]);
}

/** The arch of a sea gate, spanning `span` between pillar centres; local origin midway, at the water. */
export function archGeometry(span: number): { stone: THREE.BufferGeometry; gold: THREE.BufferGeometry; keystone: THREE.Vector3 } {
  const rise = span * 0.08 + 6;
  const thick = 22;
  const depth = 46;
  const segs = 22;
  const spring = PILLAR_HEIGHT;
  const half = span / 2;
  const curve = (t: number) => new THREE.Vector2(-half + t * span, spring + Math.sin(Math.PI * t) * rise);
  const stone: THREE.BufferGeometry[] = [];
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const p0 = curve(t0);
    const p1 = curve(t1);
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const len = p0.distanceTo(p1) * 1.02;
    const key = i === Math.floor(segs / 2) || i === Math.floor(segs / 2) - 1;
    const block = paint(new THREE.BoxGeometry(len, thick + (key ? 6 : 0), depth + (key ? 6 : 0)), i % 2 ? MARBLE : mixC(MARBLE, MARBLE_DARK, 0.35));
    place(block, mid.x, mid.y + thick / 2 - 2, 0, 0, 0, ang);
    stone.push(block);
  }
  // A cornice along the top.
  const top = curve(0.5);
  const keystone = new THREE.Vector3(0, top.y + thick / 2, depth / 2 + 4);
  const seal = new THREE.CylinderGeometry(13, 13, 3, 28);
  place(seal, 0, top.y + thick / 2, depth / 2 + 3.5, Math.PI / 2, 0, 0);
  const ring = new THREE.TorusGeometry(9, 1.3, 6, 24);
  place(ring, 0, top.y + thick / 2, depth / 2 + 5.2);
  const spokes: THREE.BufferGeometry[] = [seal, ring];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const sp = new THREE.BoxGeometry(1.4, 5, 1.4);
    place(sp, Math.cos(a) * 5.5, top.y + thick / 2 + Math.sin(a) * 5.5, depth / 2 + 5.4, 0, 0, a + Math.PI / 2);
    spokes.push(sp);
  }
  return { stone: merge(stone), gold: merge(spokes), keystone };
}

// ------------------------------------------------------------------ the Colossus

/** Height of the Colossus's hips above the water: the ship (and the camera) sail between its legs, beneath. */
export const COLOSSUS_HIP = 330;
const VERDIGRIS = srgb(80, 140, 120);
const VERDIGRIS_DARK = srgb(36, 70, 60);
const BRONZE = srgb(130, 96, 52);

export interface ColossusModel {
  bronze: THREE.BufferGeometry;
  gold: THREE.BufferGeometry;
  stone: THREE.BufferGeometry;
  /** Where the lantern burns (local). */
  lantern: THREE.Vector3;
  height: number;
}

/**
 * The Colossus of the Society, standing astride the gap: bronze gone green, a lantern raised towards the Edge, the
 * disc of the world on its shield. `half` is the distance from the centre to each foot.
 */
export function colossusModel(half: number, seed: number): ColossusModel {
  const n = new Noise3(seed);
  const hipX = Math.max(half * 0.5, 40);
  const shoulderX = hipX + 72;
  const HIP = COLOSSUS_HIP;
  const bronze: THREE.BufferGeometry[] = [];
  const gold: THREE.BufferGeometry[] = [];
  const stone: THREE.BufferGeometry[] = [];
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  for (const side of [-1, 1]) {
    const fx = side * half;
    const plinth = paint(new THREE.BoxGeometry(96, 34, 96), STONEWALL);
    place(plinth, fx, 7, 0);
    const plinthTop = paint(new THREE.BoxGeometry(84, 6, 84), mixC(STONEWALL, WHITE, 0.25));
    place(plinthTop, fx, 27, 0);
    stone.push(plinth, plinthTop);
    const band = new THREE.BoxGeometry(98, 5, 98);
    place(band, fx, 14, 0);
    gold.push(band);
    // Sandalled foot, then the leg: ankle, calf, knee, thigh, hip.
    const foot = paint(new THREE.SphereGeometry(1, 14, 8), VERDIGRIS);
    place(foot, fx, 38, 10, 0, 0, 0, 24, 11, 42);
    bronze.push(foot);
    const knee = V(side * (half * 0.74 + hipX * 0.26), 180, 12);
    const leg = taperedTube(
      [V(fx, 34, 0), V(fx + (knee.x - fx) * 0.35, 80, 4), V(fx + (knee.x - fx) * 0.7, 130, 10), knee, V(side * (hipX + (knee.x / side - hipX) * 0.45), 260, 8), V(side * hipX, HIP + 14, 0)],
      [20, 25, 28, 25, 36, 40],
      16,
    );
    bronze.push(paint(leg, VERDIGRIS));
    // Greaves with gilded rims.
    const greave = new THREE.TorusGeometry(27, 3, 6, 22);
    place(greave, fx + (knee.x - fx) * 0.55, 108, 7, Math.PI / 2, 0, 0);
    gold.push(greave);
    const strap = new THREE.TorusGeometry(22, 2.4, 5, 18);
    place(strap, fx, 46, 2, Math.PI / 2, 0, 0);
    gold.push(strap);
  }
  // Kilt of hanging bronze strips (pteruges) on a belt of gold.
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const rx = hipX + 40;
    const rz = 44;
    const strip = paint(new THREE.BoxGeometry(18, 74, 5), i % 2 ? VERDIGRIS : mixC(VERDIGRIS, VERDIGRIS_DARK, 0.45));
    place(strip, Math.cos(a) * rx, HIP + 34, Math.sin(a) * rz, 0.12 * Math.sin(a), -a + Math.PI / 2, 0.1 * Math.cos(a));
    bronze.push(strip);
  }
  const belt = new THREE.CylinderGeometry(hipX + 34, hipX + 34, 12, 30);
  place(belt, 0, HIP + 74, 0, 0, 0, 0, 1, 1, 0.58);
  gold.push(belt);
  // The torso: a loft of ellipses, narrow at the waist, broad across the chest and shoulders.
  const sections: [number, number, number, number][] = [
    // y, half-width, half-depth, forward offset
    [HIP + 60, hipX + 30, 40, 0],
    [HIP + 100, hipX + 36, 46, 4],
    [HIP + 145, shoulderX - 22, 56, 8],
    [HIP + 180, shoulderX - 6, 56, 6],
    [HIP + 200, shoulderX - 10, 50, 2],
    [HIP + 214, shoulderX - 40, 40, 0],
    [HIP + 222, 34, 28, 0],
  ];
  {
    const segs = 28;
    const pos: number[] = [];
    const idx: number[] = [];
    for (const [y, rx, rz, off] of sections)
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const front = Math.max(0, Math.sin(a));
        // Pectorals and the line of the abdomen on the front.
        const pec = y > HIP + 120 && y < HIP + 190 ? 1 + 0.06 * front * Math.abs(Math.cos(a * 2)) : 1;
        pos.push(Math.cos(a) * rx * pec, y, Math.sin(a) * rz * pec + off * front);
      }
    for (let j = 0; j < sections.length - 1; j++)
      for (let i = 0; i < segs; i++) {
        const a = j * segs + i;
        const b = j * segs + ((i + 1) % segs);
        const c = (j + 1) * segs + i;
        const d = (j + 1) * segs + ((i + 1) % segs);
        idx.push(a, c, b, b, c, d);
      }
    const torso = new THREE.BufferGeometry();
    torso.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    torso.setIndex(idx);
    torso.computeVertexNormals();
    paint(torso, VERDIGRIS);
    bronze.push(torso);
  }
  // Breastplate emblem: the disc of the world with eight rays.
  const chest = new THREE.TorusGeometry(24, 3, 6, 28);
  place(chest, 0, HIP + 162, 62);
  gold.push(chest);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const ray = new THREE.BoxGeometry(2.6, 13, 2.6);
    place(ray, Math.cos(a) * 13, HIP + 162 + Math.sin(a) * 13, 63, 0, 0, a + Math.PI / 2);
    gold.push(ray);
  }
  // Shoulders (deltoids), neck, head with a laurel crown.
  for (const side of [-1, 1]) {
    const sh = paint(new THREE.SphereGeometry(1, 16, 12), VERDIGRIS);
    place(sh, side * (shoulderX - 4), HIP + 196, 0, 0, 0, side * 0.3, 32, 28, 34);
    bronze.push(sh);
  }
  const neck = paint(new THREE.CylinderGeometry(19, 23, 40, 16), VERDIGRIS);
  place(neck, 0, HIP + 236, 2);
  const head = paint(new THREE.SphereGeometry(1, 22, 16), VERDIGRIS);
  place(head, 0, HIP + 276, 6, 0, 0, 0, 27, 34, 31);
  const jaw = paint(new THREE.SphereGeometry(1, 14, 10), VERDIGRIS);
  place(jaw, 0, HIP + 258, 14, 0, 0, 0, 20, 16, 22);
  const nose = paint(new THREE.ConeGeometry(5, 15, 6), VERDIGRIS);
  place(nose, 0, HIP + 274, 37, Math.PI / 2 + 0.35, 0, 0);
  const brow = paint(new THREE.BoxGeometry(34, 5, 8), VERDIGRIS_DARK);
  place(brow, 0, HIP + 286, 30, 0.2, 0, 0);
  bronze.push(neck, head, jaw, nose, brow);
  const laurel = new THREE.TorusGeometry(30, 3.5, 6, 30, Math.PI * 1.5);
  place(laurel, 0, HIP + 292, 4, Math.PI / 2 - 0.12, 0, Math.PI * 0.75);
  gold.push(laurel);
  for (let i = 0; i < 14; i++) {
    const a = Math.PI * 0.75 + (i / 13) * Math.PI * 1.5;
    const leaf = new THREE.SphereGeometry(1, 6, 4);
    place(leaf, Math.cos(a) * 30, HIP + 296 + (i % 2) * 3, 4 + Math.sin(a) * 30, 0, -a, 0.7, 3.2, 1.8, 8);
    gold.push(leaf);
  }
  // Port arm holds the shield; starboard arm raises the lantern towards the Edge.
  const sL = V(-(shoulderX + 2), HIP + 190, 2);
  const eL = V(-(shoulderX + 26), HIP + 112, 30);
  const hL = V(-(shoulderX + 10), HIP + 70, 62);
  bronze.push(paint(taperedTube([sL, V(-(shoulderX + 16), HIP + 150, 14), eL, hL], [28, 25, 20, 16], 14), VERDIGRIS));
  const shieldC = V(hL.x - 4, hL.y + 4, hL.z + 20);
  const shield = paint(new THREE.CylinderGeometry(72, 72, 10, 40), mixC(VERDIGRIS, VERDIGRIS_DARK, 0.25));
  place(shield, shieldC.x, shieldC.y, shieldC.z, Math.PI / 2, 0.3, 0);
  bronze.push(shield);
  const rim = new THREE.TorusGeometry(71, 5, 6, 44);
  place(rim, shieldC.x, shieldC.y, shieldC.z + 4, 0, 0.3, 0);
  gold.push(rim);
  const ice = paint(new THREE.TorusGeometry(54, 3.5, 6, 44), srgb(232, 238, 234));
  place(ice, shieldC.x + 1.5, shieldC.y, shieldC.z + 6, 0, 0.3, 0);
  stone.push(ice);
  const star = new THREE.Shape();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rr = i % 2 === 0 ? 40 : 14;
    if (i === 0) star.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else star.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  const starG = new THREE.ExtrudeGeometry(star, { depth: 4, bevelEnabled: false });
  place(starG, shieldC.x + 1.5, shieldC.y, shieldC.z + 6, 0, 0.3, 0);
  gold.push(starG);
  const sR = V(shoulderX + 2, HIP + 192, 2);
  const eR = V(shoulderX + 34, HIP + 280, 12);
  const hR = V(shoulderX + 26, HIP + 372, 20);
  bronze.push(paint(taperedTube([sR, V(shoulderX + 22, HIP + 236, 6), eR, hR], [28, 25, 20, 16], 14), VERDIGRIS));
  const fist = paint(new THREE.SphereGeometry(18, 12, 10), VERDIGRIS);
  place(fist, hR.x, hR.y, hR.z);
  bronze.push(fist);
  const cage = new THREE.CylinderGeometry(13, 15, 30, 6, 1, true);
  place(cage, hR.x, hR.y + 32, hR.z);
  const cap = new THREE.ConeGeometry(17, 15, 6);
  place(cap, hR.x, hR.y + 55, hR.z);
  const ring = new THREE.TorusGeometry(4, 1.2, 4, 10);
  place(ring, hR.x, hR.y + 65, hR.z);
  gold.push(cage, cap, ring);
  const lantern = V(hR.x, hR.y + 32, hR.z);

  const bronzeGeo = merge(bronze);
  // Patina: verdigris streaked down from the shoulders, bronze showing through where it is worn.
  const col = bronzeGeo.getAttribute('color') as THREE.BufferAttribute;
  const p = bronzeGeo.getAttribute('position') as THREE.BufferAttribute;
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    tmp.setRGB(col.getX(i), col.getY(i), col.getZ(i));
    const streak = n.get(x * 0.05, y * 0.006, z * 0.05);
    const wear = n.get(x * 0.02 + 4, y * 0.02, z * 0.02);
    tmp.lerp(VERDIGRIS_DARK, clamp(0.3 + streak * 0.5, 0, 0.65));
    if (wear > 0.42) tmp.lerp(BRONZE, Math.min(0.85, (wear - 0.42) * 1.8));
    col.setXYZ(i, tmp.r, tmp.g, tmp.b);
  }
  bronzeGeo.computeBoundingSphere();
  return { bronze: bronzeGeo, gold: merge(gold), stone: merge(stone), lantern, height: hR.y + 70 };
}

// ------------------------------------------------------------------ the leviathan

const SKIN = srgb(138, 56, 104);
const SKIN_DARK = srgb(58, 18, 46);
const SKIN_SPOT = srgb(204, 136, 170);

export interface LeviathanModel {
  head: THREE.BufferGeometry;
  /** Eye centres (local) and radius. */
  eyes: THREE.Vector3[];
  eyeR: number;
  height: number;
}

/** The leviathan: a kraken's great head breaking the surface, ridged and mottled. `r` is its collision radius. */
export function leviathanModel(r: number, seed: number): LeviathanModel {
  const n = new Noise3(seed);
  const W = r * 1.5;
  const H = r * 1.6;
  const geo = weld(new THREE.SphereGeometry(1, 48, 32));
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  const tilt = ((seed % 7) - 3) * 0.03;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i);
    let y = p.getY(i);
    let z = p.getZ(i);
    // The mantle sweeps back (away from the camera, −z) and up.
    const back = Math.max(0, -z);
    y = y * H * (1 + 0.25 * back * Math.max(0, y));
    z = z * W * (0.9 + 0.5 * back);
    x = x * W * (1 - 0.15 * back);
    // Ridges and wrinkles.
    const ridge = n.ridged(x * 0.03, y * 0.03, z * 0.03, 3);
    const s = 1 + 0.06 * ridge + 0.02 * n.get(x * 0.12, y * 0.12, z * 0.12);
    x = x * s + tilt * y;
    z *= s;
    y = y * s - H * 0.12;
    p.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  paint(geo, (x, y, z, _nx, ny) => {
    const v = n.get(x * 0.08, y * 0.08, z * 0.08);
    let c = mixC(SKIN_DARK, SKIN, smooth(-H * 0.2, H * 0.6, y) * 0.8 + ny * 0.2);
    if (n.get(x * 0.21, y * 0.21, z * 0.21) > 0.45) c = mixC(c, SKIN_SPOT, 0.6);
    c = mixC(c, SKIN_DARK, smooth(0.2, -0.3, v) * 0.4);
    return c;
  });
  const eyeR = r * 0.2;
  const eyes = [-1, 1].map((sd) => new THREE.Vector3(sd * W * 0.4 + tilt * H * 0.4, H * 0.38, W * 0.78));
  // Brow ridges.
  const brows: THREE.BufferGeometry[] = [geo];
  for (const e of eyes) {
    const brow = paint(new THREE.SphereGeometry(1, 12, 8), SKIN_DARK);
    place(brow, e.x * 1.02, e.y + eyeR * 1.15, e.z - eyeR * 0.2, 0.2, 0, -Math.sign(e.x) * 0.35, eyeR * 1.7, eyeR * 0.55, eyeR * 1.1);
    brows.push(brow);
  }
  const head = merge(brows);
  head.computeBoundingSphere();
  return { head, eyes, eyeR, height: H };
}

// ------------------------------------------------------------------ the player's ship

export interface ShipModel {
  wood: THREE.BufferGeometry;
  gold: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  windows: THREE.BufferGeometry;
  lantern: THREE.Vector3;
  mastTop: THREE.Vector3;
  /** Sails: [main course, topsail, jib] with their rest geometry. */
  sails: { geo: THREE.BufferGeometry; w: number; h: number; belly: number; at: THREE.Vector3 }[];
  rigging: THREE.BufferGeometry;
}

/** The explorer's vessel: hull, stern castle with lit windows, a mast with two square sails and a jib. */
export function shipModel(): ShipModel {
  const L = 96;
  const B = 50;
  const hull = hullGeometry({ length: L, beam: B, draft: 13, freeboard: 18, stern: 14, bow: 7 });
  const wood: THREE.BufferGeometry[] = [hull];
  const gold: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  // Stern castle: a raised cabin across the stern.
  const cabin = paint(new THREE.BoxGeometry(B * 0.74, 12, 22), srgb(104, 70, 40));
  place(cabin, 0, 32 + 6 - 3, L / 2 - 14);
  wood.push(cabin);
  const roof = paint(new THREE.BoxGeometry(B * 0.8, 2, 24), srgb(80, 54, 30));
  place(roof, 0, 42, L / 2 - 14);
  wood.push(roof);
  const transomTrim = new THREE.BoxGeometry(B * 0.78, 2.2, 1.5);
  place(transomTrim, 0, 43, L / 2 - 2);
  gold.push(transomTrim);
  // Stern windows (lit).
  const windows: THREE.BufferGeometry[] = [];
  for (const wx of [-14, -4.7, 4.7, 14]) {
    const w = new THREE.PlaneGeometry(6.5, 5.5);
    place(w, wx, 26, L / 2 + 0.35, -0.12, 0, 0);
    windows.push(w);
  }
  // Crest on the transom.
  const crest = new THREE.CylinderGeometry(4.5, 4.5, 1, 18);
  place(crest, 0, 16, L / 2 + 0.2, Math.PI / 2 - 0.12, 0, 0);
  gold.push(crest);
  const rudder = paint(new THREE.BoxGeometry(3, 20, 7), srgb(40, 28, 16));
  place(rudder, 0, 4, L / 2 + 2);
  wood.push(rudder);
  // Bowsprit and the mast.
  const sprit = paint(new THREE.CylinderGeometry(1.2, 1.8, 36, 6), srgb(56, 38, 22));
  place(sprit, 0, 30, -L / 2 - 8, Math.PI / 2 - 0.35, 0, 0);
  wood.push(sprit);
  const mastX = 0;
  const mastZ = -6;
  const mastH = 150;
  const mast = paint(new THREE.CylinderGeometry(1.8, 2.8, mastH - 20, 8), srgb(66, 44, 24));
  place(mast, mastX, 20 + (mastH - 20) / 2, mastZ);
  wood.push(mast);
  const top = paint(new THREE.CylinderGeometry(6, 5, 3, 10), srgb(60, 40, 22));
  place(top, mastX, 112, mastZ);
  wood.push(top);
  const yards = [
    { y: 106, w: 92 },
    { y: 144, w: 66 },
  ];
  for (const yd of yards) {
    const yard = paint(new THREE.CylinderGeometry(1.3, 1.3, yd.w + 6, 6), srgb(56, 38, 22));
    place(yard, mastX, yd.y, mastZ + 1.5, 0, 0, Math.PI / 2);
    wood.push(yard);
  }
  // Rails along the deck.
  for (const side of [-1, 1]) {
    const rail = paint(new THREE.BoxGeometry(1.6, 3, L * 0.62), srgb(90, 60, 32));
    place(rail, side * B * 0.47, 21, 4);
    wood.push(rail);
  }
  // Sails: billowed sheets (rest shape; the renderer breathes them).
  const sails: ShipModel['sails'] = [];
  const sail = (w: number, h: number, y: number, z: number, belly: number) => {
    const g = new THREE.PlaneGeometry(w, h, 10, 8);
    sails.push({ geo: g, w, h, belly, at: new THREE.Vector3(mastX, y, z) });
  };
  sail(88, 58, 74, mastZ - 3, 9);
  sail(62, 32, 126, mastZ - 3, 6);
  // Rigging: shrouds from the mast to the rails, stays fore and aft.
  const lines: number[] = [];
  const seg = (a: THREE.Vector3, b: THREE.Vector3) => lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
  const mtop = new THREE.Vector3(mastX, mastH, mastZ);
  for (const side of [-1, 1])
    for (let i = 0; i < 4; i++) {
      seg(new THREE.Vector3(mastX + side * 3, 112, mastZ), new THREE.Vector3(side * B * 0.48, 22, mastZ + 8 + i * 6));
    }
  seg(mtop, new THREE.Vector3(0, 36, -L / 2 - 24));
  seg(mtop, new THREE.Vector3(0, 44, L / 2 - 6));
  seg(new THREE.Vector3(mastX, 112, mastZ), new THREE.Vector3(0, 32, -L / 2 - 14));
  const rigging = new THREE.BufferGeometry();
  rigging.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  // Stern lantern on a post above the transom.
  const post = paint(new THREE.CylinderGeometry(0.7, 0.7, 10, 5), srgb(30, 22, 14));
  place(post, 0, 48, L / 2 - 3);
  dark.push(post);
  const lanternCage = new THREE.CylinderGeometry(2.4, 3, 5, 6, 1, true);
  place(lanternCage, 0, 55, L / 2 - 3);
  gold.push(lanternCage);
  return {
    wood: merge(wood),
    gold: merge(gold),
    dark: merge(dark),
    windows: merge(windows),
    lantern: new THREE.Vector3(0, 55, L / 2 - 3),
    mastTop: mtop,
    sails,
    rigging,
  };
}
