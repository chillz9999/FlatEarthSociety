export type ParticleKind = 'spark' | 'splinter' | 'spray' | 'bubble';

/** A cosmetic particle in world space: x across the channel, y up from the sea, z along the course. */
export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  spin: number;
  angle: number;
  color: string;
}

export type Project = (x: number, y: number, z: number) => { x: number; y: number; s: number } | null;

const GRAVITY: Record<ParticleKind, number> = { spark: -60, splinter: -520, spray: -460, bubble: 30 };
const DRAG: Record<ParticleKind, number> = { spark: 0.94, splinter: 0.97, spray: 0.96, bubble: 0.95 };

/** Cosmetic particles (never part of the simulation). */
export class Particles {
  readonly items: Particle[] = [];

  emit(p: Omit<Particle, 'life' | 'angle'> & { angle?: number }): void {
    if (this.items.length > 900) this.items.shift();
    this.items.push({ ...p, life: p.maxLife, angle: p.angle ?? Math.random() * Math.PI * 2 });
  }

  /** A burst from (x, y, z): `up` biases the spray upwards (0 = all directions). */
  burst(kind: ParticleKind, x: number, y: number, z: number, count: number, speed: number, colors: string[], size = 2, life = 0.9, up = 0.6, carry = 0): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.emit({
        kind,
        x,
        y,
        z,
        vx: Math.cos(a) * s,
        vy: (Math.random() * 0.6 + up) * speed,
        vz: Math.sin(a) * s + carry,
        maxLife: life * (0.6 + Math.random() * 0.6),
        size: size * (0.6 + Math.random() * 0.8),
        spin: (Math.random() - 0.5) * 10,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const k = Math.pow(DRAG[p.kind], dt * 60);
      p.vx *= k;
      p.vz *= k;
      p.vy = p.vy * k + GRAVITY[p.kind] * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0 && p.kind !== 'bubble') {
        p.y = 0;
        p.vy *= -0.2;
        p.life = Math.min(p.life, 0.25);
      }
      p.angle += p.spin * dt;
      this.items[w++] = p;
    }
    this.items.length = w;
  }

  draw(ctx: CanvasRenderingContext2D, project: Project): void {
    for (const p of this.items) {
      const q = project(p.x, p.y, p.z);
      if (!q) continue;
      const a = Math.max(0, p.life / p.maxLife);
      const size = p.size * q.s;
      if (size < 0.2) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.kind === 'splinter') {
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate(p.angle);
        ctx.fillRect(-size, -size * 0.3, size * 2, size * 0.6);
        ctx.restore();
      } else if (p.kind === 'spark') {
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate(p.angle);
        const s = size * (0.5 + a * 0.5);
        ctx.beginPath();
        ctx.moveTo(0, -s * 2);
        ctx.lineTo(s * 0.5, 0);
        ctx.lineTo(0, s * 2);
        ctx.lineTo(-s * 0.5, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(q.x, q.y, size * (p.kind === 'bubble' ? 1 : 0.6 + a * 0.6), 0, Math.PI * 2);
        if (p.kind === 'bubble') {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        } else ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}
