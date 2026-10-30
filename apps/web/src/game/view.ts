import type { DeathCause, Simulation, Whirlpool } from '@fes/game-core';

/** How the ship was lost, for the death animations. */
export interface DeathView {
  cause: DeathCause;
  /** Seconds since the moment of loss. */
  t: number;
  x: number;
  z: number;
  vx: number;
  speed: number;
  whirlpool: Whirlpool | null;
}

/** Everything a renderer needs to draw one frame. */
export interface FrameView {
  sim: Simulation;
  /** Interpolated ship position: across the channel, and along the course. */
  shipX: number;
  shipZ: number;
  /** Sideways velocity (banking) and forward speed (camera, spray). */
  vx: number;
  speed: number;
  /** Camera position across the channel (smoothed by the runner). */
  camX: number;
  /** Real time in seconds (animation clock). */
  time: number;
  dt: number;
  death: DeathView | null;
  shake: number;
}

/** A ship pose: position, roll and opacity (death animations included). */
export interface ShipPose {
  x: number;
  y: number;
  z: number;
  /** Roll in radians (positive leans to starboard). */
  bank: number;
  alpha: number;
}

/**
 * Where the ship is drawn this frame: on the water, or going over the Edge, into a whirlpool, or down after a
 * crash. Pure presentation — shared by both renderers.
 */
export function shipPoseFor(v: FrameView): ShipPose {
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
