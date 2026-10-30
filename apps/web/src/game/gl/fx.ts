import * as THREE from 'three';
import type { Particle } from '../particles';
import { detailPatch } from './materials';
import { SKY_GLSL, type SkyUniforms } from './sky';
import { waterNormalTexture } from './textures';
import { parseColor } from './util';

const LAYER_NO_MIRROR = 1;

function onLayer<T extends THREE.Object3D>(o: T, layer: number): T {
  o.layers.set(layer);
  return o;
}

// ------------------------------------------------------------------ decals on the water

/**
 * Soft shapes lying on the sea: broken foam where it laps against a hazard, and the pale bulk of ice (or the dark
 * bulk of a creature) seen beneath the surface. One instanced draw for all of them.
 */
export class WaterDecals {
  readonly mesh: THREE.InstancedMesh;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private n = 0;
  private readonly m = new THREE.Matrix4();

  constructor(sky: SkyUniforms, max = 400) {
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI / 2);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.params.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aParams', this.params);
    geo.setAttribute('aColor', this.colors);
    const mat = new THREE.ShaderMaterial({
      name: 'WaterDecals',
      uniforms: { ...sky, uLight: { value: new THREE.Color() } },
      vertexShader: /* glsl */ `
        attribute vec4 aParams;
        attribute vec3 aColor;
        varying vec2 vLocal;
        varying vec3 vWorld;
        varying vec4 vParams;
        varying vec3 vColor;
        void main() {
          vLocal = position.xz;
          vParams = aParams;
          vColor = aColor;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uLight;
        varying vec2 vLocal;
        varying vec3 vWorld;
        varying vec4 vParams;
        varying vec3 vColor;
        ${SKY_GLSL}
        void main() {
          float d = length(vLocal);
          if (d > 1.0) discard;
          float kind = vParams.w;
          float a;
          vec3 col;
          float fade = 1.0 - smoothstep(2500.0, 3300.0, length(cameraPosition - vWorld));
          if (kind < 0.5) {
            // Lapping foam: a broken ring that breathes in and out.
            float inner = vParams.x;
            float n = texture2D(uNoise, vWorld.xz / 46.0 + vec2(uTime * 0.02, vParams.z)).g;
            float m = texture2D(uNoise, vWorld.xz / 15.0 - vec2(0.0, uTime * 0.05)).b;
            float pulse = 0.04 * sin(uTime * 2.2 + vParams.z * 30.0);
            float band = smoothstep(inner - 0.06, inner + 0.02, d) * (1.0 - smoothstep(inner + 0.05 + pulse, 1.0, d + (n - 0.5) * 0.35));
            a = band * smoothstep(0.35, 0.8, n * 0.6 + m * 0.6) * vParams.y;
            col = vColor * (uLight * 0.16 + uHaze * 0.3);
          } else {
            // A soft shape beneath the surface.
            a = pow(1.0 - smoothstep(vParams.x, 1.0, d), 1.5) * vParams.y;
            col = vColor;
          }
          gl_FragColor = vec4(col, a * fade);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = onLayer(new THREE.InstancedMesh(geo, mat, max), LAYER_NO_MIRROR);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
  }

  get material(): THREE.ShaderMaterial {
    return this.mesh.material as THREE.ShaderMaterial;
  }

  begin(): void {
    this.n = 0;
  }

  /**
   * Foam (kind 0, `inner` = where the ring starts as a share of radius) or a bulk beneath (kind 1). `radiusZ`
   * stretches it along the course (an ellipse) when given.
   */
  add(x: number, z: number, radius: number, kind: 0 | 1, inner: number, strength: number, color: THREE.Color, seed: number, radiusZ = radius): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    const i = this.n++;
    this.m.makeScale(radius, 1, radiusZ).setPosition(x, kind === 0 ? 0.9 : 0.5, z);
    this.mesh.setMatrixAt(i, this.m);
    this.params.setXYZW(i, inner, strength, seed % 97 / 97, kind);
    this.colors.setXYZ(i, color.r, color.g, color.b);
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.params.needsUpdate = true;
    this.colors.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------------ glows

/** Camera-facing glows (lanterns, treasure, eyes): additive, one instanced draw. */
export class Glows {
  readonly mesh: THREE.InstancedMesh;
  private readonly a: THREE.InstancedBufferAttribute;
  private readonly b: THREE.InstancedBufferAttribute;
  private n = 0;
  private readonly m = new THREE.Matrix4();

  constructor(max = 300) {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.a.setUsage(THREE.DynamicDrawUsage);
    this.b.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGlow', this.a);
    geo.setAttribute('aShape', this.b);
    const mat = new THREE.ShaderMaterial({
      name: 'Glows',
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 aGlow;
        attribute vec4 aShape;
        varying vec2 vP;
        varying vec4 vGlow;
        varying vec4 vShape;
        varying float vFade;
        void main() {
          vP = position.xy;
          vGlow = aGlow;
          vShape = aShape;
          vec4 c = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec4 mv = viewMatrix * c;
          float dist = length(mv.xyz);
          vFade = 1.0 - smoothstep(2400.0, 3300.0, dist);
          // Never smaller than a couple of pixels' worth: distant treasure still catches the eye.
          float size = max(aShape.x, dist * 0.004 * aShape.w);
          mv.xy += position.xy * size;
          // Pull towards the camera a little so the glow is not cut by the thing that casts it.
          mv.xyz *= 1.0 - min(0.3, aShape.y / max(dist, 1.0));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vP;
        varying vec4 vGlow;
        varying vec4 vShape;
        varying float vFade;
        void main() {
          float d = length(vP);
          if (d > 1.0) discard;
          float g = exp(-d * d * 7.0) * 0.8 + exp(-d * 22.0) * 0.9;
          // Rays (super coins): slow-turning spokes of light.
          if (vShape.z > 0.0) {
            float ang = atan(vP.y, vP.x) + uTime * 0.7;
            float rays = pow(abs(cos(ang * 3.0)), 24.0) * (1.0 - d) * vShape.z;
            g += rays;
          }
          g *= 1.0 - smoothstep(0.75, 1.0, d);
          gl_FragColor = vec4(vGlow.rgb * g * vGlow.a * vFade, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.count = 0;
  }

  get material(): THREE.ShaderMaterial {
    return this.mesh.material as THREE.ShaderMaterial;
  }

  begin(): void {
    this.n = 0;
  }

  /** A glow at (x, y, z): colour × intensity, world size, pull towards camera, rays, and min on-screen size. */
  add(x: number, y: number, z: number, color: THREE.Color, intensity: number, size: number, pull = 0, rays = 0, minScreen = 0): void {
    if (this.n >= this.mesh.instanceMatrix.count || intensity <= 0) return;
    const i = this.n++;
    this.m.makeTranslation(x, y, z);
    this.mesh.setMatrixAt(i, this.m);
    this.a.setXYZW(i, color.r, color.g, color.b, intensity);
    this.b.setXYZW(i, size, pull, rays, minScreen);
  }

  end(time: number): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
    this.material.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------------ particles

const MAX_POINTS = 1200;

/**
 * The runner's cosmetic particles (spray, sparks, bubbles, splinters) drawn in 3D: soft points for spray and bubbles,
 * glowing points for sparks, and little tumbling planks for splinters.
 */
export class ParticleView {
  readonly group = new THREE.Group();
  private readonly soft: THREE.Points;
  private readonly bright: THREE.Points;
  private readonly splinters: THREE.InstancedMesh;
  private readonly softBuf: { pos: Float32Array; col: Float32Array; size: Float32Array; geo: THREE.BufferGeometry };
  private readonly brightBuf: { pos: Float32Array; col: Float32Array; size: Float32Array; geo: THREE.BufferGeometry };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  readonly uScale = { value: 400 };

  constructor(wood: THREE.Material) {
    const mk = (additive: boolean) => {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(MAX_POINTS * 3);
      const col = new Float32Array(MAX_POINTS * 4);
      const size = new Float32Array(MAX_POINTS);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
      const mat = new THREE.ShaderMaterial({
        name: additive ? 'Sparks' : 'Spray',
        uniforms: { uScale: this.uScale },
        vertexShader: /* glsl */ `
          attribute vec4 aColor;
          attribute float aSize;
          uniform float uScale;
          varying vec4 vColor;
          void main() {
            vColor = aColor;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(aSize * uScale / max(-mv.z, 1.0), 1.0, 96.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec4 vColor;
          void main() {
            vec2 p = gl_PointCoord * 2.0 - 1.0;
            float d = dot(p, p);
            if (d > 1.0) discard;
            float a = ${additive ? 'exp(-d * 3.0)' : '(1.0 - d) * (1.0 - d)'};
            gl_FragColor = vec4(vColor.rgb${additive ? ' * vColor.a * a, 1.0' : ', vColor.a * a'});
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const pts = onLayer(new THREE.Points(geo, mat), LAYER_NO_MIRROR);
      pts.frustumCulled = false;
      pts.renderOrder = 6;
      return { pts, buf: { pos, col, size, geo } };
    };
    const a = mk(false);
    const b = mk(true);
    this.soft = a.pts;
    this.softBuf = a.buf;
    this.bright = b.pts;
    this.brightBuf = b.buf;
    const box = new THREE.BoxGeometry(1, 0.32, 0.18);
    this.splinters = new THREE.InstancedMesh(box, wood, 240);
    this.splinters.frustumCulled = false;
    this.splinters.count = 0;
    this.splinters.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(240 * 3), 3);
    this.group.add(this.soft, this.bright, this.splinters);
  }

  update(items: readonly Particle[], originZ: number): void {
    let ns = 0;
    let nb = 0;
    let nw = 0;
    const S = this.softBuf;
    const B = this.brightBuf;
    for (const p of items) {
      const life = Math.max(0, p.life / p.maxLife);
      const [r, g, b, a0] = parseColor(p.color);
      const z = originZ - p.z;
      if (p.kind === 'splinter') {
        if (nw >= 240) continue;
        this.e.set(p.angle, p.angle * 0.7 + p.spin, p.angle * 1.3);
        this.q.setFromEuler(this.e);
        const sz = p.size * 2.2 * (0.4 + 0.6 * Math.min(1, life * 3));
        this.s.set(sz, sz, sz);
        this.v.set(p.x, p.y, z);
        this.m.compose(this.v, this.q, this.s);
        this.splinters.setMatrixAt(nw, this.m);
        this.c.setRGB(r, g, b);
        this.splinters.setColorAt(nw, this.c);
        nw++;
      } else if (p.kind === 'spark') {
        if (nb >= MAX_POINTS) continue;
        B.pos[nb * 3] = p.x;
        B.pos[nb * 3 + 1] = p.y;
        B.pos[nb * 3 + 2] = z;
        B.col[nb * 4] = r * 4;
        B.col[nb * 4 + 1] = g * 4;
        B.col[nb * 4 + 2] = b * 4;
        B.col[nb * 4 + 3] = life * a0;
        B.size[nb] = p.size * 3.2;
        nb++;
      } else {
        if (ns >= MAX_POINTS) continue;
        const bubble = p.kind === 'bubble';
        S.pos[ns * 3] = p.x;
        S.pos[ns * 3 + 1] = Math.max(p.y, 0.5);
        S.pos[ns * 3 + 2] = z;
        S.col[ns * 4] = r * 1.1;
        S.col[ns * 4 + 1] = g * 1.1;
        S.col[ns * 4 + 2] = b * 1.1;
        S.col[ns * 4 + 3] = life * a0 * (bubble ? 0.7 : 0.75);
        // Spray billows as it flies.
        S.size[ns] = p.size * (bubble ? 2.4 : 3.2 + (1 - life) * 4);
        ns++;
      }
    }
    for (const [buf, n] of [
      [S, ns],
      [B, nb],
    ] as const) {
      buf.geo.setDrawRange(0, n);
      for (const name of ['position', 'aColor', 'aSize']) (buf.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
    this.splinters.count = nw;
    this.splinters.instanceMatrix.needsUpdate = true;
    if (this.splinters.instanceColor) this.splinters.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.softBuf.geo.dispose();
    this.brightBuf.geo.dispose();
    (this.soft.material as THREE.Material).dispose();
    (this.bright.material as THREE.Material).dispose();
    this.splinters.geometry.dispose();
  }
}

// ------------------------------------------------------------------ wake

const WAKE_MAX = 160;

/** The ship's wake: a churned lane straight astern and the two arms of foam spreading behind it. */
export class Wake {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly data: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private trail: { x: number; z: number }[] = [];

  constructor(sky: SkyUniforms) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(WAKE_MAX * 2 * 3);
    this.data = new Float32Array(WAKE_MAX * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i < WAKE_MAX - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aWake', new THREE.BufferAttribute(this.data, 2).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      name: 'Wake',
      uniforms: { ...sky, uLight: { value: new THREE.Color() } },
      vertexShader: /* glsl */ `
        attribute vec2 aWake;
        varying vec2 vWake;
        varying vec3 vWorld;
        void main() {
          vWake = aWake;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uLight;
        varying vec2 vWake;
        varying vec3 vWorld;
        ${SKY_GLSL}
        void main() {
          float u = vWake.x;
          float age = vWake.y;
          float n = texture2D(uNoise, vWorld.xz / 38.0).g;
          float m = texture2D(uNoise, vWorld.xz / 13.0 + vec2(uTime * 0.03, 0.0)).b;
          // The arms: thin crests at the edges, breaking up as they age.
          float arm = smoothstep(0.9, 0.975, abs(u)) * (1.0 - smoothstep(0.975, 1.0, abs(u)));
          arm *= smoothstep(0.35, 0.7, n + m * 0.3 + 0.1 - age * 0.4);
          // The churned lane astern.
          float lane = (1.0 - smoothstep(0.0, 0.22 + age * 0.15, abs(u))) * smoothstep(0.3, 0.75, m * 0.7 + n * 0.5);
          float fade = 1.0 - smoothstep(0.0, 1.0, age);
          float a = (arm * 0.6 + lane * 0.55) * fade * smoothstep(0.0, 0.03, age);
          vec3 col = uLight * 0.15 + uHaze * 0.32;
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = onLayer(new THREE.Mesh(this.geo, mat), LAYER_NO_MIRROR);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  reset(): void {
    this.trail = [];
  }

  update(shipX: number, shipZ: number, alive: boolean, originZ: number, cameraZ: number, light: THREE.Color): void {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uLight.value.copy(light);
    if (alive) {
      const last = this.trail[this.trail.length - 1];
      if (!last || shipZ - last.z > 10) this.trail.push({ x: shipX, z: shipZ });
      else if (last && shipZ < last.z) this.trail = [{ x: shipX, z: shipZ }];
      while (this.trail.length > WAKE_MAX - 1 || (this.trail.length > 2 && this.trail[0].z < cameraZ - 200)) this.trail.shift();
    }
    const pts = alive ? [...this.trail, { x: shipX, z: shipZ }] : this.trail;
    const head = pts[pts.length - 1];
    const n = Math.min(WAKE_MAX, pts.length);
    for (let k = 0; k < n; k++) {
      const p = pts[pts.length - 1 - k];
      const age = head ? head.z - p.z : 0;
      const halfW = 14 + age * 0.34;
      const z = originZ - (p.z - 34);
      this.pos.set([p.x - halfW, 0, z, p.x + halfW, 0, z], k * 6);
      this.data.set([-1, age / 520, 1, age / 520], k * 4);
    }
    this.geo.setDrawRange(0, Math.max(0, (n - 1) * 6));
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aWake') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------ whirlpools

/** The surface of a whirlpool's funnel at radius r (shares of the pull radius): 0 at the rim, deep at the core. */
export function funnelDepth(r: number, core: number, depth: number): number {
  const k = (0.8 * depth) / (1 / core - 1);
  if (r >= 1) return 0;
  if (r > core) return -Math.min(depth, k * (1 / r - 1));
  return -0.8 * depth - (1 - r / core) * depth * 0.5;
}

/** How deep a whirlpool's funnel is (world units at the throat). */
export function funnelDepthFor(pullRadius: number): number {
  return 34 + pullRadius * 0.12;
}

/** A whirlpool: the sea drawn down into a turning funnel, spiral arms of foam, a black throat. */
export class WhirlpoolView {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor(sky: SkyUniforms, geo: THREE.BufferGeometry) {
    this.mat = new THREE.ShaderMaterial({
      name: 'Whirlpool',
      uniforms: {
        ...sky,
        uWaves: { value: waterNormalTexture() },
        uSpin: { value: 1 },
        uCore: { value: 0.15 },
        uRadius: { value: 180 },
        uDepth: { value: 80 },
        uSeaDeep: { value: new THREE.Color() },
        uLight: { value: new THREE.Color() },
        uAmbient: { value: new THREE.Color() },
        uHalfWidth: { value: 440 },
      },
      vertexShader: /* glsl */ `
        uniform float uCore;
        uniform float uRadius;
        uniform float uDepth;
        varying vec3 vWorld;
        varying vec2 vPolar;
        varying vec3 vNormal2;
        uniform float uHalfWidth;
        float depthAt(float r) {
          float k = (0.8 * uDepth) / (1.0 / uCore - 1.0);
          if (r >= 1.0) return 0.0;
          if (r > uCore) return -min(uDepth, k * (1.0 / r - 1.0));
          return -0.8 * uDepth - (1.0 - r / uCore) * uDepth * 0.5;
        }
        void main() {
          float r = length(position.xz);
          // Near the Edge the funnel flattens out (the current there runs over the lip instead).
          float wx = (modelMatrix * vec4(position.x * uRadius, 0.0, position.z * uRadius, 1.0)).x;
          float lip = smoothstep(uHalfWidth, uHalfWidth - 70.0, abs(wx));
          vec3 p = vec3(position.x * uRadius, depthAt(r) * lip, position.z * uRadius);
          float e = 0.01;
          float dy = lip * (depthAt(r + e) - depthAt(max(r - e, 0.0))) / (2.0 * e * uRadius);
          vec2 dir = r > 1e-4 ? position.xz / r : vec2(0.0);
          vNormal2 = normalize(vec3(-dir.x * dy, 1.0, -dir.y * dy));
          vPolar = vec2(r, atan(position.z, position.x));
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uWaves;
        uniform float uSpin;
        uniform float uCore;
        uniform vec3 uSeaDeep;
        uniform vec3 uLight;
        uniform vec3 uAmbient;
        uniform float uHalfWidth;
        varying vec3 vWorld;
        varying vec2 vPolar;
        varying vec3 vNormal2;
        ${SKY_GLSL}
        void main() {
          if (abs(vWorld.x) > uHalfWidth) discard;
          float r = vPolar.x;
          float th = vPolar.y;
          // Faster towards the throat; arms wound into a spiral.
          // The spiral turns as one (a rate that varied with radius would wind it up into rings over time);
          // the water's flow inwards along the arms is the scrolling of the noise.
          float swirl = th - uSpin * uTime * 1.3 + uSpin * log(max(r, 0.02)) * 1.6;
          float brk = texture2D(uNoise, vec2(swirl * 0.16, r * 0.8 + uTime * 0.06)).r;
          float arms = (0.5 + 0.5 * sin(swirl * 3.0 + brk * 4.0)) * smoothstep(0.25, 0.7, brk + 0.2);
          float arms2 = texture2D(uNoise, vec2(swirl / 6.2831 * 9.0 + 0.3, r * 0.5 + uTime * 0.08)).b;
          vec2 p = vec2(vWorld.x, -vWorld.z);
          vec4 w = texture2D(uWaves, p / 190.0 + vec2(-0.013, 0.009) * uTime);
          vec3 N = normalize(vNormal2 + vec3(w.x - 0.5, 0.0, -(w.y - 0.5)) * 0.8);
          vec3 V = normalize(cameraPosition - vWorld);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 col = mix(uSeaDeep * uAmbient * 0.9, skyBase(R), fres);
          vec3 H = normalize(uSunDir + V);
          col += uSunColor * uSunPower * pow(max(dot(N, H), 0.0), 300.0) * 2.0 * smoothstep(-0.08, 0.04, uSunDir.y);
          // Darkening down the throat.
          col *= mix(0.08, 1.0, smoothstep(uCore * 0.6, 0.75, r));
          // Foam: spiral streaks, strongest mid-way, and a white ring round the throat.
          float foam = smoothstep(0.62, 0.95, arms * 0.65 + arms2 * 0.45) * smoothstep(1.0, 0.5, r) * smoothstep(uCore * 0.8, uCore * 2.0, r);
          foam += smoothstep(uCore * 1.6, uCore * 1.1, r) * smoothstep(uCore * 0.7, uCore * 1.05, r) * (0.6 + 0.4 * arms2);
          col = mix(col, uAmbient * 1.1 + uLight * 0.45, clamp(foam, 0.0, 1.0) * 0.9);
          if (r < uCore * 0.75) col = mix(col, uAbyss * 0.4, smoothstep(uCore * 0.75, uCore * 0.35, r));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.mesh = onLayer(new THREE.Mesh(geo, this.mat), LAYER_NO_MIRROR);
    this.mesh.frustumCulled = false;
  }

  set(spin: number, core: number, radius: number, depth: number, seaDeep: THREE.Color, light: THREE.Color, ambient: THREE.Color): void {
    const u = this.mat.uniforms;
    u.uSpin.value = spin;
    u.uCore.value = core;
    u.uRadius.value = radius;
    u.uDepth.value = depth;
    u.uSeaDeep.value.copy(seaDeep);
    u.uLight.value.copy(light);
    u.uAmbient.value.copy(ambient);
  }

  dispose(): void {
    this.mat.dispose();
  }
}

/** A unit disc, dense towards the centre, for whirlpool funnels. */
export function funnelGeometry(): THREE.BufferGeometry {
  const rings = 40;
  const segs = 64;
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let j = 1; j <= rings; j++) {
    const r = (j / rings) ** 1.6;
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  for (let k = 0; k < segs; k++) idx.push(0, 1 + ((k + 1) % segs), 1 + k);
  for (let j = 1; j < rings; j++)
    for (let k = 0; k < segs; k++) {
      const a = 1 + (j - 1) * segs + k;
      const b = 1 + (j - 1) * segs + ((k + 1) % segs);
      const c = 1 + j * segs + k;
      const d = 1 + j * segs + ((k + 1) % segs);
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------ tentacles

const TENTACLE_GLSL = /* glsl */ `
  uniform float uTime;
  attribute vec4 aTent;
  varying float vTentT;
  varying float vTentInner;
  vec3 tentC(float t) {
    float B = aTent.w;
    float H = aTent.z;
    float ph = aTent.x;
    float curl = aTent.y;
    float k = t * t * t;
    float sway = sin(uTime * 1.8 + ph + t * 3.4) * B * 1.3 * t;
    float sway2 = cos(uTime * 1.3 + ph * 1.7 + t * 2.6) * B * 0.9 * t;
    float hook = curl * B * (2.4 + 0.6 * sin(uTime * 0.9 + ph)) * k;
    float droop = H * 0.14 * k * k * (0.7 + 0.3 * sin(uTime * 0.9 + ph));
    return vec3(sway + hook, H * t - droop, sway2 + B * 0.6 * t * t);
  }
  void tentBend(out vec3 pos, out vec3 nor) {
    float t = position.y;
    vec3 c = tentC(t);
    vec3 T = normalize(tentC(min(t + 0.02, 1.0)) - tentC(max(t - 0.02, 0.0)));
    vec3 N = normalize(cross(T, vec3(0.0, 0.0, 1.0)));
    vec3 Bn = normalize(cross(N, T));
    vec3 radial = N * position.x + Bn * position.z;
    float inner = dot(radial, N) * sign(aTent.y + 0.001);
    float rad = aTent.w * (0.12 + 0.88 * pow(max(1.0 - t, 0.0), 1.7)) + 0.5;
    // Suckers on the inner side of the curl.
    rad *= 1.0 + 0.1 * smoothstep(0.4, 0.9, inner) * smoothstep(0.2, 0.5, abs(fract(t * 22.0) - 0.5) * 2.0);
    pos = c + radial * rad;
    // The caps' centre vertices have no radial direction: face along the tentacle instead (never a zero normal).
    nor = dot(position.xz, position.xz) > 1e-4 ? radial : (t > 0.5 ? T : -T);
    vTentT = t;
    vTentInner = inner;
  }
`;

/** Every kraken tentacle in view: one instanced, GPU-animated draw (and its shadow). */
export class Tentacles {
  readonly mesh: THREE.InstancedMesh;
  private readonly attr: THREE.InstancedBufferAttribute;
  readonly uTime = { value: 0 };
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(max = 96) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 28, false);
    geo.translate(0, 0.5, 0);
    // Normalise the ring to a unit circle; caps collapse onto the axis.
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const l = Math.hypot(x, z);
      if (l > 1e-4) {
        p.setX(i, x / l);
        p.setZ(i, z / l);
      }
    }
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTent', this.attr);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0, name: 'tentacle' });
    const detail = detailPatch({ scale: 7, amp: 0.2, bump: 1.0, wet: true });
    mat.customProgramCacheKey = () => 'tentacle';
    mat.onBeforeCompile = (shader) => {
      detail(shader);
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${TENTACLE_GLSL}`)
        .replace('#include <beginnormal_vertex>', 'vec3 tentPos; vec3 objectNormal; tentBend(tentPos, objectNormal);')
        .replace('#include <begin_vertex>', 'vec3 transformed = tentPos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vTentT;\nvarying float vTentInner;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec3 dark = vec3(0.05, 0.008, 0.035);
            vec3 skin = vec3(0.2, 0.035, 0.12);
            vec3 belly = vec3(0.62, 0.32, 0.38);
            vec3 c = mix(dark, skin, 0.35 + 0.65 * smoothstep(-0.6, 0.6, -vTentInner));
            float sucker = smoothstep(0.5, 0.85, vTentInner);
            float ring = smoothstep(0.35, 0.15, abs(fract(vTentT * 22.0) - 0.5));
            c = mix(c, belly, sucker * (0.55 + 0.45 * ring));
            diffuseColor.rgb = c;
          }`,
        );
    };
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${TENTACLE_GLSL}`)
        .replace('#include <begin_vertex>', 'vec3 tentPos; vec3 tentNor; tentBend(tentPos, tentNor); vec3 transformed = tentPos;');
    };
    depth.customProgramCacheKey = () => 'tentacle-depth';
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  begin(): void {
    this.n = 0;
  }

  add(x: number, z: number, yaw: number, phase: number, curl: number, height: number, base: number): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    const i = this.n++;
    this.q.setFromAxisAngle(this.up, yaw);
    this.v.set(x, -2, z);
    this.m.compose(this.v, this.q, this.one);
    this.mesh.setMatrixAt(i, this.m);
    this.attr.setXYZW(i, phase, curl, height, base);
  }

  end(time: number): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.attr.needsUpdate = true;
    this.uTime.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.customDepthMaterial?.dispose();
  }
}

