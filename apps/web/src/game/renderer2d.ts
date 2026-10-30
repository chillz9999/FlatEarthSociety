import { STAGES, stageIndexAt, type Evidence, type Obstacle, type Simulation, type Whirlpool } from '@fes/game-core';
import { PALETTE, medallionSprite, mistSprite, mulberry32, starTile, superCoinSprite, type Sprite } from './art';
import {
  PILLAR_HEIGHT,
  debrisSideSprite,
  drawColossus,
  drawGateArch,
  drawLeviathan,
  drawShipStern,
  drawTentacle,
  iceShelfSprite,
  icebergSideSprite,
  islandSideSprite,
  pillarSideSprite,
  rockSideSprite,
  wreckSideSprite,
  type SideSprite,
} from './art3d';
import { Particles } from './particles';

import type { DeathView, FrameView } from './view';

export type { DeathView, FrameView };

/** Nearest and furthest depths drawn (world units ahead of the camera). */
const NEAR = 40;
const FAR = 3200;
/** Hazards drawn fresh every frame (they move), rather than from a cached sprite. */
const LIVE_KINDS = new Set(['tentacle', 'leviathan', 'colossus']);

type RGB = [number, number, number];

/** The light of each stage: golden dusk, an amber evening, a red storm sunset, violet twilight, and night at the Edge. */
interface Palette {
  skyTop: RGB;
  skyMid: RGB;
  haze: RGB;
  sun: RGB;
  seaNear: RGB;
  seaFar: RGB;
  stars: number;
  aurora: number;
  clouds: number;
}

const PALETTES: readonly Palette[] = [
  { skyTop: [11, 21, 25], skyMid: [34, 65, 63], haze: [199, 168, 108], sun: [255, 226, 160], seaNear: [22, 53, 60], seaFar: [74, 102, 96], stars: 0.45, aurora: 0, clouds: 0.13 },
  { skyTop: [16, 20, 34], skyMid: [62, 58, 72], haze: [218, 150, 88], sun: [255, 196, 128], seaNear: [20, 47, 58], seaFar: [92, 96, 90], stars: 0.4, aurora: 0, clouds: 0.18 },
  { skyTop: [20, 10, 18], skyMid: [86, 34, 46], haze: [214, 100, 70], sun: [255, 140, 96], seaNear: [22, 36, 48], seaFar: [96, 70, 78], stars: 0.35, aurora: 0, clouds: 0.26 },
  { skyTop: [8, 8, 26], skyMid: [46, 34, 88], haze: [146, 106, 170], sun: [232, 186, 255], seaNear: [14, 30, 50], seaFar: [64, 62, 104], stars: 0.75, aurora: 0.6, clouds: 0.14 },
  { skyTop: [3, 5, 12], skyMid: [12, 30, 46], haze: [84, 134, 146], sun: [218, 236, 255], seaNear: [10, 26, 38], seaFar: [44, 78, 92], stars: 1, aurora: 1, clouds: 0.08 },
];

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const rgba = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

/** The palette for a moment of the voyage, easing from one stage's light to the next over eight seconds. */
function paletteAt(tSec: number): Palette {
  const i = stageIndexAt(tSec);
  const cur = PALETTES[i];
  if (i === 0) return cur;
  const t = Math.min(1, (tSec - STAGES[i].startSec) / 8);
  const e = t * t * (3 - 2 * t);
  const p = PALETTES[i - 1];
  return {
    skyTop: mixRGB(p.skyTop, cur.skyTop, e),
    skyMid: mixRGB(p.skyMid, cur.skyMid, e),
    haze: mixRGB(p.haze, cur.haze, e),
    sun: mixRGB(p.sun, cur.sun, e),
    seaNear: mixRGB(p.seaNear, cur.seaNear, e),
    seaFar: mixRGB(p.seaFar, cur.seaFar, e),
    stars: mix(p.stars, cur.stars, e),
    aurora: mix(p.aurora, cur.aurora, e),
    clouds: mix(p.clouds, cur.clouds, e),
  };
}

interface Cam {
  x: number;
  y: number;
  z: number;
  f: number;
  cx: number;
  hy: number;
}

interface Billboard {
  dz: number;
  draw: () => void;
}

/**
 * Draws a frame of the Society Test from a chase camera behind the ship:
 * a perspective projection of the charted channel, the Edge of the World
 * pouring away on either side, and every hazard as an upright engraving.
 * Owns no game state: it renders whatever the simulation and runner hand it.
 *
 * This is the Canvas-2D fallback, used where WebGL is unavailable (see `renderer.ts`).
 */
