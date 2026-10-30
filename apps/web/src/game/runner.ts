import {
  GAME_VERSION,
  InputRecorder,
  LookaheadBot,
  Simulation,
  type DeathCause,
  type InputEvent,
  type RunResult,
  type SimEvent,
  type Steer,
  type Whirlpool,
} from '@fes/game-core';
import { SoundBoard } from './audio';
import { Renderer, type DeathView } from './renderer';

export type RunMode = 'practice' | 'ranked';

export interface HudState {
  score: number;
  distanceScore: number;
  timeMs: number;
  evidence: number;
  superCoins: number;
  stageIndex: number;
  /** World units between the ship and the nearer Edge. */
  edgeDistance: number;
  protectedShip: boolean;
  /** Position across the channel (0 = centre) and the channel's half width. */
  shipX: number;
  halfWidth: number;
  /** Forward speed, world units per second. */
  speed: number;
}

export interface RunSummary {
  seed: string;
  version: string;
  mode: RunMode;
  result: RunResult;
  inputs: InputEvent[];
  endTick: number;
}

export interface CheckpointSnapshot {
  tick: number;
  inputs: InputEvent[];
  checkpoints: string[];
}

export interface RunnerCallbacks {
  onHud?(h: HudState): void;
  onEvent?(e: SimEvent): void;
  onDeath?(cause: DeathCause): void;
  onEnd?(summary: RunSummary): void;
  onCheckpoint?(snap: CheckpointSnapshot): void;
}

/** How far the camera follows the ship across the channel (1 = keeps it dead centre). */
const CAMERA_FOLLOW = 0.72;

const DEATH_ANIM_SECONDS: Record<DeathCause, number> = {
  edge: 2.4,
  whirlpool: 1.9,
  rock: 1.7,
  island: 1.7,
  debris: 1.7,
  iceberg: 1.7,
  tentacle: 1.9,
  leviathan: 2.1,
  wreck: 1.7,
  pillar: 1.7,
  colossus: 1.7,
  timeout: 0.2,
};

/** Keyboard state → steering. Arrow keys or A/D; both held cancels out. */
/** The steering keys, and which way each turns the ship. */
const STEER_KEYS: Readonly<Record<string, Steer>> = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
/** Keys the page must not act on while the helm has them (no scrolling). */
const HELM_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);

/** A key press meant for a text field (typing a name), not for the helm. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

/**
 * The helm: ← → or A D. Each key is tracked on its own, and when both directions are held the one pressed last
 * wins, so rolling from one key to the other turns the ship at once instead of stalling it.
 */
class Keyboard {
  /** Steering keys held down, oldest first. */
  private readonly held: string[] = [];

  constructor(private readonly onKey: (e: KeyboardEvent) => void) {}

  readonly down = (e: KeyboardEvent): void => {
    if (typing(e)) return;
    if (e.code in STEER_KEYS && !this.held.includes(e.code)) this.held.push(e.code);
    if (HELM_KEYS.has(e.code)) e.preventDefault();
    this.onKey(e);
  };

  readonly up = (e: KeyboardEvent): void => {
    const i = this.held.indexOf(e.code);
    if (i >= 0) this.held.splice(i, 1);
  };

  readonly clear = (): void => {
    this.held.length = 0;
  };

  steer(): Steer {
    const last = this.held[this.held.length - 1];
    return last ? STEER_KEYS[last] : 0;
  }
}

/**
 * Runs one Society Test in the browser: fixed 60 Hz simulation steps from a
 * real-time accumulator, rendering interpolated between steps. In ranked
 * mode time never stops (hiding the tab does not pause the sea); in practice
 * Escape pauses.
 */
