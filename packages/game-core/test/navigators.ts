import { Simulation, straightOpenings, type RowRecord } from '../src/sim';
import type { Steer } from '../src/types';

/**
 * Reference navigators for the fairness tests. Unlike the bots they read the
 * generator's row records, so they know exactly where each row lies — what
 * they prove is that the course itself never demands the impossible.
 */

/** The next row the ship has not yet fully passed. */
export function upcomingRow(sim: Simulation): RowRecord | undefined {
  const aft = sim.config.ship.hitRadius - Math.min(...sim.config.ship.hitOffsets);
  return sim.rows.find((r) => r.pattern !== 'empty' && r.z + r.back + aft >= sim.ship.z);
}

/** Hazards belonging to a row (rows never overlap along the course). */
export function rowBlocked(sim: Simulation, row: RowRecord, pad: number): Array<[number, number]> {
  const blocked: Array<[number, number]> = [];
  for (const o of sim.obstacles) {
    if (o.z - o.r >= row.z - row.front - 1 && o.z + o.r <= row.z + row.back + 1) blocked.push([o.x - o.r - pad, o.x + o.r + pad]);
  }
  for (const w of sim.whirlpools) if (w.z === row.z) blocked.push([w.x - w.coreRadius - 40, w.x + w.coreRadius + 40]);
  return blocked;
}

/** Bang-bang helm: full steer towards `target`, letting go in time to stop on it. */
function steerTo(sim: Simulation, target: number): Steer {
  const ship = sim.ship;
  const cfg = sim.config;
  const dx = target - ship.x;
  if (Math.abs(dx) < 3) return 0;
  const decel = ship.lateralSpeed / cfg.ship.lateralDecelTime;
  const stop = (ship.vx * ship.vx) / (2 * decel) + Math.abs(ship.vx) / cfg.tickRate;
  if (Math.sign(ship.vx) === Math.sign(dx) && Math.abs(dx) <= stop) return 0;
  return dx > 0 ? 1 : -1;
}

/** Follows each row's designated passage. */
export function passageNavigator(sim: Simulation): Steer {
  const row = upcomingRow(sim);
  return row ? steerTo(sim, row.passage) : 0;
}

/**
 * Heads for the nearest straight-through gap of the next row, from wherever
 * the ship happens to be — a greedy, human-like strategy that never looks
 * further than one row ahead.
 */
export function nearestGapNavigator(sim: Simulation): Steer {
  const row = upcomingRow(sim);
  if (!row) return 0;
  const openings = straightOpenings(sim.config.channelHalfWidth, rowBlocked(sim, row, sim.config.ship.hitRadius + 1));
  let target = sim.ship.x;
  let best = Number.POSITIVE_INFINITY;
  for (const [a, b] of openings) {
    const slack = Math.min(12, (b - a) / 2);
    const t = Math.min(b - slack, Math.max(a + slack, sim.ship.x));
    const d = Math.abs(t - sim.ship.x);
    if (d < best) {
      best = d;
      target = t;
    }
  }
  return steerTo(sim, target);
}

/**
 * Chases every piece of evidence it can still reach before each row (taking
 * the nearest first), then heads for the nearest gap — proving that no piece
 * of evidence is a trap: wherever one lies, a way through the row ahead is
 * still within reach.
 */
export function coinHunterNavigator(sim: Simulation): Steer {
  const ship = sim.ship;
  const row = upcomingRow(sim);
  const fore = Math.max(...sim.config.ship.hitOffsets) + sim.config.ship.hitRadius;
  const limit = row ? row.z - row.front - fore : Number.POSITIVE_INFINITY;
  let best: { x: number; z: number } | null = null;
  for (const e of sim.evidence) {
    if (e.z <= ship.z + 20 || e.z > limit) continue;
    // Only what a sensible explorer would go for: reachable in time, with a little to spare.
    const time = (e.z - ship.z) / ship.speed;
    const reach = ship.lateralSpeed * Math.max(0, time - 0.15) * 0.8 + sim.config.evidence.pickupRadius * 0.5;
    if (Math.abs(e.x - ship.x) > reach) continue;
    if (!best || e.z < best.z) best = e;
  }
  return best ? steerTo(sim, best.x) : nearestGapNavigator(sim);
}
