/**
 * Side-view artwork for the chase camera: sea stacks, icebergs, islands,
 * wrecks and wreckage painted to look real (faceted faces lit by the low sun,
 * texture, wet waterlines, surf and reflections), the sea creatures, and the
 * explorer's ship seen from astern.
 *
 * Every sprite is generated at runtime from a cosmetic seed and rendered once.
 * Sprite pixels are world units × `SS`; the anchor is the waterline centre.
 * Randomness here never touches the simulation.
 */
import { PALETTE, mulberry32 } from './art';

export interface SideSprite {
  canvas: HTMLCanvasElement;
  /** Anchor (waterline centre) in sprite pixels. */
  ax: number;
  ay: number;
  /** Sprite pixels per world unit. */
  scale: number;
}

const SS = 2;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * SS));
  c.height = Math.max(1, Math.ceil(h * SS));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.scale(SS, SS);
  return [c, ctx];
}

function hatch(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, spacing: number, slope: number, color: string, width: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  const h = y1 - y0;
  for (let x = x0 - h * Math.abs(slope); x <= x1 + h * Math.abs(slope); x += spacing) {
    ctx.moveTo(x, y1);
    ctx.lineTo(x + h * slope, y0);
  }
  ctx.stroke();
  ctx.restore();
}

type RGB = [number, number, number];
type Pt = [number, number];

const rgb = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Direction towards the light: high and to the left (the low sun ahead lights the faces turned to it). */
const LIGHT: Pt = [-0.55, -0.83];

/** How squarely a stretch of skyline, walked left to right, faces the light (0…1). */
function facing(a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return Math.max(0, (dy / len) * LIGHT[0] + (-dx / len) * LIGHT[1]);
}

/** Break a skyline into a natural, jagged one by midpoint displacement. */
function roughen(pts: Pt[], rough: number, levels: number, rand: () => number): Pt[] {
  let out = pts;
  for (let l = 0; l < levels; l++) {
    const next: Pt[] = [out[0]];
    for (let i = 1; i < out.length; i++) {
      const [ax, ay] = out[i - 1];
      const [bx, by] = out[i];
      const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
      next.push([(ax + bx) / 2 + (rand() - 0.5) * len * rough * 0.4, (ay + by) / 2 + (rand() - 0.5) * len * rough]);
      next.push(out[i]);
    }
    out = next;
    rough *= 0.62;
  }
  return out;
}