export class GameRunner {
  readonly renderer: Renderer;
  readonly sound = new SoundBoard();
  sim: Simulation;
  private recorder = new InputRecorder();
  private readonly keyboard: Keyboard;
  private bot: LookaheadBot | null = null;
  private raf = 0;
  private lastFrame = 0;
  private acc = 0;
  private running = false;
  private paused = false;
  private destroyed = false;
  private prev = { x: 0, z: 0 };
  private camX = 0;
  /** Whirlpools already announced by sound. */
  private heard = new Set<number>();
  private death: DeathView | null = null;
  private renderFailed = false;
  private ended = false;
  private shake = 0;
  private lastHud = 0;
  private lastCheckpointTick = 0;
  private clock = 0;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly mode: RunMode,
    private callbacks: RunnerCallbacks,
    previewSeed = '00000000000000000000000000f1a7ed',
  ) {
    this.renderer = new Renderer(canvas);
    this.keyboard = new Keyboard(() => undefined);
    this.sim = new Simulation(previewSeed);
    this.renderer.resetForRun(previewSeed);
    this.renderer.warm(this.sim);
    this.resetCamera();
    window.addEventListener('keydown', this.keyboard.down);
    window.addEventListener('keyup', this.keyboard.up);
    window.addEventListener('blur', this.keyboard.clear);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver = new ResizeObserver(() => this.renderer.resize());
    this.resizeObserver.observe(canvas);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  setCallbacks(cb: RunnerCallbacks): void {
    this.callbacks = cb;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Prepare a fresh run on the given seed (the world becomes visible, the ship waits). */
  load(seed: string): void {
    this.sim = new Simulation(seed);
    this.recorder = new InputRecorder();
    this.renderer.resetForRun(seed);
    this.renderer.warm(this.sim);
    this.death = null;
    this.ended = false;
    this.running = false;
    this.paused = false;
    this.acc = 0;
    this.lastCheckpointTick = 0;
    this.resetCamera();
  }

  /** Launch: the sea starts moving. */
  begin(): void {
    if (this.running || this.sim.over) return;
    this.sound.ensure();
    this.running = true;
    this.paused = false;
    this.acc = 0;
    this.lastFrame = performance.now();
  }

  setPaused(p: boolean): void {
    if (this.mode !== 'practice' || !this.running || this.sim.over) return;
    this.paused = p;
    this.keyboard.clear();
    this.lastFrame = performance.now();
  }

  /** Development aid: let the lookahead navigator sail (used for screenshots and demos). */
  enableAutopilot(): void {
    this.bot = new LookaheadBot({ seed: this.sim.seed, reactionTicks: 6, replanTicks: 6, horizonTicks: 96, margin: 6, greed: 2 });
  }

  /** Development aid: sail ahead on autopilot instantly (screenshots of later stages). */
  fastForward(seconds: number): void {
    if (!this.bot) return;
    const sim = this.sim;
    const end = sim.tick + Math.round(seconds * sim.config.tickRate);
    while (sim.tick < end && !sim.over) {
      const steer = this.bot.decide(sim);
      this.recorder.record(sim.tick + 1, steer);
      sim.step(steer);
    }
    this.prev = { x: sim.ship.x, z: sim.ship.z };
    this.camX = sim.ship.x * CAMERA_FOLLOW;
    this.renderer.warm(sim);
  }

  /**
   * The bonus life: put the lost ship back on the water where it went down and carry on from the same tick. The
   * revival is written into the input log so the Society's replay takes it at exactly the same moment.
   */
  revive(): boolean {
    const sim = this.sim;
    if (!this.running || !sim.canRevive) return false;
    const lostAt = sim.tick;
    sim.revive();
    this.recorder.revive(lostAt);
    this.death = null;
    this.ended = false;
    this.shake = 0;
    this.keyboard.clear();
    this.prev = { x: sim.ship.x, z: sim.ship.z };
    this.acc = 0;
    this.lastFrame = performance.now();
    this.sound.setEdgeProximity(0);
    // Tell the Society at once that the voyage carries on.
    this.lastCheckpointTick = sim.tick;
    this.callbacks.onCheckpoint?.(this.snapshot());
    return true;
  }

  togglePause(): void {
    this.setPaused(!this.paused);
  }

  setMuted(m: boolean): void {
    this.sound.setMuted(m);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.keyboard.down);
    window.removeEventListener('keyup', this.keyboard.up);
    window.removeEventListener('blur', this.keyboard.clear);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver.disconnect();
    this.renderer.destroy();
    this.sound.dispose();
  }

  snapshot(): CheckpointSnapshot {
    return { tick: this.sim.tick, inputs: [...this.recorder.events], checkpoints: [...this.sim.checkpointHashes] };
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.keyboard.clear();
      // Practice pauses itself; ranked time keeps flowing (no pausing a ranked attempt).
      if (this.mode === 'practice' && this.running && !this.sim.over) this.paused = true;
    }
  };

  private resetCamera(): void {
    const s = this.sim.ship;
    this.prev = { x: s.x, z: s.z };
    this.camX = s.x * CAMERA_FOLLOW;
    this.heard.clear();
  }

  private readonly frame = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const elapsed = Math.max(0, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const frameDt = Math.min(elapsed, 0.1);
    this.clock += frameDt;

    const sim = this.sim;
    const dt = sim.dt;
    if (this.running && !this.paused && !sim.over) {
      this.acc += this.mode === 'ranked' ? elapsed : Math.min(elapsed, 0.25);
      let steps = 0;
      const maxSteps = this.mode === 'ranked' ? 600 : 30;
      while (this.acc >= dt && steps < maxSteps && !sim.over) {
        this.prev.x = sim.ship.x;
        this.prev.z = sim.ship.z;
        const steer: Steer = this.bot ? this.bot.decide(sim) : this.keyboard.steer();
        this.recorder.record(sim.tick + 1, steer);
        sim.step(steer);
        for (const e of sim.events) this.handleEvent(e);
        this.acc -= dt;
        steps++;
      }
      if (this.mode === 'ranked' && sim.tick - this.lastCheckpointTick >= 300 && !sim.over) {
        this.lastCheckpointTick = sim.tick;
        this.callbacks.onCheckpoint?.(this.snapshot());
      }
    }

    // Interpolated position between simulation steps: smooth at any refresh rate.
    const alpha = this.running && !sim.over && !this.paused ? Math.min(1, this.acc / dt) : 1;
    const s = sim.ship;
    const shipX = this.prev.x + (s.x - this.prev.x) * alpha;
    const shipZ = this.prev.z + (s.z - this.prev.z) * alpha;

    // The camera follows the ship across the channel, a little behind and never all the way to the Edge.
    const target = (this.death ? this.death.x : shipX) * CAMERA_FOLLOW;
    this.camX += (target - this.camX) * (1 - Math.exp(-frameDt * (this.death ? 1.5 : 7)));

    if (this.death) this.death.t += frameDt;
    this.shake = Math.max(0, this.shake - frameDt * 30);

    const hw = sim.config.channelHalfWidth;
    const edgeDistance = hw - Math.abs(shipX);
    if (this.running && !sim.over) {
      this.sound.setEdgeProximity(1 - edgeDistance / 200);
      for (const w of sim.whirlpools) {
        if (!this.heard.has(w.id) && w.z - s.z < 900) {
          this.heard.add(w.id);
          this.sound.whirl();
        }
      }
    } else if (!this.death || this.death.cause !== 'edge') this.sound.setEdgeProximity(0);

    // Drawing never holds up the voyage: whatever happens here, the HUD, the result and the replay carry on.
    try {
      this.renderer.render({
        sim,
        shipX,
        shipZ,
        vx: this.death ? 0 : s.vx,
        speed: this.running ? s.speed : 0,
        camX: this.camX,
        time: this.clock,
        dt: frameDt,
        death: this.death,
        shake: this.shake,
      });
    } catch (err) {
      if (!this.renderFailed) console.error('Rendering failed.', err);
      this.renderFailed = true;
    }

    if (now - this.lastHud > 90 || sim.over) {
      this.lastHud = now;
      this.callbacks.onHud?.({
        score: sim.score,
        distanceScore: sim.distanceScore,
        timeMs: Math.round((sim.tick * 1000) / sim.config.tickRate),
        evidence: sim.evidenceCollected,
        superCoins: sim.superCollected,
        stageIndex: sim.stageIndex,
        edgeDistance,
        protectedShip: this.running && sim.protectedNow,
        shipX,
        halfWidth: hw,
        speed: s.speed,
      });
    }

    if (this.death && !this.ended && this.death.t >= DEATH_ANIM_SECONDS[this.death.cause]) {
      this.ended = true;
      const summary: RunSummary = {
        seed: sim.seed,
        version: GAME_VERSION,
        mode: this.mode,
        result: sim.result(),
        inputs: [...this.recorder.events],
        endTick: sim.tick,
      };
      this.callbacks.onEnd?.(summary);
    }
  };

  private handleEvent(e: SimEvent): void {
    const r = this.renderer;
    const s = this.sim.ship;
    switch (e.type) {
      case 'evidence': {
        if (e.superCoin) {
          r.particles.burst('spark', e.x, 34, e.z, 60, 220, ['#ffd27a', '#fff1b8', '#e0343a', '#ff8a6a'], 4, 1.2, 0.2, s.speed * 0.8);
          this.sound.superCoin();
        } else {
          r.particles.burst('spark', e.x, 26, e.z, 22, 140, ['#f2d57e', '#fff1b8', '#c9a24a'], 3, 0.9, 0.2, s.speed * 0.8);
          this.sound.evidence();
        }
        break;
      }
      case 'stage':
        this.sound.stage();
        break;
      case 'nearMiss':
        this.sound.nearMiss();
        break;
      case 'death': {
        let whirl: Whirlpool | null = null;
        if (e.cause === 'whirlpool' && e.whirlpoolId !== undefined) {
          whirl = this.sim.whirlpools.find((w) => w.id === e.whirlpoolId) ?? null;
        }
        this.death = { cause: e.cause, t: 0, x: s.x, z: s.z, vx: s.vx, speed: s.speed, whirlpool: whirl };
        if (e.cause === 'edge') {
          r.particles.burst('spray', s.x, 4, s.z + 20, 60, 160, ['#e9f1ea', '#cfe0dc', '#ffffff'], 4, 1.4, 0.8, s.speed * 0.3);
          this.sound.fall();
        } else if (e.cause === 'whirlpool') {
          r.particles.burst('bubble', s.x, 0, s.z, 30, 50, ['rgba(233,241,234,0.8)'], 3, 1.4, 0.3);
          this.sound.swallowed();
        } else if (e.cause !== 'timeout') {
          r.particles.burst('splinter', s.x, 20, s.z + 30, 40, 200, ['#8b5e34', '#5b3a1e', '#efe4c6', '#3a2512'], 4, 1.3, 0.7);
          r.particles.burst('spray', s.x, 6, s.z + 30, 30, 150, ['#e9f1ea', '#ffffff'], 3, 0.9, 0.9);
          this.shake = 14;
          this.sound.crash();
        }
        this.callbacks.onDeath?.(e.cause);
        break;
      }
      default:
        break;
    }
    this.callbacks.onEvent?.(e);
  }
}
