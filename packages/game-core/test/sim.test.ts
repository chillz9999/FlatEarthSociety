import { describe, expect, it } from 'vitest';
import { LookaheadBot } from '../src/bots';
import { DEFAULT_CONFIG } from '../src/config';
import { difficultyAt } from '../src/difficulty';
import { whirlpoolDrift } from '../src/physics';
import { InputRecorder, runReplay } from '../src/replay';
import { distanceToOpening, Simulation, straightOpenings } from '../src/sim';
import type { Steer } from '../src/types';
import { coinHunterNavigator, nearestGapNavigator, passageNavigator } from './navigators';

const seedFor = (i: number) => (0x5eed + i * 2654435761).toString(16).padStart(32, '0').slice(-32);

function play(seed: string, decide: (sim: Simulation) => Steer, maxTicks = 60 * 60 * 4, keepRows = false) {
  const sim = new Simulation(seed);
  sim.keepRowHistory = keepRows;
  const rec = new InputRecorder();
  while (!sim.over && sim.tick < maxTicks) {
    const s = decide(sim);
    rec.record(sim.tick + 1, s);
    sim.step(s);
  }
  return { sim, inputs: rec.events };
}

const expert = (seed: string) => {
  const bot = new LookaheadBot({ seed, reactionTicks: 6, replanTicks: 6, horizonTicks: 96, margin: 6 });
  return (sim: Simulation) => bot.decide(sim);
};

describe('determinism', () => {
  it('same seed + same inputs ⇒ identical run, and replays reproduce it exactly', { timeout: 30_000 }, () => {
    // The passage navigator is never lost, so the run is long enough to cross many checkpoints.
    const seed = seedFor(1);
    const a = play(seed, passageNavigator, 60 * 60 * 2, true);
    const b = play(seed, passageNavigator, 60 * 60 * 2, true);
    expect(a.sim.over).toBe(false);
    expect(a.sim.result()).toEqual(b.sim.result());

    const replayed = runReplay(seed, a.inputs, a.sim.tick);
    expect(replayed.result()).toEqual(a.sim.result());
    expect(replayed.result().checkpointHashes.length).toBeGreaterThan(5);
  });

  it('different seeds chart different courses', () => {
    const a = new Simulation(seedFor(2));
    const b = new Simulation(seedFor(3));
    expect(a.obstacles.map((o) => o.x)).not.toEqual(b.obstacles.map((o) => o.x));
  });

  it('the course depends only on the seed, never on the steering', () => {
    const seed = seedFor(5);
    const a = new Simulation(seed);
    const b = new Simulation(seed);
    for (let t = 0; t < 60 * 20 && !a.over && !b.over; t++) {
      a.step(0);
      b.step(t % 50 < 10 ? 1 : t % 50 < 20 ? -1 : 0);
    }
    const ids = new Set(a.obstacles.map((o) => o.id));
    const shared = b.obstacles.filter((o) => ids.has(o.id));
    expect(shared.length).toBeGreaterThan(5);
    for (const o of shared) expect(a.obstacles.find((p) => p.id === o.id)).toEqual(o);
  });

  it('the score is distance travelled plus the value of the treasure collected', () => {
    const { sim } = play(seedFor(4), expert(seedFor(4)), 60 * 60);
    const e = sim.config.evidence;
    expect(sim.score).toBe(Math.floor(sim.ship.distance / sim.config.unitsPerPoint) + (sim.evidenceCollected - sim.superCollected) * e.points + sim.superCollected * e.superPoints);
    expect(sim.evidenceCollected).toBeGreaterThan(0);
  });
});

