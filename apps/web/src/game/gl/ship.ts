import * as THREE from 'three';
import type { Glows } from './fx';
import { withDetail, withFade } from './materials';
import { shipModel, type ShipModel } from './models';
import { canvasTexture, emblem } from './textures';

const LANTERN = new THREE.Color(1.0, 0.72, 0.36);
const SHIELD = new THREE.Color(1.0, 0.85, 0.5);

/** The sail's cloth: canvas panels, seams, and the Society's emblem on the main course. */
function sailTexture(withEmblem: boolean): THREE.Texture {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, '#d9ccab');
    g.addColorStop(0.5, '#f1e7cc');
    g.addColorStop(1, '#d4c6a2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    // Panels and seams.
    ctx.strokeStyle = 'rgba(120,96,58,0.35)';
    ctx.lineWidth = 2;
    for (let i = 1; i < 7; i++) {
      ctx.beginPath();
      ctx.moveTo((i * 256) / 7, 0);
      ctx.lineTo((i * 256) / 7, 256);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(90,70,40,0.25)';
    for (let y = 40; y < 256; y += 70) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();
    }
    // Weathering.
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(${90 + Math.random() * 40},${70 + Math.random() * 30},40,${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 12, 2 + Math.random() * 12);
    }
    // Bolt rope round the edges.
    ctx.strokeStyle = 'rgba(80,60,30,0.7)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 250, 250);
    if (withEmblem) emblem(ctx, 128, 132, 50, 'rgba(140,90,43,0.9)', 9);
  });
}

/**
 * The explorer's vessel: a little galleon with sails that breathe in the wind, a pennant streaming from the
 * masthead, lit stern windows and a lantern. Banks into turns, heads a touch into them, pitches over the swell,
 * and glows while the Society's protection holds after a second chance.
 */
export class ShipView {
  readonly group = new THREE.Group();
  private readonly hull = new THREE.Group();
  private readonly model: ShipModel;
  private readonly sails: { mesh: THREE.Mesh; base: Float32Array; w: number; h: number; belly: number }[] = [];
  private readonly pennant: THREE.Mesh;
  private readonly pennantBase: Float32Array;
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly shield: THREE.Mesh;
  private readonly shieldMat: THREE.ShaderMaterial;
  readonly fade = { value: 0 };
  private readonly glowCol = new THREE.Color();

