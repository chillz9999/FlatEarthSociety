import type { Simulation } from '@fes/game-core';
import * as THREE from 'three';
import { Particles } from '../particles';
import { shipPoseFor, type FrameView } from '../view';
import { Coins } from './coins';
import { Edge } from './edge';
import { Glows, ParticleView, Tentacles, Wake, WaterDecals, funnelDepth, funnelDepthFor } from './fx';
import { Hazards } from './hazards';
import { Materials } from './materials';
import { Post } from './post';
import { ShipView } from './ship';
import { applyLight, makeSkyDome, makeSkyUniforms, type SkyUniforms } from './sky';
import { Light } from './stage';
import { MAX_WHIRLS, Mirror, makeWaterMaterial, makeWaterMesh } from './water';

/** World units: the floating origin moves in whole steps of this (every pattern on the sea repeats within it). */
const ORIGIN_STEP = 24000;
/** How far ahead (from the camera) the scene is drawn: the mist is total by then. */
const DRAW_FAR = 3320;
const SEA_LENGTH = 9000;
/** Layer 1: drawn by the main camera only (not mirrored in the sea). */
const LAYER_NO_MIRROR = 1;
/** The rim on hazards where the light is poor, at full strength (see the stages' `rim`). */
const RIM_STRENGTH = 0.25;

/**
 * The Society Test in WebGL: a real 3D scene under a low sun, seen from the same chase camera as the chart
 * renderer. The sea mirrors the sky and the hazards, the sun casts long shadows, the mist hides the course until
 * it matters, and the Edge pours away into the void on both sides. Owns no game state: it renders whatever the
 * simulation and runner hand it, and nothing here feeds back into the simulation.
 */
export class Renderer3D {
  readonly particles = new Particles();
  /** Rolling average of render time in ms (diagnostics). */
  renderMs = 0;
  /** Feature switches (diagnostics and quality levels). */
  readonly quality = { mirror: true, shadows: true, bloom: true, msaa: true, post: true, auto: true };
  /** Time spent per section of a frame, ms (rolling; diagnostics). */
  readonly timings: Record<string, number> = {};
  private mark = 0;
  private lap(name: string): void {
    const now = performance.now();
    this.timings[name] = (this.timings[name] ?? 0) * 0.9 + (now - this.mark) * 0.1;
    this.mark = now;
  }

