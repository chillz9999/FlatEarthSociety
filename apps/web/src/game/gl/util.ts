import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Small fast cosmetic PRNG (never touches the simulation). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ noise

const GRAD3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);

/** Seeded 3D simplex noise, roughly in [-1, 1]. */
export class Noise3 {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed: number) {
    const r = rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  get(xin: number, yin: number, zin: number): number {
    const { perm, permMod12 } = this;
    const F3 = 1 / 3;
    const G3 = 1 / 6;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0];
      else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1];
    } else if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1];
    else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1];
    else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0];
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) {
      const g = permMod12[ii + perm[jj + perm[kk]]] * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) {
      const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * n;
  }

  /** Fractal sum of octaves. */
  fbm(x: number, y: number, z: number, octaves = 4, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.get(x, y, z);
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged fractal: sharp crests (crags, ridges). In [0, 1]. */
  ridged(x: number, y: number, z: number, octaves = 4): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.get(x, y, z));
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5;
      x *= 2.1;
      y *= 2.1;
      z *= 2.1;
    }
    return sum / norm;
  }
}

export const NOISE = new Noise3(0x5eed);

// ------------------------------------------------------------------ colour

const colorCache = new Map<string, [number, number, number, number]>();

/** CSS colour ('#rgb', '#rrggbb', 'rgb()', 'rgba()') → linear RGB + alpha. Cached. */
export function parseColor(css: string): [number, number, number, number] {
  let c = colorCache.get(css);
  if (c) return c;
  let r = 1;
  let g = 1;
  let b = 1;
  let a = 1;
  const s = css.trim();
  if (s[0] === '#') {
    const h = s.slice(1);
    const full = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h;
    r = parseInt(full.slice(0, 2), 16) / 255;
    g = parseInt(full.slice(2, 4), 16) / 255;
    b = parseInt(full.slice(4, 6), 16) / 255;
  } else {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map((p) => parseFloat(p));
      r = parts[0] / 255;
      g = parts[1] / 255;
      b = parts[2] / 255;
      if (parts.length > 3) a = parts[3];
    }
  }
  const col = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  c = [col.r, col.g, col.b, a];
  colorCache.set(css, c);
  return c;
}

/** An sRGB colour given as 0–255 components, in the working (linear) colour space. */
export function srgb(r: number, g: number, b: number): THREE.Color {
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

export function hex(h: number): THREE.Color {
  return new THREE.Color(h);
}

// ------------------------------------------------------------------ geometry

/** Give a geometry a constant vertex colour (linear RGB). */
export function paint(geo: THREE.BufferGeometry, color: THREE.Color | ((x: number, y: number, z: number, nx: number, ny: number, nz: number) => THREE.Color)): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = typeof color === 'function' ? color(pos.getX(i), pos.getY(i), pos.getZ(i), nor ? nor.getX(i) : 0, nor ? nor.getY(i) : 1, nor ? nor.getZ(i) : 0) : color;
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Strip a geometry down to position / normal / colour (non-indexed), so it can be merged with any other. */
export function plain(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('color')) paint(g, new THREE.Color(1, 1, 1));
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
  g.morphAttributes = {};
  if (g !== geo) geo.dispose();
  g.clearGroups();
  return g;
}

/** Merge pieces (each painted) into one geometry; the pieces are disposed. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const ps = parts.map(plain);
  const out = mergeGeometries(ps, false);
  for (const p of ps) p.dispose();
  if (!out) throw new Error('merge failed');
  return out;
}

/** Flat-shaded copy of a geometry (faceted look). */
export function facet(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  if (g !== geo) geo.dispose();
  return g;
}

export function weld(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const keep = new THREE.BufferGeometry();
  keep.setAttribute('position', geo.getAttribute('position'));
  if (geo.index) keep.setIndex(geo.index);
  const g = mergeVertices(keep, 1e-4);
  geo.dispose();
  return g;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

/** Transform a geometry in place: translate, rotate (XYZ euler), scale. */
export function place(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.BufferGeometry {
  tmpE.set(rx, ry, rz);
  tmpQ.setFromEuler(tmpE);
  tmpS.set(sx, sy, sz);
  tmpP.set(x, y, z);
  tmpM.compose(tmpP, tmpQ, tmpS);
  geo.applyMatrix4(tmpM);
  return geo;
}

/** Place a cylinder-like geometry (built along +y from 0) so it runs from point a to point b. */
export function between(geo: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  geo.applyMatrix4(new THREE.Matrix4().makeScale(1, len, 1));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  geo.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  geo.translate(a.x, a.y, a.z);
  return geo;
}

/** A tube of varying radius along points (radii per point), closed at both ends. */
export function taperedTube(points: THREE.Vector3[], radii: number[], radial = 10): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const steps = Math.max(8, points.length * 4);
  const frames = curve.computeFrenetFrames(steps, false);
  const pos: number[] = [];
  const idx: number[] = [];
  const rAt = (t: number) => {
    const f = t * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    return lerp(radii[i], radii[i + 1], f - i);
  };
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const p = curve.getPointAt(t);
    const N = frames.normals[s];
    const B = frames.binormals[s];
    const r = rAt(t);
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pos.push(p.x + r * (c * N.x + sn * B.x), p.y + r * (c * N.y + sn * B.y), p.z + r * (c * N.z + sn * B.z));
    }
  }
  for (let s = 0; s < steps; s++) {
    for (let k = 0; k < radial; k++) {
      const a = s * radial + k;
      const b = s * radial + ((k + 1) % radial);
      const c = (s + 1) * radial + k;
      const d = (s + 1) * radial + ((k + 1) % radial);
      idx.push(a, b, c, b, d, c);
    }
  }
  // Caps.
  const p0 = curve.getPointAt(0);
  const p1 = curve.getPointAt(1);
  const c0 = pos.length / 3;
  pos.push(p0.x, p0.y, p0.z);
  const c1 = pos.length / 3;
  pos.push(p1.x, p1.y, p1.z);
  for (let k = 0; k < radial; k++) {
    idx.push(c0, (k + 1) % radial, k);
    idx.push(c1, steps * radial + k, steps * radial + ((k + 1) % radial));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Dispose every geometry and (non-shared) material under an object. */
export function disposeTree(obj: THREE.Object3D, keep?: Set<unknown>): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !keep?.has(m.geometry)) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      for (const x of Array.isArray(mat) ? mat : [mat]) if (!keep?.has(x)) x.dispose();
    }
  });
}
