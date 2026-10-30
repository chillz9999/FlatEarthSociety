/**
 * Where players are lost: deaths per minute of sailing in each stretch of the voyage, by cause, for bots of
 * different skill. A difficulty spike shows as a jump in the rate; an unkind opening as a high rate early on.
 *
 *   npx tsx scripts/hazard-rate.ts [runs]
 */
import { LookaheadBot } from '../src/bots';
import { Simulation } from '../src/sim';

const runs = Number(process.argv[2] ?? 120);
const bins = [0, 5, 10, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 600];
const skills = {
  novice: (seed: string) => new LookaheadBot({ seed, reactionTicks: 24, replanTicks: 15, horizonTicks: 54, margin: 0, viewRadius: 1100, blunderRate: 0.06 }),
  average: (seed: string) => new LookaheadBot({ seed, reactionTicks: 18, replanTicks: 12, horizonTicks: 66, margin: 2, viewRadius: 1400, blunderRate: 0.025 }),
  good: (seed: string) => new LookaheadBot({ seed, reactionTicks: 12, replanTicks: 8, horizonTicks: 80, margin: 4, viewRadius: 1800, blunderRate: 0.01 }),
};
for (const [name, make] of Object.entries(skills)) {
  const exposure = new Array(bins.length - 1).fill(0);
  const deaths = new Array(bins.length - 1).fill(0);
  const causes: Record<string, number>[] = bins.slice(1).map(() => ({}));
  for (let i = 0; i < runs; i++) {
    const seed = (0x5000 + i * 104729).toString(16).padStart(32, 'b');
    const sim = new Simulation(seed);
    const bot = make(seed);
    while (!sim.over && sim.tick < 60 * 600) sim.step(bot.decide(sim));
    const t = sim.timeSeconds;
    for (let b = 0; b < bins.length - 1; b++) exposure[b] += Math.max(0, Math.min(t, bins[b + 1]) - bins[b]);
    if (sim.death && sim.death !== 'timeout') {
      const b = bins.findIndex((x, k) => t >= x && t < bins[k + 1]);
      deaths[b]++;
      causes[b][sim.death] = (causes[b][sim.death] ?? 0) + 1;
    }
  }
  console.log(`\n== ${name} (${runs} runs): deaths per minute of sailing`);
  for (let b = 0; b < bins.length - 1; b++) {
    if (exposure[b] < 1) continue;
    const rate = (deaths[b] / exposure[b]) * 60;
    console.log(`  ${String(bins[b]).padStart(3)}-${String(bins[b + 1]).padEnd(3)}s  ${rate.toFixed(2).padStart(5)}/min  ${'#'.repeat(Math.round(rate * 10))}  ${JSON.stringify(causes[b])}`);
  }
}
