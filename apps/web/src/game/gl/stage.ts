import { STAGES, stageIndexAt } from '@fes/game-core';
import * as THREE from 'three';

type RGB = [number, number, number];

/**
 * The light of each stage — golden dusk, an amber evening, a red storm sunset, violet twilight with aurora, and
 * night under the moon at the Edge — as the 3D renderer needs it.
 */
interface StageLook {
  skyTop: RGB;
  skyMid: RGB;
  haze: RGB;
  /** Colour of the sun (or moon) disk and its glow. */
  sun: RGB;
  /** Sun direction: azimuth (degrees, negative = to port of the course) and elevation (degrees). */
  sunAz: number;
  sunEl: number;
  /** Brightness of the disk and glow in the sky (HDR). */
  sunPower: number;
  /** Key light (the sun, casting shadows). */
  light: RGB;
  lightI: number;
  /** Fill light from behind the camera, and the ambient sky light. */
  fill: RGB;
  fillI: number;
  ambient: RGB;
  ambientI: number;
  /** Water: deep body colour and the colour light scatters to inside the waves. */
  seaDeep: RGB;
  seaScatter: RGB;
  /** The void beneath the world. */
  abyss: RGB;
  stars: number;
  aurora: number;
  clouds: number;
  /** Darker, heavier clouds (the storm). */
  storm: number;
  /** 1 = the disk is the moon. */
  moon: number;
  exposure: number;
  /**
   * The rim on hazards (see materials.ts), so they stand out where the light is poor: its strength (0 = none) and
   * colour. In the red storm a pale gold, as a red rim would vanish against the red sea; at night the moonlight.
   */
  rim: number;
  rimColor: RGB;
}

const LOOKS: readonly StageLook[] = [
  {
    skyTop: [18, 32, 46],
    skyMid: [70, 96, 104],
    haze: [214, 178, 116],
    sun: [255, 214, 150],
    sunAz: -24,
    sunEl: 6.5,
    sunPower: 9,
    light: [255, 206, 140],
    lightI: 3.4,
    fill: [150, 172, 190],
    fillI: 0.75,
    ambient: [120, 120, 112],
    ambientI: 0.55,
    seaDeep: [6, 24, 36],
    seaScatter: [34, 84, 96],
    abyss: [4, 7, 9],
    stars: 0.25,
    aurora: 0,
    clouds: 0.42,
    storm: 0,
    moon: 0,
    exposure: 0.82,
    rim: 0,
    rimColor: [0, 0, 0],
  },
  {
    skyTop: [22, 26, 46],
    skyMid: [92, 76, 92],
    haze: [228, 150, 88],
    sun: [255, 180, 110],
    sunAz: -17,
    sunEl: 4,
    sunPower: 8,
    light: [255, 170, 104],
    lightI: 3.0,
    fill: [140, 150, 190],
    fillI: 0.7,
    ambient: [118, 104, 104],
    ambientI: 0.5,
    seaDeep: [8, 26, 36],
    seaScatter: [42, 86, 92],
    abyss: [5, 6, 10],
    stars: 0.3,
    aurora: 0,
    clouds: 0.5,
    storm: 0.15,
    moon: 0,
    exposure: 0.85,
    rim: 0,
    rimColor: [0, 0, 0],
  },
  {
    skyTop: [26, 12, 22],
    skyMid: [112, 40, 50],
    haze: [222, 104, 70],
    sun: [255, 128, 84],
    sunAz: -10,
    sunEl: 2.2,
    sunPower: 7,
    light: [255, 120, 80],
    lightI: 2.5,
    fill: [140, 120, 160],
    fillI: 0.65,
    ambient: [110, 82, 90],
    ambientI: 0.5,
    seaDeep: [10, 20, 30],
    seaScatter: [52, 60, 76],
    abyss: [6, 4, 7],
    stars: 0.25,
    aurora: 0,
    clouds: 0.72,
    storm: 0.65,
    moon: 0,
    exposure: 0.9,
    rim: 1.3,
    rimColor: [255, 214, 168],
  },
  {
    skyTop: [16, 16, 46],
    skyMid: [72, 56, 128],
    haze: [176, 130, 196],
    sun: [236, 180, 255],
    sunAz: -6,
    sunEl: -2.5,
    sunPower: 4,
    light: [200, 165, 255],
    lightI: 1.5,
    fill: [165, 155, 228],
    fillI: 1.35,
    ambient: [128, 116, 168],
    ambientI: 1.0,
    seaDeep: [22, 32, 66],
    seaScatter: [62, 72, 132],
    abyss: [4, 4, 12],
    stars: 0.8,
    aurora: 0.65,
    clouds: 0.3,
    storm: 0.1,
    moon: 0,
    exposure: 1.25,
    rim: 1,
    rimColor: [200, 165, 255],
  },
  {
    skyTop: [8, 13, 28],
    skyMid: [24, 52, 76],
    haze: [108, 156, 172],
    sun: [214, 232, 255],
    sunAz: 21,
    sunEl: 12,
    sunPower: 3.2,
    light: [180, 208, 255],
    lightI: 1.75,
    fill: [132, 160, 206],
    fillI: 1.2,
    ambient: [98, 122, 152],
    ambientI: 0.95,
    seaDeep: [18, 38, 58],
    seaScatter: [46, 92, 116],
    abyss: [2, 3, 7],
    stars: 1,
    aurora: 1,
    clouds: 0.2,
    storm: 0,
    moon: 1,
    exposure: 1.5,
    rim: 1,
    rimColor: [180, 208, 255],
  },
];

