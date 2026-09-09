import * as THREE from 'three';

/**
 * The coin: gold, struck with a dragon in relief, and handled for a long time.
 *
 * Fresh gold is a mirror with a colour, and a mirror with a colour is not much to
 * look at. What makes a coin read as a coin is everything that has happened to it
 * since it was struck, and all of that follows the shape:
 *
 * - The high points — the rim, and the raised relief — are what fingers and
 *   pockets and other coins have rubbed, so they are the clean, polished metal.
 * - The recessed field between them is where the dirt stays. It is dull, dark,
 *   and not metal at all: grime is a dielectric sitting on top of the gold, so it
 *   wants low metalness and high roughness, not just a darker gold.
 * - The exposed metal is covered in fine hairline scratches that run around the
 *   coin rather than across it — the marks of being turned in a hand and tumbled
 *   in a pocket — and they catch the light as rings.
 * - Over the top of that, faint uneven tarnish, and the odd pit.
 *
 * Almost none of it is a texture. The asset pipeline stores how deep into a recess
 * each vertex sits in the UV slot (the coin has no texture to put there), bakes
 * how far each point of the field is from the foot of a wall into a small map
 * that is sampled by the coin's own x and z, and everything else is noise in the
 * coin's own object space, so it is locked to the metal and turns with it. The
 * relief depth itself is measured off the model at build time.
 */

export interface CoinSettings {
  /** How much dirt sits in the recesses, 0..1. */
  grime: number;
  /** Roughness of the clean high points. Gold that has been handled sits low. */
  polish: number;
  /** Strength of the hairline scratches, both as roughness and as relief. */
  scratches: number;
  /** Broad soft patches of dulled metal on the exposed surfaces. */
  tarnish: number;
  /** Pin-prick pits and dark spots. */
  speckle: number;
}

export const DEFAULT_COIN: CoinSettings = {
  grime: 0.9,
  // Handled gold is not a mirror, but it is close to one: this is what puts the
  // reflector's sweep of light across the relief. Under the plain room, without
  // the reflector, anything this polished mirrored the dark shell and the relief
  // went black against the field — the coin turned inside out.
  polish: 0.35,
  scratches: 0.8,
  tarnish: 0.4,
  speckle: 0.3,
};

export interface CoinMaterial {
  material: THREE.MeshPhysicalMaterial;
  /** Resolves once the baked wear map is in; until then the field is clean. */
  ready: Promise<void>;
  setCoin(settings: Partial<CoinSettings>): void;
  getCoin(): CoinSettings;
}

/**
 * How the wear map is laid out; the asset build writes it to match. It spans this
 * many units either side of the coin's axis, and stores distances as a fraction
 * of this range.
 */
const COIN_WEAR_EXTENT = 0.7;
const COIN_WEAR_RANGE = 0.25;

const COIN_VERTEX_PARS = /* glsl */ `
varying vec3 vCoinPosition;
varying vec2 vCoinUv;
varying vec3 vCoinRadial;
varying vec3 vCoinAxis;
`;

const COIN_VERTEX = /* glsl */ `
vCoinPosition = position;
vCoinUv = uv;
// The two directions the scratches can tilt the surface in, carried into view
// space so they line up with the normal the lighting code is holding.
vec3 coinRadialObject = normalize(vec3(position.x, 0.0, position.z) + vec3(1e-5, 0.0, 0.0));
vCoinRadial = normalize(normalMatrix * coinRadialObject);
vCoinAxis = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
`;

const COIN_FRAGMENT_PARS = /* glsl */ `
#define COIN_WEAR_EXTENT ${COIN_WEAR_EXTENT.toFixed(3)}
#define COIN_WEAR_RANGE ${COIN_WEAR_RANGE.toFixed(3)}
varying vec3 vCoinPosition;
varying vec2 vCoinUv;
varying vec3 vCoinRadial;
varying vec3 vCoinAxis;
uniform float uCoinGrime;
uniform float uCoinPolish;
uniform float uCoinScratches;
uniform float uCoinTarnish;
uniform float uCoinSpeckle;
uniform vec3 uCoinGold;
uniform vec3 uCoinGrimeColor;
// Distance to the nearest wall foot as a fraction of COIN_WEAR_RANGE, in r for
// the heads face and g for tails, over ±COIN_WEAR_EXTENT of the coin's x and z.
uniform sampler2D uCoinWear;

float coinHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float coinNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(coinHash(i), coinHash(i + vec3(1, 0, 0)), f.x), mix(coinHash(i + vec3(0, 1, 0)), coinHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(coinHash(i + vec3(0, 0, 1)), coinHash(i + vec3(1, 0, 1)), f.x), mix(coinHash(i + vec3(0, 1, 1)), coinHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z
  );
}

float coinFbm(vec3 p) {
  float amplitude = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * coinNoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    amplitude *= 0.5;
  }
  return sum;
}

// Hairlines that run around the coin: slow around the circumference, fast
// radially, so the noise is stretched into rings. Sampled on the direction rather
// than on an angle, so there is no seam where an angle would wrap. Thirty rings
// to the unit is a few pixels apart at the reveal's framing; at 170 they were
// finer than a pixel, and a pattern finer than a pixel does not draw as lines,
// it draws as glitter.
float coinScratchAt(vec2 direction, float r, float y) {
  return coinNoise(vec3(direction * 4.0, r * 30.0 + y * 6.0));
}
`;