describe('the voyage', () => {
  it('sails straight ahead on its own, faster and faster', () => {
    const sim = new Simulation(seedFor(6));
    let prevSpeed = 0;
    let prevZ = -1;
    // Across the open opening stretch (the first row waits 800 units out), with no hand on the helm.
    for (let t = 0; t < 60; t++) {
      sim.step(0);
      expect(sim.ship.z).toBeGreaterThan(prevZ);
      expect(sim.ship.speed).toBeGreaterThanOrEqual(prevSpeed);
      prevSpeed = sim.ship.speed;
      prevZ = sim.ship.z;
    }
    expect(sim.ship.x).toBe(0);
    let last = 0;
    for (let t = 0; t <= 600; t += 5) {
      const d = difficultyAt(t * 60, DEFAULT_CONFIG);
      expect(d.speed).toBeGreaterThanOrEqual(last);
      last = d.speed;
    }
    expect(difficultyAt(240 * 60, DEFAULT_CONFIG).speed).toBeGreaterThan(difficultyAt(0, DEFAULT_CONFIG).speed * 2);
  });

  it('steers smoothly: eases up to full sideways speed and back, never jumps', () => {
    const sim = new Simulation(seedFor(7));
    const cfg = sim.config;
    let prevVx = 0;
    let prevX = 0;
    const trace: number[] = [];
    const full: number[] = [];
    for (let t = 0; t < 60; t++) {
      sim.step(t < 30 ? 1 : 0);
      // Sideways speed (and the most it may change in one tick) follows the slowly rising top speed.
      const max = sim.ship.lateralSpeed;
      trace.push(sim.ship.vx);
      full.push(max);
      expect(Math.abs(sim.ship.vx - prevVx)).toBeLessThanOrEqual((max / cfg.ship.lateralDecelTime / cfg.tickRate) * 1.0001);
      expect(Math.abs(sim.ship.x - prevX)).toBeLessThan(max / cfg.tickRate + 1e-9);
      prevVx = sim.ship.vx;
      prevX = sim.ship.x;
    }
    const accelTicks = Math.ceil(cfg.ship.lateralAccelTime * cfg.tickRate);
    expect(trace[0]).toBeGreaterThan(0);
    expect(trace[0]).toBeLessThan(full[0]);
    expect(trace[accelTicks] / full[accelTicks]).toBeGreaterThan(0.995);
    expect(trace[30 + Math.ceil(cfg.ship.lateralDecelTime * cfg.tickRate)]).toBe(0);
  });

  it('holding one direction sails off the Edge; letting go never does', () => {
    for (let i = 0; i < 10; i++) {
      const held = play(seedFor(10 + i), () => (i % 2 ? 1 : -1), 60 * 10);
      expect(held.sim.death).toBe('edge');
      expect(held.sim.timeSeconds).toBeLessThan(2);
      const idle = play(seedFor(10 + i), () => 0, 60 * 60 * 3);
      expect(idle.sim.death).not.toBe('edge');
    }
  });

  it('keeps every hazard and every piece of evidence inside the channel’s lines', () => {
    let hazards = 0;
    let coins = 0;
    for (let i = 0; i < 6; i++) {
      const sim = new Simulation(seedFor(60 + i));
      const hw = sim.config.channelHalfWidth;
      const seen = new Set<number>();
      while (!sim.over && sim.tick < 60 * 60 * 4) {
        sim.step(passageNavigator(sim));
        for (const o of sim.obstacles) {
          if (seen.has(o.id)) continue;
          seen.add(o.id);
          hazards++;
          expect(o.x - o.r).toBeGreaterThanOrEqual(-hw - 1e-9);
          expect(o.x + o.r).toBeLessThanOrEqual(hw + 1e-9);
        }
        for (const w of sim.whirlpools) {
          expect(Math.abs(w.x) + w.coreRadius).toBeLessThanOrEqual(hw + 1e-9);
        }
        for (const e of sim.evidence) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          coins++;
          expect(Math.abs(e.x) + sim.config.evidence.radius).toBeLessThanOrEqual(hw);
        }
      }
    }
    expect(hazards).toBeGreaterThan(500);
    expect(coins).toBeGreaterThan(300);
  });

  it('keeps the opening stretch clear', () => {
    for (let i = 0; i < 20; i++) {
      const sim = new Simulation(seedFor(20 + i));
      const first = Math.min(...sim.obstacles.map((o) => o.z - o.r), ...sim.whirlpools.map((w) => w.z - w.coreRadius));
      expect(first).toBeGreaterThan(sim.config.track.firstRowDistance - 200);
    }
  });

  it('an idle helm does not get far (no farming by doing nothing)', () => {
    const times: number[] = [];
    for (let i = 0; i < 30; i++) times.push(play(seedFor(40 + i), () => 0).sim.timeSeconds);
    expect(Math.max(...times), times.map(Math.round).join(',')).toBeLessThan(120);
  });

  it('whirlpools pull, but always more weakly than the helm', () => {
    const cfg = DEFAULT_CONFIG;
    const w = { id: 1, x: 0, z: 0, pullRadius: 200, coreRadius: 26, spin: 1 as const };
    for (let d = 1; d < 260; d += 7) {
      const drift = Math.abs(whirlpoolDrift(d, 0, 500, [w], cfg));
      expect(drift).toBeLessThanOrEqual(500 * cfg.whirlpool.pullFactor);
      expect(drift).toBeLessThan(500 * 0.5);
    }
  });
});