export class Renderer2D {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private readonly sprites = new Map<number, SideSprite>();
  private readonly starPattern: CanvasPattern;
  private readonly medallion: Sprite;
  private readonly superCoin: Sprite;
  private readonly mist: HTMLCanvasElement;
  readonly particles = new Particles();
  private wake: { x: number; z: number }[] = [];
  private iceWall: number[] = [];
  private readonly cam: Cam = { x: 0, y: 240, z: 0, f: 400, cx: 0, hy: 0 };
  private readonly pt = { x: 0, y: 0, s: 0 };
  private sprayClock = 0;
  private pal: Palette = PALETTES[0];
  private hw = 440;
  /** Rolling average of render time in ms (diagnostics). */
  renderMs = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.starPattern = ctx.createPattern(starTile(), 'repeat')!;
    this.medallion = medallionSprite(16);
    this.superCoin = superCoinSprite(24);
    this.mist = mistSprite();
    const rand = mulberry32(0x1ce);
    for (let i = 0; i < 64; i++) this.iceWall.push(rand());
    this.resize();
  }

  /** Nothing to release: a 2D canvas holds no GPU resources of ours. */
  destroy(): void {
    this.sprites.clear();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  /** Pre-build sprites for the hazards already charted so the first seconds never stutter. */
  warm(sim: Simulation): void {
    for (const o of sim.obstacles) if (!o.hidden && !LIVE_KINDS.has(o.kind)) this.sprite(o);
    this.wake = [];
    this.particles.items.length = 0;
  }

  resetForRun(_seed: string): void {
    this.sprites.clear();
    this.wake = [];
    this.particles.items.length = 0;
  }


  /**
   * Build the sprites of hazards about to come into view, a few each frame, so that a crowded row never
   * makes one frame build them all at once.
   */
  private prebuild(sim: Simulation, budgetMs: number): void {
    const t0 = performance.now();
    for (const o of sim.obstacles) {
      if (o.hidden || LIVE_KINDS.has(o.kind) || this.sprites.has(o.id)) continue;
      this.sprite(o);
      if (performance.now() - t0 > budgetMs) return;
    }
  }

  private sprite(o: Obstacle): SideSprite {
    let s = this.sprites.get(o.id);
    if (!s) {
      s =
        o.kind === 'island'
          ? islandSideSprite(o.shape, o.vr)
          : o.kind === 'debris'
            ? debrisSideSprite(o.shape, o.vr)
            : o.kind === 'iceberg'
              ? o.form === 'shelf'
                ? iceShelfSprite(o.shape, o.vr)
                : icebergSideSprite(o.shape, o.vr)
              : o.kind === 'wreck'
                ? wreckSideSprite(o.shape, o.vr)
                : o.kind === 'pillar'
                  ? pillarSideSprite(o.shape, o.vr)
                  : rockSideSprite(o.shape, o.vr);
      this.sprites.set(o.id, s);
    }
    return s;
  }

  /** Project a world point; null when behind the near plane. Reuses one object — copy what you keep. */
  private project(x: number, y: number, z: number): { x: number; y: number; s: number } | null {
    const c = this.cam;
    const dz = z - c.z;
    // A little tolerance: far down the course, (cam.z + NEAR) − cam.z can round to just under NEAR.
    if (dz < NEAR - 0.01) return null;
    const s = c.f / dz;
    this.pt.x = c.cx + (x - c.x) * s;
    this.pt.y = c.hy + (c.y - y) * s;
    this.pt.s = s;
    return this.pt;
  }

  render(v: FrameView): void {
    const t0 = performance.now();
    this.draw(v);
    this.renderMs = this.renderMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  private draw(v: FrameView): void {
    const { ctx } = this;
    const W = this.width;
    const H = this.height;
    const sim = v.sim;
    const cfg = sim.config;
    const hw = cfg.channelHalfWidth;
    const speedFrac = Math.max(0, Math.min(1, (v.speed - cfg.ship.baseSpeed) / (cfg.ship.maxSpeed - cfg.ship.baseSpeed)));

    // Camera: low behind the stern; it pulls back and widens a little as the ship gathers speed.
    const back = 330 + 50 * speedFrac;
    const anchorZ = v.death ? v.death.z : v.shipZ;
    const cam = this.cam;
    cam.f = H * (0.66 - 0.1 * speedFrac);
    cam.y = 235 + 25 * speedFrac;
    cam.z = anchorZ - back;
    cam.x = v.camX + (v.shake ? (Math.random() - 0.5) * v.shake * 2 : 0);
    cam.cx = W / 2;
    cam.hy = H * 0.3 + (v.shake ? (Math.random() - 0.5) * v.shake : 0);

    this.pal = paletteAt(sim.timeSeconds);
    this.hw = hw;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSky(W, H, v.time);
    this.drawVoid(W, H, v.time);
    this.drawFalls(hw, v.time, -1);
    this.drawFalls(hw, v.time, 1);
    this.drawSea(hw, W, H, v.time);
    this.drawLips(hw, v.time);
    for (const w of sim.whirlpools) this.drawWhirlpool(w, v.time);
    this.drawWake(v);

    this.prebuild(sim, 3);
    // Upright things, furthest first.
    const items: Billboard[] = [];
    const pairs = new Map<number, Obstacle>();
    for (const o of sim.obstacles) {
      const dz = o.z - cam.z;
      if (o.hidden || dz < NEAR || dz > FAR) continue;
      if (o.kind === 'tentacle') items.push({ dz, draw: () => this.drawTentacleAt(o, dz, v.time) });
      else if (o.kind === 'leviathan') items.push({ dz, draw: () => this.drawLeviathanAt(o, dz, v.time) });
      else if (o.kind !== 'colossus') items.push({ dz, draw: () => this.drawObstacle(o, dz) });
      // The two pillars of a gate, and the two legs of the Colossus, share a field id: once both are
      // known, the arch (or the statue) goes up between them.
      if ((o.kind === 'pillar' || o.kind === 'colossus') && o.fieldId) {
        const other = pairs.get(o.fieldId);
        if (!other) pairs.set(o.fieldId, o);
        else if (o.kind === 'pillar') items.push({ dz: dz - 0.5, draw: () => this.drawArch(other, o, dz, v.time) });
        else items.push({ dz: dz - 0.5, draw: () => this.drawColossusAt(other, o, dz, v.time) });
      }
    }
    for (const e of sim.evidence) {
      const dz = e.z - cam.z;
      if (dz < NEAR || dz > FAR) continue;
      items.push({ dz, draw: () => this.drawEvidence(e, dz, v.time) });
    }
    const ship = this.shipPose(v);
    if (ship) items.push({ dz: ship.z - cam.z, draw: () => this.drawShip(v, ship) });
    items.sort((a, b) => b.dz - a.dz);
    for (const it of items) it.draw();

    this.particles.update(v.dt);
    this.particles.draw(ctx, (x, y, z) => this.project(x, y, z));
    this.bowSpray(v, ship);

    this.drawHorizonMist(W, H);
    this.drawSpeedLines(W, H, speedFrac, v);
    this.drawVignette(W, H, v);
  }

  // ------------------------------------------------------------- backdrop

  private drawSky(W: number, H: number, time: number): void {
    const { ctx } = this;
    const hy = this.cam.hy;
    const g = ctx.createLinearGradient(0, 0, 0, hy);
    const pal = this.pal;
    g.addColorStop(0, rgba(pal.skyTop));
    g.addColorStop(0.55, rgba(pal.skyMid));
    g.addColorStop(1, rgba(pal.haze));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, hy + 1);
    // Faint stars in the upper sky.
    ctx.save();
    ctx.globalAlpha = pal.stars;
    ctx.beginPath();
    ctx.rect(0, 0, W, hy * 0.75);
    ctx.clip();
    ctx.fillStyle = this.starPattern;
    ctx.translate(-((time * 2) % 512), 0);
    ctx.fillRect(0, 0, W + 512, hy);
    ctx.restore();
    // The low sun over the Edge, dead ahead.
    const sun = ctx.createRadialGradient(W / 2, hy, 0, W / 2, hy, H * 0.55);
    sun.addColorStop(0, rgba(pal.sun, 0.75));
    sun.addColorStop(0.18, rgba(pal.sun, 0.32));
    sun.addColorStop(1, rgba(pal.sun, 0));
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, W, hy + 2);
    ctx.beginPath();
    ctx.arc(W / 2, hy, H * 0.05, Math.PI, 0);
    ctx.fillStyle = rgba(mixRGB(pal.sun, [255, 255, 255], 0.35), 0.92);
    ctx.fill();
    if (pal.aurora > 0.01) this.drawAurora(W, hy, time, pal.aurora);
    // Engraved cloud bands.
    ctx.strokeStyle = `rgba(232,220,192,${pal.clouds})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      const y = hy * (0.18 + i * 0.075);
      const x0 = ((i * 397 + time * (6 + i)) % (W + 600)) - 300;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.bezierCurveTo(x0 + 80, y - 6, x0 + 160, y + 4, x0 + 260, y - 2);
      ctx.stroke();
    }
    // The ice wall that rings the world, far beyond the Edge.
    ctx.beginPath();
    ctx.moveTo(0, hy);
    const n = this.iceWall.length;
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * W;
      ctx.lineTo(x, hy - 2 - this.iceWall[i % n] * H * 0.012);
    }
    ctx.lineTo(W, hy);
    ctx.closePath();
    ctx.fillStyle = 'rgba(236,240,232,0.55)';
    ctx.fill();
  }

  private drawVoid(W: number, H: number, time: number): void {
    const { ctx } = this;
    const hy = this.cam.hy;
    const g = ctx.createLinearGradient(0, hy, 0, H);
    g.addColorStop(0, '#2a3a38');
    g.addColorStop(0.12, '#0b1416');
    g.addColorStop(1, PALETTE.abyss);
    ctx.fillStyle = g;
    ctx.fillRect(0, hy, W, H - hy);
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = this.starPattern;
    ctx.translate(0, hy - ((time * 6) % 512));
    ctx.fillRect(0, 0, W, H + 512);
    ctx.restore();
  }

  /** The sea pouring off the Edge: a curtain hanging from each side of the channel. */
  private drawFalls(hw: number, time: number, side: -1 | 1): void {
    const { ctx } = this;
    const cam = this.cam;
    const x = side * hw;
    const z0 = cam.z + NEAR;
    const z1 = cam.z + FAR;
    // The curtain, in bands that darken with depth below the lip.
    const bands = 7;
    const bandH = 110;
    for (let i = 0; i < bands; i++) {
      const y0 = -i * bandH;
      const y1 = -(i + 1) * bandH;
      const a = this.project(x, y0, z0);
      if (!a) return;
      const ax = a.x;
      const ay = a.y;
      const b = this.project(x, y0, z1)!;
      const bx = b.x;
      const by = b.y;
      const c = this.project(x, y1, z1)!;
      const cx = c.x;
      const cy = c.y;
      const d = this.project(x, y1, z0)!;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx, cy);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      const f = 1 - i / bands;
      ctx.fillStyle = `rgba(${Math.round(70 + 90 * f)},${Math.round(110 + 90 * f)},${Math.round(112 + 80 * f)},${0.12 + 0.4 * f * f})`;
      ctx.fill();
    }

    // Falling streaks.
    ctx.save();
    ctx.lineCap = 'round';
    for (let k = 0; k < 70; k++) {
      const zz = cam.z + NEAR + 10 + ((k * 53) % 2400);
      const top = this.project(x, 0, zz);
      if (!top) continue;
      const tx = top.x;
      const ty = top.y;
      const s = top.s;
      const bot = this.project(x, -700, zz)!;
      const bx = bot.x;
      const by = bot.y;
      const phase = (time * (0.9 + (k % 5) * 0.08) + k * 0.137) % 1;
      const p0 = phase * phase;
      const p1 = Math.min(1, p0 + 0.08 + phase * 0.1);
      ctx.strokeStyle = `rgba(233,241,234,${0.7 * (1 - phase) * Math.min(1, s * 1.5)})`;
      ctx.lineWidth = Math.max(0.7, s * 7);
      ctx.beginPath();
      ctx.moveTo(tx + (bx - tx) * p0, ty + (by - ty) * p0);
      ctx.lineTo(tx + (bx - tx) * p1, ty + (by - ty) * p1);
      ctx.stroke();
    }
    ctx.restore();

    // Spray rising from the abyss beside the ship.
    for (let k = 0; k < 8; k++) {
      const zz = cam.z + 150 + k * 240 - ((time * 80) % 240);
      const p = this.project(x + side * 40, -60 + Math.sin(time * 0.8 + k) * 30, zz);
      if (!p) continue;
      const size = 600 * p.s;
      ctx.globalAlpha = 0.65;
      ctx.drawImage(this.mist, p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  /** The charted channel: the sea surface and wave engravings. */
  private drawSea(hw: number, W: number, H: number, time: number): void {
    const { ctx } = this;
    const cam = this.cam;
    const nearL = this.project(-hw, 0, cam.z + NEAR)!;
    const nlx = nearL.x;
    const nly = nearL.y;
    const nearR = this.project(hw, 0, cam.z + NEAR)!;
    const nrx = nearR.x;
    const farL = this.project(-hw, 0, cam.z + FAR)!;
    const flx = farL.x;
    const fly = farL.y;
    const farR = this.project(hw, 0, cam.z + FAR)!;
    const frx = farR.x;
    ctx.beginPath();
    ctx.moveTo(nlx, nly);
    ctx.lineTo(flx, fly);
    ctx.lineTo(frx, fly);
    ctx.lineTo(nrx, nly);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, fly, 0, Math.min(nly, H));
    g.addColorStop(0, rgba(this.pal.seaFar));
    g.addColorStop(0.08, rgba(mixRGB(this.pal.seaFar, this.pal.seaNear, 0.45)));
    g.addColorStop(0.35, rgba(mixRGB(this.pal.seaFar, this.pal.seaNear, 0.8)));
    g.addColorStop(1, rgba(this.pal.seaNear));
    ctx.fillStyle = g;
    ctx.fill();

    ctx.save();
    ctx.clip();
    // Glitter of the low sun on the water, straight down the course.
    const glare = ctx.createRadialGradient(W / 2, fly, 0, W / 2, fly, H * 0.45);
    glare.addColorStop(0, rgba(this.pal.sun, 0.32));
    glare.addColorStop(1, rgba(this.pal.sun, 0));
    ctx.fillStyle = glare;
    ctx.fillRect(0, fly, W, H);

    // Engraved wave marks, anchored to the water so they stream past too.
    ctx.strokeStyle = 'rgba(160,200,196,0.22)';
    const band = 120;
    const z0 = Math.ceil((cam.z + NEAR + 20) / band) * band;
    for (let z = z0; z < cam.z + 2000; z += band) {
      const rand = mulberry32(Math.round(z / band) * 2654435761);
      for (let i = 0; i < 7; i++) {
        const x = -hw + 20 + rand() * (hw * 2 - 40);
        const zz = z + rand() * band;
        const p = this.project(x + Math.sin(time * 1.4 + i + z) * 6, 0, zz);
        if (!p) continue;
        const w = 22 * p.s;
        if (w < 1.5) continue;
        ctx.lineWidth = Math.max(0.5, p.s * 2);
        ctx.beginPath();
        ctx.moveTo(p.x - w, p.y);
        ctx.quadraticCurveTo(p.x - w / 2, p.y - w * 0.25, p.x, p.y);
        ctx.quadraticCurveTo(p.x + w / 2, p.y + w * 0.25, p.x + w, p.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Foam where the channel spills over the Edge. */
  private drawLips(hw: number, time: number): void {
    const { ctx } = this;
    const cam = this.cam;
    for (const side of [-1, 1] as const) {
      ctx.beginPath();
      let started = false;
      for (let z = cam.z + NEAR; z < cam.z + FAR; z += z - cam.z < 600 ? 30 : 120) {
        const wob = Math.sin(z * 0.02 + time * 3) * 5;
        const p = this.project(side * (hw - 4) + wob, 2, z);
        if (!p) continue;
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(233,241,234,0.85)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(233,241,234,0.25)';
      ctx.lineWidth = 9;
      ctx.stroke();
    }
  }

  private drawWhirlpool(w: Whirlpool, time: number): void {
    const { ctx } = this;
    const dz = w.z - this.cam.z;
    if (dz < NEAR - w.pullRadius || dz > FAR) return;
    const fog = this.fog(dz);
    ctx.save();
    // Nothing is drawn beyond the channel's lines: clip the swirl to the water.
    this.channelPath();
    ctx.clip();
    const ring = (r: number) => {
      ctx.beginPath();
      let first = true;
      for (let i = 0; i <= 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const p = this.project(w.x + Math.cos(a) * r, 0, w.z + Math.sin(a) * r);
        if (!p) continue;
        if (first) {
          ctx.moveTo(p.x, p.y);
          first = false;
        } else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    };
    ctx.save();
    ctx.globalAlpha = fog;
    ring(w.pullRadius);
    ctx.fillStyle = 'rgba(6,22,26,0.32)';
    ctx.fill();
    ring(w.pullRadius * 0.55);
    ctx.fillStyle = 'rgba(4,14,18,0.35)';
    ctx.fill();
    // Spiral arms turning towards the core.
    for (let arm = 0; arm < 4; arm++) {
      ctx.beginPath();
      let first = true;
      for (let i = 0; i <= 26; i++) {
        const t = i / 26;
        const r = w.pullRadius * (1 - t) + w.coreRadius * t;
        const a = arm * (Math.PI / 2) + w.spin * (time * 2.4 + t * 5.2);
        const p = this.project(w.x + Math.cos(a) * r, 0, w.z + Math.sin(a) * r);
        if (!p) continue;
        if (first) {
          ctx.moveTo(p.x, p.y);
          first = false;
        } else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(233,241,234,0.55)';
      ctx.lineWidth = Math.max(0.8, (this.cam.f / Math.max(dz, NEAR)) * 4);
      ctx.stroke();
    }
    ring(w.coreRadius);
    ctx.fillStyle = '#03080a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(233,241,234,0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  /** The outline of the channel's water on screen (for clipping). */
  private channelPath(): void {
    const { ctx } = this;
    const cam = this.cam;
    const hw = this.hw;
    const a = this.project(-hw, 0, cam.z + NEAR)!;
    const ax = a.x;
    const ay = a.y;
    const b = this.project(-hw, 0, cam.z + FAR)!;
    const bx = b.x;
    const by = b.y;
    const c = this.project(hw, 0, cam.z + FAR)!;
    const cx = c.x;
    const d = this.project(hw, 0, cam.z + NEAR)!;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, by);
    ctx.lineTo(d.x, ay);
    ctx.closePath();
  }

  private drawWake(v: FrameView): void {
    const { ctx } = this;
    if (!v.death) {
      const last = this.wake[this.wake.length - 1];
      if (!last || v.shipZ - last.z > 10) this.wake.push({ x: v.shipX, z: v.shipZ });
      while (this.wake.length > 2 && this.wake[0].z < this.cam.z) this.wake.shift();
    }
    if (this.wake.length < 2) return;
    const head = v.death ? { x: v.death.x, z: v.death.z } : { x: v.shipX, z: v.shipZ };
    // Churned water straight astern…
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let first = true;
    let width = 0;
    for (let i = this.wake.length - 1; i >= 0; i--) {
      const p = this.wake[i];
      const q = this.project(p.x, 0, p.z - 34);
      if (!q) continue;
      if (first) {
        ctx.moveTo(q.x, q.y);
        width = q.s * 18;
        first = false;
      } else ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = 'rgba(233,241,234,0.12)';
    ctx.lineWidth = width;
    ctx.stroke();
    // …then the two arms of the wake spreading behind it, fading as they go.
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      let prev: { x: number; y: number } | null = null;
      for (let i = this.wake.length - 1; i >= 0; i--) {
        const p = this.wake[i];
        const age = head.z - p.z;
        const fade = Math.max(0, 1 - age / 420);
        const wobble = Math.sin(p.z * 0.05 + v.time * 4) * 3;
        const q = this.project(p.x + side * (14 + age * 0.32) + wobble, 0, p.z - 34);
        if (!q) continue;
        const cur = { x: q.x, y: q.y };
        if (prev) {
          ctx.strokeStyle = `rgba(233,241,234,${0.55 * fade})`;
          ctx.lineWidth = Math.max(1, q.s * 3.2);
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(cur.x, cur.y);
          ctx.stroke();
        }
        prev = cur;
      }
    }
  }

  // ------------------------------------------------------------- upright things

  /** 1 near the ship, fading to 0 in the mist at the horizon. */
  private fog(dz: number): number {
    return Math.max(0, Math.min(1, (FAR - dz) / (FAR * 0.38)));
  }

  private drawObstacle(o: Obstacle, dz: number): void {
    const p = this.project(o.x, 0, o.z);
    if (!p) return;
    const s = this.sprite(o);
    const k = p.s / s.scale;
    const w = s.canvas.width * k;
    if (w < 1) return;
    const { ctx } = this;
    ctx.globalAlpha = this.fog(dz);
    ctx.drawImage(s.canvas, p.x - s.ax * k, p.y - s.ay * k, w, s.canvas.height * k);
    ctx.globalAlpha = 1;
  }

  private drawEvidence(e: Evidence, dz: number, time: number): void {
    const { ctx } = this;
    const big = e.superCoin;
    const bob = Math.sin(time * 2.6 + e.id) * (big ? 6 : 4);
    const g = this.project(e.x, 0, e.z);
    if (!g) return;
    const gx = g.x;
    const gy = g.y;
    const gs = g.s;
    const p = this.project(e.x, (big ? 34 : 26) + bob, e.z)!;
    const fog = this.fog(dz);
    const r = (big ? 24 : 16) * gs;
    // Shadow and glow (a super coin's glow is ruby-warm and pulses, with turning rays of light).
    ctx.globalAlpha = fog * 0.5;
    ctx.beginPath();
    ctx.ellipse(gx, gy, r * 1.1, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fill();
    ctx.globalAlpha = fog;
    const reach = r * (big ? 4.2 + Math.sin(time * 5 + e.id) * 0.6 : 3.2);
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, reach);
    glow.addColorStop(0, big ? 'rgba(255,190,120,0.75)' : 'rgba(242,213,126,0.55)');
    glow.addColorStop(big ? 0.45 : 1, big ? 'rgba(230,80,60,0.22)' : 'rgba(242,213,126,0)');
    if (big) glow.addColorStop(1, 'rgba(230,80,60,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(p.x - reach, p.y - reach, reach * 2, reach * 2);
    if (big) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(time * 0.8 + e.id);
      ctx.fillStyle = 'rgba(255,226,150,0.22)';
      for (let i = 0; i < 6; i++) {
        ctx.rotate(Math.PI / 3);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(r * 3.6, -r * 0.28);
        ctx.lineTo(r * 3.6, r * 0.28);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    // The coin, turning.
    const spin = Math.cos(time * (big ? 2.2 : 3) + e.id * 0.7);
    const m = big ? this.superCoin : this.medallion;
    const size = m.size * gs;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(Math.max(0.12, Math.abs(spin)), 1);
    ctx.drawImage(m.canvas as CanvasImageSource, -size / 2, -size / 2, size, size);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawLeviathanAt(o: Obstacle, dz: number, time: number): void {
    const p = this.project(o.x, 0, o.z);
    if (!p) return;
    drawLeviathan(this.ctx, p.x, p.y, p.s, o.r, o.shape, time, this.fog(dz));
  }

  private drawColossusAt(a: Obstacle, b: Obstacle, dz: number, time: number): void {
    const p = this.project((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
    if (!p) return;
    drawColossus(this.ctx, p.x, p.y, p.s, Math.abs(b.x - a.x) / 2, time, this.fog(dz));
  }

  private drawTentacleAt(o: Obstacle, dz: number, time: number): void {
    const p = this.project(o.x, 0, o.z);
    if (!p) return;
    drawTentacle(this.ctx, p.x, p.y, p.s, o.vr, o.shape, time, this.fog(dz));
  }

  /** The arch of a sea gate between its two pillars, with the Society's seal on the keystone. */
  private drawArch(a: Obstacle, b: Obstacle, dz: number, time: number): void {
    const [l, r] = a.x < b.x ? [a, b] : [b, a];
    const span = r.x - l.x;
    const rise = span * 0.32;
    const pts: [number, number][] = [];
    let thickness = 0;
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x = l.x + span * t;
      const y = PILLAR_HEIGHT + 4 + rise * Math.sin(Math.PI * t);
      const q = this.project(x, y, l.z + (r.z - l.z) * t);
      if (!q) return;
      pts.push([q.x, q.y]);
      thickness = 18 * q.s;
    }
    drawGateArch(this.ctx, pts, thickness, this.fog(dz), time);
  }

  /** Curtains of light over the Outer Rim and the Edge. */
  private drawAurora(W: number, hy: number, time: number, strength: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const colours: RGB[] = [
      [90, 255, 170],
      [120, 200, 255],
      [200, 120, 255],
    ];
    for (let band = 0; band < 3; band++) {
      const baseY = hy * (0.22 + band * 0.12);
      const c = colours[band];
      // One gradient per band: bright at the curtain's lower hem, fading upwards.
      const g = ctx.createLinearGradient(0, baseY - hy * 0.26, 0, baseY + hy * 0.09);
      g.addColorStop(0, rgba(c, 0));
      g.addColorStop(0.75, rgba(c, 0.24 * strength));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      for (let x = 0; x < W; x += 6) {
        const wave = Math.sin(x * 0.006 + time * 0.25 + band * 1.7) * hy * 0.07 + Math.sin(x * 0.017 - time * 0.4 + band) * hy * 0.02;
        const y = baseY + wave * 0.6;
        const len = hy * (0.12 + 0.06 * Math.sin(x * 0.011 + time * 0.6 + band * 2.3));
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(x * 0.02 + time + band);
        ctx.fillRect(x, y - len, 6, len + hy * 0.05);
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------- the ship

  private shipPose(v: FrameView): { x: number; y: number; z: number; bank: number; alpha: number } | null {
    const lat = v.sim.ship.lateralSpeed || 1;
    const bank = Math.max(-0.2, Math.min(0.2, (v.vx / lat) * 0.17));
    const d = v.death;
    if (!d) return { x: v.shipX, y: 0, z: v.shipZ, bank, alpha: 1 };
    const t = d.t;
    switch (d.cause) {
      case 'edge': {
        const side = Math.sign(d.x) || 1;
        // Over the lip, a moment's hang, then down into the void.
        const out = Math.max(Math.abs(d.vx), 160) * t * 0.55;
        const fall = Math.max(0, t - 0.2);
        return { x: d.x + side * out, y: -0.5 * 520 * fall * fall, z: d.z + d.speed * 0.3 * Math.min(t, 1), bank: bank + side * t * 1.1, alpha: Math.max(0, 1 - t / 2.3) };
      }
      case 'whirlpool': {
        const w = d.whirlpool;
        if (!w) return { x: d.x, y: -t * 30, z: d.z, bank, alpha: Math.max(0, 1 - t / 1.9) };
        const dx = d.x - w.x;
        const dz = d.z - w.z;
        const r0 = Math.sqrt(dx * dx + dz * dz);
        const a = Math.atan2(dz, dx) + w.spin * t * 6;
        const r = r0 * Math.max(0, 1 - t / 1.4);
        return { x: w.x + Math.cos(a) * r, y: -t * t * 30, z: w.z + Math.sin(a) * r, bank: w.spin * t * 2, alpha: Math.max(0, 1 - t / 1.9) };
      }
      case 'timeout':
        return { x: d.x, y: 0, z: d.z, bank: 0, alpha: 1 };
      default: {
        const side = Math.sign(d.vx) || 1;
        return { x: d.x, y: -t * 20, z: d.z, bank: side * Math.min(0.7, t * 0.9), alpha: Math.max(0, 1 - t / 1.7) };
      }
    }
  }

  private drawShip(v: FrameView, pose: { x: number; y: number; z: number; bank: number; alpha: number }): void {
    const p = this.project(pose.x, pose.y, pose.z);
    if (!p || pose.alpha <= 0) return;
    const lat = v.sim.ship.lateralSpeed || 1;
    // After a bonus life the ship glows and flickers for as long as hazards cannot sink it.
    const shielded = !v.death && v.sim.revived && v.sim.protectedNow;
    const pulse = shielded ? 0.5 + 0.5 * Math.sin(v.time * 10) : 1;
    if (shielded) {
      const { ctx } = this;
      const r = 70 * p.s;
      const cy = p.y - r * 0.3;
      const g = ctx.createRadialGradient(p.x, cy, r * 0.15, p.x, cy, r);
      g.addColorStop(0, `rgba(255,226,140,${0.16 + 0.14 * pulse})`);
      g.addColorStop(1, 'rgba(255,226,140,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, cy, r * 1.1, r * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const alpha = pose.alpha * (shielded ? 0.6 + 0.4 * pulse : 1);
    drawShipStern(this.ctx, { x: p.x, y: p.y, scale: p.s, bank: pose.bank, time: v.time, helm: Math.max(-1, Math.min(1, v.vx / lat)), alpha });
  }

  /** Spray thrown up at the bow, more of it the faster the ship goes. */
  private bowSpray(v: FrameView, pose: { x: number; z: number } | null): void {
    if (!pose || v.death || v.speed <= 0) return;
    this.sprayClock += v.dt * (6 + v.speed / 40);
    while (this.sprayClock > 1) {
      this.sprayClock -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      this.particles.emit({
        kind: 'spray',
        x: pose.x + side * 26,
        y: 4,
        z: pose.z + 30,
        vx: side * (40 + Math.random() * 60) + v.vx * 0.3,
        vy: 60 + Math.random() * 90,
        vz: v.speed * 0.6,
        maxLife: 0.5 + Math.random() * 0.3,
        size: 2 + Math.random() * 2,
        spin: 0,
        color: Math.random() < 0.5 ? '#e9f1ea' : '#cfe0dc',
      });
    }
  }

  // ------------------------------------------------------------- overlays

  private drawHorizonMist(W: number, H: number): void {
    const { ctx } = this;
    const hy = this.cam.hy;
    const g = ctx.createLinearGradient(0, hy - H * 0.03, 0, hy + H * 0.12);
    g.addColorStop(0, rgba(this.pal.haze, 0));
    g.addColorStop(0.3, rgba(this.pal.haze, 0.55));
    g.addColorStop(1, rgba(this.pal.haze, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, hy - H * 0.03, W, H * 0.15);
  }

  private drawSpeedLines(W: number, H: number, speedFrac: number, v: FrameView): void {
    if (speedFrac < 0.25 || v.death) return;
    const { ctx } = this;
    const a = (speedFrac - 0.25) * 0.35;
    ctx.strokeStyle = `rgba(233,241,234,${a})`;
    ctx.lineWidth = 1.2;
    const cx = W / 2;
    const cy = this.cam.hy;
    for (let i = 0; i < 14; i++) {
      const seed = Math.floor(v.time * 9) * 31 + i * 7;
      const r = mulberry32(seed);
      const ang = (r() < 0.5 ? Math.PI * (0.88 + r() * 0.2) : Math.PI * (-0.08 + r() * 0.2)) + (r() - 0.5) * 0.1;
      const d0 = W * (0.42 + r() * 0.2);
      const d1 = d0 + W * (0.08 + r() * 0.1);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * d0, cy + Math.abs(Math.sin(ang)) * d0 * 0.6 + H * 0.1);
      ctx.lineTo(cx + Math.cos(ang) * d1, cy + Math.abs(Math.sin(ang)) * d1 * 0.6 + H * 0.1);
      ctx.stroke();
    }
  }

  private drawVignette(W: number, H: number, v: FrameView): void {
    const { ctx } = this;
    const g = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.35, W / 2, H * 0.55, H * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(5,4,3,0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // A red tint as the ship nears the Edge.
    const hw = v.sim.config.channelHalfWidth;
    const near = v.death ? 0 : Math.max(0, 1 - (hw - Math.abs(v.shipX)) / 120);
    if (near > 0) {
      const side = Math.sign(v.shipX);
      const e = ctx.createLinearGradient(side > 0 ? W : 0, 0, side > 0 ? W * 0.6 : W * 0.4, 0);
      e.addColorStop(0, `rgba(160,40,20,${0.35 * near})`);
      e.addColorStop(1, 'rgba(160,40,20,0)');
      ctx.fillStyle = e;
      ctx.fillRect(0, 0, W, H);
    }
  }
}