  private readonly gl: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 2, 10000);
  private readonly sky: SkyUniforms;
  private readonly light = new Light();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly fill = new THREE.DirectionalLight(0xffffff, 0.5);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 0.5);
  private readonly water: THREE.Mesh;
  private readonly waterMat: THREE.ShaderMaterial;
  private readonly edge: Edge;
  private readonly post: Post;
  private readonly mirror: Mirror;
  private readonly mats = new Materials();
  private readonly hazards: Hazards;
  private readonly decals: WaterDecals;
  private readonly glows = new Glows();
  private readonly tentacles = new Tentacles();
  private readonly coins = new Coins();
  private readonly ship = new ShipView();
  private readonly wake: Wake;
  private readonly particleView: ParticleView;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envKey = -99;
  private envAt = -99;
  private width = 1;
  private height = 1;
  private pixelRatio = 0;
  private maxPixelRatio = 1;
  private originZ = 0;
  private readonly hw = 440;
  private lastFrameAt = 0;
  private tier = 0;
  private floorTier = 0;
  private sized = false;
  private dtAvg = 16.7;
  private adaptFrames = 0;
  /** The hidden one-of-every-hazard (see Hazards.showcase) is in the scene. */
  private showcased = false;
  private settleUntil = 0;
  private slowSince = 0;
  private sprayClock = 0;
  private warmNext = true;
  private contextLost = false;
  private readonly tmpV = new THREE.Vector3();
  private readonly lightCol = new THREE.Color();
  private readonly ambientCol = new THREE.Color();
  /** Development aid (`?hitboxes`): every collision circle drawn on the water, to check them against the models. */
  private readonly hitboxes: THREE.Group | null = null;
  private readonly onLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
  };
  private readonly onRestored = () => {
    this.contextLost = false;
    this.envKey = -99;
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);

    this.camera.layers.enable(LAYER_NO_MIRROR);
    this.sky = makeSkyUniforms();
    this.scene.add(makeSkyDome(this.sky));
    this.envScene.add(makeSkyDome(this.sky, 100));
    this.pmrem = new THREE.PMREMGenerator(this.gl);

    this.waterMat = makeWaterMaterial(this.sky);
    this.water = makeWaterMesh(this.waterMat, this.hw, SEA_LENGTH);
    this.water.layers.set(LAYER_NO_MIRROR);
    this.scene.add(this.water);

    this.edge = new Edge(this.sky, this.hw, SEA_LENGTH);
    this.edge.group.traverse((o) => o.layers.set(LAYER_NO_MIRROR));
    this.scene.add(this.edge.group);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.8;
    this.sun.shadow.radius = 1.5;
    this.scene.add(this.sun, this.sun.target, this.fill, this.fill.target, this.hemi);

    this.hazards = new Hazards(this.mats, this.sky);
    this.decals = new WaterDecals(this.sky);
    this.wake = new Wake(this.sky);
    this.particleView = new ParticleView(this.mats.plain);
    this.scene.add(this.hazards.group, this.decals.mesh, this.glows.mesh, this.tentacles.mesh, this.coins.group, this.ship.group, this.wake.mesh, this.particleView.group);

    if (process.env.NODE_ENV !== 'production' && new URLSearchParams(window.location.search).has('hitboxes')) {
      this.hitboxes = new THREE.Group();
      this.scene.add(this.hitboxes);
    }

    this.post = new Post(this.sky, 4);
    this.mirror = new Mirror(1, 1);
    this.waterMat.uniforms.uReflection.value = this.mirror.target.texture;
    this.waterMat.uniforms.uTexMatrix.value = this.mirror.textureMatrix;
    this.waterMat.uniforms.uUseReflection.value = 1;

    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.applyTier();
  }

  /**
   * Quality tiers, best first: each step down gives up something the eye misses least — multisampling, then the
   * mirrored scene in the sea (the sky is still reflected), then resolution, then bloom.
   */
  private applyTier(): void {
    const t = this.tier;
    const q = this.quality;
    q.msaa = t < 1;
    q.mirror = t < 2;
    q.bloom = t < 5;
    const base = Math.min(this.maxPixelRatio, 1.5);
    const pr = t <= 2 ? base : t === 3 ? Math.min(base, 1) : t === 4 ? Math.min(base, 0.8) : Math.min(base, 0.66);
    if (pr !== this.pixelRatio || !this.sized) {
      this.pixelRatio = pr;
      this.sized = true;
      this.gl.setPixelRatio(pr);
      this.gl.setSize(this.width, this.height, false);
    }
    const w = Math.round(this.width * this.pixelRatio);
    const h = Math.round(this.height * this.pixelRatio);
    this.post.setSize(w, h);
    this.mirror.setSize(Math.round(w / 2), Math.round(h / 2));
  }

  /**
   * Keep the frame rate: when frames run long for a couple of seconds, drop a quality tier; after a long stretch of
   * smooth frames, try the tier above once more.
   */
  private adapt(now: number): void {
    const dt = this.lastFrameAt ? now - this.lastFrameAt : 16.7;
    this.lastFrameAt = now;
    if (!this.quality.auto || dt > 250 || document.hidden) return;
    if (now < this.settleUntil) return;
    this.dtAvg = this.dtAvg * 0.95 + dt * 0.05;
    this.adaptFrames++;
    if (this.adaptFrames < 90) return;
    if (this.dtAvg > 19.5 && this.tier < 5) {
      this.tier++;
      this.applyTier();
      this.adaptFrames = 0;
      this.settleUntil = now + 1500;
      this.slowSince = now;
    } else if (this.dtAvg < 17.2 && this.tier > this.floorTier && now - this.slowSince > 30000) {
      // Room to spare for half a minute: try better again (once per tier).
      this.floorTier = this.tier;
      this.tier--;
      this.applyTier();
      this.adaptFrames = 0;
      this.settleUntil = now + 1500;
      this.slowSince = now;
    }
  }

  /** Build the models of what is already charted (and compile their shaders) so the first seconds never stutter. */
  warm(_sim: Simulation): void {
    this.particles.items.length = 0;
    this.wake.reset();
    this.warmNext = true;
    // Building and compiling takes a moment: do not judge the frame rate by it.
    this.settleUntil = performance.now() + 2500;
  }

  resetForRun(_seed: string): void {
    this.hazards.reset();
    this.wake.reset();
    this.particles.items.length = 0;
    this.warmNext = true;
  }

  /** The WebGL context is lost (the facade falls back to 2D if the browser does not restore it). */
  get lost(): boolean {
    return this.contextLost;
  }

  render(v: FrameView): void {
    if (this.contextLost) return;
    const t0 = performance.now();
    this.adapt(t0);
    this.draw(v);
    this.renderMs = this.renderMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  private draw(v: FrameView): void {
    const sim = v.sim;
    const cfg = sim.config;
    const W = this.width;
    const H = this.height;
    const speedFrac = Math.max(0, Math.min(1, (v.speed - cfg.ship.baseSpeed) / (cfg.ship.maxSpeed - cfg.ship.baseSpeed)));

    // Camera: low behind the stern, as in the chart renderer; it pulls back and widens a little with speed.
    const back = 330 + 50 * speedFrac;
    const anchorZ = v.death ? v.death.z : v.shipZ;
    const camZ = anchorZ - back;
    this.originZ = Math.floor(camZ / ORIGIN_STEP) * ORIGIN_STEP;
    const oz = this.originZ;
    const f = H * (0.66 - 0.1 * speedFrac);
    const cam = this.camera;
    const shakeX = v.shake ? (Math.random() - 0.5) * v.shake * 2 : 0;
    const shakeY = v.shake ? (Math.random() - 0.5) * v.shake : 0;
    cam.position.set(v.camX + shakeX, 235 + 25 * speedFrac, oz - camZ);
    cam.rotation.set(0, 0, 0);
    // The horizon sits 30 % down the frame: an off-centre (shifted) projection, looking level.
    const fullH = H * 1.4;
    cam.fov = (2 * Math.atan(fullH / 2 / f) * 180) / Math.PI;
    cam.setViewOffset(W, fullH, 0, H * 0.4 + shakeY, W, H);
    cam.near = 2;
    cam.far = 10000;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    this.mark = performance.now();
    // The light of the stage.
    const L = this.light.at(sim.timeSeconds);
    applyLight(this.sky, L, v.time);
    const light = this.lightCol.copy(L.light).multiplyScalar(L.lightI * Math.max(0.15, Math.min(1, (L.sunDir.y + 0.06) / 0.1)));
    const ambient = this.ambientCol.copy(L.ambient).multiplyScalar(L.ambientI);
    const wu = this.waterMat.uniforms;
    wu.uSeaDeep.value.copy(L.seaDeep);
    wu.uSeaScatter.value.copy(L.seaScatter);
    wu.uLight.value.copy(light);
    wu.uAmbient.value.copy(ambient);
    this.sun.color.copy(L.light);
    this.sun.intensity = L.lightI * Math.max(0, Math.min(1, (L.sunDir.y + 0.06) / 0.1));
    this.fill.color.copy(L.fill);
    this.fill.intensity = L.fillI;
    this.hemi.color.copy(L.ambient);
    this.hemi.groundColor.copy(L.seaDeep).multiplyScalar(2);
    this.hemi.intensity = L.ambientI * 0.6;
    this.mats.iceGlow.value.copy(L.seaScatter).multiplyScalar(0.3).lerp(L.haze, 0.08);
    // Where the light is poor (the red storm, and night at the Outer Rim and the Edge) a rim on every rock, so it
    // stands out from the sea.
    this.mats.rim.value.copy(L.rimColor).multiplyScalar(RIM_STRENGTH * L.rim);
    this.refreshEnvironment(L.key, v.time);
    this.lap('light');

    // Shadows: an orthographic box over the course near the ship, following it.
    const sd = this.tmpV.copy(L.keyDir);
    const focusZ = oz - (anchorZ + 650);
    this.sun.target.position.set(0, 0, focusZ);
    this.sun.position.set(sd.x * 2600, sd.y * 2600, focusZ + sd.z * 2600);
    this.fitShadow(anchorZ);
    this.fill.position.set(cam.position.x + 300, 900, cam.position.z + 700);
    this.fill.target.position.set(cam.position.x, 0, cam.position.z - 900);

    this.water.position.z = cam.position.z;
    this.edge.update(light, ambient, cam.position.z);

    // Hazards, whirlpools, treasure.
    this.decals.begin();
    this.glows.begin();
    const budget = this.warmNext ? 1000 : 4;
    this.lap('setup');
    this.hazards.update(sim, oz, cam.position.x, camZ, v.time, budget, this.decals, this.glows, this.tentacles, DRAW_FAR);
    this.lap('hazards');
    const whirls = this.hazards.whirlList(sim, camZ, DRAW_FAR, L.seaDeep, light, ambient);
    const wv = wu.uWhirls.value as THREE.Vector4[];
    for (let i = 0; i < MAX_WHIRLS; i++) {
      const w = whirls[i];
      if (w) wv[i].set(w.x, w.z - oz, w.pullRadius * 0.995, 0);
      else wv[i].set(0, 0, 0, 0);
    }
    this.coins.update(sim, oz, camZ, v.time, DRAW_FAR, this.glows);
    this.lap('coins');

    // The ship.
    const pose = shipPoseFor(v);
    if (v.death?.cause === 'whirlpool') pose.x = Math.max(-this.hw + 24, Math.min(this.hw - 24, pose.x));
    let y = pose.y;
    let dive = 0;
    const d = v.death;
    if (d) {
      if (d.cause === 'whirlpool' && d.whirlpool) {
        // Down the funnel's side as it spirals in.
        const w = d.whirlpool;
        const r = Math.hypot(pose.x - w.x, pose.z - w.z) / w.pullRadius;
        const lip = Math.max(0, Math.min(1, (this.hw - Math.abs(pose.x)) / 70));
        // Riding the funnel's surface down, settling into it at the last.
        y = funnelDepth(r, w.coreRadius / w.pullRadius, funnelDepthFor(w.pullRadius)) * lip * lip * (3 - 2 * lip) + 2 + pose.y * 0.25;
        dive = -Math.min(0.5, d.t * 0.4);
      } else if (d.cause === 'edge') dive = -Math.min(1.3, Math.max(0, d.t - 0.15) * 1.1);
      else if (d.cause !== 'timeout') {
        dive = -Math.min(0.35, d.t * 0.3);
        y = pose.y * 1.6 - d.t * d.t * 6;
      }
    }
    const lat = sim.ship.lateralSpeed || 1;
    const helm = Math.max(-1, Math.min(1, v.vx / lat));
    const heading = d ? 0 : helm * 0.12;
    const shielded = !d && sim.revived && sim.protectedNow;
    const shield = shielded ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(v.time * 10)) : 0;
    this.ship.update(pose.x, y, oz - pose.z, pose.bank, heading, helm, v.time, pose.alpha, shield, this.glows);
    if (dive) this.ship.group.children[0].rotation.x += dive;
    if (this.hitboxes) this.drawHitboxes(v, oz, camZ);
    this.lap('ship');

    // Wake and spray.
    this.wake.update(v.shipX, v.shipZ, !d && v.speed > 0, oz, camZ, light);
    this.bowSpray(v, pose.x, pose.z);
    this.particles.update(v.dt);
    this.particleView.uScale.value = (H * this.pixelRatio * cam.projectionMatrix.elements[5]) / 2;
    this.particleView.update(this.particles.items, oz);

    this.decals.material.uniforms.uLight.value.copy(light);
    this.decals.end();
    this.glows.end(v.time);
    this.lap('fx');

    // Draw: the sun's shadows and the mirror, then the scene, then mist, bloom and grade.
    this.post.setSamples(this.quality.msaa ? 4 : 0);
    this.gl.shadowMap.enabled = this.quality.shadows;
    this.sun.castShadow = this.quality.shadows;
    this.gl.shadowMap.autoUpdate = true;
    if (!this.showcased || this.warmNext) {
      // A shader is compiled for where it draws (a render target is linear colour, the screen sRGB) and for the
      // lights and shadows of the moment: compile into the scene's own target, as it is about to be drawn.
      this.gl.setRenderTarget(this.quality.post ? this.post.scene : null);
      if (!this.showcased) {
        // Once, on the first frame (before any voyage): every hazard's shaders, compiled in the background.
        this.showcased = true;
        this.scene.add(this.hazards.showcase());
        void this.gl.compileAsync(this.scene, cam).catch(() => undefined);
      }
      if (this.warmNext) {
        this.gl.compile(this.scene, cam);
        this.warmNext = false;
      }
    }
    wu.uUseReflection.value = this.quality.mirror ? 1 : 0;
    if (this.quality.mirror) {
      this.mirror.render(this.gl, this.scene, cam);
      this.gl.shadowMap.autoUpdate = false;
    }
    this.lap('mirror');
    if (!this.quality.post) {
      this.gl.setRenderTarget(null);
      this.gl.render(this.scene, cam);
      return;
    }
    this.gl.setRenderTarget(this.post.scene);
    this.gl.render(this.scene, cam);
    this.lap('main');
    const edgeNear = d ? 0 : Math.max(0, 1 - (this.hw - Math.abs(v.shipX)) / 120);
    this.post.finish(this.gl, cam, { exposure: L.exposure, edge: edgeNear, edgeSide: Math.sign(v.shipX) || 1, vignette: 1, bloom: this.quality.bloom ? 0.5 : 0 });
    this.lap('post');
  }

  private drawHitboxes(v: FrameView, oz: number, camZ: number): void {
    const g = this.hitboxes!;
    const sim = v.sim;
    let i = 0;
    const ring = (x: number, z: number, r: number, color: number) => {
      let line = g.children[i] as THREE.LineLoop | undefined;
      if (!line) {
        const pts: number[] = [];
        for (let k = 0; k < 48; k++) pts.push(Math.cos((k / 48) * Math.PI * 2), 0, Math.sin((k / 48) * Math.PI * 2));
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ depthTest: false, transparent: true }));
        line.layers.set(LAYER_NO_MIRROR);
        line.renderOrder = 99;
        g.add(line);
      }
      line.visible = true;
      line.position.set(x, 3, oz - z);
      line.scale.set(r, 1, r);
      (line.material as THREE.LineBasicMaterial).color.setHex(color);
      i++;
    };
    for (const o of sim.obstacles) if (o.z - camZ < 1800 && o.z + o.r > camZ) ring(o.x, o.z, o.r, 0xff3030);
    for (const w of sim.whirlpools) if (w.z - camZ < 1800) ring(w.x, w.z, w.coreRadius, 0xff9900);
    for (const off of sim.config.ship.hitOffsets) ring(v.shipX, v.shipZ + off, sim.config.ship.hitRadius, 0x40ff70);
    for (; i < g.children.length; i++) g.children[i].visible = false;
  }

  /** Spray thrown up at the bow, more of it the faster the ship goes (cosmetic). */
  private bowSpray(v: FrameView, x: number, z: number): void {
    if (v.death || v.speed <= 0) return;
    this.sprayClock += v.dt * (8 + v.speed / 30);
    while (this.sprayClock > 1) {
      this.sprayClock -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      this.particles.emit({
        kind: 'spray',
        x: x + side * 20,
        y: 4,
        z: z - 40,
        vx: side * (40 + Math.random() * 70) + v.vx * 0.3,
        vy: 50 + Math.random() * 90,
        vz: v.speed * 0.75,
        maxLife: 0.45 + Math.random() * 0.3,
        size: 2.5 + Math.random() * 2.5,
        spin: 0,
        color: Math.random() < 0.5 ? '#e9f1ea' : '#cfe0dc',
      });
    }
  }

  /** Re-light metal and the sky's ambient from the current sky (when the stage's light has moved on). */
  private refreshEnvironment(key: number, time: number): void {
    if (Math.abs(key - this.envKey) < 0.15 && this.envRT) return;
    if (this.envRT && time - this.envAt < 0.6 && Math.abs(key - this.envKey) < 0.6) return;
    this.envKey = key;
    this.envAt = time;
    const rt = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 1000);
    this.envRT?.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.85;
  }

  private fitShadow(anchorZ: number): void {
    const s = this.sun.shadow.camera;
    const oz = this.originZ;
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    const look = new THREE.Matrix4().lookAt(this.sun.position, this.sun.target.position, new THREE.Vector3(0, 1, 0));
    const inv = look.clone().invert();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const c = new THREE.Vector3();
    for (const x of [-this.hw - 80, this.hw + 80])
      for (const y of [-20, 300])
        for (const z of [anchorZ - 560, anchorZ + 2000]) {
          c.set(x, y, oz - z).sub(this.sun.position).applyMatrix4(inv);
          minX = Math.min(minX, c.x);
          maxX = Math.max(maxX, c.x);
          minY = Math.min(minY, c.y);
          maxY = Math.max(maxY, c.y);
          minZ = Math.min(minZ, c.z);
          maxZ = Math.max(maxZ, c.z);
        }
    s.left = minX;
    s.right = maxX;
    s.bottom = minY;
    s.top = maxY;
    s.near = Math.max(1, -maxZ - 600);
    s.far = -minZ + 600;
    s.updateProjectionMatrix();
  }

  destroy(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.hazards.dispose();
    this.decals.dispose();
    this.glows.dispose();
    this.tentacles.dispose();
    this.coins.dispose();
    this.ship.dispose();
    this.wake.dispose();
    this.particleView.dispose();
    this.edge.dispose();
    this.mats.dispose();
    this.waterMat.dispose();
    this.water.geometry.dispose();
    for (const s of [this.scene, this.envScene])
      s.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | undefined;
        if (mat && 'dispose' in mat) mat.dispose();
      });
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.post.dispose();
    this.mirror.dispose();
    this.sun.shadow.map?.dispose();
    this.gl.dispose();
  }
}