describe('fairness of the course', () => {
  it('every row keeps its passage open and an opening within reach of wherever the ship could be', { timeout: 120_000 }, () => {
    const cfg = DEFAULT_CONFIG;
    const hw = cfg.channelHalfWidth;
    const start = difficultyAt(0, cfg);
    // Sideways reach per unit sailed is greatest at launch and only shrinks as the ship speeds up.
    const maxRatio = start.lateralSpeed / start.speed;
    for (let i = 0; i < 12; i++) {
      const sim = new Simulation(seedFor(100 + i));
      sim.keepRowHistory = true;
      // Hazards are pruned once passed, so gather them as they are laid.
      const hazards = new Map<number, { z0: number; z1: number; ship: [number, number]; raw: [number, number]; whirlZ?: number }>();
      while (!sim.over && sim.tick < 60 * 60 * 6) {
        sim.step(passageNavigator(sim));
        for (const o of sim.obstacles) {
          if (!hazards.has(o.id)) hazards.set(o.id, { z0: o.z - o.r, z1: o.z + o.r, ship: [o.x - o.r - cfg.ship.hitRadius - 1, o.x + o.r + cfg.ship.hitRadius + 1], raw: [o.x - o.r, o.x + o.r] });
        }
        for (const w of sim.whirlpools) {
          if (hazards.has(w.id)) continue;
          const berth: [number, number] = [w.x - w.coreRadius - 40, w.x + w.coreRadius + 40];
          hazards.set(w.id, { z0: w.z - w.coreRadius, z1: w.z + w.coreRadius, ship: berth, raw: berth, whirlZ: w.z });
        }
      }
      expect(sim.over).toBe(false);
      const rows = sim.rows.filter((r) => r.pattern !== 'empty' && r.z < sim.ship.z + 1000);
      expect(rows.length).toBeGreaterThan(150);
      const byRow = new Map<number, Array<{ ship: [number, number]; raw: [number, number] }>>();
      for (const h of hazards.values()) {
        const row = h.whirlZ !== undefined ? rows.find((r) => r.z === h.whirlZ) : rows.find((r) => h.z0 >= r.z - r.front - 1 && h.z1 <= r.z + r.back + 1);
        if (!row) {
          // Only hazards beyond the last checked row may be unaccounted for.
          expect(h.z0).toBeGreaterThan(rows[rows.length - 1].z);
          continue;
        }
        if (h.whirlZ !== undefined) expect(row.pattern).toBe('whirlpool');
        byRow.set(row.index, [...(byRow.get(row.index) ?? []), h]);
      }
      for (let k = 1; k < rows.length; k++) {
        const row = rows[k];
        const prev = rows[k - 1];
        const own = byRow.get(row.index) ?? [];
        // 1. The main passage is open and inside the channel.
        expect(row.passage - row.gap / 2).toBeGreaterThan(-hw);
        expect(row.passage + row.gap / 2).toBeLessThan(hw);
        for (const { raw } of own) expect(raw[1] <= row.passage - row.gap / 2 + 1e-9 || raw[0] >= row.passage + row.gap / 2 - 1e-9).toBe(true);
        // 2. Rows never overlap: open water lies between them.
        expect(row.z - row.front).toBeGreaterThan(prev.z + prev.back + 60);
        // 3. From anywhere the ship could have left the previous row, an opening is within guaranteed reach…
        const openings = straightOpenings(
          hw,
          own.map((h) => h.ship),
        );
        for (let x = prev.hullLo; x <= prev.hullHi; x += 2) expect(distanceToOpening(x, openings)).toBeLessThanOrEqual(row.reach + 1e-6);
        // 4. …and that reach keeps a wide safety margin on what the ship can physically do across the open water.
        expect(row.reach).toBeLessThanOrEqual(row.window * maxRatio * cfg.track.reachMargin + 1e-6);
        expect(cfg.track.reachMargin).toBeLessThanOrEqual(0.7);
      }
    }
  });

  it('never makes the way through hug the Edge: every passage keeps 80 units of open water to the lip', { timeout: 60_000 }, () => {
    for (let i = 0; i < 8; i++) {
      const { sim } = play(seedFor(600 + i), passageNavigator, 60 * 60 * 4, true);
      for (const r of sim.rows) {
        if (r.pattern === 'empty' || r.pattern === 'whirlpool') continue;
        expect(sim.config.channelHalfWidth - Math.abs(r.passage) - r.gap / 2).toBeGreaterThanOrEqual(80 - 1e-6);
      }
    }
  });

  it('a navigator that follows the main passages is never lost', { timeout: 120_000 }, () => {
    for (let i = 0; i < 10; i++) {
      const { sim } = play(seedFor(200 + i), passageNavigator, 60 * 60 * 6, true);
      expect(sim.over, `seed ${i}: ${sim.death} at ${sim.timeSeconds}s`).toBe(false);
    }
  });

  it('a greedy navigator that heads for the nearest gap from wherever it is is never lost', { timeout: 120_000 }, () => {
    for (let i = 0; i < 10; i++) {
      const { sim } = play(seedFor(300 + i), nearestGapNavigator, 60 * 60 * 6, true);
      expect(sim.over, `seed ${i}: ${sim.death} at ${sim.timeSeconds}s`).toBe(false);
    }
  });

  it('evidence is scattered across the channel, and none of it is a trap', { timeout: 120_000 }, () => {
    let away = 0;
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const sim = new Simulation(seedFor(350 + i));
      sim.keepRowHistory = true;
      const seen = new Set<number>();
      while (!sim.over && sim.tick < 60 * 60 * 6) {
        sim.step(coinHunterNavigator(sim));
        for (const e of sim.evidence) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          const row = sim.rows.find((r) => r.pattern !== 'empty' && r.z >= e.z - 1);
          if (!row) continue;
          total++;
          if (Math.abs(e.x - row.passage) > row.gap) away++;
        }
      }
      // A navigator that goes for every piece it can reach in time is never lost.
      expect(sim.over, `seed ${i}: ${sim.death} at ${sim.timeSeconds}s`).toBe(false);
      expect(sim.evidenceCollected).toBeGreaterThan(150);
    }
    // Much of it lies well away from the way through.
    expect(away / total).toBeGreaterThan(0.35);
  });

  it('a navigator that only sees what is in view survives long runs', { timeout: 180_000 }, () => {
    // Even sharp navigators are sometimes lost in the later stages, so this asks for most long runs, not all.
    const seeds = 12;
    const times: number[] = [];
    for (let i = 0; i < seeds; i++) {
      const seed = seedFor(400 + i);
      const { sim } = play(seed, expert(seed), 60 * 60 * 4);
      times.push(Math.round(sim.timeSeconds));
    }
    expect(Math.min(...times), `survival times ${times.join(', ')}`).toBeGreaterThanOrEqual(120);
    expect(times.filter((t) => t >= 180).length, `survival times ${times.join(', ')}`).toBeGreaterThanOrEqual(Math.ceil(seeds * 0.75));
  });

  it('walls, gates, the Colossus and slaloms have no misleading half-gaps: any space in them is closed or the passage', () => {
    let walls = 0;
    for (let i = 0; i < 20; i++) {
      const sim = new Simulation(seedFor(500 + i));
      sim.keepRowHistory = true;
      const checked = new Set<number>();
      while (sim.tick < 60 * 200) {
        sim.step(passageNavigator(sim));
        for (const row of sim.rows) {
          if (!['wall', 'gate', 'colossus', 'slalom'].includes(row.pattern) || checked.has(row.index)) continue;
          checked.add(row.index);
          walls++;
          const rocks = sim.obstacles.filter((o) => Math.abs(o.z - row.z) <= 6).sort((a, b) => a.x - b.x);
          expect(rocks.length).toBeGreaterThan(3);
          for (let k = 1; k < rocks.length; k++) {
            const gap = rocks[k].x - rocks[k].r - (rocks[k - 1].x + rocks[k - 1].r);
            if (gap > 1e-6) expect(gap).toBeGreaterThanOrEqual(row.gap - 1e-6);
          }
        }
      }
    }
    expect(walls).toBeGreaterThan(50);
  });
});