/** Runs after color_fragment; everything later reads what this works out. */
const COIN_FRAGMENT_COLOR = /* glsl */ `
vec3 coinP = vCoinPosition;
float coinCavity = clamp(vCoinUv.x, 0.0, 1.0);
float coinExposed = 1.0 - coinCavity;
float coinR = length(coinP.xz);
vec2 coinDir = coinR > 1e-4 ? coinP.xz / coinR : vec2(1.0, 0.0);

// Dirt collects in the recesses — heaviest at the foot of the walls, where a
// thumb cannot reach, thinner across the open field, and never evenly. A field
// that is uniformly dirty is a field that has been painted.
vec2 coinWearUv = (coinP.xz + COIN_WEAR_EXTENT) / (2.0 * COIN_WEAR_EXTENT);
vec2 coinWear = texture2D(uCoinWear, coinWearUv).rg;
float coinWallDistance = (coinP.y > 0.0 ? coinWear.r : coinWear.g) * COIN_WEAR_RANGE;
float coinFoot = 1.0 - smoothstep(0.0, 0.1, coinWallDistance);
// The blotch threshold is narrow on purpose: eased over the whole range of
// the noise it shaded the field one even brown, which is paint, not dirt.
float coinBlotch = coinFbm(coinP * 9.0 + vec3(3.1, 7.7, 1.3));
float coinGrime = uCoinGrime * coinCavity
  * (0.4 + 0.6 * coinFoot)
  * smoothstep(0.42, 0.62, coinBlotch + 0.5 * coinFoot);
// And the corner where field meets wall is in shadow from every direction at
// once, whether or not there is dirt in it.
float coinRecessShade = coinCavity * coinFoot;

// Tarnish: broad, soft, mostly on the exposed metal.
float coinTarnish = uCoinTarnish
  * smoothstep(0.5, 0.8, coinFbm(coinP * 3.7 + vec3(11.0, 2.0, 5.0)))
  * (1.0 - coinCavity * 0.6);

// Pits: small and dark, and still metal. Not rough — in this room a rough
// patch of gold is a bright one, and rough pits drew as pale blotches all over
// the rim; and not dielectric either, since anything that scatters the key
// comes out brighter than gold mirroring a dark room.
float coinSpeck = uCoinSpeckle * smoothstep(0.74, 0.8, coinNoise(coinP * 60.0 + 4.2));

// Scratches on the high points: the roughness rises and falls smoothly with
// the ring noise, so they read as a brushed sheen. Thresholded into distinct
// lines they came out as pale blotches, since here a rough patch of gold
// catches the key softbox and a polished one reflects the dark room. The slope
// of the field in the two directions the surface can tilt feeds the normal.
float coinS0 = coinScratchAt(coinDir, coinR, coinP.y);
float coinScratch = uCoinScratches * (coinS0 - 0.5) * coinExposed;
float coinSlopeR = (coinScratchAt(coinDir, coinR + 0.004, coinP.y) - coinS0) * uCoinScratches * coinExposed * 0.1;
float coinSlopeY = (coinScratchAt(coinDir, coinR, coinP.y + 0.004) - coinS0) * uCoinScratches * coinExposed * 0.1;

vec3 coinBase = mix(uCoinGold, uCoinGrimeColor, coinGrime);
coinBase = mix(coinBase, coinBase * vec3(0.72, 0.66, 0.58), coinTarnish);
coinBase *= 1.0 - 0.6 * coinSpeck;
// The rubbed high points are a shade brighter than the rest.
coinBase *= 1.0 + 0.12 * coinExposed;
// And the field is toned well below the metal it was struck from: a film of
// oxide that absorbs rather than a colour. Measured in the probe, a field left
// as bright as the relief came out at 180 to the relief's 137 out of 255, since
// its rougher metal gathers more of the softbox than the polished high points do
// — the coin inside out. This puts the clean field below the relief and the
// grime below that.
coinBase *= 1.0 - 0.55 * coinCavity;
diffuseColor.rgb = coinBase;
`;

