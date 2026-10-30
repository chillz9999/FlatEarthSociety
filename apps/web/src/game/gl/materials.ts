import * as THREE from 'three';
import { noiseTexture } from './textures';

/**
 * Material patches shared by the scene's surfaces (all of them three.js standard materials underneath, so they
 * take the sun, its shadows and the sky's light):
 *  - detail: triplanar noise in world space, breaking up colour and bumping the surface (stone, ice, wood, bronze);
 *  - wet: darker and glossier at the waterline;
 *  - fade: a dithered dissolve (used when something tall comes too close to the camera, and for the lost ship);
 *  - glow: extra light from within (ice);
 *  - rim: a moonlit edge, so that at night hazards stand out from the dark sea.
 */

export interface DetailOptions {
  /** World units per noise tile. */
  scale: number;
  /** ± colour variation. */
  amp: number;
  /** Bump strength. */
  bump: number;
  /** Darken and gloss towards the waterline. */
  wet?: boolean;
  /** A dithered dissolve driven by this uniform (0 = solid, 1 = gone). */
  fade?: { value: number };
  /** Translucent inner light (ice): colour × strength. */
  glow?: { value: THREE.Color };
  /** Vertical streaks (meltwater, rain-wash). */
  streaks?: number;
  /** Light along the silhouette and a little over the faces: colour × strength (black by day). */
  rim?: { value: THREE.Color };
}

type Shader = Parameters<THREE.Material['onBeforeCompile']>[0];

