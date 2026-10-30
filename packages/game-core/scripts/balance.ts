/**
 * Balancing harness: plays many seeded runs with automated navigators of
 * different skill and prints survival-time distributions and causes of loss.
 *
 *   npm run balance -w @fes/game-core -- [runs]
 */
import { LookaheadBot } from '../src/bots';
import { Rng } from '../src/rng';
import { Simulation } from '../src/sim';
import { InputRecorder } from '../src/replay';
import type { Steer } from '../src/types';

type Policy = { name: string; make: (seed: string) => (sim: Simulation) => Steer };

const runs = Number(process.argv[2] ?? 40);

const policies: Policy[] = [
  { name: 'no input', make: () => () => 0 },
  { name: 'hold left', make: () => () => -1 },
  {
    name: 'random helm (mashes keys, ignores hazards)',
    make: (seed) => {
      const rng = Rng.fromSeed(seed, 'masher');
      let steer: Steer = 0;
      return (sim) => {
        if (sim.tick % 12 === 0) steer = sim.ship.x > 300 ? -1 : sim.ship.x < -300 ? 1 : rng.pick([-1, 0, 1] as const);
        return steer;
      };
    },
  },
  {
    name: 'novice bot (slow reactions, blunders)',
    make: (seed) => {
      const b = new LookaheadBot({ seed, reactionTicks: 24, replanTicks: 15, horizonTicks: 54, margin: 0, viewRadius: 1100, blunderRate: 0.06 });
      return (sim) => b.decide(sim);
    },
  },
  {
    name: 'average bot',
    make: (seed) => {
      const b = new LookaheadBot({ seed, reactionTicks: 18, replanTicks: 12, horizonTicks: 66, margin: 2, viewRadius: 1400, blunderRate: 0.025 });
      return (sim) => b.decide(sim);
    },
  },
  {
    name: 'good bot',
    make: (seed) => {
      const b = new LookaheadBot({ seed, reactionTicks: 12, replanTicks: 8, horizonTicks: 80, margin: 4, viewRadius: 1800, blunderRate: 0.01 });
      return (sim) => b.decide(sim);
    },
  },
  {
    name: 'expert bot (no blunders)',
    make: (seed) => {
      const b = new LookaheadBot({ seed, reactionTicks: 6, replanTicks: 6, horizonTicks: 96, margin: 6, viewRadius: 2200 });
      return (sim) => b.decide(sim);
    },
  },
];

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

for (const policy of policies) {
  const times: number[] = [];
  const scores: number[] = [];
  const causes: Record<string, number> = {};
  let evidence = 0;
  let supers = 0;
  let changes = 0;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) {
    const seed = (0x1000 + i * 7919).toString(16).padStart(32, 'a');
    const sim = new Simulation(seed);
    const decide = policy.make(seed);
    const rec = new InputRecorder();
    const cap = 60 * 60 * 10;
    while (!sim.over && sim.tick < cap) {
      const s = decide(sim);
      rec.record(sim.tick + 1, s);
      sim.step(s);
    }
    times.push(sim.timeSeconds);
    scores.push(sim.score);
    causes[sim.death ?? 'alive@10min'] = (causes[sim.death ?? 'alive@10min'] ?? 0) + 1;
    evidence += sim.evidenceCollected;
    supers += sim.superCollected;
    changes += rec.events.length / Math.max(1, sim.timeSeconds);
  }
  const ms = performance.now() - t0;
  times.sort((a, b) => a - b);
  scores.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`\n== ${policy.name}  (${runs} runs, ${(ms / runs).toFixed(0)} ms/run)`);
  console.log(
    `   survival s: p10 ${pct(times, 0.1).toFixed(0)}  p50 ${pct(times, 0.5).toFixed(0)}  p90 ${pct(times, 0.9).toFixed(0)}  mean ${mean.toFixed(0)}  max ${times[times.length - 1].toFixed(0)}`,
  );
  console.log(`   score: p50 ${pct(scores, 0.5)}  p90 ${pct(scores, 0.9)}   treasure/run ${(evidence / runs).toFixed(1)} (super ${(supers / runs).toFixed(1)})   input changes/s ${(changes / runs).toFixed(2)}`);
  console.log(`   causes: ${JSON.stringify(causes)}`);
}
