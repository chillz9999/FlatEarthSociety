/**
 * Procedural artwork for the Society Test, drawn in the manner of an
 * engraved antique nautical chart. Everything is generated at runtime from
 * seeds — there are no image assets to load — and expensive pieces are
 * rendered once into offscreen sprites.
 *
 * Randomness here is purely cosmetic and never touches the simulation.
 */

export const PALETTE = {
  ink: '#0d0b08',
  abyss: '#050607',
  sea: '#16343b',
  seaDeep: '#0f262c',
  seaLine: '#2d5a63',
  seaGlint: '#7fb0b0',
  foam: '#e9f1ea',
  gold: '#c9a24a',
  goldBright: '#f2d57e',
  goldDeep: '#7c5619',
  bronze: '#8c5a2b',
  parchment: '#e8dcc0',
  parchmentDark: '#c8b48a',
  rock: '#2a2520',
  rockLight: '#6f6152',
  wood: '#5b3a1e',
  woodLight: '#8b5e34',
  sail: '#efe4c6',
  danger: '#d9a441',
} as const;

/** Small fast cosmetic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Sprite = { canvas: HTMLCanvasElement | OffscreenCanvas; size: number; scale: number };

function makeCanvas(px: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}


/** A super coin — a broad gold doubloon set with a cut ruby, its rim stamped with rays. */
export function superCoinSprite(radius: number): Sprite {
  const size = Math.ceil(radius * 2 + 8);
  const S = 4;
  const [c, ctx] = makeCanvas(size * S);
  ctx.scale(S, S);
  ctx.translate(size / 2, size / 2);
  const g = ctx.createRadialGradient(-radius * 0.35, -radius * 0.4, radius * 0.1, 0, 0, radius);
  g.addColorStop(0, '#fff6cf');
  g.addColorStop(0.3, '#ffe08a');
  g.addColorStop(0.7, PALETTE.gold);
  g.addColorStop(1, '#5e3d0c');
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#3d2706';
  ctx.stroke();
  // Stamped rays around the rim.
  ctx.strokeStyle = 'rgba(74,50,12,0.7)';
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * radius * 0.62, Math.sin(a) * radius * 0.62);
    ctx.lineTo(Math.cos(a) * radius * 0.9, Math.sin(a) * radius * 0.9);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.58, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(61,39,6,0.85)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  // The ruby: an octagon cut with a bright table and dark pavilion facets.
  const rr = radius * 0.42;
  const pts: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  const rg = ctx.createRadialGradient(-rr * 0.3, -rr * 0.35, rr * 0.05, 0, 0, rr);
  rg.addColorStop(0, '#ffb3a6');
  rg.addColorStop(0.35, '#e0343a');
  rg.addColorStop(1, '#5c0710');
  ctx.fillStyle = rg;
  ctx.fill();
  ctx.strokeStyle = '#3d2706';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,210,200,0.35)';
  ctx.lineWidth = 0.4;
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.moveTo(x * 0.5, y * 0.5);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const [x, y] = pts[i];
    if (i) ctx.lineTo(x * 0.5, y * 0.5);
    else ctx.moveTo(x * 0.5, y * 0.5);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(-rr * 0.3, -rr * 0.35, rr * 0.22, rr * 0.12, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fill();
  return { canvas: c, size, scale: S };
}

/** A treasure coin — gold with a rope border and a compass star. */
export function medallionSprite(radius: number): Sprite {
  const size = Math.ceil(radius * 2 + 8);
  const S = 4;
  const [c, ctx] = makeCanvas(size * S);
  ctx.scale(S, S);
  ctx.translate(size / 2, size / 2);
  const g = ctx.createRadialGradient(-radius * 0.35, -radius * 0.4, radius * 0.1, 0, 0, radius);
  g.addColorStop(0, '#fff1b8');
  g.addColorStop(0.35, PALETTE.goldBright);
  g.addColorStop(0.75, PALETTE.gold);
  g.addColorStop(1, PALETTE.goldDeep);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = '#4a320c';
  ctx.stroke();
  // Rope border.
  const n = 22;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ctx.save();
    ctx.rotate(a);
    ctx.translate(radius * 0.8, 0);
    ctx.rotate(0.6);
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 0.16, radius * 0.07, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(74,50,12,0.75)';
    ctx.lineWidth = 0.45;
    ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.62, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(74,50,12,0.8)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  // Compass star.
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? radius * 0.5 : radius * 0.18;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#6b4a14';
  ctx.fill();
  return { canvas: c, size, scale: S };
}

/** A soft round mist puff for the rim of the world. */
export function mistSprite(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(230,238,232,0.35)');
  g.addColorStop(0.5, 'rgba(230,238,232,0.12)');
  g.addColorStop(1, 'rgba(230,238,232,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** Faint stars of the void beyond the Edge. */
export function starTile(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const rand = mulberry32(0x57a2);
  for (let i = 0; i < 140; i++) {
    const r = rand() * 1.2 + 0.2;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(230,220,190,${0.15 + rand() * 0.45})`;
    ctx.fill();
  }
  return c;
}
