/** Incremental FNV-1a (32-bit) over numbers' exact IEEE-754 bit patterns. */
export class StateHasher {
  private h = 0x811c9dc5;
  private readonly view = new DataView(new ArrayBuffer(8));

  f64(v: number): this {
    this.view.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) {
      this.h ^= this.view.getUint8(i);
      this.h = Math.imul(this.h, 0x01000193);
    }
    return this;
  }

  u32(v: number): this {
    for (let i = 0; i < 4; i++) {
      this.h ^= (v >>> (i * 8)) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
    return this;
  }

  digest(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}
