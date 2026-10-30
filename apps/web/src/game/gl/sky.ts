import * as THREE from 'three';
import type { Light } from './stage';
import { noiseTexture } from './textures';

/**
 * Uniforms describing the sky, shared (by reference) by the sky dome, the sea and the mist pass, so that all three
 * always agree on the colour of the horizon.
 */
export function makeSkyUniforms() {
  return {
    uSkyTop: { value: new THREE.Color() },
    uSkyMid: { value: new THREE.Color() },
    uHaze: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 0.1, -1) },
    uSunPower: { value: 1 },
    uAbyss: { value: new THREE.Color() },
    uStars: { value: 0 },
    uAurora: { value: 0 },
    uClouds: { value: 0 },
    uStorm: { value: 0 },
    uMoon: { value: 0 },
    uTime: { value: 0 },
    uNoise: { value: noiseTexture() as THREE.Texture },
  };
}

export type SkyUniforms = ReturnType<typeof makeSkyUniforms>;

export function applyLight(u: SkyUniforms, l: Light, time: number): void {
  u.uSkyTop.value.copy(l.skyTop);
  u.uSkyMid.value.copy(l.skyMid);
  u.uHaze.value.copy(l.haze);
  u.uSunColor.value.copy(l.sun);
  u.uSunDir.value.copy(l.sunDir);
  u.uSunPower.value = l.sunPower;
  u.uAbyss.value.copy(l.abyss);
  u.uStars.value = l.stars;
  u.uAurora.value = l.aurora;
  u.uClouds.value = l.clouds;
  u.uStorm.value = l.storm;
  u.uMoon.value = l.moon;
  u.uTime.value = time;
}

/** GLSL: the sky's colour in a direction. `skyBase` is the gradient and glow only (used for mist and reflections). */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uHaze;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunPower;
uniform vec3 uAbyss;
uniform float uStars;
uniform float uAurora;
uniform float uClouds;
uniform float uStorm;
uniform float uMoon;
uniform float uTime;
uniform sampler2D uNoise;

float skyHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// The sky's gradient and the glow around the sun, for a direction at or above the horizon.
vec3 skyBase(vec3 dir) {
  float e = max(dir.y, 0.0);
  vec3 col = mix(uHaze, uSkyMid, smoothstep(0.0, 0.22, e));
  col = mix(col, uSkyTop, smoothstep(0.16, 0.8, e));
  // A brighter band along the horizon, and the warm glow of the low sun (stronger towards it).
  float cs = dot(dir, uSunDir);
  float toward = max(cs, 0.0);
  float band = exp(-e * 14.0);
  float glow = pow(toward, 8.0) * 0.12 + pow(toward, 48.0) * 0.28 + pow(toward, 700.0) * 0.5;
  float sunUp = smoothstep(-0.12, 0.05, uSunDir.y);
  col += uSunColor * glow * uSunPower * 0.1 * (0.4 + 0.6 * band) * sunUp * (1.0 - uMoon * 0.75);
  col += uHaze * band * 0.08 * (0.5 + 0.5 * toward);
  return col;
}

vec3 skyBelow(vec3 dir) {
  // The void beneath the world: the haze thins into the abyss.
  float d = -dir.y;
  vec3 haze = skyBase(normalize(vec3(dir.x, 0.0, dir.z)));
  // Mist rising out of the void glows faintly with the light of the sky; deeper down, the dark.
  vec3 mist = uAbyss + uHaze * 0.07 + uSkyMid * 0.08;
  vec3 col = mix(haze, mist, smoothstep(0.0, 0.045, d));
  col = mix(col, uAbyss, smoothstep(0.04, 0.35, d));
  return col;
}

