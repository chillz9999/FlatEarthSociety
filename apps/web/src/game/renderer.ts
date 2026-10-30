import type { Simulation } from '@fes/game-core';
import { Renderer3D } from './gl/renderer3d';
import type { Particles } from './particles';
import { Renderer2D } from './renderer2d';
import type { FrameView } from './view';

export type { DeathView, FrameView } from './view';

interface RendererImpl {
  readonly particles: Particles;
  renderMs: number;
  /** The WebGL context is lost (3D only). */
  readonly lost?: boolean;
  resize(): void;
  warm(sim: Simulation): void;
  resetForRun(seed: string): void;
  render(v: FrameView): void;
  destroy(): void;
}

/** Set for the rest of the browser session once the 3D renderer has failed here. */
const FAILED_KEY = 'fes:renderer-failed';
/** How long a lost WebGL context may stay lost before the voyage carries on in 2D. */
const LOST_GRACE_MS = 2000;

/**
 * Which renderer to use: `?renderer=2d|3d` (or localStorage `fes:renderer`) chooses; otherwise WebGL 2 when the
 * browser offers it on real graphics hardware (and the 3D renderer has not failed in this session), else the
 * Canvas-2D renderer.
 */
function choose(): '2d' | '3d' {
  let pref: string | null = null;
  let failed = false;
  try {
    pref = new URLSearchParams(window.location.search).get('renderer') ?? window.localStorage.getItem('fes:renderer');
    failed = window.sessionStorage.getItem(FAILED_KEY) === '1';
  } catch {
    /* storage unavailable */
  }
  if (pref === '2d' || (failed && pref !== '3d')) return '2d';
  // Probe on a scratch canvas: a canvas that has handed out a WebGL context can never fall back to 2D.
  try {
    const probe = document.createElement('canvas');
    const ok = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: pref !== '3d' });
    if (!ok) return '2d';
    ok.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    return '2d';
  }
  return '3d';
}

/**
 * Draws the Society Test: a real-time 3D scene (WebGL, three.js) where the browser can, the original Canvas-2D
 * chart-style renderer where it cannot. If the 3D renderer fails mid-voyage (an error, or a WebGL context the
 * browser does not give back), the voyage carries on in 2D on a fresh canvas laid over the first. Owns no game
 * state: it renders whatever the simulation and runner hand it.
 */
export class Renderer {
  private impl: RendererImpl;
  private current: '2d' | '3d';
  private overlay: HTMLCanvasElement | null = null;
  private lostSince = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    let impl: RendererImpl | null = null;
    if (choose() === '3d') {
      try {
        impl = new Renderer3D(canvas);
      } catch (err) {
        console.warn('3D renderer unavailable, using the 2D chart renderer.', err);
      }
    }
    this.current = impl ? '3d' : '2d';
    this.impl = impl ?? new Renderer2D(canvas);
  }

  get kind(): '2d' | '3d' {
    return this.current;
  }

  get particles(): Particles {
    return this.impl.particles;
  }

  /** Rolling average of render time in ms (diagnostics). */
  get renderMs(): number {
    return this.impl.renderMs;
  }

  resize(): void {
    this.impl.resize();
  }

  /** Prepare what is already charted so the first seconds never stutter. */
  warm(sim: Simulation): void {
    this.impl.warm(sim);
  }

  resetForRun(seed: string): void {
    this.impl.resetForRun(seed);
  }

  render(v: FrameView): void {
    if (this.current === '2d') {
      this.impl.render(v);
      return;
    }
    try {
      this.impl.render(v);
    } catch (err) {
      this.fallBack(err);
      this.impl.render(v);
      return;
    }
    if (!this.impl.lost) {
      this.lostSince = 0;
      return;
    }
    const now = performance.now();
    if (!this.lostSince) this.lostSince = now;
    else if (now - this.lostSince > LOST_GRACE_MS) this.fallBack(new Error('The WebGL context was lost and not restored.'));
  }

  /** Carry on in 2D: the WebGL canvas can never draw in 2D, so draw on a fresh canvas laid over it. */
  private fallBack(reason: unknown): void {
    console.error('The 3D renderer failed; carrying on with the 2D chart renderer.', reason);
    try {
      window.sessionStorage.setItem(FAILED_KEY, '1');
    } catch {
      /* storage unavailable */
    }
    try {
      this.impl.destroy();
    } catch {
      /* already broken */
    }
    const overlay = document.createElement('canvas');
    overlay.className = this.canvas.className;
    // Hidden, not removed: it keeps its size, so the runner's resize observer still sees the stage resize.
    this.canvas.style.visibility = 'hidden';
    this.canvas.after(overlay);
    this.overlay = overlay;
    this.impl = new Renderer2D(overlay);
    this.current = '2d';
  }

  /** Release GPU resources. */
  destroy(): void {
    this.impl.destroy();
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
      this.canvas.style.visibility = '';
    }
  }
}