  constructor() {
    this.model = shipModel();
    const fade = this.fade;
    const wood = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, name: 'ship-wood' }), { scale: 9, amp: 0.22, bump: 0.6, wet: true, fade, streaks: 0.5 });
    const gold = withFade(new THREE.MeshStandardMaterial({ color: 0xf2c25c, metalness: 1, roughness: 0.28, name: 'ship-gold' }), fade, 'g');
    const dark = withFade(new THREE.MeshStandardMaterial({ color: 0x24170c, roughness: 0.8, name: 'ship-dark' }), fade, 'd');
    const windows = withFade(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.7, 0.36).multiplyScalar(1.5), name: 'ship-windows' }), fade, 'w');
    const main = sailTexture(true);
    const top = sailTexture(false);
    this.textures.push(main, top);
    const sailMain = withFade(new THREE.MeshStandardMaterial({ map: main, roughness: 0.95, side: THREE.DoubleSide, name: 'sail-main' }), fade, 's1');
    const sailTop = withFade(new THREE.MeshStandardMaterial({ map: top, roughness: 0.95, side: THREE.DoubleSide, name: 'sail-top' }), fade, 's2');
    const ropes = new THREE.LineBasicMaterial({ color: 0x1c140c, transparent: true, opacity: 0.85 });
    this.materials.push(wood, gold, dark, windows, sailMain, sailTop, ropes);

    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      m.receiveShadow = true;
      this.hull.add(m);
      return m;
    };
    mk(this.model.wood, wood);
    mk(this.model.gold, gold);
    mk(this.model.dark, dark);
    mk(this.model.windows, windows, false);
    this.model.sails.forEach((s, i) => {
      const mesh = mk(s.geo, i === 0 ? sailMain : sailTop);
      mesh.position.copy(s.at);
      this.sails.push({ mesh, base: (s.geo.getAttribute('position') as THREE.BufferAttribute).array.slice() as Float32Array, w: s.w, h: s.h, belly: s.belly });
    });
    const rig = new THREE.LineSegments(this.model.rigging, ropes);
    this.hull.add(rig);
    // Pennant streaming from the masthead.
    const pg = new THREE.PlaneGeometry(30, 6, 8, 1);
    pg.translate(15, 0, 0);
    this.pennantBase = (pg.getAttribute('position') as THREE.BufferAttribute).array.slice() as Float32Array;
    this.pennant = mk(pg, withFade(new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide }), fade, 'p'), false);
    this.materials.push(this.pennant.material as THREE.Material);
    this.pennant.position.copy(this.model.mastTop);
    this.pennant.rotation.y = Math.PI / 2;
    // The Society's protection: a faint shell of light.
    const shieldMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uK: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uK;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.5);
          gl_FragColor = vec4(uColor * (0.015 + rim) * uK, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.materials.push(shieldMat);
    this.shieldMat = shieldMat;
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), shieldMat);
    this.shield.scale.set(66, 84, 88);
    this.shield.position.y = 46;
    this.shield.visible = false;
    this.group.add(this.hull, this.shield);
    this.hull.rotation.order = 'YXZ';
  }

  /**
   * Pose: position (scene space), roll (+ = starboard), heading (+ = turning to starboard), how hard the helm is
   * over (−1…1), visibility, protection glow (0…1).
   */
  update(x: number, y: number, z: number, roll: number, heading: number, helm: number, time: number, alpha: number, shield: number, glows: Glows): void {
    this.group.position.set(x, y, z);
    const pitch = Math.sin(time * 1.7) * 0.02 + Math.sin(time * 3.1) * 0.008;
    const heave = Math.sin(time * 3.1) * 1.2 + Math.sin(time * 1.3) * 0.8;
    this.hull.position.y = heave;
    this.hull.rotation.set(pitch, -heading, -roll);
    this.setAlpha(alpha);
    this.group.visible = alpha > 0.01;

    // Sails: bellied by the wind, breathing, swung a little by the helm.
    const billow = 1 + Math.sin(time * 1.7) * 0.18 + Math.sin(time * 4.3) * 0.05;
    for (const s of this.sails) {
      const p = s.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = p.array as Float32Array;
      for (let i = 0; i < p.count; i++) {
        const bx = s.base[i * 3];
        const by = s.base[i * 3 + 1];
        const u = bx / s.w + 0.5;
        const v = by / s.h + 0.5;
        const bulge = Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + 0.85 * v)) * s.belly * billow;
        arr[i * 3] = bx + helm * 4 * (1 - v);
        arr[i * 3 + 1] = by;
        arr[i * 3 + 2] = -bulge;
      }
      p.needsUpdate = true;
      s.mesh.geometry.computeVertexNormals();
    }
    // Pennant: streams aft, swings away from the turn, ripples.
    {
      const p = this.pennant.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = p.array as Float32Array;
      for (let i = 0; i < p.count; i++) {
        const bx = this.pennantBase[i * 3];
        const by = this.pennantBase[i * 3 + 1];
        const k = bx / 30;
        arr[i * 3] = bx;
        arr[i * 3 + 1] = by * (1 - k * 0.7) - k * 3;
        arr[i * 3 + 2] = Math.sin(time * 9 - bx * 0.35) * 2.2 * k + helm * 10 * k;
      }
      p.needsUpdate = true;
    }

    // Lantern and the protection's glow.
    const lw = this.model.lantern.clone().applyEuler(this.hull.rotation).add(this.group.position);
    lw.y += heave;
    const flick = 0.9 + 0.1 * Math.sin(time * 13) + 0.05 * Math.sin(time * 29);
    glows.add(lw.x, lw.y, lw.z, LANTERN, 0.32 * flick * alpha, 11, 4, 0, 0);
    this.shield.visible = shield > 0.001 && alpha > 0.01;
    if (this.shield.visible) {
      const sm = this.shield.material as THREE.ShaderMaterial;
      sm.uniforms.uColor.value.copy(SHIELD);
      sm.uniforms.uK.value = shield * 0.5;
      this.glowCol.copy(SHIELD);
      glows.add(x, y + 50, z, this.glowCol, 0.22 * shield, 120, 0, 0, 0);
    }
  }

  private alpha = 1;

  /** Fade the whole ship (as it is lost): blended transparency, only while it is fading. */
  private setAlpha(alpha: number): void {
    if (alpha === this.alpha) return;
    const fading = alpha < 0.999;
    for (const m of this.materials) {
      if (m === this.shieldMat) continue;
      if (m.transparent !== fading && !(m instanceof THREE.LineBasicMaterial)) {
        m.transparent = fading;
        m.needsUpdate = true;
      }
      m.opacity = fading ? alpha * (m instanceof THREE.LineBasicMaterial ? 0.85 : 1) : m instanceof THREE.LineBasicMaterial ? 0.85 : 1;
    }
    this.alpha = alpha;
  }

  dispose(): void {
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