vec3 skyFull(vec3 dir) {
  if (dir.y < 0.0) {
    vec3 col = skyBelow(dir);
    // Stars below the world, too.
    vec3 sp = dir * 140.0;
    vec3 cell = floor(sp);
    float h = skyHash(cell);
    if (h > 0.986) {
      vec3 c = cell + 0.5 + (vec3(skyHash(cell + 1.3), skyHash(cell + 2.7), skyHash(cell + 4.1)) - 0.5) * 0.6;
      float s = smoothstep(0.16, 0.0, length(sp - c));
      col += vec3(0.75, 0.82, 1.0) * s * (h - 0.986) * 60.0 * smoothstep(0.02, 0.25, -dir.y);
    }
    return col;
  }
  vec3 col = skyBase(dir);
  float e = dir.y;
  float cs = dot(dir, uSunDir);

  // Stars, fading where the sky is bright.
  if (uStars > 0.01) {
    vec3 sp = dir * 150.0;
    vec3 cell = floor(sp);
    float h = skyHash(cell);
    if (h > 0.982) {
      vec3 c = cell + 0.5 + (vec3(skyHash(cell + 1.3), skyHash(cell + 2.7), skyHash(cell + 4.1)) - 0.5) * 0.6;
      float s = smoothstep(0.16, 0.0, length(sp - c));
      float tw = 0.7 + 0.3 * sin(uTime * (2.0 + h * 30.0) + h * 100.0);
      float dark = 1.0 - smoothstep(0.05, 0.5, dot(col, vec3(0.33)));
      col += vec3(0.85, 0.9, 1.0) * s * tw * (h - 0.982) * 55.0 * uStars * dark * smoothstep(0.03, 0.2, e);
    }
  }

  // Aurora: curtains of light hanging over the Outer Rim and the Edge.
  if (uAurora > 0.01 && e > 0.02) {
    float az = atan(dir.x, -dir.z);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float hem = 0.16 + fi * 0.09 + 0.07 * (texture2D(uNoise, vec2(az * 0.18 + fi * 0.31 + uTime * 0.004, 0.2 + fi * 0.3)).r - 0.5) * 2.0;
      float above = e - hem;
      float curtain = above > 0.0 ? exp(-above * (9.0 - fi * 2.0)) : exp(above * 60.0);
      float rays = texture2D(uNoise, vec2(az * 1.6 + fi * 0.7 + uTime * 0.01, 0.5 + fi * 0.2)).g;
      rays = pow(smoothstep(0.3, 0.85, rays), 1.5);
      float wave = 0.5 + 0.5 * sin(az * 3.0 + uTime * 0.21 + fi * 2.1);
      vec3 c = mix(vec3(0.15, 1.0, 0.55), vec3(0.45, 0.65, 1.0), fi * 0.5);
      c = mix(c, vec3(0.75, 0.35, 1.0), smoothstep(0.0, 0.25, above));
      acc += c * curtain * (0.25 + rays) * wave;
    }
    col += acc * uAurora * 0.32 * smoothstep(0.02, 0.1, e);
  }

  // Clouds: streaks of stratus on a high plane, lit from below by the low sun.
  if (uClouds > 0.01 && e > 0.0) {
    vec2 uv = dir.xz / (e + 0.06);
    vec2 cuv = vec2(uv.x * 0.055, uv.y * 0.16) + vec2(uTime * 0.002, 0.0);
    float n = texture2D(uNoise, cuv).a * 0.65 + texture2D(uNoise, cuv * 3.1 + 0.37).r * 0.35;
    float cover = uClouds;
    float d = smoothstep(1.0 - cover * 0.95, 1.0 - cover * 0.95 + 0.28, n);
    d *= smoothstep(0.0, 0.05, e) * (1.0 - smoothstep(0.45, 0.9, e) * 0.6);
    float lit = pow(max(cs, 0.0), 3.0);
    vec3 under = mix(uSkyMid * 0.75, uHaze * 0.55, 0.4) * (1.0 - uStorm * 0.55);
    vec3 cc = under + uSunColor * (0.18 + 1.6 * lit) * uSunPower * 0.08 * (1.0 - uMoon * 0.6);
    // Bright rims towards the sun.
    cc += uSunColor * pow(max(cs, 0.0), 12.0) * uSunPower * 0.12 * (1.0 - d);
    col = mix(col, cc, d * (0.75 + uStorm * 0.2));
  }

  // The sun (or moon) disk.
  float disk = smoothstep(0.99955, 0.99975, cs);
  if (disk > 0.0) {
    // Bright, but capped: a brighter disk only spreads a wider bloom across the horizon.
    vec3 dc = uSunColor * min(uSunPower, 3.5) * (1.0 + 0.4 * (1.0 - uMoon));
    if (uMoon > 0.5) {
      // Maria on the moon's face.
      vec3 side = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(side, uSunDir);
      vec2 mp = vec2(dot(dir, side), dot(dir, up)) * 40.0;
      float m = texture2D(uNoise, mp + 0.3).r;
      dc *= 0.75 + 0.35 * smoothstep(0.35, 0.65, m);
    }
    col = mix(col, dc, disk);
  }

  // The ice wall that rings the world, far off on the horizon.
  float az2 = atan(dir.x, -dir.z);
  float wall = 0.004 + 0.011 * texture2D(uNoise, vec2(az2 * 0.9, 0.11)).b + 0.004 * texture2D(uNoise, vec2(az2 * 4.0, 0.61)).g;
  if (e < wall) {
    float lit = 0.55 + 0.45 * max(dot(normalize(vec3(dir.x, 0.0, dir.z)), -normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
    vec3 ice = mix(uHaze, vec3(0.9, 0.95, 1.0) * dot(uHaze, vec3(0.5)) * 1.4, 0.45) * lit;
    col = mix(col, ice, smoothstep(wall, wall - 0.002, e) * 0.85);
  }
  return col;
}
`;

/** The sky dome: behind everything, following whichever camera looks at it. */
export function makeSkyDome(u: SkyUniforms, radius = 9000): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    name: 'Sky',
    uniforms: u,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w * 0.99999;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${SKY_GLSL}
      void main() {
        vec3 dir = normalize(vDir);
        gl_FragColor = vec4(skyFull(dir), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
  mesh.frustumCulled = false;
  // Drawn after everything opaque, at the far plane: only the sky that shows is shaded.
  mesh.renderOrder = 1000;
  mesh.onBeforeRender = (_r, _s, camera) => {
    mesh.position.copy(camera.position);
    mesh.updateMatrixWorld();
  };
  return mesh;
}
