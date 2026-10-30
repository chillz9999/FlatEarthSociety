import type { Obstacle, Simulation, Whirlpool } from '@fes/game-core';
import * as THREE from 'three';
import type { Glows, Tentacles, WaterDecals } from './fx';
import { WhirlpoolView, funnelDepthFor, funnelGeometry } from './fx';
import { Materials, withDetail } from './materials';
import {
  archGeometry,
  colossusModel,
  debrisGeometry,
  icebergGeometry,
  islandModel,
  leviathanModel,
  pillarBands,
  pillarGeometry,
  rockForm,
  rockGeometry,
  shelfGeometry,
  wreckModel,
} from './models';
import type { SkyUniforms } from './sky';
import { rng, smooth, srgb } from './util';

/** A drawn hazard. */
interface View {
  obj: THREE.Object3D;
  x: number;
  z: number;
  /** Shared geometry/material (not disposed with the view). */
  shared: boolean;
  /** For level of detail (rocks): near and far geometry. */
  lod?: { mesh: THREE.Mesh; hi: THREE.BufferGeometry; lo: THREE.BufferGeometry };
  animate?(time: number, dz: number): void;
  water?(d: WaterDecals, oz: number): void;
  glow?(g: Glows, oz: number, time: number): void;
  /** Dissolve when the camera comes too close (tall things the camera could pass through). */
  fade?: { value: number };
  /** Half-width beyond which the camera clears it, and the gap it leaves in the middle (the Colossus's stride). */
  span?: number;
  stride?: number;
  seen: number;
}

const ICE_BULK = srgb(40, 120, 130).multiplyScalar(0.4);
const DARK_BULK = new THREE.Color(0.0, 0.0, 0.0);
const LAMP = new THREE.Color(1.0, 0.7, 0.35);
const EYE = new THREE.Color(1.0, 0.62, 0.16);

/** Rock and ice variants kept (each obstacle picks one by its shape seed, turned and sized by it). */
const VARIANTS = 10;

/**
 * Every hazard on the course as a 3D model: created as it is charted ahead (a few per frame), placed where the
 * simulation says it collides, animated, and disposed once it falls behind.
 */
export class Hazards {
  readonly group = new THREE.Group();
  private readonly views = new Map<string, View>();
  private readonly geoCache = new Map<string, { geo: THREE.BufferGeometry; height: number }>();
  private readonly pillarGeo: THREE.BufferGeometry[] = [];
  private pillarBandGeo: THREE.BufferGeometry | null = null;
  private readonly debrisGeo = new Map<number, THREE.BufferGeometry>();
  private readonly whirls = new Map<number, { view: WhirlpoolView; seen: number }>();
  private readonly funnel = funnelGeometry();
  private frame = 0;
  /** Rock and ice variants still to build, one per frame when there is time (so none is built mid-row). */
  private readonly pending: (() => void)[] = [];
  /** Materials of a fort's flag and the leviathan's eyes: one each, shared by every view, never disposed. */
  private readonly flagMat = new THREE.MeshStandardMaterial({ color: 0x8a1f1c, side: THREE.DoubleSide, roughness: 0.9, name: 'flag' });
  private readonly eyeMat = new THREE.MeshStandardMaterial({ color: 0x331800, emissive: new THREE.Color(1.0, 0.45, 0.08), emissiveIntensity: 0.75, roughness: 0.2, name: 'eye' });
  private readonly pupilMat = new THREE.MeshBasicMaterial({ color: 0x050102, name: 'pupil' });
  private readonly keep = new Set<THREE.Material>([this.flagMat, this.eyeMat, this.pupilMat]);
  private showcaseView: { group: THREE.Group; whirl: WhirlpoolView } | null = null;

  constructor(
    private readonly mats: Materials,
    private readonly sky: SkyUniforms,
  ) {
    for (let variant = 0; variant < VARIANTS; variant++) {
      for (const form of ['stack', 'spire', 'twin', 'mesa'] as const) {
        this.pending.push(() => this.cached(`rock:${form}:${variant}:3`, () => rockGeometry(variant, form, 3)));
        this.pending.push(() => this.cached(`rock:${form}:${variant}:2`, () => rockGeometry(variant, form, 2)));
      }
      this.pending.push(() => this.cached(`ice:${variant}`, () => icebergGeometry(variant)));
    }
  }

