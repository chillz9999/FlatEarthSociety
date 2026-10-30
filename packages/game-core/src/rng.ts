/**
 * Deterministic pseudo-random numbers.
 *
 * Everything here uses 32-bit integer arithmetic (Math.imul, |0, >>>), which
 * behaves identically in every JavaScript engine. The simulation never calls
 * Math.random().
 */

/** FNV-1a 32-bit hash of a string. */
export function hashString32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** SplitMix32 step — used to expand seeds into well-mixed state words. */
export function splitmix32(state: number): [next: number, out: number] {
  const next = (state + 0x9e3779b9) | 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  z ^= z >>> 16;
  return [next, z >>> 0];
}

/** Parse a hex seed (any length, `0x` optional) into four 32-bit words. */
export function seedWords(seedHex: string): [number, number, number, number] {
  const clean = seedHex.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(clean)) throw new Error('Seed must be a hex string');
  const padded = clean.padStart(32, '0');
  const words: number[] = [];
  // Fold arbitrarily long seeds into 128 bits.
  for (let i = 0; i < 4; i++) words.push(0);
  for (let i = 0; i < padded.length; i += 8) {
    const chunk = parseInt(padded.slice(i, i + 8).padEnd(8, '0'), 16) >>> 0;
    const slot = (i / 8) % 4;
    words[slot] = (Math.imul(words[slot] ^ chunk, 0x01000193) + chunk) >>> 0;
  }
  return [words[0], words[1], words[2], words[3]];
}

/** Small fast counter-based generator (sfc32). Period ≥ 2^32, excellent statistical quality. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(a: number, b: number, c: number, d: number) {
    this.a = a | 0;
    this.b = b | 0;
    this.c = c | 0;
    this.d = d | 0;
    for (let i = 0; i < 15; i++) this.nextU32();
  }

  /** Create an independent stream for `stream` derived from a hex seed. */
  static fromSeed(seedHex: string, stream: string): Rng {
    const [w0, w1, w2, w3] = seedWords(seedHex);
    let s = (w0 ^ hashString32(stream)) | 0;
    const out: number[] = [];
    const mix = [w0, w1, w2, w3];
    for (let i = 0; i < 4; i++) {
      const [next, o] = splitmix32((s ^ mix[i]) | 0);
      s = next;
      out.push(o);
    }
    return new Rng(out[0], out[1], out[2], out[3] | 1);
  }

  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}

/** Generate a fresh random 128-bit hex seed (client practice mode / server session issuance). */
export function randomSeedHex(randomBytes?: (n: number) => Uint8Array): string {
  const bytes = randomBytes
    ? randomBytes(16)
    : (() => {
        const b = new Uint8Array(16);
        const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
        if (!c?.getRandomValues) throw new Error('No secure random source available');
        c.getRandomValues(b);
        return b;
      })();
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
