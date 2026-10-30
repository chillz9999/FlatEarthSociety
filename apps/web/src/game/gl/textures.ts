import * as THREE from 'three';
import { rng } from './util';

/**
 * Procedural textures, generated once at runtime (there are no image files to load).
 */

function finish(tex: THREE.DataTexture, srgb = false): THREE.DataTexture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Periodic gradient noise on an n×n lattice (tiles seamlessly). */
class PeriodicNoise {
  private readonly gx: Float32Array;
  private readonly gy: Float32Array;

  constructor(
    private readonly period: number,
    seed: number,
  ) {
    const r = rng(seed);
    this.gx = new Float32Array(period * period);
    this.gy = new Float32Array(period * period);
    for (let i = 0; i < period * period; i++) {
      const a = r() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** u, v in lattice units [0, period). */
  get(u: number, v: number): number {
    const P = this.period;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fu = u - i0;
    const fv = v - j0;
    const i = ((i0 % P) + P) % P;
    const j = ((j0 % P) + P) % P;
    const i1 = (i + 1) % P;
    const j1 = (j + 1) % P;
    const dot = (ii: number, jj: number, dx: number, dy: number) => this.gx[jj * P + ii] * dx + this.gy[jj * P + ii] * dy;
    const n00 = dot(i, j, fu, fv);
    const n10 = dot(i1, j, fu - 1, fv);
    const n01 = dot(i, j1, fu, fv - 1);
    const n11 = dot(i1, j1, fu - 1, fv - 1);
    const su = fu * fu * fu * (fu * (fu * 6 - 15) + 10);
    const sv = fv * fv * fv * (fv * (fv * 6 - 15) + 10);
    return (n00 + (n10 - n00) * su + (n01 - n00 + (n11 - n10 - n01 + n00) * su) * sv) * 1.41;
  }
}

/** Tileable fractal noise in [0, 1] sampled at texel (x, y) of a size×size tile. */
function fbmField(size: number, basePeriod: number, octaves: number, seed: number, ridged = false): Float32Array {
  const out = new Float32Array(size * size);
  const layers = Array.from({ length: octaves }, (_, o) => new PeriodicNoise(basePeriod << o, seed + o * 7919));
  let norm = 0;
  for (let o = 0; o < octaves; o++) norm += 0.5 ** o;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let o = 0; o < octaves; o++) {
        const P = basePeriod << o;
        let n = layers[o].get((x / size) * P, (y / size) * P);
        if (ridged) n = 1 - Math.abs(n) * 1.4;
        s += n * 0.5 ** o;
      }
      out[y * size + x] = ridged ? s / norm : s / norm * 0.5 + 0.5;
    }
  }
  return out;
}

let noiseTex: THREE.DataTexture | null = null;

/**
 * Shared RGBA noise: R = soft fractal noise, G = finer fractal noise, B = ridged noise (crags, streaks), A = cloud-like
 * billows. All channels tile.
 */
export function noiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const N = 256;
  const r = fbmField(N, 4, 5, 11);
  const g = fbmField(N, 16, 4, 23);
  const b = fbmField(N, 8, 4, 37, true);
  const a = fbmField(N, 6, 5, 51);
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.max(0, Math.min(255, r[i] * 255));
    data[i * 4 + 1] = Math.max(0, Math.min(255, g[i] * 255));
    data[i * 4 + 2] = Math.max(0, Math.min(255, b[i] * 255));
    data[i * 4 + 3] = Math.max(0, Math.min(255, a[i] * 255));
  }
  noiseTex = finish(new THREE.DataTexture(data, N, N, THREE.RGBAFormat));
  return noiseTex;
}

let waterTex: THREE.DataTexture | null = null;

/**
 * The sea's surface normals: a tileable sum of many small wave trains (a toy ocean spectrum), wind from astern.
 * RGB = normal (tangent space, z up), A = height (for crest foam).
 */
export function waterNormalTexture(): THREE.DataTexture {
  if (waterTex) return waterTex;
  const N = 256;
  const r = rng(0x0ce4);
  const waves: { kx: number; ky: number; amp: number; ph: number }[] = [];
  for (let i = 0; i < 90; i++) {
    // Integer wave numbers keep the field periodic over the tile.
    const k = 4 + Math.floor(r() ** 1.3 * 40);
    // Swell from astern: crests mostly across the course, with some cross-sea.
    const ang = Math.PI / 2 + (r() - 0.5) * Math.PI * 0.55 + (r() < 0.15 ? (r() - 0.5) * Math.PI : 0);
    const kx = Math.round(Math.cos(ang) * k);
    const ky = Math.round(Math.sin(ang) * k);
    if (kx === 0 && ky === 0) continue;
    const len = Math.hypot(kx, ky);
    waves.push({ kx, ky, amp: 1 / len ** 1.35, ph: r() * Math.PI * 2 });
  }
  const h = new Float32Array(N * N);
  const dx = new Float32Array(N * N);
  const dy = new Float32Array(N * N);
  let hmin = Infinity;
  let hmax = -Infinity;
  const TAU = Math.PI * 2;
  for (const w of waves) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const p = TAU * ((w.kx * x + w.ky * y) / N) + w.ph;
        // A slightly peaked (trochoidal-ish) profile: sharper crests, broader troughs.
        const s = Math.sin(p);
        const c = Math.cos(p);
        const i = y * N + x;
        h[i] += w.amp * (s + 0.25 * (s * s - 0.5));
        const d = w.amp * TAU * (c + 0.5 * s * c);
        dx[i] += d * w.kx;
        dy[i] += d * w.ky;
      }
    }
  }
  for (let i = 0; i < N * N; i++) {
    hmin = Math.min(hmin, h[i]);
    hmax = Math.max(hmax, h[i]);
  }
  const data = new Uint8Array(N * N * 4);
  const slope = 0.0085;
  for (let i = 0; i < N * N; i++) {
    let nx = -dx[i] * slope;
    let ny = -dy[i] * slope;
    let nz = 1;
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    data[i * 4] = (nx * 0.5 + 0.5) * 255;
    data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
    data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
    data[i * 4 + 3] = ((h[i] - hmin) / (hmax - hmin)) * 255;
  }
  waterTex = finish(new THREE.DataTexture(data, N, N, THREE.RGBAFormat));
  return waterTex;
}

/** A canvas texture (sRGB colour, mipmapped). */
export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** The Society's emblem: the disc of the world and its rim, with eight rays. Drawn into a canvas context. */
export function emblem(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, width: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.moveTo(cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42);
    ctx.lineTo(cx + Math.cos(a) * r * 0.85, cy + Math.sin(a) * r * 0.85);
  }
  ctx.lineWidth = width * 0.7;
  ctx.stroke();
  ctx.restore();
}

let glowTex: THREE.Texture | null = null;

/** A soft round glow (for lanterns, coins, eyes): white, alpha falling off from the centre. */
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  glowTex = canvasTexture(
    128,
    128,
    (ctx) => {
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.15, 'rgba(255,255,255,0.7)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    },
    false,
  );
  return glowTex;
}