/** The detail patch as a function of a shader (to combine with other patches). */
export function detailPatch(o: DetailOptions): (shader: Shader) => void {
  const tex = noiseTexture();
  return (shader) => {
    shader.uniforms.uDetailTex = { value: tex };
    shader.uniforms.uFade = o.fade ?? { value: 0 };
    shader.uniforms.uGlow = o.glow ?? { value: new THREE.Color(0, 0, 0) };
    shader.uniforms.uRim = o.rim ?? { value: new THREE.Color(0, 0, 0) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDPos;\nvarying vec3 vDNor;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          vec4 dp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            dp = instanceMatrix * dp;
          #endif
          vDPos = (modelMatrix * dp).xyz;
          vec3 dn = objectNormal;
          #ifdef USE_INSTANCING
            dn = mat3(instanceMatrix) * dn;
          #endif
          vDNor = normalize(mat3(modelMatrix) * dn);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vDPos;
        varying vec3 vDNor;
        uniform sampler2D uDetailTex;
        uniform float uFade;
        uniform vec3 uGlow;
        uniform vec3 uRim;
        float detailH() {
          vec3 w = pow(abs(vDNor), vec3(4.0));
          w /= (w.x + w.y + w.z + 1e-5);
          vec3 p = vDPos / ${o.scale.toFixed(2)};
          float hx = texture2D(uDetailTex, p.zy).g * 0.6 + texture2D(uDetailTex, p.zy * 0.27).r * 0.4;
          float hy = texture2D(uDetailTex, p.xz).g * 0.6 + texture2D(uDetailTex, p.xz * 0.27).r * 0.4;
          float hz = texture2D(uDetailTex, p.xy).g * 0.6 + texture2D(uDetailTex, p.xy * 0.27).r * 0.4;
          float h = hx * w.x + hy * w.y + hz * w.z;
          ${o.streaks ? `h = mix(h, texture2D(uDetailTex, vec2((vDPos.x + vDPos.z) / ${(o.scale * 0.6).toFixed(2)}, vDPos.y / ${(o.scale * 6).toFixed(2)})).b, ${o.streaks.toFixed(2)} * (1.0 - w.y));` : ''}
          return h;
        }
        vec3 detailPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
          vec3 sx = dFdx(surfPos);
          vec3 sy = dFdy(surfPos);
          vec3 r1 = cross(sy, surfNorm);
          vec3 r2 = cross(surfNorm, sx);
          float det = dot(sx, r1) * faceDir;
          vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
          return normalize(abs(det) * surfNorm - grad);
        }`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (uFade > 0.0) {
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (ign < uFade) discard;
        }
        float dH = detailH();`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= 1.0 + (dH - 0.5) * ${(o.amp * 2).toFixed(3)};
        ${o.wet ? 'diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(-1.0, 10.0, vDPos.y));' : ''}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        ${o.wet ? 'roughnessFactor *= mix(0.4, 1.0, smoothstep(0.0, 9.0, vDPos.y));' : ''}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = detailPerturb(-vViewPosition, normal, vec2(dFdx(dH), dFdy(dH)) * ${o.bump.toFixed(3)}, faceDirection);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Light from within: strongest at grazing angles and in the shade.
          float nv = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
          totalEmissiveRadiance += uGlow * (0.35 + 0.65 * pow(1.0 - nv, 2.0)) * (0.6 + 0.8 * dH);
          ${o.rim ? '// Moonlight catching the outline, and a touch over the faces.\n          totalEmissiveRadiance += uRim * (0.06 + pow(1.0 - nv, 3.0)) * (0.7 + 0.6 * dH);' : ''}
        }`,
      );
  };
}

export function withDetail<T extends THREE.MeshStandardMaterial>(mat: T, o: DetailOptions): T {
  const key = `detail-${o.scale}-${o.amp}-${o.bump}-${o.wet ? 1 : 0}-${o.fade ? 1 : 0}-${o.glow ? 1 : 0}-${o.streaks ?? 0}-${o.rim ? 1 : 0}`;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = detailPatch(o);
  return mat;
}

/** A plain dithered-fade patch for materials without detail. */
export function withFade<T extends THREE.Material>(mat: T, fade: { value: number }, keySuffix = ''): T {
  mat.customProgramCacheKey = () => `fade${keySuffix}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFade = fade;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFade;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (uFade > 0.0) {
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (ign < uFade) discard;
        }`,
      );
  };
  return mat;
}

/** The scene's shared materials. */
export class Materials {
  readonly stone: THREE.MeshStandardMaterial;
  readonly ice: THREE.MeshStandardMaterial;
  readonly iceGlow = { value: new THREE.Color(0.05, 0.16, 0.2) };
  /** The moonlit edge of rock, ice, wood, land and kraken (set each frame from the stage's light). */
  readonly rim = { value: new THREE.Color(0, 0, 0) };
  readonly wood: THREE.MeshStandardMaterial;
  readonly land: THREE.MeshStandardMaterial;
  readonly foliage: THREE.MeshStandardMaterial;
  readonly gold: THREE.MeshStandardMaterial;
  readonly cloth: THREE.MeshStandardMaterial;
  readonly flesh: THREE.MeshStandardMaterial;
  readonly plain: THREE.MeshStandardMaterial;
  readonly lamp: THREE.MeshBasicMaterial;
  readonly dark: THREE.MeshStandardMaterial;

  constructor() {
    this.stone = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, name: 'stone' }), { scale: 30, amp: 0.32, bump: 5, wet: true, streaks: 0.35, rim: this.rim });
    this.ice = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0, name: 'ice' }), { scale: 60, amp: 0.1, bump: 2, glow: this.iceGlow, streaks: 0.4, rim: this.rim });
    this.wood = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, name: 'wood' }), { scale: 10, amp: 0.25, bump: 1.5, wet: true, streaks: 0.6, rim: this.rim });
    this.land = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, name: 'land' }), { scale: 40, amp: 0.35, bump: 4, wet: true, rim: this.rim });
    this.foliage = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, name: 'foliage' }), { scale: 9, amp: 0.4, bump: 3 });
    this.gold = new THREE.MeshStandardMaterial({ color: 0xffc860, metalness: 1, roughness: 0.3, name: 'gold' });
    this.cloth = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, name: 'cloth' });
    this.flesh = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0, name: 'flesh' }), { scale: 7, amp: 0.25, bump: 3, wet: true, rim: this.rim });
    this.plain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, name: 'plain' });
    this.lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.72, 0.38).multiplyScalar(7), name: 'lamp' });
    this.dark = new THREE.MeshStandardMaterial({ color: 0x1a120a, roughness: 0.8, name: 'dark' });
  }

  dispose(): void {
    for (const m of [this.stone, this.ice, this.wood, this.land, this.foliage, this.gold, this.cloth, this.flesh, this.plain, this.lamp, this.dark]) m.dispose();
  }
}
