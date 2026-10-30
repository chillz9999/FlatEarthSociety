import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dcos, dsin, normAngle, PI } from '../src/detmath';
import { Rng, randomSeedHex, seedWords } from '../src/rng';

describe('deterministic trigonometry', () => {
  it('matches Math.sin/cos to 1e-11 over the steering range', () => {
    for (let a = -20; a <= 20; a += 0.0137) {
      expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-11);
      expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-11);
    }
  });

  it('wraps angles into [-PI, PI)', () => {
    for (let a = -50; a <= 50; a += 0.31) {
      const n = normAngle(a);
      expect(n).toBeGreaterThanOrEqual(-PI);
      expect(n).toBeLessThan(PI);
      expect(Math.abs(dsin(n) - Math.sin(a))).toBeLessThan(1e-9);
    }
  });

  it('simulation modules avoid engine-dependent math', () => {
    // Math.sin/cos/atan2/exp/pow and ** are "implementation-approximated" in ECMAScript
    // and differ between Chrome, Firefox and Safari. Ranked replays must be bit-exact.
    const files = ['sim.ts', 'physics.ts', 'difficulty.ts', 'detmath.ts', 'rng.ts', 'replay.ts', 'hash.ts'];
    const forbidden = /Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt|sinh|cosh|tanh|random)\b|\*\*/;
    for (const f of files) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
        .join('\n');
      expect(forbidden.test(src), `${f} uses engine-dependent math`).toBe(false);
    }
  });
});

describe('seeded RNG', () => {
  it('is reproducible per seed and stream', () => {
    const a = Rng.fromSeed('00112233445566778899aabbccddeeff', 'world');
    const b = Rng.fromSeed('00112233445566778899aabbccddeeff', 'world');
    const seqA = Array.from({ length: 50 }, () => a.nextU32());
    const seqB = Array.from({ length: 50 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);
  });

  it('produces a known sequence (guards against accidental algorithm changes)', () => {
    const r = Rng.fromSeed('00000000000000000000000000000001', 'world');
    expect([r.nextU32(), r.nextU32(), r.nextU32()]).toMatchInlineSnapshot(`
      [
        2212093611,
        3038547300,
        3156564246,
      ]
    `);
  });

  it('separates streams and seeds', () => {
    const s = '00112233445566778899aabbccddeeff';
    expect(Rng.fromSeed(s, 'world').nextU32()).not.toBe(Rng.fromSeed(s, 'hazards').nextU32());
    expect(Rng.fromSeed(s, 'world').nextU32()).not.toBe(Rng.fromSeed(s.replace('ff', 'fe'), 'world').nextU32());
  });

  it('is roughly uniform', () => {
    const r = Rng.fromSeed('abcdef', 'u');
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100000; i++) buckets[Math.floor(r.next() * 10)]++;
    for (const b of buckets) expect(Math.abs(b - 10000)).toBeLessThan(500);
  });

  it('rejects non-hex seeds and generates 128-bit seeds', () => {
    expect(() => seedWords('not hex')).toThrow();
    const seed = randomSeedHex();
    expect(seed).toMatch(/^[0-9a-f]{32}$/);
  });
});