function trace(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/**
 * Faces of rock or ice: each stretch of skyline falls to the waterline as a slanting plane, shaded by how it
 * faces the light. Overlapping planes give the broken, fractured look of real cliffs. Call inside a clip.
 */
function facets(ctx: CanvasRenderingContext2D, pts: Pt[], wy: number, lit: RGB, shade: RGB, alpha: number, rand: () => number, reach = 1): void {
  for (let i = 1; i < pts.length - 2; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const f = facing(a, b);
    const ya = a[1] + (wy + 2 - a[1]) * reach;
    const yb = b[1] + (wy + 2 - b[1]) * reach;
    const slant = (rand() - 0.5) * (ya - Math.min(a[1], b[1])) * 0.5;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(b[0] + slant, yb);
    ctx.lineTo(a[0] + slant, ya);
    ctx.closePath();
    ctx.fillStyle = rgb(mix(shade, lit, f), alpha * (0.55 + rand() * 0.45));
    ctx.fill();
  }
}

/** Fine speckle of lighter and darker grains over the current clip (stone texture, snow crust). */
function grain(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, rand: () => number, light: string, dark: string, density = 0.12): void {
  const n = Math.min(1600, Math.round((x1 - x0) * (y1 - y0) * density));
  // Two batched passes (one fill each) keep this cheap.
  for (const color of [light, dark]) {
    ctx.beginPath();
    for (let i = 0; i < n / 2; i++) {
      const r = 0.35 + rand() * 0.9;
      ctx.rect(x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0), r, r);
    }
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** Cracks: thin dark fissures wandering down a face. */
function cracks(ctx: CanvasRenderingContext2D, pts: Pt[], wy: number, count: number, color: string, rand: () => number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.7;
  for (let i = 0; i < count; i++) {
    const [sx, sy] = pts[1 + Math.floor(rand() * (pts.length - 2))];
    let x = sx;
    let y = sy + 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 4 + Math.floor(rand() * 4);
    const fall = (wy - y) * (0.3 + rand() * 0.6);
    for (let k = 0; k < steps; k++) {
      x += (rand() - 0.5) * 7;
      y += fall / steps;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** Light catching the edges of the skyline that face it. */
function rimLight(ctx: CanvasRenderingContext2D, pts: Pt[], color: RGB, width: number): void {
  ctx.lineCap = 'round';
  for (let i = 1; i < pts.length - 2; i++) {
    const f = facing(pts[i], pts[i + 1]);
    if (f < 0.25) continue;
    ctx.beginPath();
    ctx.moveTo(pts[i][0], pts[i][1] + width * 0.3);
    ctx.lineTo(pts[i + 1][0], pts[i + 1][1] + width * 0.3);
    ctx.strokeStyle = rgb(color, Math.min(0.85, f * 0.9));
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

/** The dark wet band the sea leaves on anything it washes, with weed and barnacles. Call inside a clip. */
function wetLine(ctx: CanvasRenderingContext2D, x0: number, x1: number, wy: number, depth: number, weed: boolean, rand: () => number): void {
  const g = ctx.createLinearGradient(0, wy - depth, 0, wy);
  g.addColorStop(0, 'rgba(10,12,10,0)');
  g.addColorStop(0.6, 'rgba(10,12,10,0.45)');
  g.addColorStop(1, 'rgba(5,8,6,0.7)');
  ctx.fillStyle = g;
  ctx.fillRect(x0, wy - depth, x1 - x0, depth + 2);
  if (!weed) return;
  for (let x = x0; x < x1; x += 1.6 + rand() * 2.4) {
    const len = depth * (0.25 + rand() * 0.55);
    ctx.strokeStyle = rand() < 0.5 ? 'rgba(52,78,38,0.8)' : 'rgba(74,92,44,0.7)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, wy);
    ctx.quadraticCurveTo(x + (rand() - 0.5) * 3, wy - len * 0.5, x + (rand() - 0.5) * 2, wy - len);
    ctx.stroke();
  }
  for (let i = 0; i < (x1 - x0) / 4; i++) {
    ctx.fillStyle = 'rgba(200,196,180,0.5)';
    ctx.fillRect(x0 + rand() * (x1 - x0), wy - rand() * depth * 0.6, 0.9, 0.9);
  }
}

/**
 * The object's reflection: what stands just above the waterline, mirrored and squashed into the sea, broken
 * by ripples and fading with depth. Draw it after the object and before the surf.
 */
function reflect(c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, wy: number, depth: number, strength: number, rand: () => number): void {
  const wyPx = Math.round(wy * SS);
  const rows = Math.min(c.height - wyPx, Math.round(depth * SS));
  if (rows <= 0 || wyPx <= 0) return;
  const srcH = Math.min(wyPx, Math.round(rows * 1.5));
  const r = document.createElement('canvas');
  r.width = c.width;
  r.height = rows;
  const rc = r.getContext('2d')!;
  // Flip: the source row at the waterline lands at the top of the reflection.
  rc.setTransform(1, 0, 0, -rows / srcH, 0, rows);
  rc.drawImage(c, 0, wyPx - srcH, c.width, srcH, 0, 0, c.width, srcH);
  rc.setTransform(1, 0, 0, 1, 0, 0);
  rc.globalCompositeOperation = 'destination-out';
  rc.fillStyle = 'rgba(0,0,0,0.8)';
  for (let y = 2; y < rows; y += 3 + rand() * 4) rc.fillRect(0, y, r.width, 1 + (y / rows) * 2.5);
  const fade = rc.createLinearGradient(0, 0, 0, rows);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  rc.fillStyle = fade;
  rc.fillRect(0, 0, r.width, rows);
  // The sea darkens and cools what it reflects.
  rc.globalCompositeOperation = 'source-atop';
  rc.fillStyle = 'rgba(12,38,44,0.5)';
  rc.fillRect(0, 0, r.width, rows);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = strength * 1.6;
  ctx.drawImage(r, 0, wyPx);
  ctx.restore();
}

/** Surf where the sea breaks on something: layered foam with a ragged crest, and a few flecks of spray. */
function foamBand(ctx: CanvasRenderingContext2D, cx: number, wy: number, half: number, rand: () => number): void {
  ctx.save();
  for (let layer = 0; layer < 3; layer++) {
    const lift = 1.5 + layer * 1.6;
    ctx.beginPath();
    ctx.moveTo(cx - half, wy + 1.5);
    const n = Math.max(10, Math.round(half / 5));
    for (let i = 0; i <= n; i++) {
      const x = cx - half + (i / n) * half * 2;
      const edge = Math.min(1, Math.min(i, n - i) / 2.5);
      ctx.lineTo(x, wy - (lift + rand() * 2.8) * edge);
    }
    ctx.lineTo(cx + half, wy + 1.5);
    ctx.closePath();
    ctx.fillStyle = `rgba(236,243,238,${0.5 - layer * 0.12})`;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(cx, wy + 2.5, half * 1.02, 2.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(236,243,238,0.35)';
  ctx.fill();
  for (let i = 0; i < half / 3; i++) {
    ctx.fillStyle = 'rgba(240,246,242,0.7)';
    const x = cx + (rand() - 0.5) * half * 2.1;
    const y = wy - 2 - rand() * 7;
    ctx.fillRect(x, y, 0.8 + rand() * 0.9, 0.8 + rand() * 0.9);
  }
  ctx.restore();
}

/** Gulls wheeling above a hazard (cosmetic). */
function gulls(ctx: CanvasRenderingContext2D, cx: number, top: number, spread: number, rand: () => number): void {
  ctx.strokeStyle = 'rgba(236,232,220,0.9)';
  ctx.lineWidth = 1.1;
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const x = cx + (rand() - 0.5) * spread;
    const y = top - 6 - rand() * 18;
    const w = 2.5 + rand() * 2;
    ctx.beginPath();
    ctx.moveTo(x - w, y - w * 0.35);
    ctx.quadraticCurveTo(x - w * 0.4, y - w * 0.6, x, y);
    ctx.quadraticCurveTo(x + w * 0.4, y - w * 0.6, x + w, y - w * 0.35);
    ctx.stroke();
  }
}

/** Stone in three kinds: grey basalt, weathered sandstone, and black volcanic rock. */
const STONES: { lit: RGB; mid: RGB; shade: RGB; base: RGB }[] = [
  { lit: [148, 140, 128], mid: [92, 86, 78], shade: [44, 41, 38], base: [22, 20, 18] },
  { lit: [168, 138, 104], mid: [112, 88, 64], shade: [58, 44, 32], base: [28, 21, 15] },
  { lit: [110, 106, 104], mid: [58, 56, 56], shade: [28, 27, 28], base: [12, 12, 13] },
];

/**
 * Rock in the sea, in several forms: a sea stack, a needle-thin spire, twin crags, or a flat-topped mesa
 * capped with grass. Faceted, fractured and weathered, wet and weedy at the waterline, mirrored in the sea.
 */
export function rockSideSprite(shape: number, vr: number): SideSprite {
  const rand = mulberry32(shape);
  const form = rand();
  const variant = form < 0.4 ? 'stack' : form < 0.6 ? 'spire' : form < 0.82 ? 'twin' : 'mesa';
  const height = vr * (variant === 'spire' ? 2 + rand() * 0.6 : variant === 'mesa' ? 0.75 + rand() * 0.25 : variant === 'twin' ? 1.2 + rand() * 0.4 : 0.95 + rand() * 0.8);
  const stone = STONES[rand() < 0.6 ? 0 : rand() < 0.6 ? 1 : 2];
  const half = variant === 'spire' ? vr * 0.8 : vr;
  const below = Math.min(60, height * 0.5) + 8;
  const w = vr * 2.4 + 16;
  const wy = height + 34;
  const h = wy + below;
  const [c, ctx] = makeCanvas(w, h);
  const cx = w / 2;

  // Silhouette: a coarse profile for the form, broken up into a natural skyline.
  const key: Pt[] = [[cx - half * 1.04, wy]];
  const n = 6 + Math.floor(rand() * 3);
  const crown = rand() * 0.5 - 0.25;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    let profile: number;
    if (variant === 'twin') profile = Math.max(Math.exp(-(((t - 0.3) * 4.2) ** 2)), 0.8 * Math.exp(-(((t - 0.72) * 4.6) ** 2)));
    else if (variant === 'mesa') profile = Math.min(1, Math.max(0, 1 - Math.abs((t - 0.5) * 2) ** 4) * 1.25);
    else if (variant === 'spire') profile = Math.max(0, 1 - Math.abs((t - 0.5 - crown * 0.2) * 2) ** 0.9);
    else profile = Math.max(0, 1 - Math.abs((t - 0.5 - crown * 0.4) * 2) ** 1.6);
    const jag = variant === 'mesa' ? 0.97 + rand() * 0.05 : 0.86 + rand() * 0.24;
    key.push([cx - half + t * half * 2 + (rand() - 0.5) * half * 0.12, wy - height * (0.16 + 0.84 * profile) * jag]);
  }
  key.push([cx + half * 1.04, wy]);
  const coarse = roughen(key, variant === 'mesa' ? 0.12 : 0.32, 1, rand);
  const pts = roughen(coarse, variant === 'mesa' ? 0.08 : 0.2, 2, rand);
  for (const p of pts) p[1] = Math.min(p[1], wy);
  const top = Math.min(...pts.map((p) => p[1]));

  // Body, shaded top to bottom; then fractured faces, texture and cracks.
  trace(ctx, pts);
  const body = ctx.createLinearGradient(0, top, 0, wy);
  body.addColorStop(0, rgb(stone.mid));
  body.addColorStop(0.55, rgb(stone.shade));
  body.addColorStop(1, rgb(stone.base));
  ctx.fillStyle = body;
  ctx.fill();
  ctx.save();
  trace(ctx, pts);
  ctx.clip();
  // Large planes from the broad shape of the skyline, then finer faces near the top that break them up.
  facets(ctx, coarse, wy, stone.lit, stone.shade, 0.75, rand);
  facets(ctx, pts, wy, stone.lit, stone.base, 0.3, rand, 0.35);
  if (variant !== 'mesa') {
    // Horizontal bedding, faint.
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 0.6;
    for (let i = 0; i < 6; i++) {
      const y = wy - height * (0.12 + i * 0.14 + rand() * 0.05);
      ctx.beginPath();
      ctx.moveTo(cx - half, y);
      ctx.bezierCurveTo(cx - half * 0.3, y - 3 + rand() * 6, cx + half * 0.3, y - 3 + rand() * 6, cx + half, y + (rand() - 0.5) * 5);
      ctx.stroke();
    }
  }
  cracks(ctx, pts, wy, 3 + Math.floor(rand() * 4), 'rgba(8,7,6,0.55)', rand);
  grain(ctx, cx - half * 1.1, top, cx + half * 1.1, wy, rand, rgb(stone.lit, 0.22), 'rgba(0,0,0,0.22)');
  // Bird lime streaks on the tallest rocks, ambient shadow towards the base, the wet line.
  if (height > vr * 1.2 && rand() < 0.5) {
    ctx.strokeStyle = 'rgba(232,228,214,0.35)';
    ctx.lineWidth = 1.1;
    for (let i = 0; i < 5; i++) {
      const [sx, sy] = pts[Math.floor(pts.length * (0.3 + rand() * 0.4))];
      ctx.beginPath();
      ctx.moveTo(sx + (rand() - 0.5) * 6, sy + 2);
      ctx.lineTo(sx + (rand() - 0.5) * 8, sy + 8 + rand() * height * 0.3);
      ctx.stroke();
    }
  }
  const ao = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  ao.addColorStop(0, 'rgba(0,0,0,0)');
  ao.addColorStop(0.6, 'rgba(0,0,0,0.1)');
  ao.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = ao;
  ctx.fillRect(cx - half * 1.1, top, half * 2.2, wy - top);
  wetLine(ctx, cx - half * 1.1, cx + half * 1.1, wy, Math.min(14, height * 0.22), rand() < 0.7, rand);
  ctx.restore();

  if (variant === 'mesa') {
    // A thin cap of turf along the table, ragged at the edges.
    ctx.beginPath();
    const capTop = pts.filter((p) => p[1] < wy - height * 0.82);
    if (capTop.length > 2) {
      ctx.moveTo(capTop[0][0], capTop[0][1]);
      for (const [x, y] of capTop) ctx.lineTo(x, y - 1.5 - rand() * 2);
      for (let i = capTop.length - 1; i >= 0; i--) ctx.lineTo(capTop[i][0], capTop[i][1] + 3 + rand() * 4);
      ctx.closePath();
      const turf = ctx.createLinearGradient(0, top - 3, 0, top + 7);
      turf.addColorStop(0, '#8a9a5a');
      turf.addColorStop(1, '#3e4a26');
      ctx.fillStyle = turf;
      ctx.fill();
    }
  }
  rimLight(ctx, pts, [255, 226, 180], 1.4);
  trace(ctx, pts);
  ctx.strokeStyle = rgb(stone.base, 0.6);
  ctx.lineWidth = 0.8;
  ctx.stroke();
  if (rand() < 0.25) gulls(ctx, cx, top, half * 1.6, rand);

  reflect(c, ctx, wy, below - 4, 0.4, rand);
  foamBand(ctx, cx, wy, half * 1.1, rand);
  return { canvas: c, ax: cx * SS, ay: wy * SS, scale: SS };
}

/**
 * An iceberg calved from the ice wall: sharp faces of white and blue ice, meltwater grooves, a wave-cut
 * notch at the waterline and the great pale bulk beneath the surface.
 */
export function icebergSideSprite(shape: number, vr: number): SideSprite {
  const rand = mulberry32(shape);
  const height = vr * (1.1 + rand() * 0.9);
  const tabular = rand() < 0.3;
  const below = Math.min(70, height * 0.6) + 10;
  const w = vr * 2.8 + 16;
  const wy = height + 14;
  const h = wy + below;
  const [c, ctx] = makeCanvas(w, h);
  const cx = w / 2;

  const key: Pt[] = [[cx - vr, wy]];
  const n = tabular ? 5 : 4 + Math.floor(rand() * 3);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const profile = tabular
      ? Math.min(1, Math.max(0.2, 1 - Math.abs((t - 0.5) * 2) ** 5) * 1.1)
      : Math.max(0.18, 1 - Math.abs((t - 0.45 - (rand() - 0.5) * 0.25) * 2) ** 1.1);
    key.push([cx - vr + t * vr * 2 + (rand() - 0.5) * vr * 0.2, wy - height * profile * (0.8 + rand() * 0.3)]);
  }
  key.push([cx + vr, wy]);
  // Ice breaks in straight, sharp lines: little displacement, at a coarse scale.
  const coarse = roughen(key, 0.22, 1, rand);
  const pts = roughen(coarse, 0.14, 1, rand);
  for (const p of pts) p[1] = Math.min(p[1], wy);
  const top = Math.min(...pts.map((p) => p[1]));

  trace(ctx, pts);
  const body = ctx.createLinearGradient(0, top, 0, wy);
  body.addColorStop(0, '#f6fbfd');
  body.addColorStop(0.5, '#cfe5ee');
  body.addColorStop(1, '#8fbccd');
  ctx.fillStyle = body;
  ctx.fill();
  ctx.save();
  trace(ctx, pts);
  ctx.clip();
  facets(ctx, coarse, wy, [255, 255, 255], [96, 146, 178], 0.7, rand);
  facets(ctx, pts, wy, [255, 255, 255], [120, 168, 196], 0.3, rand, 0.3);
  // Meltwater grooves running down the faces.
  ctx.strokeStyle = 'rgba(110,160,190,0.28)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < vr / 4; i++) {
    const x = cx - vr + rand() * vr * 2;
    ctx.beginPath();
    ctx.moveTo(x, top + rand() * height * 0.3);
    ctx.lineTo(x + (rand() - 0.5) * 4, wy);
    ctx.stroke();
  }
  cracks(ctx, pts, wy, 2 + Math.floor(rand() * 3), 'rgba(40,96,130,0.55)', rand);
  grain(ctx, cx - vr, top, cx + vr, wy, rand, 'rgba(255,255,255,0.4)', 'rgba(120,170,200,0.18)', 0.08);
  // The wave-cut notch: a band of deep turquoise ice just above the sea.
  ctx.beginPath();
  ctx.moveTo(cx - vr, wy);
  for (let x = cx - vr; x <= cx + vr; x += 4) ctx.lineTo(x, wy - 4 - rand() * 3);
  ctx.lineTo(cx + vr, wy + 2);
  ctx.lineTo(cx - vr, wy + 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(40,130,160,0.55)';
  ctx.fill();
  const shade = ctx.createLinearGradient(cx - vr, 0, cx + vr, 0);
  shade.addColorStop(0, 'rgba(60,110,150,0)');
  shade.addColorStop(1, 'rgba(60,110,150,0.3)');
  ctx.fillStyle = shade;
  ctx.fillRect(cx - vr, top, vr * 2, wy - top);
  ctx.restore();
  rimLight(ctx, pts, [255, 255, 255], 1.5);
  trace(ctx, pts);
  ctx.strokeStyle = 'rgba(60,110,140,0.55)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  reflect(c, ctx, wy, below - 4, 0.45, rand);
  // The bulk below the surface, pale turquoise fading into the deep.
  ctx.beginPath();
  ctx.moveTo(cx - vr * 1.02, wy + 1);
  ctx.quadraticCurveTo(cx - vr * 1.4, wy + below * 0.5, cx - vr * 0.3, wy + below * 0.92);
  ctx.quadraticCurveTo(cx + vr * 0.6, wy + below, cx + vr * 1.3, wy + below * 0.45);
  ctx.lineTo(cx + vr * 1.02, wy + 1);
  ctx.closePath();
  const deep = ctx.createLinearGradient(0, wy, 0, wy + below);
  deep.addColorStop(0, 'rgba(110,205,214,0.42)');
  deep.addColorStop(1, 'rgba(110,205,214,0)');
  ctx.fillStyle = deep;
  ctx.fill();
  foamBand(ctx, cx, wy, vr * 1.06, rand);
  return { canvas: c, ax: cx * SS, ay: wy * SS, scale: SS };
}

/** Wood in strakes: each plank its own weathered tone, darker and greener towards the waterline. */
function planking(ctx: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, strakes: number, rand: () => number): void {
  const step = (y1 - y0) / strakes;
  for (let i = 0; i < strakes; i++) {
    const t = i / strakes;
    const base = mix([118, 84, 52], [46, 34, 22], t * 0.9);
    const tone = mix(base, [rand() * 30 + 60, rand() * 20 + 45, 30], 0.18);
    ctx.fillStyle = rgb(tone);
    ctx.fillRect(x0, y0 + i * step, x1 - x0, step + 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x0, y0 + (i + 1) * step - 0.6, x1 - x0, 0.6);
    // Butt joints and grain.
    for (let x = x0 + rand() * 30; x < x1; x += 22 + rand() * 26) {
      ctx.fillRect(x, y0 + i * step, 0.6, step);
    }
  }
}

/** The wreck of a galleon, listing in the shallows, masts snapped, sails in rags, weed on the hull. */
export function wreckSideSprite(shape: number, vr: number): SideSprite {
  const rand = mulberry32(shape);
  const len = vr * 2.1;
  const hullH = vr * 0.55;
  const below = 26;
  const w = len + 70;
  const wy = hullH + vr * 1.6 + 14;
  const h = wy + below;
  const [c, ctx] = makeCanvas(w, h);
  const cx = w / 2;
  const flip = rand() < 0.5 ? -1 : 1;
  ctx.save();
  ctx.translate(cx, wy);
  ctx.scale(flip, 1);
  ctx.rotate(-0.12 - rand() * 0.1);

  // Masts first (behind the hull): one snapped, one leaning; rags of sail; slack rigging.
  const mast = (x: number, height: number, lean: number) => {
    const topX = x + lean;
    const topY = -hullH * 0.6 - height;
    const g = ctx.createLinearGradient(x - 2, 0, x + 2, 0);
    g.addColorStop(0, '#5a3d20');
    g.addColorStop(1, '#22160a');
    ctx.beginPath();
    ctx.moveTo(x - 1.8, -hullH * 0.6);
    ctx.lineTo(topX - 1.2, topY + 3);
    ctx.lineTo(topX - 0.4, topY);
    ctx.lineTo(topX + 0.8, topY + 4);
    ctx.lineTo(topX + 1.4, topY + 1.5);
    ctx.lineTo(x + 1.8, -hullH * 0.6);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    // A rag of sail on a broken yard, holed and frayed.
    const sx = x + lean * 0.7;
    const sy = -hullH * 0.6 - height * 0.7;
    ctx.beginPath();
    ctx.moveTo(sx - 2, sy);
    ctx.lineTo(sx + 28, sy + height * 0.06);
    ctx.lineTo(sx + 24, sy + height * 0.22);
    for (let k = 0; k < 6; k++) ctx.lineTo(sx + 22 - k * 4.5, sy + height * (0.3 + rand() * 0.1));
    ctx.closePath();
    const sail = ctx.createLinearGradient(sx, sy, sx + 26, sy + height * 0.3);
    sail.addColorStop(0, 'rgba(206,192,158,0.92)');
    sail.addColorStop(1, 'rgba(140,124,94,0.92)');
    ctx.fillStyle = sail;
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.ellipse(sx + 6 + rand() * 16, sy + 4 + rand() * height * 0.18, 1.5 + rand() * 2.5, 1 + rand() * 2, rand(), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(30,22,12,0.7)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(topX, topY + 2);
    ctx.quadraticCurveTo(x + lean * 0.3 - 20, -hullH * 0.6 - height * 0.2, -len * 0.45, -hullH * 0.9);
    ctx.moveTo(topX, topY + 4);
    ctx.quadraticCurveTo(x + lean * 0.5 + 20, -hullH * 0.6 - height * 0.3, len * 0.4, -hullH * 0.85);
    ctx.stroke();
  };
  mast(-len * 0.12, vr * 1.25, 18);
  mast(len * 0.22, vr * 0.6, -8);
  // What is left of a flag: the Globe Lobby's round world, faded and torn.
  const fx = -len * 0.12 + 18;
  const fy = -hullH * 0.6 - vr * 1.25 + 2;
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(fx + 16, fy + 1.5);
  ctx.lineTo(fx + 13, fy + 5);
  ctx.lineTo(fx + 17, fy + 8);
  ctx.lineTo(fx + 11, fy + 11);
  ctx.lineTo(fx, fy + 11);
  ctx.closePath();
  ctx.fillStyle = 'rgba(52,78,112,0.92)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(fx + 6, fy + 5.5, 3.2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(214,204,178,0.85)';
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // Hull: planked, weathered, a stern castle, and a breach with the ribs showing.
  const hull = () => {
    ctx.beginPath();
    ctx.moveTo(-len / 2, -hullH);
    ctx.lineTo(len / 2 - 20, -hullH * 0.9);
    ctx.quadraticCurveTo(len / 2 + 6, -hullH * 0.8, len / 2, 0);
    ctx.lineTo(-len / 2 + 14, hullH * 0.15);
    ctx.quadraticCurveTo(-len / 2 - 4, -hullH * 0.3, -len / 2, -hullH);
    ctx.closePath();
  };
  ctx.save();
  hull();
  ctx.clip();
  planking(ctx, -len / 2 - 6, len / 2 + 8, -hullH * 1.05, hullH * 0.2, 7, rand);
  const round = ctx.createLinearGradient(0, -hullH, 0, hullH * 0.2);
  round.addColorStop(0, 'rgba(255,220,170,0.18)');
  round.addColorStop(0.35, 'rgba(0,0,0,0)');
  round.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = round;
  ctx.fillRect(-len / 2 - 6, -hullH * 1.1, len + 16, hullH * 1.4);
  // Weed and slime where the sea washes the hull.
  const slime = ctx.createLinearGradient(0, -hullH * 0.45, 0, 0);
  slime.addColorStop(0, 'rgba(48,70,34,0)');
  slime.addColorStop(1, 'rgba(48,70,34,0.7)');
  ctx.fillStyle = slime;
  ctx.fillRect(-len / 2 - 6, -hullH * 0.45, len + 16, hullH * 0.7);
  grain(ctx, -len / 2, -hullH, len / 2, hullH * 0.2, rand, 'rgba(210,180,140,0.12)', 'rgba(0,0,0,0.2)', 0.06);
  // Gun ports, lids hanging.
  for (let i = 0; i < 5; i++) {
    const gx = -len / 2 + 24 + i * (len / 6);
    ctx.fillStyle = '#0c0703';
    ctx.fillRect(gx, -hullH * 0.64, 6.5, 5.5);
    ctx.fillStyle = 'rgba(90,62,34,0.9)';
    ctx.fillRect(gx - 0.5, -hullH * 0.64 + 5.5, 7.5, 2);
  }
  // The breach, with ribs.
  ctx.beginPath();
  ctx.moveTo(len * 0.04, -hullH * 0.5);
  ctx.lineTo(len * 0.1, -hullH * 0.8);
  ctx.lineTo(len * 0.17, -hullH * 0.7);
  ctx.lineTo(len * 0.21, -hullH * 0.32);
  ctx.lineTo(len * 0.12, -hullH * 0.12);
  ctx.closePath();
  ctx.fillStyle = '#070402';
  ctx.fill();
  ctx.strokeStyle = 'rgba(110,78,44,0.85)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 3; i++) {
    const rx = len * (0.08 + i * 0.045);
    ctx.beginPath();
    ctx.moveTo(rx, -hullH * 0.75);
    ctx.quadraticCurveTo(rx + 2, -hullH * 0.45, rx, -hullH * 0.15);
    ctx.stroke();
  }
  ctx.restore();
  hull();
  ctx.strokeStyle = 'rgba(14,9,4,0.8)';
  ctx.lineWidth = 0.9;
  ctx.stroke();
  // Stern castle, planked too, with its broken rail.
  ctx.save();
  ctx.beginPath();
  ctx.rect(-len / 2, -hullH * 1.45, len * 0.22, hullH * 0.5);
  ctx.clip();
  planking(ctx, -len / 2, -len / 2 + len * 0.22, -hullH * 1.45, -hullH * 0.95, 3, rand);
  ctx.fillStyle = 'rgba(255,220,170,0.12)';
  ctx.fillRect(-len / 2, -hullH * 1.45, len * 0.22, hullH * 0.12);
  ctx.restore();
  ctx.strokeStyle = 'rgba(14,9,4,0.7)';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(-len / 2, -hullH * 1.45, len * 0.22, hullH * 0.5);
  ctx.fillStyle = '#2a1a0b';
  for (let x = -len / 2 + 2; x < -len / 2 + len * 0.18; x += 5 + rand() * 4) ctx.fillRect(x, -hullH * 1.45 - 4 - rand() * 2, 1.2, 4);
  ctx.restore();

  reflect(c, ctx, wy, below - 4, 0.35, rand);
  foamBand(ctx, cx, wy, len * 0.55, rand);
  return { canvas: c, ax: cx * SS, ay: wy * SS, scale: SS };
}

/** Height (world units) of a sea gate's pillars; the arch springs from their tops. */
export const PILLAR_HEIGHT = 150;

/** One pillar of a Society sea gate: dressed stone in courses on a rock footing, weathered and weedy, a brazier on top. */
export function pillarSideSprite(shape: number, vr: number): SideSprite {
  const rand = mulberry32(shape);
  const half = vr * 0.75;
  const below = 40;
  const w = vr * 2.4 + 16;
  const wy = PILLAR_HEIGHT + 38;
  const h = wy + below;
  const [c, ctx] = makeCanvas(w, h);
  const cx = w / 2;
  const colTop = wy - PILLAR_HEIGHT;
  const colBottom = wy - 16;
  // Footing: a skirt of rough rock.
  const foot = roughen(
    [
      [cx - vr * 1.08, wy],
      [cx - vr * 0.82, wy - 16],
      [cx, wy - 22],
      [cx + vr * 0.86, wy - 18],
      [cx + vr * 1.08, wy],
    ],
    0.3,
    3,
    rand,
  );
  trace(ctx, foot);
  ctx.fillStyle = rgb(STONES[0].shade);
  ctx.fill();
  ctx.save();
  trace(ctx, foot);
  ctx.clip();
  facets(ctx, foot, wy, STONES[0].lit, STONES[0].base, 0.7, rand);
  grain(ctx, cx - vr * 1.1, wy - 24, cx + vr * 1.1, wy, rand, 'rgba(200,190,170,0.2)', 'rgba(0,0,0,0.25)');
  wetLine(ctx, cx - vr * 1.1, cx + vr * 1.1, wy, 12, true, rand);
  ctx.restore();
  // The column: courses of dressed stone, rounded by the light.
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - half, colTop, half * 2, colBottom - colTop);
  ctx.clip();
  const courses = 9;
  for (let i = 0; i < courses; i++) {
    const y0 = colTop + ((colBottom - colTop) * i) / courses;
    const tone = mix([196, 182, 152], [150, 136, 110], rand());
    ctx.fillStyle = rgb(tone);
    ctx.fillRect(cx - half, y0, half * 2, (colBottom - colTop) / courses + 0.5);
    ctx.fillStyle = 'rgba(30,24,16,0.5)';
    ctx.fillRect(cx - half, y0, half * 2, 0.8);
  }
  const round = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  round.addColorStop(0, 'rgba(255,236,200,0.25)');
  round.addColorStop(0.35, 'rgba(0,0,0,0)');
  round.addColorStop(1, 'rgba(10,8,6,0.62)');
  ctx.fillStyle = round;
  ctx.fillRect(cx - half, colTop, half * 2, colBottom - colTop);
  // Rain streaks and lichen.
  for (let i = 0; i < 8; i++) {
    const x = cx - half + rand() * half * 2;
    const st = ctx.createLinearGradient(0, colTop, 0, colTop + 40 + rand() * 60);
    st.addColorStop(0, 'rgba(20,18,14,0.3)');
    st.addColorStop(1, 'rgba(20,18,14,0)');
    ctx.fillStyle = st;
    ctx.fillRect(x, colTop, 1.5 + rand() * 2, 100);
  }
  grain(ctx, cx - half, colTop, cx + half, colBottom, rand, 'rgba(255,240,210,0.16)', 'rgba(0,0,0,0.16)', 0.08);
  const moss = ctx.createLinearGradient(0, colBottom - 30, 0, colBottom);
  moss.addColorStop(0, 'rgba(60,80,40,0)');
  moss.addColorStop(1, 'rgba(60,80,40,0.55)');
  ctx.fillStyle = moss;
  ctx.fillRect(cx - half, colBottom - 30, half * 2, 30);
  ctx.restore();
  // Bronze bands, and the capital.
  for (const t of [0.3, 0.62]) {
    const y = wy - PILLAR_HEIGHT * t - 3;
    const band = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
    band.addColorStop(0, '#b08a3e');
    band.addColorStop(0.4, '#7a5a22');
    band.addColorStop(1, '#2e2210');
    ctx.fillStyle = band;
    ctx.fillRect(cx - half - 2, y, half * 2 + 4, 5);
  }
  const cap = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  cap.addColorStop(0, '#ddd0ac');
  cap.addColorStop(1, '#5e5440');
  ctx.fillStyle = cap;
  ctx.fillRect(cx - half - 6, colTop - 6, half * 2 + 12, 8);
  ctx.strokeStyle = 'rgba(28,22,14,0.6)';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(cx - half - 6, colTop - 6, half * 2 + 12, 8);
  ctx.strokeRect(cx - half, colTop, half * 2, colBottom - colTop);
  // Brazier and its fire.
  ctx.beginPath();
  ctx.moveTo(cx - 9, colTop - 6);
  ctx.lineTo(cx + 9, colTop - 6);
  ctx.lineTo(cx + 6, colTop - 14);
  ctx.lineTo(cx - 6, colTop - 14);
  ctx.closePath();
  ctx.fillStyle = '#2a1a0b';
  ctx.fill();
  const fire = ctx.createRadialGradient(cx, colTop - 20, 0, cx, colTop - 20, 22);
  fire.addColorStop(0, 'rgba(255,230,150,0.95)');
  fire.addColorStop(0.35, 'rgba(255,170,70,0.6)');
  fire.addColorStop(1, 'rgba(255,140,40,0)');
  ctx.fillStyle = fire;
  ctx.fillRect(cx - 22, colTop - 42, 44, 44);
  reflect(c, ctx, wy, below - 4, 0.35, rand);
  foamBand(ctx, cx, wy, vr * 1.1, rand);
  return { canvas: c, ax: cx * SS, ay: wy * SS, scale: SS };
}

/**
 * A kraken's tentacle breaking the surface, drawn fresh every frame so it
 * sways. (x, y) is the waterline on screen; `k` is screen pixels per world unit.
 */
export function drawTentacle(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, vr: number, seed: number, time: number, alpha: number): void {
  const height = vr * (3.6 + (seed % 7) * 0.18);
  const base = vr * 0.95;
  const phase = (seed % 1000) * 0.0063;
  const curl = seed % 2 ? 1 : -1;
  const n = 16;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  const centre: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const sway = Math.sin(time * 1.8 + phase + t * 2.6) * vr * 0.9 * t;
    const hook = curl * vr * 1.6 * t * t * t;
    const cxw = sway + hook;
    const cyw = -height * t;
    const width = base * (1 - t) ** 0.85 + 0.6;
    centre.push([x + cxw * k, y + cyw * k]);
    left.push([x + (cxw - width) * k, y + cyw * k]);
    right.push([x + (cxw + width) * k, y + cyw * k]);
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (const p of left) ctx.lineTo(p[0], p[1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  const g = ctx.createLinearGradient(x - base * k, 0, x + base * k, 0);
  g.addColorStop(0, '#2c1024');
  g.addColorStop(0.5, '#6e2a52');
  g.addColorStop(1, '#2a0e22');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(15,5,12,0.9)';
  ctx.lineWidth = Math.max(0.6, k * 1.2);
  ctx.stroke();
  // Suckers along the inner edge.
  ctx.fillStyle = 'rgba(232,190,200,0.75)';
  for (let i = 1; i < n - 2; i += 2) {
    const t = i / n;
    const [px, py] = centre[i];
    const r = Math.max(0.4, base * (1 - t) * 0.28 * k);
    ctx.beginPath();
    ctx.arc(px + curl * r * 1.4, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Foam where it breaks the surface.
  ctx.beginPath();
  ctx.ellipse(x, y, base * 1.7 * k, base * 0.45 * k, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(233,241,234,0.7)';
  ctx.fill();
  ctx.restore();
}

/** The arch of a Society sea gate, spanning between the tops of its two pillars. Points are on screen. */
export function drawGateArch(ctx: CanvasRenderingContext2D, pts: [number, number][], thickness: number, alpha: number, time: number): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
  ctx.strokeStyle = '#1c160e';
  ctx.lineWidth = thickness + 3;
  ctx.stroke();
  ctx.strokeStyle = '#a8957a';
  ctx.lineWidth = thickness;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(216,200,164,0.8)';
  ctx.lineWidth = Math.max(1, thickness * 0.25);
  ctx.stroke();
  // Keystone with the Society's seal, and a lantern swinging beneath it.
  const mid = pts[Math.floor(pts.length / 2)];
  const r = thickness * 0.75;
  ctx.beginPath();
  ctx.arc(mid[0], mid[1], r, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.gold;
  ctx.fill();
  ctx.strokeStyle = '#4a320c';
  ctx.lineWidth = Math.max(1, r * 0.15);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mid[0], mid[1], r * 0.45, 0, Math.PI * 2);
  ctx.stroke();
  const swing = Math.sin(time * 1.6) * r * 0.5;
  const ly = mid[1] + r * 3.2;
  ctx.beginPath();
  ctx.moveTo(mid[0], mid[1] + r);
  ctx.lineTo(mid[0] + swing, ly);
  ctx.strokeStyle = '#2a1a0b';
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.stroke();
  const glow = ctx.createRadialGradient(mid[0] + swing, ly, 0, mid[0] + swing, ly, r * 2.2);
  glow.addColorStop(0, 'rgba(255,217,138,0.95)');
  glow.addColorStop(1, 'rgba(255,217,138,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(mid[0] + swing - r * 2.2, ly - r * 2.2, r * 4.4, r * 4.4);
  ctx.restore();
}

/** A palm: a curving, ringed trunk and drooping fronds. */
function palm(ctx: CanvasRenderingContext2D, px: number, base: number, rand: () => number): void {
  const ph = 22 + rand() * 18;
  const lean = (rand() - 0.5) * 16;
  const tx = px + lean;
  const ty = base - ph;
  ctx.beginPath();
  ctx.moveTo(px - 1.6, base);
  ctx.quadraticCurveTo(px + lean * 0.3 - 1.2, base - ph * 0.6, tx - 0.8, ty);
  ctx.lineTo(tx + 0.8, ty);
  ctx.quadraticCurveTo(px + lean * 0.3 + 1.2, base - ph * 0.6, px + 1.6, base);
  ctx.closePath();
  const trunk = ctx.createLinearGradient(px - 2, 0, px + 2, 0);
  trunk.addColorStop(0, '#8a6a44');
  trunk.addColorStop(1, '#3a2a16');
  ctx.fillStyle = trunk;
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,28,14,0.6)';
  ctx.lineWidth = 0.5;
  for (let k = 1; k < 8; k++) {
    const t = k / 8;
    const x = px + (lean * 0.3) * 2 * t * (1 - t) + lean * t * t;
    const y = base - ph * t;
    ctx.beginPath();
    ctx.moveTo(x - 1.6, y);
    ctx.lineTo(x + 1.6, y + 0.6);
    ctx.stroke();
  }
  for (let f = 0; f < 7; f++) {
    const a = -Math.PI / 2 + (f - 3) * 0.55 + (rand() - 0.5) * 0.2;
    const len = 12 + rand() * 6;
    const ex = tx + Math.cos(a) * len;
    const ey = ty + Math.sin(a) * len * 0.5 + len * 0.55;
    const mx = tx + Math.cos(a) * len * 0.55;
    const my = ty + Math.sin(a) * len * 0.5 - 3;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo(mx, my - 2.2, ex, ey);
    ctx.quadraticCurveTo(mx, my + 2.2, tx, ty);
    ctx.fillStyle = f % 2 ? '#3f5a24' : '#2c4419';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,170,90,0.45)';
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }
}

/**
 * An island: rocky shores and a beach or two, hills under a dense canopy of trees lit by the low sun, palms,
 * and sometimes a Society lighthouse or a Globe Lobby fort. Mirrored in the sea.
 */
export function islandSideSprite(shape: number, vr: number): SideSprite {
  const rand = mulberry32(shape);
  const height = vr * (0.42 + rand() * 0.18);
  const towerH = rand() < 0.4 ? vr * 0.55 : 0;
  const fort = towerH === 0 && rand() < 0.55;
  const below = Math.min(50, height * 0.6) + 8;
  const w = vr * 2.3 + 24;
  const wy = height + Math.max(towerH, fort ? 90 : 0) + 34;
  const h = wy + below;
  const [c, ctx] = makeCanvas(w, h);
  const cx = w / 2;

  // The skyline of the hills.
  const peaks = 1 + Math.floor(rand() * 3);
  const centres = Array.from({ length: peaks }, (_, p) => (p + 0.5) / peaks + (rand() - 0.5) * 0.08);
  const key: Pt[] = [[cx - vr * 1.02, wy]];
  const steps = 18;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    let y = 0;
    for (const pc of centres) y = Math.max(y, Math.exp(-(((t - pc) * (2.2 + peaks)) ** 2)));
    const edge = Math.min(1, t * 5, (1 - t) * 5);
    key.push([cx - vr + t * vr * 2, wy - 4 - height * (0.12 + 0.88 * y) * edge]);
  }
  key.push([cx + vr * 1.02, wy]);
  const pts = roughen(key, 0.12, 2, rand);
  const top = Math.min(...pts.map((p) => p[1]));
  const skyAt = (x: number) => {
    for (let i = 1; i < pts.length; i++) if (pts[i][0] >= x) return pts[i][1];
    return wy;
  };

  trace(ctx, pts);
  const land = ctx.createLinearGradient(0, top, 0, wy);
  land.addColorStop(0, '#4f5e2c');
  land.addColorStop(1, '#1f2812');
  ctx.fillStyle = land;
  ctx.fill();
  ctx.save();
  trace(ctx, pts);
  ctx.clip();
  facets(ctx, key, wy, [120, 136, 70], [24, 32, 16], 0.6, rand);
  // The canopy: clumps of tree crowns, shadowed below and lit above (batched into a few tones).
  const crowns = Math.min(360, Math.round((vr * 2 * height) / 30));
  const TONES = 5;
  const darkPaths = Array.from({ length: TONES }, () => new Path2D());
  const litPaths = Array.from({ length: TONES }, () => new Path2D());
  for (let i = 0; i < crowns; i++) {
    const x = cx - vr + rand() * vr * 2;
    const sky = skyAt(x);
    if (sky >= wy - 3) continue;
    const y = sky + 1 + rand() ** 1.6 * (wy - sky) * 0.85;
    const r = 2.2 + rand() * 3.4;
    const light = Math.min(1, Math.max(0, 1 - (y - sky) / (wy - sky + 1)) * 0.7 + (x < cx ? 0.2 : 0)) * (0.6 + rand() * 0.4);
    const d = darkPaths[Math.floor(rand() * TONES)];
    d.moveTo(x + 0.8 + r, y + 0.8);
    d.arc(x + 0.8, y + 0.8, r, 0, Math.PI * 2);
    const l = litPaths[Math.min(TONES - 1, Math.floor(light * TONES))];
    l.moveTo(x - r * 0.25 + r * 0.7, y - r * 0.3);
    l.arc(x - r * 0.25, y - r * 0.3, r * 0.7, 0, Math.PI * 2);
  }
  darkPaths.forEach((p, i) => {
    ctx.fillStyle = rgb(mix([22, 30, 14], [44, 58, 24], i / (TONES - 1)));
    ctx.fill(p);
  });
  litPaths.forEach((p, i) => {
    ctx.fillStyle = rgb(mix([52, 68, 30], [128, 142, 70], i / (TONES - 1)));
    ctx.fill(p);
  });
  const shade = ctx.createLinearGradient(cx - vr, 0, cx + vr, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = shade;
  ctx.fillRect(cx - vr * 1.05, top, vr * 2.1, wy - top);
  ctx.restore();
  rimLight(ctx, pts, [230, 220, 150], 1.2);

  // Rocky shore along the waterline, broken by a beach or two.
  const beaches: Array<[number, number]> = [];
  const nBeach = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < nBeach; i++) {
    const bc = cx - vr * 0.7 + rand() * vr * 1.4;
    const bw = vr * (0.25 + rand() * 0.3);
    beaches.push([bc - bw, bc + bw]);
  }
  const onBeach = (x: number) => beaches.some(([a, b]) => x > a && x < b);
  const shoreTop: Pt[] = [];
  for (let x = cx - vr * 1.02; x <= cx + vr * 1.02; x += 3) {
    const tall = onBeach(x) ? 0 : 6 + rand() * 9;
    shoreTop.push([x, wy - Math.min(tall, wy - skyAt(x))]);
  }
  const shore: Pt[] = [[cx - vr * 1.02, wy], ...shoreTop, [cx + vr * 1.02, wy]];
  trace(ctx, shore);
  ctx.fillStyle = rgb(STONES[0].shade);
  ctx.fill();
  ctx.save();
  trace(ctx, shore);
  ctx.clip();
  facets(ctx, shore, wy, STONES[0].lit, STONES[0].base, 0.8, rand);
  grain(ctx, cx - vr * 1.05, wy - 16, cx + vr * 1.05, wy, rand, 'rgba(210,200,180,0.2)', 'rgba(0,0,0,0.25)');
  wetLine(ctx, cx - vr * 1.05, cx + vr * 1.05, wy, 6, true, rand);
  ctx.restore();
  for (const [a, b] of beaches) {
    ctx.beginPath();
    ctx.moveTo(a - 6, wy);
    ctx.quadraticCurveTo((a + b) / 2, wy - 9, b + 6, wy);
    ctx.closePath();
    const sand = ctx.createLinearGradient(0, wy - 9, 0, wy);
    sand.addColorStop(0, '#e2d2a6');
    sand.addColorStop(0.7, '#c4b084');
    sand.addColorStop(1, '#8e7c58');
    ctx.fillStyle = sand;
    ctx.fill();
  }

  const palms = 2 + Math.floor(rand() * 4);
  for (let i = 0; i < palms; i++) {
    const near = beaches[i % beaches.length];
    const px = i < beaches.length * 2 ? near[0] + rand() * (near[1] - near[0]) : cx - vr * 0.75 + rand() * vr * 1.5;
    palm(ctx, px, Math.min(wy - 5, skyAt(px) + 6), rand);
  }

  // The Society's lighthouse: a white tower banded in red, its lamp lit.
  if (towerH > 0) {
    const tx = cx + (rand() - 0.5) * vr * 0.6;
    const base = skyAt(tx) + 6;
    const tw = 9;
    ctx.beginPath();
    ctx.moveTo(tx - tw, base);
    ctx.lineTo(tx - tw * 0.6, base - towerH);
    ctx.lineTo(tx + tw * 0.6, base - towerH);
    ctx.lineTo(tx + tw, base);
    ctx.closePath();
    const tower = ctx.createLinearGradient(tx - tw, 0, tx + tw, 0);
    tower.addColorStop(0, '#fbf6ea');
    tower.addColorStop(0.45, '#e2dccb');
    tower.addColorStop(1, '#8e887a');
    ctx.fillStyle = tower;
    ctx.fill();
    ctx.save();
    ctx.clip();
    for (let b = 0; b < 3; b++) {
      const y = base - towerH * (0.18 + b * 0.27);
      const band = ctx.createLinearGradient(tx - tw, 0, tx + tw, 0);
      band.addColorStop(0, '#c4473a');
      band.addColorStop(1, '#5e1c16');
      ctx.fillStyle = band;
      ctx.fillRect(tx - tw, y - 5, tw * 2, 7);
    }
    ctx.restore();
    ctx.fillStyle = '#1c1c1e';
    ctx.fillRect(tx - tw * 0.8, base - towerH - 2, tw * 1.6, 3);
    ctx.fillRect(tx - tw * 0.45, base - towerH - 10, tw * 0.9, 8);
    ctx.beginPath();
    ctx.moveTo(tx - tw * 0.55, base - towerH - 10);
    ctx.lineTo(tx, base - towerH - 15);
    ctx.lineTo(tx + tw * 0.55, base - towerH - 10);
    ctx.fill();
    const lamp = ctx.createRadialGradient(tx, base - towerH - 6, 0, tx, base - towerH - 6, 18);
    lamp.addColorStop(0, 'rgba(255,236,170,1)');
    lamp.addColorStop(0.3, 'rgba(255,214,120,0.6)');
    lamp.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.fillStyle = lamp;
    ctx.fillRect(tx - 18, base - towerH - 24, 36, 36);
  }

  // A fort of the Globe Lobby: a curtain wall of dressed stone, a round tower, a faded flag.
  if (fort) {
    const fx = cx + (rand() - 0.5) * vr * 0.5;
    const base = skyAt(fx) + 8;
    const fw = Math.min(vr * 0.9, 110);
    const wall = () => {
      ctx.beginPath();
      ctx.moveTo(fx - fw / 2, base + 6);
      ctx.lineTo(fx - fw / 2, base - 26);
      for (let x = fx - fw / 2; x < fx + fw / 2 - 1; x += 10) {
        ctx.lineTo(x, base - 32);
        ctx.lineTo(x + 5, base - 32);
        ctx.lineTo(x + 5, base - 26);
        ctx.lineTo(Math.min(fx + fw / 2, x + 10), base - 26);
      }
      ctx.lineTo(fx + fw / 2, base + 6);
      ctx.closePath();
      ctx.moveTo(fx + fw / 2 - 24, base + 6);
      ctx.rect(fx + fw / 2 - 24, base - 62, 24, 68);
      for (let x = fx + fw / 2 - 24; x < fx + fw / 2; x += 8) ctx.rect(x, base - 68, 4, 6);
    };
    const stone = ctx.createLinearGradient(fx - fw / 2, 0, fx + fw / 2, 0);
    stone.addColorStop(0, '#cdbd9a');
    stone.addColorStop(1, '#6a5e48');
    wall();
    ctx.fillStyle = stone;
    ctx.fill();
    ctx.save();
    wall();
    ctx.clip();
    ctx.strokeStyle = 'rgba(40,32,20,0.3)';
    ctx.lineWidth = 0.5;
    for (let y = base + 4; y > base - 68; y -= 4) {
      const off = ((base - y) / 4) % 2 ? 3 : 0;
      ctx.beginPath();
      ctx.moveTo(fx - fw / 2, y);
      ctx.lineTo(fx + fw / 2, y);
      for (let x = fx - fw / 2 + off; x < fx + fw / 2; x += 7) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - 4);
      }
      ctx.stroke();
    }
    grain(ctx, fx - fw / 2, base - 70, fx + fw / 2, base + 6, rand, 'rgba(255,240,210,0.15)', 'rgba(0,0,0,0.2)', 0.08);
    const sh = ctx.createLinearGradient(0, base - 70, 0, base + 6);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = sh;
    ctx.fillRect(fx - fw / 2, base - 70, fw, 76);
    ctx.restore();
    ctx.fillStyle = '#140d06';
    ctx.beginPath();
    ctx.moveTo(fx - 7, base + 6);
    ctx.lineTo(fx - 7, base - 8);
    ctx.quadraticCurveTo(fx, base - 16, fx + 7, base - 8);
    ctx.lineTo(fx + 7, base + 6);
    ctx.closePath();
    ctx.fill();
    const tx = fx + fw / 2 - 12;
    ctx.fillRect(tx - 2, base - 48, 4, 9);
    ctx.beginPath();
    ctx.moveTo(tx, base - 68);
    ctx.lineTo(tx, base - 92);
    ctx.strokeStyle = '#2a1a0b';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx, base - 92);
    ctx.quadraticCurveTo(tx + 9, base - 94, tx + 18, base - 90);
    ctx.lineTo(tx + 17, base - 80);
    ctx.quadraticCurveTo(tx + 9, base - 82, tx, base - 80);
    ctx.closePath();
    ctx.fillStyle = 'rgba(52,78,112,0.92)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(tx + 9, base - 86, 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(214,204,178,0.85)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  reflect(c, ctx, wy, below - 4, 0.35, rand);
  foamBand(ctx, cx, wy, vr * 1.06, rand);
  return { canvas: c, ax: cx * SS, ay: wy * SS, scale: SS };
}

/**
 * A wide, flat-topped shelf of ice: sheer cliffs of fractured columns, a snow crust on top, meltwater
 * grooves, a wave-cut notch and an ice cave, the great bulk below the surface, and a few penguins.
 */
export function iceShelfSprite(shape: number, half: number): SideSprite {
  const rand = mulberry32(shape);
  const height = 85 + rand() * 40;
  const below = 60;
  const w = half * 2 + 40;
  const wy = height + 40;
  const h = wy + below;
  const [c, ctx] = makeCanvas(w, h);
  const cx = w / 2;
  const x0 = cx - half;
  const x1 = cx + half;

  // Body: steep cliffs, a gently uneven table on top.
  const top: Pt[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    top.push([x0 + 10 + t * (half * 2 - 20), wy - height + (rand() - 0.5) * 8]);
  }
  const outlinePts: Pt[] = roughen([[x0, wy], [x0 + 6, wy - height * 0.55], ...top, [x1 - 6, wy - height * 0.5], [x1, wy]], 0.08, 2, rand);
  trace(ctx, outlinePts);
  const g = ctx.createLinearGradient(0, wy - height, 0, wy);
  g.addColorStop(0, '#f4fafc');
  g.addColorStop(0.4, '#cfe4ec');
  g.addColorStop(1, '#7eaec2');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  trace(ctx, outlinePts);
  ctx.clip();
  // The cliff face: fractured columns, each catching the light a little differently.
  for (let x = x0; x < x1; ) {
    const cw = 6 + rand() * 14;
    const lit = rand();
    ctx.fillStyle = lit < 0.5 ? `rgba(255,255,255,${0.15 + lit * 0.4})` : `rgba(70,120,160,${(lit - 0.5) * 0.45})`;
    ctx.beginPath();
    ctx.moveTo(x, wy - height - 4);
    ctx.lineTo(x + cw, wy - height - 4);
    ctx.lineTo(x + cw + (rand() - 0.5) * 6, wy + 2);
    ctx.lineTo(x + (rand() - 0.5) * 6, wy + 2);
    ctx.closePath();
    ctx.fill();
    x += cw;
  }
  // Strata, meltwater grooves and crevasses.
  ctx.strokeStyle = 'rgba(70,130,160,0.18)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 2; i++) {
    const y = wy - height * (0.3 + i * 0.3 + rand() * 0.08);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.bezierCurveTo(cx - half * 0.3, y - 3, cx + half * 0.3, y + 4, x1, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(110,160,190,0.3)';
  ctx.lineWidth = 0.7;
  for (let i = 0; i < half / 6; i++) {
    const x = x0 + rand() * half * 2;
    ctx.beginPath();
    ctx.moveTo(x, wy - height + 8 + rand() * 20);
    ctx.lineTo(x + (rand() - 0.5) * 3, wy);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(30,80,110,0.6)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < Math.round(half / 40); i++) {
    const x = x0 + 20 + rand() * (half * 2 - 40);
    ctx.beginPath();
    ctx.moveTo(x, wy - height + 6);
    ctx.lineTo(x + (rand() - 0.5) * 8, wy - height * 0.6);
    ctx.lineTo(x + (rand() - 0.5) * 12, wy - height * 0.3);
    ctx.stroke();
  }
  grain(ctx, x0, wy - height, x1, wy, rand, 'rgba(255,255,255,0.35)', 'rgba(100,150,180,0.15)', 0.02);
  // The wave-cut notch.
  ctx.beginPath();
  ctx.moveTo(x0, wy + 2);
  for (let x = x0; x <= x1; x += 5) ctx.lineTo(x, wy - 5 - rand() * 4);
  ctx.lineTo(x1, wy + 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(40,130,160,0.55)';
  ctx.fill();
  // An ice cave at the waterline, glowing blue within.
  const caveX = x0 + half * (0.4 + rand() * 1.2);
  const caveW = 26 + rand() * 18;
  const cave = ctx.createRadialGradient(caveX, wy - caveW * 0.3, 2, caveX, wy - caveW * 0.5, caveW * 1.3);
  cave.addColorStop(0, '#0a2433');
  cave.addColorStop(0.6, '#1d4f6a');
  cave.addColorStop(1, '#5aa2bf');
  ctx.fillStyle = cave;
  ctx.beginPath();
  ctx.moveTo(caveX - caveW, wy);
  ctx.quadraticCurveTo(caveX - caveW, wy - caveW * 1.2, caveX, wy - caveW * 1.25);
  ctx.quadraticCurveTo(caveX + caveW, wy - caveW * 1.2, caveX + caveW, wy);
  ctx.closePath();
  ctx.fill();
  const shade = ctx.createLinearGradient(x0, 0, x1, 0);
  shade.addColorStop(0, 'rgba(60,110,150,0)');
  shade.addColorStop(1, 'rgba(60,110,150,0.25)');
  ctx.fillStyle = shade;
  ctx.fillRect(x0, wy - height - 6, half * 2, height + 8);
  ctx.restore();
  // Snow crust and icicles.
  ctx.beginPath();
  ctx.moveTo(top[0][0], top[0][1]);
  for (const [x, y] of top) ctx.lineTo(x, y - 2);
  for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i][0], top[i][1] + 6 + (i % 3) * 2);
  ctx.closePath();
  const snow = ctx.createLinearGradient(0, wy - height - 3, 0, wy - height + 10);
  snow.addColorStop(0, '#ffffff');
  snow.addColorStop(1, '#dfeef4');
  ctx.fillStyle = snow;
  ctx.fill();
  ctx.fillStyle = 'rgba(220,240,250,0.95)';
  for (let i = 0; i < half / 14; i++) {
    const x = x0 + 14 + rand() * (half * 2 - 28);
    const y = wy - height + 9;
    const len = 4 + rand() * 9;
    ctx.beginPath();
    ctx.moveTo(x - 1.6, y);
    ctx.lineTo(x + 1.6, y);
    ctx.lineTo(x, y + len);
    ctx.closePath();
    ctx.fill();
  }
  rimLight(ctx, outlinePts, [255, 255, 255], 1.4);
  trace(ctx, outlinePts);
  ctx.strokeStyle = 'rgba(60,110,140,0.5)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  // Penguins, who have their own views on the shape of the world.
  const penguins = 2 + Math.floor(rand() * 4);
  for (let i = 0; i < penguins; i++) {
    const [px, py] = top[1 + Math.floor(rand() * (top.length - 2))];
    ctx.fillStyle = '#121418';
    ctx.beginPath();
    ctx.ellipse(px, py - 7, 3.4, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2f2ee';
    ctx.beginPath();
    ctx.ellipse(px + 0.6, py - 6, 2, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e0902c';
    ctx.fillRect(px + 1.5, py - 12, 2.5, 1.2);
  }

  reflect(c, ctx, wy, below - 4, 0.4, rand);
  ctx.beginPath();
  ctx.moveTo(x0, wy + 1);
  ctx.quadraticCurveTo(x0 - 20, wy + below * 0.6, cx, wy + below * 0.95);
  ctx.quadraticCurveTo(x1 + 20, wy + below * 0.6, x1, wy + 1);
  ctx.closePath();
  const deep = ctx.createLinearGradient(0, wy, 0, wy + below);
  deep.addColorStop(0, 'rgba(110,205,214,0.4)');
  deep.addColorStop(1, 'rgba(110,205,214,0)');
  ctx.fillStyle = deep;
  ctx.fill();
  foamBand(ctx, cx, wy, half * 1.04, rand);
  return { canvas: c, ax: cx * SS, ay: wy * SS, scale: SS };
}

/**
 * The leviathan: a kraken's great head breaking the surface, eyes aglow, drawn
 * fresh each frame so it breathes and blinks. (x, y) is the waterline on screen.
 */
export function drawLeviathan(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, r: number, seed: number, time: number, alpha: number): void {
  const W = r * 1.45;
  const H = r * 1.55 * (1 + 0.035 * Math.sin(time * 1.3 + seed));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(k, k);
  // Its bulk, dark beneath the water.
  ctx.beginPath();
  ctx.ellipse(0, 6, W * 1.25, 14, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,0,10,0.45)';
  ctx.fill();
  // The head.
  const tilt = ((seed % 7) - 3) * 0.04 * W;
  const dome = () => {
    ctx.beginPath();
    ctx.moveTo(-W, 0);
    ctx.bezierCurveTo(-W * 1.02, -H * 0.75, -W * 0.45 + tilt, -H * 1.08, tilt, -H);
    ctx.bezierCurveTo(W * 0.45 + tilt, -H * 1.08, W * 1.02, -H * 0.75, W, 0);
    ctx.closePath();
  };
  dome();
  const g = ctx.createLinearGradient(-W, -H, W, 0);
  g.addColorStop(0, '#8a3a6a');
  g.addColorStop(0.45, '#4e1a3e');
  g.addColorStop(1, '#1c0616');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  dome();
  ctx.clip();
  // Ridges and mottling.
  ctx.strokeStyle = 'rgba(20,4,16,0.55)';
  ctx.lineWidth = 2.2;
  for (let i = 1; i <= 3; i++) {
    ctx.beginPath();
    ctx.ellipse(tilt * 0.5, 0, W * (0.3 + i * 0.2), H * (0.35 + i * 0.2), 0, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(230,190,210,0.35)';
  for (let i = 0; i < 14; i++) {
    const a = ((seed * (i + 3)) % 100) / 100;
    const b = ((seed * (i + 7)) % 97) / 97;
    ctx.beginPath();
    ctx.arc(-W * 0.8 + a * W * 1.6, -H * 0.1 - b * H * 0.75, 1.5 + (i % 3), 0, Math.PI * 2);
    ctx.fill();
  }
  // Water streaming off the brow.
  ctx.strokeStyle = 'rgba(233,241,234,0.55)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 6; i++) {
    const sx = -W * 0.7 + i * W * 0.28;
    const phase = (time * 0.9 + i * 0.37) % 1;
    ctx.beginPath();
    ctx.moveTo(sx, -H * (0.85 - phase * 0.7));
    ctx.lineTo(sx + 1, -H * (0.7 - phase * 0.7));
    ctx.stroke();
  }
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#120310';
  dome();
  ctx.stroke();
  // Brows and eyes, which blink now and then.
  const blink = (time + (seed % 50) * 0.1) % 5.2 < 0.16 ? 0.12 : 1;
  for (const side of [-1, 1]) {
    const ex = side * W * 0.38 + tilt * 0.3;
    const ey = -H * 0.52;
    const er = r * 0.2;
    const glow = ctx.createRadialGradient(ex, ey, 0, ex, ey, er * 3.2);
    glow.addColorStop(0, 'rgba(255,190,60,0.55)');
    glow.addColorStop(1, 'rgba(255,190,60,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(ex - er * 3.2, ey - er * 3.2, er * 6.4, er * 6.4);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.scale(1, blink);
    ctx.beginPath();
    ctx.ellipse(0, 0, er * 1.25, er, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb63a';
    ctx.fill();
    ctx.strokeStyle = '#2a0820';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, er * 0.22, er * 0.85, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0206';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(ex - side * er * 1.6, ey - er * 1.1);
    ctx.quadraticCurveTo(ex, ey - er * 2, ex + side * er * 1.5, ey - er * 1.6);
    ctx.strokeStyle = '#1c0414';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  // Foam where it breaks the surface.
  ctx.beginPath();
  ctx.ellipse(0, 0, W * 1.08, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(233,241,234,0.75)';
  ctx.fill();
  ctx.restore();
}

/** Height of the Colossus's hips above the water: the ship sails between its legs, beneath. */
export const COLOSSUS_HIP = 215;

/**
 * The Colossus of the Society, standing astride the gap: bronze gone green,
 * a lantern raised towards the Edge, the disc of the world on its shield.
 * (x, y) is the waterline midway between its feet; `half` is the distance from
 * there to each foot, in world units.
 */
export function drawColossus(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, half: number, time: number, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(k, k);
  const hipX = Math.max(half * 0.5, 38);
  const shoulderX = hipX + 52;
  const bronze = (x0: number, x1: number) => {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, '#7cb3a0');
    g.addColorStop(0.45, '#4a8473');
    g.addColorStop(1, '#22423a');
    return g;
  };
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#13261f';
  ctx.lineWidth = 2;
  // Plinths.
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#9a8a6c';
    ctx.fillRect(side * half - 38, -26, 76, 26);
    ctx.strokeRect(side * half - 38, -26, 76, 26);
    ctx.fillStyle = PALETTE.goldDeep;
    ctx.fillRect(side * half - 38, -20, 76, 4);
  }
  // Legs, from the feet on the plinths up to the hips.
  for (const side of [-1, 1]) {
    const fx = side * half;
    const hx = side * hipX;
    ctx.beginPath();
    ctx.moveTo(fx - 22, -26);
    ctx.lineTo(fx + 22, -26);
    ctx.quadraticCurveTo((fx + hx) / 2 + 24, -120, hx + 28, -COLOSSUS_HIP);
    ctx.lineTo(hx - 28, -COLOSSUS_HIP);
    ctx.quadraticCurveTo((fx + hx) / 2 - 24, -120, fx - 22, -26);
    ctx.closePath();
    ctx.fillStyle = bronze(fx - 30, fx + 30);
    ctx.fill();
    ctx.stroke();
    // Greave and sandal straps.
    ctx.strokeStyle = PALETTE.gold;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(fx - 22 + (hx - fx) * 0.25, -80);
    ctx.lineTo(fx + 22 + (hx - fx) * 0.25, -84);
    ctx.stroke();
    ctx.lineWidth = 2;
    for (const yy of [-34, -44]) {
      ctx.beginPath();
      ctx.moveTo(fx - 20, yy);
      ctx.lineTo(fx + 20, yy - 3);
      ctx.stroke();
    }
    ctx.strokeStyle = '#13261f';
  }
  // Kilt of bronze strips.
  ctx.beginPath();
  ctx.moveTo(-hipX - 36, -COLOSSUS_HIP + 14);
  ctx.lineTo(hipX + 36, -COLOSSUS_HIP + 14);
  ctx.lineTo(hipX + 24, -262);
  ctx.lineTo(-hipX - 24, -262);
  ctx.closePath();
  ctx.fillStyle = bronze(-hipX - 36, hipX + 36);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(19,38,31,0.7)';
  ctx.lineWidth = 1.5;
  for (let xx = -hipX - 24; xx <= hipX + 24; xx += 14) {
    ctx.beginPath();
    ctx.moveTo(xx, -262);
    ctx.lineTo(xx * 1.12, -COLOSSUS_HIP + 14);
    ctx.stroke();
  }
  ctx.fillStyle = PALETTE.gold;
  ctx.fillRect(-hipX - 26, -268, (hipX + 26) * 2, 8);
  // Torso and breastplate with the Society's emblem.
  ctx.strokeStyle = '#13261f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-hipX - 20, -264);
  ctx.quadraticCurveTo(-hipX - 6, -320, -shoulderX, -382);
  ctx.lineTo(shoulderX, -382);
  ctx.quadraticCurveTo(hipX + 6, -320, hipX + 20, -264);
  ctx.closePath();
  ctx.fillStyle = bronze(-shoulderX, shoulderX);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -330, 24, 0, Math.PI * 2);
  ctx.strokeStyle = PALETTE.goldBright;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.moveTo(Math.cos(a) * 7, -330 + Math.sin(a) * 7);
    ctx.lineTo(Math.cos(a) * 20, -330 + Math.sin(a) * 20);
  }
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // The left arm holds the shield: the disc of the world, rimmed in ice.
  ctx.strokeStyle = '#13261f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-shoulderX + 6, -380);
  ctx.quadraticCurveTo(-shoulderX - 30, -340, -shoulderX - 18, -292);
  ctx.lineTo(-shoulderX + 4, -292);
  ctx.quadraticCurveTo(-shoulderX - 6, -336, -shoulderX + 26, -372);
  ctx.closePath();
  ctx.fillStyle = bronze(-shoulderX - 30, -shoulderX + 26);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-shoulderX - 14, -292, 46, 0, Math.PI * 2);
  ctx.fillStyle = '#3e6a60';
  ctx.fill();
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-shoulderX - 14, -292, 34, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(236,240,232,0.8)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rr = i % 2 === 0 ? 28 : 10;
    const px = -shoulderX - 14 + Math.cos(a) * rr;
    const py = -292 + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = PALETTE.goldBright;
  ctx.fill();
  // The right arm raises a lantern towards the Edge.
  ctx.beginPath();
  ctx.moveTo(shoulderX - 24, -380);
  ctx.quadraticCurveTo(shoulderX + 14, -420, shoulderX + 14, -470);
  ctx.lineTo(shoulderX + 36, -470);
  ctx.quadraticCurveTo(shoulderX + 34, -410, shoulderX - 2, -366);
  ctx.closePath();
  ctx.fillStyle = bronze(shoulderX - 24, shoulderX + 36);
  ctx.strokeStyle = '#13261f';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  const lx = shoulderX + 25;
  const ly = -492;
  ctx.fillStyle = '#2a1a0b';
  ctx.fillRect(lx - 12, ly + 6, 24, 16);
  const flicker = 1 + 0.12 * Math.sin(time * 11) + 0.06 * Math.sin(time * 23);
  const fire = ctx.createRadialGradient(lx, ly, 0, lx, ly, 60 * flicker);
  fire.addColorStop(0, 'rgba(255,240,180,1)');
  fire.addColorStop(0.25, 'rgba(255,190,90,0.75)');
  fire.addColorStop(1, 'rgba(255,150,50,0)');
  ctx.fillStyle = fire;
  ctx.fillRect(lx - 60, ly - 60, 120, 120);
  // Head, with a laurel crown of gold.
  ctx.fillStyle = bronze(-26, 26);
  ctx.fillRect(-12, -398, 24, 18);
  ctx.beginPath();
  ctx.arc(0, -420, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(19,38,31,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-11, -424);
  ctx.lineTo(-4, -424);
  ctx.moveTo(4, -424);
  ctx.lineTo(11, -424);
  ctx.moveTo(0, -421);
  ctx.lineTo(0, -410);
  ctx.moveTo(-6, -404);
  ctx.lineTo(6, -404);
  ctx.stroke();
  ctx.fillStyle = PALETTE.gold;
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (1.05 + i * 0.1);
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * 26, -420 + Math.sin(a) * 26, 6, 3, a + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  // Foam about the plinths.
  ctx.fillStyle = 'rgba(233,241,234,0.75)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * half, 0, 46, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Wreckage of a less careful expedition: a barrel, planks, or a broken mast — waterlogged and weedy. */
export function debrisSideSprite(shape: number, vr: number): SideSprite {
  const rand = mulberry32(shape);
  const kind = Math.floor(rand() * 3);
  const below = 16;
  const w = vr * 2.6 + 20;
  const wy = vr * 2.6 + 10;
  const h = wy + below;
  const [c, ctx] = makeCanvas(w, h);
  const cx = w / 2;
  const wood = (x0: number, y0: number, x1: number, y1: number) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    const tone = mix([132, 96, 60], [92, 66, 40], rand());
    g.addColorStop(0, rgb(mix(tone, [200, 170, 130], 0.25)));
    g.addColorStop(0.5, rgb(tone));
    g.addColorStop(1, rgb(mix(tone, [20, 14, 8], 0.6)));
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = 'rgba(30,20,10,0.35)';
    ctx.lineWidth = 0.4;
    for (let k = 0; k < 3; k++) {
      const y = y0 + ((k + 1) * (y1 - y0)) / 4 + (rand() - 0.5);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.bezierCurveTo(x0 + (x1 - x0) * 0.3, y - 0.8, x0 + (x1 - x0) * 0.7, y + 0.8, x1, y);
      ctx.stroke();
    }
  };
  if (kind === 0) {
    // A barrel bobbing, half sunk: staves, iron hoops, a lid.
    const bw = vr * 0.85;
    const bh = vr * 1.25;
    ctx.save();
    ctx.translate(cx, wy + bh * 0.15);
    ctx.rotate((rand() - 0.5) * 0.6);
    const body = () => {
      ctx.beginPath();
      ctx.moveTo(-bw * 0.85, 0);
      ctx.quadraticCurveTo(-bw * 1.1, -bh / 2, -bw * 0.85, -bh);
      ctx.lineTo(bw * 0.85, -bh);
      ctx.quadraticCurveTo(bw * 1.1, -bh / 2, bw * 0.85, 0);
      ctx.closePath();
    };
    body();
    const g = ctx.createLinearGradient(-bw, 0, bw, 0);
    g.addColorStop(0, '#9a6c3e');
    g.addColorStop(0.35, '#7c5430');
    g.addColorStop(1, '#2c1c0c');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.save();
    body();
    ctx.clip();
    ctx.strokeStyle = 'rgba(30,18,8,0.55)';
    ctx.lineWidth = 0.6;
    for (let k = -3; k <= 3; k++) {
      ctx.beginPath();
      ctx.moveTo((k / 3.5) * bw * 0.85, 0);
      ctx.quadraticCurveTo((k / 3.5) * bw * 1.1, -bh / 2, (k / 3.5) * bw * 0.85, -bh);
      ctx.stroke();
    }
    for (const t of [0.18, 0.82]) {
      const hoop = ctx.createLinearGradient(-bw, 0, bw, 0);
      hoop.addColorStop(0, '#7a7a76');
      hoop.addColorStop(0.3, '#4a4a48');
      hoop.addColorStop(1, '#141414');
      ctx.fillStyle = hoop;
      ctx.fillRect(-bw * 1.1, -bh * t - 1.4, bw * 2.2, 2.8);
    }
    grain(ctx, -bw, -bh, bw, 0, rand, 'rgba(220,190,150,0.12)', 'rgba(0,0,0,0.18)', 0.1);
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(0, -bh, bw * 0.85, bw * 0.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#5e3e20';
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,12,6,0.6)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.restore();
  } else if (kind === 1) {
    // Planks and a spar, awash.
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.translate(cx + (rand() - 0.5) * vr * 0.6, wy - 1.5 - i * 2.6);
      ctx.rotate((rand() - 0.5) * 0.5);
      const pw = vr * (1.6 + rand() * 0.6);
      wood(-pw / 2, -4, pw / 2, 1.5);
      // A splintered end.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.moveTo(pw / 2 + 1, -4.5);
      ctx.lineTo(pw / 2 - 4 - rand() * 4, -2.5);
      ctx.lineTo(pw / 2 - 1, -1);
      ctx.lineTo(pw / 2 - 5, 0.5);
      ctx.lineTo(pw / 2 + 1, 2);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }
    ctx.save();
    ctx.translate(cx - vr * 0.15, wy - 5);
    ctx.rotate(-1.35 + (rand() - 0.5) * 0.3);
    wood(0, -1.6, vr * 0.95, 1.6);
    ctx.restore();
  } else {
    // A broken mast with a rag of sail, leaning out of the sea.
    const lean = (rand() < 0.5 ? -1 : 1) * (0.35 + rand() * 0.3);
    const len = vr * 2.1;
    ctx.save();
    ctx.translate(cx, wy);
    ctx.rotate(lean);
    wood(-1.8, -len, 1.8, 0);
    ctx.beginPath();
    ctx.moveTo(-1.8, -len);
    ctx.lineTo(-0.6, -len - 3);
    ctx.lineTo(0.6, -len + 1);
    ctx.lineTo(1.8, -len - 2);
    ctx.lineTo(1.8, -len);
    ctx.fillStyle = '#6e4c2a';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.75);
    ctx.lineTo(16, -len * 0.7);
    ctx.lineTo(13, -len * 0.5);
    ctx.lineTo(7, -len * 0.47);
    ctx.lineTo(0, -len * 0.45);
    ctx.closePath();
    const sail = ctx.createLinearGradient(0, -len * 0.75, 14, -len * 0.45);
    sail.addColorStop(0, 'rgba(214,200,166,0.92)');
    sail.addColorStop(1, 'rgba(146,130,98,0.92)');
    ctx.fillStyle = sail;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(cx, wy - 2);
    wood(-vr * 0.7, -3, vr * 0.7, 2);
    ctx.restore();
  }
  reflect(c, ctx, wy, below - 2, 0.3, rand);
  foamBand(ctx, cx, wy, vr * 1.05, rand);
  return { canvas: c, ax: cx * SS, ay: wy * SS, scale: SS };
}

export interface ShipPose {
  /** Screen position of the waterline centre. */
  x: number;
  y: number;
  /** Screen pixels per world unit. */
  scale: number;
  /** Roll in radians (positive leans to starboard). */
  bank: number;
  time: number;
  /** -1…1: how hard the helm is over (the pennant and sail respond). */
  helm: number;
  alpha: number;
}

/** The explorer's vessel, seen from astern. */
export function drawShipStern(ctx: CanvasRenderingContext2D, p: ShipPose): void {
  const k = p.scale;
  ctx.save();
  ctx.globalAlpha = p.alpha;
  ctx.translate(p.x, p.y);
  ctx.scale(k, k);

  // Shadow on the water.
  ctx.beginPath();
  ctx.ellipse(0, 3, 40, 9, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fill();

  ctx.rotate(p.bank);
  const bob = Math.sin(p.time * 3.1) * 1.2;
  ctx.translate(0, bob);

  // Hull (stern view): wide at the rail, rounding to the keel.
  const hw = 32;
  const hh = 30;
  ctx.beginPath();
  ctx.moveTo(-hw, -hh);
  ctx.lineTo(hw, -hh);
  ctx.bezierCurveTo(hw * 1.02, -hh * 0.3, hw * 0.55, 4, 0, 6);
  ctx.bezierCurveTo(-hw * 0.55, 4, -hw * 1.02, -hh * 0.3, -hw, -hh);
  ctx.closePath();
  const hull = ctx.createLinearGradient(-hw, 0, hw, 0);
  hull.addColorStop(0, '#3a2512');
  hull.addColorStop(0.45, PALETTE.woodLight);
  hull.addColorStop(1, '#2a1a0b');
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = '#120a04';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // Planking.
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(20,12,4,0.5)';
  ctx.lineWidth = 0.7;
  for (let y = -hh + 6; y < 6; y += 5) {
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.quadraticCurveTo(0, y + 2.5, hw, y);
    ctx.stroke();
  }
  ctx.restore();
  // Gilded rail and transom.
  ctx.fillStyle = PALETTE.gold;
  ctx.fillRect(-hw - 2, -hh - 4, hw * 2 + 4, 4);
  ctx.strokeStyle = '#4a320c';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(-hw - 2, -hh - 4, hw * 2 + 4, 4);
  // Stern windows, lit.
  for (const wx of [-16, 0, 16]) {
    ctx.fillStyle = '#ffd98a';
    ctx.fillRect(wx - 4.5, -hh + 5, 9, 7);
    ctx.strokeStyle = '#3a2512';
    ctx.lineWidth = 1;
    ctx.strokeRect(wx - 4.5, -hh + 5, 9, 7);
  }
  // Society crest on the transom.
  ctx.beginPath();
  ctx.arc(0, -hh + 20, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.goldBright;
  ctx.fill();
  ctx.strokeStyle = '#4a320c';
  ctx.stroke();
  // Rudder.
  ctx.fillStyle = '#24170a';
  ctx.fillRect(-2.5, -8, 5, 15);
  // Stern lantern.
  ctx.beginPath();
  ctx.arc(0, -hh - 9, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd98a';
  ctx.fill();
  const glow = ctx.createRadialGradient(0, -hh - 9, 0, 0, -hh - 9, 18);
  glow.addColorStop(0, 'rgba(255,217,138,0.5)');
  glow.addColorStop(1, 'rgba(255,217,138,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-18, -hh - 27, 36, 36);

  // Mast.
  const deck = -hh - 4;
  const top = deck - 118;
  ctx.beginPath();
  ctx.moveTo(0, deck);
  ctx.lineTo(0, top);
  ctx.strokeStyle = '#2a1a0b';
  ctx.lineWidth = 3.2;
  ctx.stroke();

  // Courses: main sail and topsail, seen from behind, bellying with the wind (and the helm).
  const sail = (yTop: number, yBot: number, half: number, belly: number) => {
    const lean = p.helm * 6;
    ctx.beginPath();
    ctx.moveTo(-half, yTop);
    ctx.lineTo(half, yTop);
    ctx.quadraticCurveTo(half + belly * 0.25 + lean, (yTop + yBot) / 2, half * 0.92 + lean * 0.5, yBot);
    ctx.quadraticCurveTo(lean * 0.6, yBot + belly, -half * 0.92 + lean * 0.5, yBot);
    ctx.quadraticCurveTo(-half - belly * 0.25 + lean, (yTop + yBot) / 2, -half, yTop);
    ctx.closePath();
    const g = ctx.createLinearGradient(-half, 0, half, 0);
    g.addColorStop(0, '#cbbd98');
    g.addColorStop(0.5, PALETTE.sail);
    g.addColorStop(1, '#bfae86');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(70,50,22,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Seams.
    ctx.strokeStyle = 'rgba(120,96,58,0.35)';
    ctx.lineWidth = 0.6;
    for (let i = 1; i < 4; i++) {
      const x = -half + (i * half * 2) / 4;
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.quadraticCurveTo(x * 0.96 + lean * 0.4, (yTop + yBot) / 2, x * 0.92 + lean * 0.5, yBot + belly * 0.4);
      ctx.stroke();
    }
    // Yard.
    ctx.beginPath();
    ctx.moveTo(-half - 4, yTop);
    ctx.lineTo(half + 4, yTop);
    ctx.strokeStyle = '#2a1a0b';
    ctx.lineWidth = 2.6;
    ctx.stroke();
  };
  const billow = 4 + Math.sin(p.time * 1.7) * 1.5;
  sail(deck - 84, deck - 20, 44, 8 + billow);
  sail(top + 8, deck - 90, 32, 5 + billow * 0.6);
  // The Society's emblem on the main course: the disc of the world and its rim.
  ctx.beginPath();
  ctx.arc(p.helm * 3, deck - 52, 13, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(140,90,43,0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p.helm * 3, deck - 52, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(140,90,43,0.85)';
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.moveTo(p.helm * 3 + Math.cos(a) * 5.5, deck - 52 + Math.sin(a) * 5.5);
    ctx.lineTo(p.helm * 3 + Math.cos(a) * 11, deck - 52 + Math.sin(a) * 11);
  }
  ctx.lineWidth = 1;
  ctx.stroke();

  // Pennant streaming from the masthead (it swings away from the turn).
  const flutter = Math.sin(p.time * 9) * 2;
  const stream = -p.helm * 22;
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.quadraticCurveTo(stream * 0.5, top - 4 + flutter, stream, top + 2 + flutter * 1.5);
  ctx.lineTo(stream * 0.55, top + 6 + flutter * 0.5);
  ctx.lineTo(0, top + 7);
  ctx.closePath();
  ctx.fillStyle = PALETTE.gold;
  ctx.fill();
  ctx.restore();
}
