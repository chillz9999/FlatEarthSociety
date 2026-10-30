import * as THREE from 'three';
import { SKY_GLSL, type SkyUniforms } from './sky';

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** One full-screen triangle pair, drawn with a given material. */
class Quad {
  private readonly mesh: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  draw(renderer: THREE.WebGLRenderer, mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.mesh.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.cam);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

function rt(w: number, h: number, opts: THREE.RenderTargetOptions = {}): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    ...opts,
  });
  t.texture.generateMipmaps = false;
  t.texture.minFilter = THREE.LinearFilter;
  t.texture.magFilter = THREE.LinearFilter;
  return t;
}

/** Per-frame settings for the final grade. */
export interface GradeParams {
  exposure: number;
  /** 0…1: how close the ship is to the Edge (a red tint on that side). */
  edge: number;
  edgeSide: number;
  /** 0…1: the darkening at the corners. */
  vignette: number;
  bloom: number;
}

/**
 * The frame after the scene is drawn: bloom on the brightest light, then in one pass the mist that hides the far
 * course, tone mapping, vignette and the warning tint near the Edge.
 */
export class Post {
  readonly scene: THREE.WebGLRenderTarget;
  private readonly blooms: THREE.WebGLRenderTarget[] = [];
  private readonly ups: THREE.WebGLRenderTarget[] = [];
  private readonly quad = new Quad();
  private readonly brightMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly finalMat: THREE.ShaderMaterial;
  private readonly levels = 5;
  private w = 1;
  private h = 1;