describe('evidence', () => {
  it('is never placed inside a hazard, and pays 250 points (2,500 for a super coin)', { timeout: 30_000 }, () => {
    const seed = seedFor(700);
    const sim = new Simulation(seed);
    const bot = new LookaheadBot({ seed, greed: 3 });
    let collected = 0;
    let supers = 0;
    let overlaps = 0;
    const checked = new Set<number>();
    while (!sim.over && sim.tick < 60 * 90) {
      sim.step(bot.decide(sim));
      for (const e of sim.evidence) {
        if (checked.has(e.id)) continue;
        checked.add(e.id);
        for (const o of sim.obstacles) {
          const dx = e.x - o.x;
          const dz = e.z - o.z;
          if (Math.sqrt(dx * dx + dz * dz) <= o.r + sim.config.evidence.radius) overlaps++;
        }
      }
      for (const ev of sim.events) {
        if (ev.type !== 'evidence') continue;
        collected++;
        if (ev.superCoin) supers++;
      }
    }
    expect(checked.size).toBeGreaterThan(5);
    expect(overlaps).toBe(0);
    expect(collected).toBeGreaterThan(0);
    expect(sim.config.evidence.points).toBe(250);
    expect(sim.config.evidence.superPoints).toBe(2500);
    expect(sim.superCollected).toBe(supers);
    expect(sim.evidenceScore).toBe((collected - supers) * 250 + supers * 2500);
  });

  it('super coins are rare, and never in the main gap', { timeout: 60_000 }, () => {
    let total = 0;
    let supers = 0;
    let inMainGap = 0;
    for (let k = 0; k < 20; k++) {
      const sim = new Simulation(seedFor(900 + k));
      const seen = new Set<number>();
      while (!sim.over && sim.tick < 60 * 120) {
        sim.step(passageNavigator(sim));
        for (const e of sim.evidence) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          total++;
          if (!e.superCoin) continue;
          supers++;
          const row = sim.rows.find((r) => r.z === e.z);
          if (row && !e.risky && Math.abs(e.x - row.passage) <= row.gap / 4) inMainGap++;
        }
      }
    }
    // Roughly one piece in fifty, so one every ten seconds or so of sailing.
    expect(supers / total).toBeGreaterThan(0.005);
    expect(supers / total).toBeLessThan(0.05);
    expect(inMainGap).toBe(0);
  });
});

describe('performance', () => {
  it('replays a long run quickly enough for the server', { timeout: 60_000 }, () => {
    const seed = seedFor(800);
    const { sim, inputs } = play(seed, nearestGapNavigator, 60 * 60 * 10);
    const t0 = performance.now();
    const again = runReplay(seed, inputs, sim.tick);
    const ms = performance.now() - t0;
    expect(again.score).toBe(sim.score);
    expect(ms).toBeLessThan(1500);
  });
});

