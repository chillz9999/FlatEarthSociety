import type { Simulation } from '@fes/game-core';
import * as THREE from 'three';
import type { Glows } from './fx';
import { canvasTexture, emblem } from './textures';
import { merge, place } from './util';

const GOLD_GLOW = new THREE.Color(1.0, 0.78, 0.36);
const SUPER_GLOW = new THREE.Color(1.0, 0.5, 0.3);
const RUBY_GLOW = new THREE.Color(1.0, 0.12, 0.1);

/** The face of a doubloon: the Society's emblem struck in relief, a beaded rim (as a height map). */
function faceBump(ruby: boolean): THREE.Texture {
  return canvasTexture(
    256,
    256,
    (ctx) => {
      ctx.fillStyle = '#777';
      ctx.fillRect(0, 0, 256, 256);
      const g = ctx.createRadialGradient(128, 128, 60, 128, 128, 128);
      g.addColorStop(0, '#808080');
      g.addColorStop(1, '#5a5a5a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(128, 128, 128, 0, Math.PI * 2);
      ctx.fill();
      // Beaded rim.
      ctx.fillStyle = '#d8d8d8';
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(128 + Math.cos(a) * 104, 128 + Math.sin(a) * 104, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!ruby) emblem(ctx, 128, 128, 70, '#e8e8e8', 10);
      else {
        // Stamped rays round the gem.
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 6;
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(128 + Math.cos(a) * 46, 128 + Math.sin(a) * 46);
          ctx.lineTo(128 + Math.cos(a) * 88, 128 + Math.sin(a) * 88);
          ctx.stroke();
        }
      }
    },
    false,
  );
}

/** A coin standing on edge, faces towards ±z: disc plus a raised rim. */
function coinGeometry(radius: number, thick: number): THREE.BufferGeometry {
  const disc = new THREE.CylinderGeometry(radius, radius, thick, 48, 1);
  disc.rotateX(Math.PI / 2);
  return disc;
}

function rimGeometry(radius: number, thick: number): THREE.BufferGeometry {
  const rim = new THREE.TorusGeometry(radius * 0.97, thick * 0.32, 8, 48);
  const a = rim.clone();
  place(a, 0, 0, thick * 0.42);
  place(rim, 0, 0, -thick * 0.42);
  const g = merge([rim, a]);
  return g;
}

/**
 * Treasure: heavy gold doubloons turning in the air above the water, catching the light, each with its glow;
 * super coins larger, set with a ruby, burning warm.
 */
export class Coins {
  readonly group = new THREE.Group();
  private readonly coins: THREE.InstancedMesh;
  private readonly rims: THREE.InstancedMesh;
  private readonly supers: THREE.InstancedMesh;
  private readonly superRims: THREE.InstancedMesh;
  private readonly rubies: THREE.InstancedMesh;
  private readonly materials: THREE.Material[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly e = new THREE.Euler();

  constructor(max = 160) {
    const gold = (bump: THREE.Texture) => {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffc85a, metalness: 1, roughness: 0.24, bumpMap: bump, bumpScale: 2.2, emissive: new THREE.Color(0.2, 0.11, 0.02) });
      this.materials.push(mat);
      return mat;
    };
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xffd27a, metalness: 1, roughness: 0.2, emissive: new THREE.Color(0.2, 0.12, 0.03) });
    this.materials.push(rimMat);
    this.coins = new THREE.InstancedMesh(coinGeometry(16, 3.6), gold(faceBump(false)), max);
    this.rims = new THREE.InstancedMesh(rimGeometry(16, 3.6), rimMat, max);
    this.supers = new THREE.InstancedMesh(coinGeometry(24, 5), gold(faceBump(true)), 24);
    this.superRims = new THREE.InstancedMesh(rimGeometry(24, 5), rimMat, 24);
    const rubyMat = new THREE.MeshStandardMaterial({ color: 0x8a0010, metalness: 0.1, roughness: 0.08, emissive: new THREE.Color(0.9, 0.02, 0.04), emissiveIntensity: 1.4, flatShading: true });
    this.materials.push(rubyMat);
    const ruby = new THREE.OctahedronGeometry(7, 0);
    ruby.scale(1, 1, 0.75);
    this.rubies = new THREE.InstancedMesh(ruby, rubyMat, 24);
    for (const im of [this.coins, this.rims, this.supers, this.superRims, this.rubies]) {
      im.frustumCulled = false;
      im.castShadow = true;
      im.count = 0;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
    }
  }

  update(sim: Simulation, oz: number, camZ: number, time: number, far: number, glows: Glows): void {
    let n = 0;
    let ns = 0;
    for (const e of sim.evidence) {
      const dz = e.z - camZ;
      if (dz > far || dz < 10) continue;
      const big = e.superCoin;
      const bob = Math.sin(time * 2.6 + e.id) * (big ? 6 : 4);
      const y = (big ? 36 : 28) + bob;
      const spin = time * (big ? 1.2 : 1.5) + e.id * 0.7;
      this.e.set(0, spin, 0);
      this.q.setFromEuler(this.e);
      this.p.set(e.x, y, oz - e.z);
      this.m.compose(this.p, this.q, this.s);
      // Fade the far ones in by size (they emerge from the mist with the rest).
      const fade = Math.max(0, Math.min(1, (far - dz) / 700));
      if (big) {
        if (ns >= 24) continue;
        this.supers.setMatrixAt(ns, this.m);
        this.superRims.setMatrixAt(ns, this.m);
        this.p.set(e.x + Math.sin(spin) * 2.9, y, oz - e.z + Math.cos(spin) * 2.9);
        this.m.compose(this.p, this.q, this.s);
        this.rubies.setMatrixAt(ns, this.m);
        ns++;
        const pulse = 1 + 0.25 * Math.sin(time * 5 + e.id);
        glows.add(e.x, y, oz - e.z, SUPER_GLOW, 0.45 * pulse * fade, 44 * pulse, 30, 0, 4);
        glows.add(e.x, y, oz - e.z, RUBY_GLOW, 0.35 * fade, 16, 34);
      } else {
        if (n >= this.coins.instanceMatrix.count) continue;
        this.coins.setMatrixAt(n, this.m);
        this.rims.setMatrixAt(n, this.m);
        n++;
        glows.add(e.x, y, oz - e.z, GOLD_GLOW, 0.2 * fade, 28, 24, 0, 3);
      }
    }
    this.coins.count = n;
    this.rims.count = n;
    this.supers.count = ns;
    this.superRims.count = ns;
    this.rubies.count = ns;
    for (const im of [this.coins, this.rims, this.supers, this.superRims, this.rubies]) im.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const im of [this.coins, this.rims, this.supers, this.superRims, this.rubies]) im.geometry.dispose();
    for (const m of this.materials) {
      const sm = m as THREE.MeshStandardMaterial;
      sm.bumpMap?.dispose();
      m.dispose();
    }
  }
}