  constructor(sky: SkyUniforms, samples: number) {
    this.scene = rt(1, 1, { depthBuffer: true, samples });
    this.scene.depthTexture = new THREE.DepthTexture(1, 1);
    this.scene.depthTexture.type = THREE.UnsignedIntType;
    for (let i = 0; i < this.levels; i++) {
      this.blooms.push(rt(1, 1));
      this.ups.push(rt(1, 1));
    }

    this.brightMat = new THREE.ShaderMaterial({
      name: 'BloomBright',
      uniforms: { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform vec2 uTexel;
        void main() {
          vec3 c = texture2D(tColor, vUv + uTexel * vec2(-0.5, -0.5)).rgb
                 + texture2D(tColor, vUv + uTexel * vec2(0.5, -0.5)).rgb
                 + texture2D(tColor, vUv + uTexel * vec2(-0.5, 0.5)).rgb
                 + texture2D(tColor, vUv + uTexel * vec2(0.5, 0.5)).rgb;
          c *= 0.25;
          // Never let a stray NaN or infinity bloom across the frame.
          if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
          c = min(c, vec3(40.0));
          float l = max(c.r, max(c.g, c.b));
          float knee = 0.5;
          float th = 1.15;
          float soft = clamp(l - th + knee, 0.0, 2.0 * knee);
          soft = soft * soft / (4.0 * knee + 1e-4);
          float k = max(soft, l - th) / max(l, 1e-4);
          gl_FragColor = vec4(c * k, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.downMat = new THREE.ShaderMaterial({
      name: 'BloomDown',
      uniforms: { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform vec2 uTexel;
        void main() {
          vec3 c = texture2D(tColor, vUv).rgb * 4.0;
          c += texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
          c += texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb;
          c += texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
          c += texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
          gl_FragColor = vec4(c / 8.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.upMat = new THREE.ShaderMaterial({
      name: 'BloomUp',
      uniforms: { tColor: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform sampler2D tBase;
        uniform vec2 uTexel;
        void main() {
          vec3 c = vec3(0.0);
          c += texture2D(tColor, vUv + uTexel * vec2(-2.0, 0.0)).rgb;
          c += texture2D(tColor, vUv + uTexel * vec2(2.0, 0.0)).rgb;
          c += texture2D(tColor, vUv + uTexel * vec2(0.0, -2.0)).rgb;
          c += texture2D(tColor, vUv + uTexel * vec2(0.0, 2.0)).rgb;
          c += texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 2.0;
          c += texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb * 2.0;
          c += texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb * 2.0;
          c += texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb * 2.0;
          gl_FragColor = vec4(c / 12.0 + texture2D(tBase, vUv).rgb, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.finalMat = new THREE.ShaderMaterial({
      name: 'Grade',
      uniforms: {
        ...sky,
        tColor: { value: null },
        tDepth: { value: null },
        tBloom: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uFogStart: { value: 1900 },
        uFogEnd: { value: 3300 },
        uExposure: { value: 1 },
        uBloom: { value: 0.6 },
        uEdge: { value: 0 },
        uEdgeSide: { value: 1 },
        uVignette: { value: 1 },
        uFrame: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform sampler2D tBloom;
        uniform mat4 uInvProj;
        uniform mat4 uCamWorld;
        uniform vec3 uCamPos;
        uniform float uFogStart;
        uniform float uFogEnd;
        uniform float uExposure;
        uniform float uBloom;
        uniform float uEdge;
        uniform float uEdgeSide;
        uniform float uVignette;
        uniform float uFrame;
        uniform float uAspect;

        vec3 RRTAndODTFit(vec3 v) {
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }
        vec3 aces(vec3 color) {
          const mat3 ACESInputMat = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
          const mat3 ACESOutputMat = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
          color = ACESInputMat * color;
          color = RRTAndODTFit(color);
          color = ACESOutputMat * color;
          return clamp(color, 0.0, 1.0);
        }
        vec3 toSRGB(vec3 c) {
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        ${SKY_GLSL}

        // The far mist: depth-based, coloured like the sky behind it, so hazards emerge from the haze exactly as
        // the horizon looks (and are hidden until they are well within reach).
        vec3 mist(vec3 col) {
          float depth = texture2D(tDepth, vUv).r;
          if (depth >= 0.999999) return col;
          vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vp /= vp.w;
          float dist = length(vp.xyz);
          vec3 dir = normalize((uCamWorld * vec4(vp.xyz, 0.0)).xyz);
          float wy = uCamPos.y + dir.y * dist;
          float f = smoothstep(uFogStart, uFogEnd, dist);
          f = f * f * (3.0 - 2.0 * f);
          float haze = (1.0 - exp(-dist * 0.00012)) * mix(1.0, 0.6, smoothstep(30.0, 500.0, wy));
          f = max(f, haze * 0.3);
          vec3 fogCol = skyBase(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.35 + 0.004, dir.z)));
          return mix(col, fogCol, clamp(f, 0.0, 1.0));
        }

        void main() {
          vec3 base = texture2D(tColor, vUv).rgb;
          if (any(isnan(base)) || any(isinf(base))) base = vec3(0.0);
          vec3 c = mist(base) + texture2D(tBloom, vUv).rgb * uBloom;
          c = aces(c * uExposure / 0.6);
          // Vignette: the corners of the chart darken.
          vec2 q = (vUv - vec2(0.5, 0.45)) * vec2(uAspect, 1.0);
          float v = smoothstep(0.35, 1.05, length(q) / max(uAspect, 1.0) * 1.35);
          c *= 1.0 - v * 0.55 * uVignette;
          // The Edge is close: a red warning creeping in from that side.
          if (uEdge > 0.0) {
            float s = uEdgeSide > 0.0 ? vUv.x : 1.0 - vUv.x;
            float k = smoothstep(0.55, 1.0, s) * uEdge;
            c = mix(c, c * vec3(1.25, 0.55, 0.45) + vec3(0.12, 0.02, 0.0), k * 0.75);
          }
          c = toSRGB(c);
          // Dither away banding in the dusk gradients.
          c += (hash(gl_FragCoord.xy + uFrame * 17.0) - 0.5) / 255.0;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  /** Multisampling of the scene (0 = off). */
  setSamples(n: number): void {
    if (this.scene.samples === n) return;
    this.scene.samples = n;
    this.scene.dispose();
  }

  setSize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.scene.setSize(this.w, this.h);
    let bw = Math.max(1, Math.round(this.w / 2));
    let bh = Math.max(1, Math.round(this.h / 2));
    for (let i = 0; i < this.levels; i++) {
      this.blooms[i].setSize(bw, bh);
      this.ups[i].setSize(bw, bh);
      bw = Math.max(1, Math.round(bw / 2));
      bh = Math.max(1, Math.round(bh / 2));
    }
  }

  /** Mist, bloom and grade: from `this.scene` (already drawn) to the screen. */
  finish(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, g: GradeParams): void {
    // Bloom: bright pass at half size, down the chain, then back up adding each level.
    if (g.bloom > 0) {
      this.brightMat.uniforms.tColor.value = this.scene.texture;
      this.brightMat.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
      this.quad.draw(renderer, this.brightMat, this.blooms[0]);
      for (let i = 1; i < this.levels; i++) {
        const src = this.blooms[i - 1];
        this.downMat.uniforms.tColor.value = src.texture;
        this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.quad.draw(renderer, this.downMat, this.blooms[i]);
      }
      let cur = this.blooms[this.levels - 1];
      for (let i = this.levels - 2; i >= 0; i--) {
        this.upMat.uniforms.tColor.value = cur.texture;
        this.upMat.uniforms.tBase.value = this.blooms[i].texture;
        this.upMat.uniforms.uTexel.value.set(1 / cur.width, 1 / cur.height);
        this.quad.draw(renderer, this.upMat, this.ups[i]);
        cur = this.ups[i];
      }
    }

    const f = this.finalMat.uniforms;
    f.tColor.value = this.scene.texture;
    f.tDepth.value = this.scene.depthTexture;
    f.uInvProj.value.copy(camera.projectionMatrixInverse);
    f.uCamWorld.value.copy(camera.matrixWorld);
    f.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    f.tBloom.value = this.ups[0].texture;
    f.uExposure.value = g.exposure;
    f.uBloom.value = g.bloom;
    f.uEdge.value = g.edge;
    f.uEdgeSide.value = g.edgeSide;
    f.uVignette.value = g.vignette;
    f.uFrame.value = (f.uFrame.value + 1) % 64;
    f.uAspect.value = this.w / this.h;
    this.quad.draw(renderer, this.finalMat, null);
  }

  dispose(): void {
    this.scene.depthTexture?.dispose();
    this.scene.dispose();
    for (const t of this.blooms) t.dispose();
    for (const t of this.ups) t.dispose();
    for (const m of [this.brightMat, this.downMat, this.upMat, this.finalMat]) m.dispose();
    this.quad.dispose();
  }
}
