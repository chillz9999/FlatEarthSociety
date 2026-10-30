import * as THREE from 'three';
import { SKY_GLSL, type SkyUniforms } from './sky';

/** Seconds of fall drawn below the lip, the outward speed over it, and gravity (world units). */
const FALL_T = 2.4;
const OUT_SPEED = 70;
const GRAVITY = 520;

/**
 * The Edge of the World on both sides of the channel: the sea pouring over a lip and falling away into the void
 * as a curtain of streaming water that breaks up into spray and mist.
 */
export class Edge {
  readonly group = new THREE.Group();
  private readonly mat: THREE.ShaderMaterial;

  constructor(
    sky: SkyUniforms,
    private readonly halfWidth: number,
    length: number,
  ) {
    this.mat = new THREE.ShaderMaterial({
      name: 'Falls',
      uniforms: {
        ...sky,
        uLight: { value: new THREE.Color() },
        uAmbient: { value: new THREE.Color() },
        uFallT: { value: FALL_T },
      },
      vertexShader: /* glsl */ `
        attribute float aFall;
        varying vec3 vWorld;
        varying float vFall;
        varying float vSide;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vFall = aFall;
          vSide = sign(position.x);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uLight;
        uniform vec3 uAmbient;
        uniform float uFallT;
        varying vec3 vWorld;
        varying float vFall;
        varying float vSide;
        ${SKY_GLSL}
        void main() {
          float s = -vWorld.z;
          float tau = vFall;
          // Streaks travel down with the water (each feature falls one second per second).
          float a = texture2D(uNoise, vec2(s / 90.0, (tau - uTime) * 0.55)).g;
          float b = texture2D(uNoise, vec2(s / 37.0 + 0.3, (tau - uTime) * 1.3)).b;
          float c = texture2D(uNoise, vec2(s / 260.0, (tau - uTime) * 0.25)).r;
          float streak = smoothstep(0.35, 0.8, a * 0.55 + b * 0.45);
          float body = smoothstep(0.25, 0.75, c);
          // Solid and white at the lip, thinning to ragged sheets and spray below.
          float top = 1.0 - smoothstep(0.0, 0.3, tau);
          float thin = 1.0 - smoothstep(0.35, uFallT, tau);
          float alpha = (top * 0.95 + (0.35 + 0.65 * streak) * thin * (0.55 + 0.45 * body)) * thin;
          alpha *= 1.0 - smoothstep(2600.0, 3400.0, length(cameraPosition - vWorld));
          vec3 water = mix(skyBase(normalize(vec3(-vSide, 0.25, -0.5))), uHaze, 0.25) * 0.85;
          vec3 foam = uAmbient * 1.1 + uLight * 0.4 + uHaze * 0.15;
          vec3 col = mix(water, foam, clamp(top * 0.8 + streak * 0.6, 0.0, 1.0));
          // Lit from within by the light of the void's mist at depth.
          col = mix(col, uHaze * 0.8, smoothstep(0.6, 2.0, tau) * 0.5);
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    for (const side of [-1, 1]) this.group.add(this.curtain(side, length));
  }

  private curtain(side: number, length: number): THREE.Mesh {
    const rows = 26;
    const cols = 30;
    const pos: number[] = [];
    const fall: number[] = [];
    const idx: number[] = [];
    for (let r = 0; r <= rows; r++) {
      // Rows bunched near the lip, where the curve is.
      const k = r / rows;
      const tau = FALL_T * k * k;
      const x = side * (this.halfWidth + OUT_SPEED * tau + 3);
      const y = -0.5 * GRAVITY * tau * tau + 1.5;
      for (let c = 0; c <= cols; c++) {
        const z = 200 - (c / cols) * length;
        pos.push(x, y, z);
        fall.push(tau);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        idx.push(a, a + cols + 1, a + 1, a + 1, a + cols + 1, a + cols + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aFall', new THREE.Float32BufferAttribute(fall, 1));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return mesh;
  }

  update(light: THREE.Color, ambient: THREE.Color, cameraZ: number): void {
    this.mat.uniforms.uLight.value.copy(light);
    this.mat.uniforms.uAmbient.value.copy(ambient);
    this.group.position.z = cameraZ;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
    this.mat.dispose();
  }
}