const COIN_FRAGMENT_ROUGHNESS = /* glsl */ `
// The field is not polished: it was struck matte and has been toned by a
// lifetime of small wear. Left as bright as the relief it reflected the key
// softbox as one pale sheet, and the relief, tilted away from it, went dark —
// the exact inverse of a worn coin, whose high points are what shine.
roughnessFactor = mix(uCoinPolish, uCoinPolish + 0.14, coinCavity);
roughnessFactor = mix(roughnessFactor, 0.75, coinGrime);
roughnessFactor += 0.16 * coinTarnish + 0.14 * coinScratch;
roughnessFactor = clamp(roughnessFactor, 0.06, 0.95);
`;

const COIN_FRAGMENT_METALNESS = /* glsl */ `
// Grime is not metal. This is most of what makes it read as dirt rather than as
// a darker gold: it stops reflecting the room and starts scattering the key.
metalnessFactor = mix(1.0, 0.12, coinGrime);
`;

const COIN_FRAGMENT_NORMAL = /* glsl */ `
normal = normalize(normal + vCoinRadial * coinSlopeR + vCoinAxis * coinSlopeY);
`;

/**
 * Runs after aomap_fragment. The foot of a wall sees less of the room than the
 * open field does, and for a metal the room is nearly all of its light.
 */
const COIN_FRAGMENT_AO = /* glsl */ `
float coinOcclusion = 1.0 - 0.6 * coinRecessShade;
reflectedLight.indirectDiffuse *= coinOcclusion;
reflectedLight.indirectSpecular *= coinOcclusion;
`;

export function createCoinMaterial(settings?: Partial<CoinSettings>): CoinMaterial {
  const coin: CoinSettings = { ...DEFAULT_COIN, ...settings };
  // Clean until the map arrives: a single texel as far from any wall as the map
  // can say.
  const clean = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  clean.needsUpdate = true;
  const uniforms = {
    uCoinWear: { value: clean as THREE.Texture },
    uCoinGrime: { value: coin.grime },
    uCoinPolish: { value: coin.polish },
    uCoinScratches: { value: coin.scratches },
    uCoinTarnish: { value: coin.tarnish },
    uCoinSpeckle: { value: coin.speckle },
    // Linear, since it is written straight into the shader: gold's reflectance is
    // about this, and it is the colour the metal actually is rather than a tint.
    uCoinGold: { value: new THREE.Color(1.0, 0.71, 0.29) },
    uCoinGrimeColor: { value: new THREE.Color(0.05, 0.035, 0.02) },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 1,
    roughness: coin.polish,
    // Gold has nothing but the room to show, and its room has the reflector in
    // it (see createEnvironment). Measured in the probe: at 0.8 the relief was
    // already past the tone curve's shoulder and reading as pale cream, at 0.5
    // it is gold.
    envMapIntensity: 0.55,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${COIN_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${COIN_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COIN_FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${COIN_FRAGMENT_COLOR}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${COIN_FRAGMENT_ROUGHNESS}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${COIN_FRAGMENT_METALNESS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${COIN_FRAGMENT_NORMAL}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${COIN_FRAGMENT_AO}`);
  };
  // A key of its own, so three does not hand this material a program cached for
  // an unpatched MeshPhysicalMaterial with the same settings.
  material.customProgramCacheKey = () => 'coin-weathered';

  const ready = new THREE.TextureLoader()
    .loadAsync(`${import.meta.env.BASE_URL}dice/coin-wear.png`)
    .then((texture) => {
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      uniforms.uCoinWear.value = texture;
    });

  return {
    material,
    ready,
    setCoin(next) {
      Object.assign(coin, next);
      uniforms.uCoinGrime.value = coin.grime;
      uniforms.uCoinPolish.value = coin.polish;
      uniforms.uCoinScratches.value = coin.scratches;
      uniforms.uCoinTarnish.value = coin.tarnish;
      uniforms.uCoinSpeckle.value = coin.speckle;
    },
    getCoin: () => ({ ...coin }),
  };
}
