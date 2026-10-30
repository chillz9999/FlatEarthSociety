import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { difficultyAt, intensityAt, STAGES, stageIndexAt } from '../src/difficulty';

describe('difficulty progression (spec §5)', () => {
  it('follows the stage table', () => {
    expect(intensityAt(10)).toBeCloseTo(0.18);
    expect(intensityAt(45)).toBeCloseTo(0.35);
    expect(intensityAt(90)).toBeCloseTo(0.6);
    expect(intensityAt(150)).toBeCloseTo(0.82);
    expect(intensityAt(240)).toBeCloseTo(1.0);
    expect(STAGES.map((s) => s.name)).toEqual([
      'Calm Waters',
      'Uncharted Territory',
      'Dangerous Waters',
      'The Outer Rim',
      'The Edge',
    ]);
    expect(stageIndexAt(0)).toBe(0);
    expect(stageIndexAt(30)).toBe(1);
    expect(stageIndexAt(181)).toBe(4);
  });

  it('never decreases and keeps rising after five minutes', () => {
    let prev = 0;
    for (let t = 0; t < 900; t += 0.5) {
      const v = intensityAt(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
    expect(intensityAt(420)).toBeGreaterThan(1);
    expect(intensityAt(3000)).toBeLessThanOrEqual(1.45);
  });

  it('starts calm: no whirlpools, wreckage or walls in the opening stage', () => {
    const d = difficultyAt(0, DEFAULT_CONFIG);
    expect(d.speed).toBe(DEFAULT_CONFIG.ship.baseSpeed);
    expect(d.lateralSpeed).toBe(DEFAULT_CONFIG.ship.baseLateral);
    expect(d.whirlpoolChance).toBe(0);
    expect(d.debrisChance).toBe(0);
    expect(d.wallChance).toBe(0);
    expect(d.emptyChance).toBeGreaterThan(0.15);
  });

  it('introduces walls after the opening stage, and whirlpools and wreckage with Dangerous Waters', () => {
    expect(difficultyAt(25 * 60, DEFAULT_CONFIG).wallChance).toBe(0);
    expect(difficultyAt(45 * 60, DEFAULT_CONFIG).wallChance).toBeGreaterThan(0);
    expect(difficultyAt(45 * 60, DEFAULT_CONFIG).krakenChance).toBeGreaterThan(0);
    // One new kind of trouble at a time: whirlpools wait for Dangerous Waters.
    expect(difficultyAt(50 * 60, DEFAULT_CONFIG).whirlpoolChance).toBe(0);
    expect(difficultyAt(70 * 60, DEFAULT_CONFIG).whirlpoolChance).toBeGreaterThan(0);
    expect(difficultyAt(50 * 60, DEFAULT_CONFIG).debrisChance).toBe(0);
    expect(difficultyAt(130 * 60, DEFAULT_CONFIG).debrisChance).toBeGreaterThan(0);
  });

  it('opens with a warm-up: sparser rows, wider passages and no ice shelves, easing into Calm Waters', () => {
    const launch = difficultyAt(0, DEFAULT_CONFIG);
    const calm = difficultyAt(20 * 60, DEFAULT_CONFIG);
    expect(launch.gap).toBeGreaterThan(calm.gap);
    expect(launch.fill).toBeLessThan(calm.fill);
    expect(launch.rowInterval).toBeGreaterThan(calm.rowInterval);
    expect(launch.emptyChance).toBeGreaterThan(calm.emptyChance);
    expect(launch.shelfChance).toBe(0);
    expect(calm.shelfChance).toBeGreaterThan(0);
    // It eases in: no step anywhere in the first seconds.
    for (let t = 1; t < 15 * 60; t++) {
      expect(Math.abs(difficultyAt(t, DEFAULT_CONFIG).gap - difficultyAt(t - 1, DEFAULT_CONFIG).gap)).toBeLessThan(1);
    }
  });

  it('tightens the passages and quickens the rows as it goes', () => {
    const early = difficultyAt(10 * 60, DEFAULT_CONFIG);
    const late = difficultyAt(240 * 60, DEFAULT_CONFIG);
    expect(late.gap).toBeLessThan(early.gap);
    expect(late.rowInterval).toBeLessThan(early.rowInterval);
    expect(late.speed).toBeGreaterThan(early.speed);
    expect(late.lateralSpeed).toBeGreaterThan(early.lateralSpeed);
    // Sideways speed grows more slowly than forward speed: the sea really does get harder.
    expect(late.lateralSpeed / late.speed).toBeLessThan(early.lateralSpeed / early.speed);
  });

  it('caps speed', () => {
    expect(difficultyAt(60 * 60 * 30, DEFAULT_CONFIG).speed).toBeLessThanOrEqual(DEFAULT_CONFIG.ship.maxSpeed);
  });
});
