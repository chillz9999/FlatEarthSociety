import type { GameConfig } from './config';
import { approach } from './detmath';
import type { ShipState, Steer, Whirlpool } from './types';

/**
 * Smooth sideways steering: holding a key eases the ship up to full sideways
 * speed in a fraction of a second; letting go eases it back to a straight
 * course. Reversing direction passes through the quicker "release" rate, so
 * the ship never feels sluggish or drifts on.
 */
export function steerShip(ship: ShipState, steer: Steer, config: GameConfig, dt: number): void {
  const max = ship.lateralSpeed;
  const target = steer * max;
  const building = steer !== 0 && Math.sign(ship.vx) !== -steer && Math.abs(target) >= Math.abs(ship.vx);
  const time = building ? config.ship.lateralAccelTime : config.ship.lateralDecelTime;
  ship.vx = approach(ship.vx, target, (max / time) * dt);
}

/**
 * Sideways drift from whirlpools near (x, z). The pull points at the core,
 * grows linearly towards the centre and never exceeds `pullFactor` of the
 * ship's sideways speed — so steering away always escapes. Fully predictable.
 */
export function whirlpoolDrift(x: number, z: number, lateralSpeed: number, whirlpools: readonly Whirlpool[], config: GameConfig): number {
  let drift = 0;
  for (let i = 0; i < whirlpools.length; i++) {
    const w = whirlpools[i];
    const dx = w.x - x;
    const dz = w.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= w.pullRadius * w.pullRadius || d2 < 1e-9) continue;
    const d = Math.sqrt(d2);
    const k = 1 - d / w.pullRadius;
    drift += (dx / d) * config.whirlpool.pullFactor * lateralSpeed * k;
  }
  return drift;
}

/** Advance one tick: forward at the current speed, sideways at the steering velocity plus any drift. */
export function moveShip(ship: ShipState, drift: number, dt: number): void {
  ship.x += (ship.vx + drift) * dt;
  ship.z += ship.speed * dt;
  ship.distance += ship.speed * dt;
}

/** World positions (x, z pairs) of the hull's collision circles. */
export function hullPoints(ship: ShipState, config: GameConfig, out: number[]): number[] {
  const offs = config.ship.hitOffsets;
  out.length = offs.length * 2;
  for (let i = 0; i < offs.length; i++) {
    out[i * 2] = ship.x;
    out[i * 2 + 1] = ship.z + offs[i];
  }
  return out;
}
