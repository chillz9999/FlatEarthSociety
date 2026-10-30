import * as THREE from 'three';
import { SKY_GLSL, type SkyUniforms } from './sky';
import { waterNormalTexture } from './textures';

/** Most whirlpools on the water at once (the sea's surface opens for each). */
export const MAX_WHIRLS = 4;

/**
 * The sea of the charted channel: animated normals from a procedural wave texture, the sky and the scene mirrored in
 * it, fresnel, the low sun's glitter, light scattering through the crests, the current quickening towards the Edge
 * and its foam, and openings where whirlpools draw the water down.
 */
export function makeWaterMaterial(sky: SkyUniforms): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    {
      uWaves: { value: null },
      uReflection: { value: null },
      uTexMatrix: { value: new THREE.Matrix4() },
      uUseReflection: { value: 0 },
      uSeaDeep: { value: new THREE.Color() },
      uSeaScatter: { value: new THREE.Color() },
      uLight: { value: new THREE.Color() },
      uAmbient: { value: new THREE.Color() },
      uHalfWidth: { value: 440 },
      uWhirls: { value: Array.from({ length: MAX_WHIRLS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    },
  ]);
  // Shared by reference: the sky's uniforms are the same objects as the dome's.
  Object.assign(uniforms, sky);
  uniforms.uWaves.value = waterNormalTexture();
  const mat = new THREE.ShaderMaterial({
    name: 'Sea',
    uniforms,
    lights: true,
    vertexShader: /* glsl */ `
      uniform mat4 uTexMatrix;
      varying vec3 vWorld;
      varying vec4 vMirror;
      #include <common>
      #include <shadowmap_pars_vertex>
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorld = worldPosition.xyz;
        vMirror = uTexMatrix * worldPosition;
        vec4 mvPosition = viewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        #include <shadowmap_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uWaves;
      uniform sampler2D uReflection;
      uniform float uUseReflection;
      uniform vec3 uSeaDeep;
      uniform vec3 uSeaScatter;
      uniform vec3 uLight;
      uniform vec3 uAmbient;
      uniform float uHalfWidth;
      uniform vec4 uWhirls[${MAX_WHIRLS}];
      varying vec3 vWorld;
      varying vec4 vMirror;
      ${SKY_GLSL}
      #include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>

      vec3 waveNormal(vec2 p, float t, float dist, out float crest) {
        vec4 a = texture2D(uWaves, p / 600.0 + vec2(0.004, 0.012) * t);
        vec4 b = texture2D(uWaves, mat2(0.966, -0.259, 0.259, 0.966) * p / 230.0 + vec2(-0.004, 0.016) * t);
        vec4 c = texture2D(uWaves, mat2(0.94, 0.342, -0.342, 0.94) * p / 76.0 + vec2(0.006, 0.03) * t);
        vec2 n = (a.xy - 0.5) * 1.0 + (b.xy - 0.5) * 0.75 + (c.xy - 0.5) * 0.42 * (1.0 - smoothstep(300.0, 1600.0, dist));
        crest = a.w * 0.45 + b.w * 0.35 + c.w * 0.2;
        // Calmer-looking (and free of shimmer) towards the horizon.
        n *= mix(1.15, 0.7, smoothstep(200.0, 3500.0, dist));
        return normalize(vec3(n.x, 1.0, -n.y));
      }

      void main() {
        vec3 wp = vWorld;
        // Course coordinates: x across, s along (the scene runs towards −z).
        vec2 p = vec2(wp.x, -wp.z);
        float t = uTime;
        vec3 toEye = cameraPosition - wp;
        float dist = length(toEye);
        vec3 V = toEye / dist;

        // Whirlpools: the surface opens over each funnel.
        for (int i = 0; i < ${MAX_WHIRLS}; i++) {
          vec4 w = uWhirls[i];
          if (w.z > 0.0 && length(p - w.xy) < w.z) discard;
        }

        // Towards the Edge the current quickens and runs out over the lip.
        float edgeDist = uHalfWidth - abs(p.x);
        float side = sign(p.x);
        float pull = 1.0 - smoothstep(0.0, 110.0, edgeDist);
        vec2 flow = vec2(side * pull * pull * 2.8 * t * 60.0, 0.0);
        float crest;
        vec3 N = waveNormal(p - flow * 0.3, t, dist, crest);

        float NdV = max(dot(N, V), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 refl = skyBase(R);
        if (uUseReflection > 0.5) {
          vec2 ruv = vMirror.xy / vMirror.w + N.xz * vec2(0.03, 0.05) * clamp(260.0 / dist, 0.15, 1.0);
          vec4 rs = texture2D(uReflection, ruv);
          refl = mix(refl, rs.rgb, 0.92);
        }

        float shadow = getShadowMask();
        vec3 L = uSunDir;
        float sunUp = smoothstep(-0.08, 0.04, L.y);
        // Body of the water: deep colour, lifted by the sky, and light scattering through the backs of waves.
        float diffuse = max(dot(N, L), 0.0);
        vec3 body = uSeaDeep * (uAmbient * 0.7 + uLight * diffuse * 0.06 * shadow);
        float sss = pow(max(dot(V, -L), 0.0), 4.0) * (0.2 + crest * 1.1) * sunUp;
        body += uSeaScatter * (uAmbient * 0.12 + uLight * (sss * 0.22 + 0.015) * mix(0.5, 1.0, shadow)) * smoothstep(4000.0, 600.0, dist);

        vec3 col = mix(body, refl, fres);

        // The sun's glitter: a tight highlight and a broad sheen.
        vec3 H = normalize(L + V);
        float nh = max(dot(N, H), 0.0);
        // (Capped like the sun's disk: sparkles far over the bloom threshold flare into a blinding path.)
        float spec = pow(nh, 1400.0) * 4.0 + pow(nh, 160.0) * 0.4 + pow(nh, 24.0) * 0.03;
        col += uSunColor * min(uSunPower, 4.0) * spec * shadow * sunUp * (0.3 + 0.7 * fres) * 0.35;

        // Foam where the sea runs over the Edge: streaks drawn out by the current, then a bright lip.
        float streak = texture2D(uNoise, vec2(p.x / 140.0 - side * t * 0.55 * (0.4 + pull), p.y / 34.0)).g;
        float churn = texture2D(uNoise, vec2(p.x / 60.0 - side * t * 0.9, p.y / 60.0 + t * 0.05)).b;
        float foam = pull * pull * smoothstep(0.6 - pull * 0.25, 0.9, streak * 0.6 + churn * 0.6) * 0.85;
        foam = max(foam, smoothstep(14.0, 1.5, edgeDist) * (0.55 + 0.35 * churn));
        // Whitecaps, here and there on the steepest crests.
        foam = max(foam, smoothstep(0.86, 0.97, crest) * 0.25 * (1.0 - smoothstep(400.0, 1800.0, dist)));
        vec3 foamCol = uAmbient * 0.75 + uLight * (0.12 + 0.15 * diffuse) * shadow;
        col = mix(col, foamCol, clamp(foam, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return mat;
}

/** The water plane: spans the channel exactly, from behind the camera to the far haze. */
export function makeWaterMesh(mat: THREE.Material, halfWidth: number, length: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(halfWidth * 2, length, 1, 1);
  geo.rotateX(-Math.PI / 2);
  // From +200 (behind the camera) to −length+200 ahead.
  geo.translate(0, 0, -length / 2 + 200);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * A planar mirror for the sea: the scene rendered from beneath the surface, at reduced resolution, into a texture
 * the sea samples with its ripples. Things on layer 1 (decals, particles, the sea itself) are not mirrored.
 */
export class Mirror {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  private readonly cam = new THREE.PerspectiveCamera();
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();

  constructor(w: number, h: number) {
    this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    this.target.texture.generateMipmaps = false;
    this.cam.layers.set(0);
  }

  setSize(w: number, h: number): void {
    this.target.setSize(Math.max(1, w), Math.max(1, h));
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const cam = this.cam;
    // Mirror the camera in the plane y = 0 (a proper rotation: rolled half a turn about its view axis).
    camera.updateMatrixWorld();
    const pos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(camera.matrixWorld));
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(new THREE.Matrix4().extractRotation(camera.matrixWorld));
    cam.position.set(pos.x, -pos.y, pos.z);
    cam.up.set(up.x, -up.y, up.z);
    cam.lookAt(pos.x + look.x, -pos.y - look.y, pos.z + look.z);
    cam.near = camera.near;
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(cam.projectionMatrix);
    this.textureMatrix.multiply(cam.matrixWorldInverse);

    // Oblique near plane: clip everything beneath the water (the mirror shows only what stands above it).
    this.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
    this.plane.applyMatrix4(cam.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = cam.projectionMatrix;
    const q = this.q;
    q.x = (Math.sign(this.clip.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(this.clip.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    this.clip.multiplyScalar(2.0 / this.clip.dot(q));
    pm.elements[2] = this.clip.x;
    pm.elements[6] = this.clip.y;
    pm.elements[10] = this.clip.z + 1.0 - 0.0;
    pm.elements[14] = this.clip.w;

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.target.dispose();
  }
}