  /** Drop everything (a new voyage). */
  reset(): void {
    for (const [key, v] of this.views) this.drop(key, v);
    for (const [id, w] of this.whirls) {
      this.group.remove(w.view.mesh);
      w.view.dispose();
      this.whirls.delete(id);
    }
  }

  // ----------------------------------------------------------- caches

  private cached(key: string, make: () => { geo: THREE.BufferGeometry; height: number }) {
    let c = this.geoCache.get(key);
    if (!c) {
      c = make();
      this.geoCache.set(key, c);
    }
    return c;
  }

  // ----------------------------------------------------------- builders

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadows = true): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadows;
    m.receiveShadow = true;
    return m;
  }

  private build(o: Obstacle): View | null {
    const r = rng(o.shape);
    const v: View = { obj: new THREE.Group(), x: o.x, z: o.z, shared: true, seen: this.frame };
    switch (o.kind) {
      case 'rock': {
        const form = rockForm(o.shape);
        const variant = o.shape % VARIANTS;
        const hi = this.cached(`rock:${form}:${variant}:3`, () => rockGeometry(variant, form, 3));
        const lo = this.cached(`rock:${form}:${variant}:2`, () => rockGeometry(variant, form, 2));
        const m = this.mesh(hi.geo, this.mats.stone);
        const s = o.vr;
        m.scale.set(s * (0.95 + r() * 0.15), s * (0.9 + r() * 0.2), s * (0.95 + r() * 0.15));
        m.rotation.y = r() * Math.PI * 2;
        v.obj = m;
        v.lod = { mesh: m, hi: hi.geo, lo: lo.geo };
        return v;
      }
      case 'iceberg': {
        if (o.form === 'shelf') {
          const { geo } = shelfGeometry(o.shape, o.vr);
          const m = this.mesh(geo, this.mats.ice);
          v.obj = m;
          v.shared = false;
          return v;
        }
        const variant = o.shape % VARIANTS;
        const c = this.cached(`ice:${variant}`, () => icebergGeometry(variant));
        const m = this.mesh(c.geo, this.mats.ice);
        m.scale.set(o.vr * (0.95 + r() * 0.15), o.vr * (0.9 + r() * 0.25), o.vr * (0.95 + r() * 0.15));
        m.rotation.y = r() * Math.PI * 2;
        v.obj = m;
        v.water = (d, oz) => d.add(o.x, oz - o.z, o.vr * 1.9, 1, 0.25, 0.4, ICE_BULK, o.shape);
        return v;
      }
      case 'island': {
        const im = islandModel(o.shape, o.vr);
        const g = new THREE.Group();
        g.add(this.mesh(im.land, this.mats.land));
        g.add(this.mesh(im.trees, this.mats.foliage));
        if (im.stone) g.add(this.mesh(im.stone, this.mats.stone));
        v.obj = g;
        v.shared = false;
        if (im.lamp) {
          const lamp = this.mesh(new THREE.SphereGeometry(5.5, 10, 8), this.mats.lamp, false);
          lamp.position.copy(im.lamp);
          g.add(lamp);
          const lp = im.lamp.clone();
          v.glow = (gl, oz, t) => gl.add(o.x + lp.x, lp.y, oz - o.z + lp.z, LAMP, 2.2 + 0.4 * Math.sin(t * 2 + o.id), 48, 10, 0, 6);
        }
        if (im.flag) {
          const flag = this.mesh(new THREE.PlaneGeometry(18, 11, 6, 1), this.flagMat, false);
          flag.position.set(im.flag.x + 9, im.flag.y - 4, im.flag.z);
          g.add(flag);
          const base = (flag.geometry.getAttribute('position') as THREE.BufferAttribute).array.slice();
          v.animate = (t) => {
            const p = flag.geometry.getAttribute('position') as THREE.BufferAttribute;
            for (let i = 0; i < p.count; i++) {
              const x = base[i * 3] + 9;
              p.setZ(i, Math.sin(t * 5 + x * 0.35) * x * 0.12);
            }
            p.needsUpdate = true;
          };
        }
        return v;
      }
      case 'debris': {
        const variant = o.shape % 12;
        let geo = this.debrisGeo.get(variant);
        if (!geo) {
          geo = debrisGeometry(variant);
          this.debrisGeo.set(variant, geo);
        }
        const m = this.mesh(geo, this.mats.wood);
        m.scale.setScalar(o.vr);
        const yaw = r() * Math.PI * 2;
        const ph = r() * 10;
        v.obj = m;
        v.animate = (t) => {
          m.position.y = Math.sin(t * 1.9 + ph) * 1.6 - 1;
          m.rotation.set(Math.sin(t * 1.3 + ph) * 0.06, yaw + Math.sin(t * 0.4 + ph) * 0.1, Math.cos(t * 1.6 + ph) * 0.07);
        };
        return v;
      }
      case 'wreck': {
        const wm = wreckModel(o.shape, o.vr);
        const g = new THREE.Group();
        g.add(this.mesh(wm.wood, this.mats.wood));
        g.add(this.mesh(wm.cloth, this.mats.cloth));
        v.obj = g;
        v.shared = false;
        v.water = (d, oz) => d.add(o.x, oz - o.z, o.vr * 1.25, 1, 0.3, 0.4, DARK_BULK, o.shape);
        return v;
      }
      case 'pillar': {
        const variant = o.shape % 3;
        if (!this.pillarGeo[variant]) this.pillarGeo[variant] = pillarGeometry(variant);
        if (!this.pillarBandGeo) this.pillarBandGeo = pillarBands();
        const g = new THREE.Group();
        g.add(this.mesh(this.pillarGeo[variant], this.mats.stone));
        g.add(this.mesh(this.pillarBandGeo, this.mats.gold));
        g.rotation.y = (r() - 0.5) * 0.3;
        v.obj = g;
        return v;
      }
      case 'leviathan': {
        const lm = leviathanModel(o.r, o.shape);
        const g = new THREE.Group();
        const head = this.mesh(lm.head, this.mats.flesh);
        g.add(head);
        const eyes: THREE.Group[] = [];
        for (const e of lm.eyes) {
          const eg = new THREE.Group();
          const ball = new THREE.Mesh(new THREE.SphereGeometry(lm.eyeR, 16, 12), this.eyeMat);
          ball.scale.set(1.25, 1, 0.7);
          const pupil = new THREE.Mesh(new THREE.BoxGeometry(lm.eyeR * 0.28, lm.eyeR * 1.6, 1), this.pupilMat);
          pupil.position.z = lm.eyeR * 0.68;
          eg.add(ball, pupil);
          eg.position.copy(e);
          eg.rotation.y = Math.sign(e.x) * 0.35;
          g.add(eg);
          eyes.push(eg);
        }
        v.obj = g;
        v.shared = false;
        const seed = o.shape;
        let blink = 1;
        v.animate = (t) => {
          const breathe = 1 + 0.035 * Math.sin(t * 1.3 + seed);
          head.scale.set(1, breathe, 1);
          blink = (t + (seed % 50) * 0.1) % 5.2 < 0.16 ? 0.1 : 1;
          for (const eg of eyes) {
            eg.scale.set(1, blink, 1);
            eg.position.y = lm.eyes[0].y * breathe;
          }
          g.position.y = Math.sin(t * 0.7 + seed) * 2.5 - 3;
        };
        v.water = (d, oz) => d.add(o.x, oz - o.z, o.vr * 1.9, 1, 0.2, 0.55, DARK_BULK, o.shape);
        v.glow = (gl, oz) => {
          if (blink < 0.5) return;
          for (const e of lm.eyes) gl.add(o.x + e.x, e.y, oz - o.z + e.z + 6, EYE, 0.28, lm.eyeR * 2.6, 8, 0, 1.5);
        };
        return v;
      }
      default:
        return null;
    }
  }

  private buildArch(a: Obstacle, b: Obstacle): View {
    const [l, rr] = a.x < b.x ? [a, b] : [b, a];
    const span = rr.x - l.x;
    const ag = archGeometry(span);
    const g = new THREE.Group();
    g.add(this.mesh(ag.stone, this.mats.stone));
    g.add(this.mesh(ag.gold, this.mats.gold));
    // A lantern swinging beneath the keystone.
    const lanternG = new THREE.Group();
    const chainLen = 20;
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, chainLen, 4), this.mats.dark);
    chain.position.y = -chainLen / 2;
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(6, 8, 6), this.mats.lamp);
    lamp.position.y = -chainLen - 4;
    lanternG.add(chain, lamp);
    lanternG.position.set(0, ag.keystone.y - 18, 0);
    g.add(lanternG);
    const cx = (l.x + rr.x) / 2;
    const cz = (l.z + rr.z) / 2;
    const v: View = { obj: g, x: cx, z: cz, shared: false, seen: this.frame };
    let swing = 0;
    v.animate = (t) => {
      swing = Math.sin(t * 1.6) * 0.25;
      lanternG.rotation.z = swing;
    };
    v.glow = (gl, oz, t) => {
      const ly = ag.keystone.y - 18 - (chainLen + 4) * Math.cos(swing);
      const lx = cx + (chainLen + 4) * Math.sin(swing);
      gl.add(lx, ly, oz - cz, LAMP, 2.6 + 0.3 * Math.sin(t * 9), 40, 6, 0, 5);
    };
    return v;
  }

  private buildColossus(a: Obstacle, b: Obstacle): View {
    const [l, rr] = a.x < b.x ? [a, b] : [b, a];
    const half = (rr.x - l.x) / 2;
    const cm = colossusModel(half, a.shape);
    const fade = { value: 0 };
    const bronze = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.2, roughness: 0.55, name: 'bronze' }), { scale: 30, amp: 0.3, bump: 3, fade, streaks: 0.5 });
    const gold = withDetail(new THREE.MeshStandardMaterial({ color: 0xf0bc58, metalness: 1, roughness: 0.32, name: 'gold-fade' }), { scale: 20, amp: 0.08, bump: 0.3, fade });
    const stone = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, name: 'stone-fade' }), { scale: 34, amp: 0.3, bump: 1.2, wet: true, fade });
    const g = new THREE.Group();
    g.add(this.mesh(cm.bronze, bronze), this.mesh(cm.gold, gold), this.mesh(cm.stone, stone));
    const fire = new THREE.Mesh(new THREE.SphereGeometry(9, 10, 8), this.mats.lamp);
    fire.position.copy(cm.lantern);
    g.add(fire);
    const cx = (l.x + rr.x) / 2;
    const cz = (l.z + rr.z) / 2;
    const v: View = { obj: g, x: cx, z: cz, shared: false, seen: this.frame, fade, span: half + 70, stride: Math.max(half * 0.5, 40) - 34 };
    v.glow = (gl, oz, t) => {
      const fl = 1 + 0.12 * Math.sin(t * 11) + 0.06 * Math.sin(t * 23);
      gl.add(cx + cm.lantern.x, cm.lantern.y, oz - cz + cm.lantern.z, LAMP, 3.2 * fl * (1 - fade.value), 110 * fl, 14, 0, 8);
    };
    v.animate = () => {
      fire.visible = fade.value < 0.95;
    };
    const mats = [bronze, gold, stone];
    const prevDispose = g.userData.dispose;
    g.userData.dispose = () => {
      prevDispose?.();
      for (const m of mats) m.dispose();
    };
    return v;
  }

  /**
   * One of every kind of hazard (and a whirlpool), hidden. Compiling it before the voyage readies every shader the
   * course will need, and keeping it keeps them: a kind's shaders are otherwise compiled the first time one comes over
   * the horizon, and again after the last one has gone (a freeze of a tenth of a second or more each time).
   */
  showcase(): THREE.Group {
    if (this.showcaseView) return this.showcaseView.group;
    const group = new THREE.Group();
    group.name = 'showcase';
    group.visible = false;
    let id = -1;
    const ob = (kind: Obstacle['kind'], extra: Partial<Obstacle> = {}): Obstacle => ({ id: id--, kind, x: 0, z: 0, r: 30, vr: 40, shape: 1, fieldId: 0, ...extra });
    const kinds = [
      ob('rock'),
      ob('iceberg'),
      ob('iceberg', { form: 'shelf', vr: 120 }),
      ob('island', { vr: 90 }),
      ob('debris', { vr: 10 }),
      ob('wreck', { vr: 70 }),
      ob('pillar'),
      ob('leviathan', { r: 50, vr: 60 }),
    ];
    for (const o of kinds) {
      const v = this.build(o);
      if (v) group.add(v.obj);
    }
    group.add(this.buildArch(ob('pillar', { x: -100 }), ob('pillar', { x: 100 })).obj);
    group.add(this.buildColossus(ob('colossus', { x: -90 }), ob('colossus', { x: 90 })).obj);
    // The pieces only some views have: a fort's flag and a lighthouse's lamp.
    group.add(this.mesh(new THREE.PlaneGeometry(1, 1), this.flagMat, false), this.mesh(new THREE.SphereGeometry(1, 6, 4), this.mats.lamp, false));
    const whirl = new WhirlpoolView(this.sky, this.funnel);
    group.add(whirl.mesh);
    this.showcaseView = { group, whirl };
    return group;
  }

  // ----------------------------------------------------------- per frame

  /**
   * Sync with the simulation: create views for hazards charted ahead (within the budget), drop those left behind,
   * place everything relative to the floating origin, animate, and fill the decal and glow lists.
   */
  update(sim: Simulation, oz: number, camX: number, camZ: number, time: number, budgetMs: number, decals: WaterDecals, glows: Glows, tentacles: Tentacles, far: number): void {
    this.frame++;
    const t0 = performance.now();
    const pairs = new Map<number, Obstacle>();
    tentacles.begin();
    for (const o of sim.obstacles) {
      const dz = o.z - camZ;
      if (o.kind === 'tentacle') {
        if (o.hidden || dz > far || dz < -300) continue;
        const s = o.shape;
        tentacles.add(o.x, oz - o.z, (s % 360) * 0.0174, (s % 1000) * 0.0063, s % 2 ? 1 : -1, o.vr * (5.4 + (s % 7) * 0.25), o.vr * 1.0);
        continue;
      }
      if ((o.kind === 'pillar' || o.kind === 'colossus') && o.fieldId) {
        const other = pairs.get(o.fieldId);
        if (!other) pairs.set(o.fieldId, o);
        else {
          const key = (o.kind === 'pillar' ? 'arch:' : 'col:') + o.fieldId;
          let v = this.views.get(key);
          if (!v && (performance.now() - t0 < budgetMs || dz < far)) {
            v = o.kind === 'pillar' ? this.buildArch(other, o) : this.buildColossus(other, o);
            this.add(key, v);
          }
          if (v) v.seen = this.frame;
        }
        if (o.kind === 'colossus') continue;
      }
      if (o.hidden) continue;
      const key = String(o.id);
      let v = this.views.get(key);
      if (!v) {
        // Cheap views always; costly ones within the frame's budget (they are charted far beyond the mist).
        const heavy = o.kind === 'island' || o.kind === 'wreck' || o.kind === 'leviathan' || o.form === 'shelf';
        if (heavy && performance.now() - t0 > budgetMs && dz > far) continue;
        const built = this.build(o);
        if (!built) continue;
        v = built;
        this.add(key, v);
      }
      v.seen = this.frame;
    }
    tentacles.end(time);
    if (this.pending.length && performance.now() - t0 < budgetMs * 0.5) this.pending.pop()?.();

    // Whirlpools: funnels in the sea.
    for (const w of sim.whirlpools) this.whirl(w, oz, camZ, far);
    for (const [id, w] of this.whirls) {
      if (w.seen !== this.frame) {
        this.group.remove(w.view.mesh);
        w.view.dispose();
        this.whirls.delete(id);
      }
    }

    for (const [key, v] of this.views) {
      if (v.seen !== this.frame) {
        this.drop(key, v);
        continue;
      }
      const dz = v.z - camZ;
      const visible = dz < far && dz > -700;
      v.obj.visible = visible;
      if (!visible) continue;
      v.obj.position.x = v.x;
      v.obj.position.z = oz - v.z;
      if (v.lod) {
        const want = dz < 1100 ? v.lod.hi : v.lod.lo;
        if (v.lod.mesh.geometry !== want) v.lod.mesh.geometry = want;
      }
      if (v.fade) {
        // Dissolve only if the camera would pass through it (outside the stride of its legs).
        const off = Math.abs(camX - v.x);
        const through = off > (v.stride ?? 0) && off < (v.span ?? 0);
        v.fade.value = through ? smooth(300, 70, dz) : 0;
      }
      v.animate?.(time, dz);
      v.water?.(decals, oz);
      v.glow?.(glows, oz, time);
    }
  }

  private whirl(w: Whirlpool, oz: number, camZ: number, far: number): void {
    const dz = w.z - camZ;
    let e = this.whirls.get(w.id);
    if (!e) {
      const view = new WhirlpoolView(this.sky, this.funnel);
      this.group.add(view.mesh);
      e = { view, seen: this.frame };
      this.whirls.set(w.id, e);
    }
    e.seen = this.frame;
    const m = e.view.mesh;
    m.visible = dz < far && dz > -w.pullRadius - 400;
    m.position.set(w.x, 0, oz - w.z);
  }

  /** Whirlpools to cut out of the sea, nearest first, and their funnel settings. */
  whirlList(sim: Simulation, camZ: number, far: number, seaDeep: THREE.Color, light: THREE.Color, ambient: THREE.Color): Whirlpool[] {
    const out: Whirlpool[] = [];
    for (const w of sim.whirlpools) {
      const dz = w.z - camZ;
      if (dz > far || dz < -w.pullRadius - 400) continue;
      out.push(w);
      const e = this.whirls.get(w.id);
      e?.view.set(w.spin, w.coreRadius / w.pullRadius, w.pullRadius, funnelDepthFor(w.pullRadius), seaDeep, light, ambient);
    }
    out.sort((a, b) => a.z - b.z);
    return out;
  }

  private add(key: string, v: View): void {
    this.views.set(key, v);
    this.group.add(v.obj);
  }

  private drop(key: string, v: View): void {
    this.group.remove(v.obj);
    if (!v.shared) {
      v.obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && m.geometry !== this.pillarBandGeo && !this.pillarGeo.includes(m.geometry)) m.geometry.dispose();
        const mat = m.material as THREE.Material | undefined;
        // Only per-view materials are disposed (shared ones belong to Materials, or are kept here).
        if (mat && !this.keep.has(mat) && !Object.values(this.mats).includes(mat)) mat.dispose();
      });
      (v.obj.userData.dispose as (() => void) | undefined)?.();
    }
    this.views.delete(key);
  }

  dispose(): void {
    this.reset();
    for (const m of this.keep) m.dispose();
    if (this.showcaseView) {
      this.showcaseView.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && !this.pillarGeo.includes(m.geometry) && m.geometry !== this.pillarBandGeo) m.geometry.dispose();
        const mat = m.material as THREE.Material | undefined;
        if (mat && !this.keep.has(mat) && !Object.values(this.mats).includes(mat)) mat.dispose();
      });
      this.showcaseView.whirl.dispose();
    }
    for (const c of this.geoCache.values()) c.geo.dispose();
    for (const g of this.pillarGeo) g?.dispose();
    this.pillarBandGeo?.dispose();
    for (const g of this.debrisGeo.values()) g.dispose();
    this.funnel.dispose();
  }
}