const lin = (c: RGB, out: THREE.Color) => out.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);

/** The blended light of one moment, in linear colour, ready for uniforms. */
export class Light {
  readonly skyTop = new THREE.Color();
  readonly skyMid = new THREE.Color();
  readonly haze = new THREE.Color();
  readonly sun = new THREE.Color();
  /** Towards the sun (or moon), in scene space. */
  readonly sunDir = new THREE.Vector3();
  /**
   * Towards the key light that shades the scene: the sun's light, swung further to the side and a little higher than
   * the disk itself, so that hazards facing the chase camera are side-lit rather than black against the glare.
   */
  readonly keyDir = new THREE.Vector3();
  sunPower = 1;
  readonly light = new THREE.Color();
  lightI = 1;
  readonly fill = new THREE.Color();
  fillI = 1;
  readonly ambient = new THREE.Color();
  ambientI = 1;
  readonly seaDeep = new THREE.Color();
  readonly seaScatter = new THREE.Color();
  readonly abyss = new THREE.Color();
  stars = 0;
  aurora = 0;
  clouds = 0;
  storm = 0;
  moon = 0;
  exposure = 1;
  /** The rim on hazards: strength, and colour (linear). */
  rim = 0;
  readonly rimColor = new THREE.Color();
  /** Stage index and blend (for deciding when to refresh the environment map). */
  key = 0;

  private readonly a = new THREE.Color();
  private readonly b = new THREE.Color();

  /** Set for a moment of the voyage: each stage's light eases into the next over eight seconds. */
  at(tSec: number): this {
    const i = stageIndexAt(tSec);
    const cur = LOOKS[i];
    let prev = cur;
    let e = 1;
    if (i > 0) {
      const t = Math.min(1, (tSec - STAGES[i].startSec) / 8);
      e = t * t * (3 - 2 * t);
      prev = LOOKS[i - 1];
    }
    this.key = i - 1 + e;
    const col = (k: keyof StageLook, out: THREE.Color) => {
      lin(prev[k] as RGB, this.a);
      lin(cur[k] as RGB, this.b);
      out.copy(this.a).lerp(this.b, e);
    };
    const num = (k: keyof StageLook) => (prev[k] as number) + ((cur[k] as number) - (prev[k] as number)) * e;
    col('skyTop', this.skyTop);
    col('skyMid', this.skyMid);
    col('haze', this.haze);
    col('sun', this.sun);
    col('light', this.light);
    col('fill', this.fill);
    col('ambient', this.ambient);
    col('seaDeep', this.seaDeep);
    col('seaScatter', this.seaScatter);
    col('abyss', this.abyss);
    col('rimColor', this.rimColor);
    // The sun swings smoothly; across the moonrise it sets first and the moon rises.
    let az = num('sunAz');
    let el = num('sunEl');
    if (prev.moon !== cur.moon) {
      const k = e < 0.5 ? e * 2 : (e - 0.5) * 2;
      az = e < 0.5 ? prev.sunAz : cur.sunAz;
      el = e < 0.5 ? prev.sunEl + (-6 - prev.sunEl) * k : -6 + (cur.sunEl + 6) * k;
    }
    const azr = (az * Math.PI) / 180;
    const elr = (el * Math.PI) / 180;
    // In scene space: x across the channel, y up, and the course runs towards −z.
    this.sunDir.set(Math.sin(azr) * Math.cos(elr), Math.sin(elr), -Math.cos(azr) * Math.cos(elr));
    const kaz = ((az + (az < 0 ? -36 : 36)) * Math.PI) / 180;
    const kel = (Math.max(el, 12) + 6) * (Math.PI / 180);
    this.keyDir.set(Math.sin(kaz) * Math.cos(kel), Math.sin(kel), -Math.cos(kaz) * Math.cos(kel));
    this.sunPower = num('sunPower');
    this.lightI = num('lightI');
    this.fillI = num('fillI');
    this.ambientI = num('ambientI');
    this.stars = num('stars');
    this.aurora = num('aurora');
    this.clouds = num('clouds');
    this.storm = num('storm');
    this.moon = prev.moon !== cur.moon ? (e < 0.5 ? prev.moon : cur.moon) : cur.moon;
    this.exposure = num('exposure');
    this.rim = num('rim');
    return this;
  }
}
