import * as THREE from 'three';

/**
 * The coin: gold, struck with a dragon in relief, and very old.
 *
 * Fresh gold is a mirror with a colour, and a mirror with a colour is not much to
 * look at. What makes a coin read as a coin is everything that has happened to it
 * since it was struck, and all of that follows the shape:
 *
 * - The high points — the rim, and the raised relief — are what fingers and
 *   pockets and other coins have rubbed, so they are the cleanest, brightest metal.
 * - The recessed field between them is where the dirt stays. It is dull, dark,
 *   and not metal at all: grime is a dielectric sitting on top of the gold, so it
 *   wants low metalness and high roughness, not just a darker gold.
 * - Nothing on it has one roughness. Wear comes in patches: here a spot rubbed
 *   back to a near mirror, there a broad dull area the polish never reached, and
 *   between them everything in between. That variation, more than any colour,
 *   is what says the metal is old.
 * - Over that, toning — the reddish-brown film old gold takes on, in soft
 *   patches, thickest where the field is sheltered.
 * - And the surface itself, from a baked slope map (see tools/coin-surface.mjs):
 *   every edge of the relief rounded off by a lifetime in pockets, the rim's
 *   edge and the coin's edge rounded the same way, hundreds of shallow
 *   scratches at every length and angle, dents, nicks in the rim, pinpoint
 *   pores. The map stores slopes rather than normals, so one map serves the
 *   faces sampled by x and z and, as a strip, the edge sampled by angle and y;
 *   the shader tilts the geometric normal by the slopes along the matching
 *   tangents. The strike's slow swell and the fine grain of the metal are
 *   computed here, as height differences, since baked they cost more bytes than
 *   the rest of the map together.
 *
 * Almost none of it is a texture. The asset pipeline stores how deep into a recess
 * each vertex sits in the UV slot (the coin has no texture to put there), bakes
 * how far each point of the field is from the foot of a wall into a small map
 * that is sampled by the coin's own x and z, and everything else is noise in the
 * coin's own object space, so it is locked to the metal and turns with it. The
 * relief depth itself is measured off the model at build time.
 *
 * None of it glitters. The slope map is mipmapped, and slopes average correctly
 * under filtering, so a scratch that is narrower than a pixel fades to a faint
 * tilt rather than flickering; the procedural grain is kept coarser than a pixel
 * at the reveal's framing. A pattern finer than a pixel does not draw as a
 * pattern; it draws as sparkle that crawls when the camera moves, and the first
 * version of this coin did exactly that.
 */

export interface CoinSettings {
  /** How much dirt sits in the recesses, 0..1. */
  grime: number;
  /** How far the most-rubbed metal goes toward a mirror: the low end of the roughness. */
  polish: number;
  /** How much of the surface the polish never reached: the spread of the roughness. */
  wear: number;
  /** How much the scratches roughen and tilt the metal. */
  scratches: number;
  /** Reddish-brown toning in soft patches. */
  patina: number;
  /** How much the dents, nicks and pores roughen and darken the metal. */
  pits: number;
}

export const DEFAULT_COIN: CoinSettings = {
  grime: 0.85,
  // Below about 0.18 the rubbed patches stop reading as worn and start reading
  // as wet.
  polish: 0.2,
  wear: 0.8,
  scratches: 0.8,
  patina: 0.8,
  pits: 0.5,
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
/** Slopes in the surface maps are stored as a fraction of this; see coin-surface.mjs. */
const COIN_SLOPE_MAX = 1.5;

const COIN_VERTEX_PARS = /* glsl */ `
varying vec3 vCoinPosition;
varying vec2 vCoinUv;
varying vec3 vCoinRadial;
varying vec3 vCoinAxis;
varying vec3 vCoinTangent;
varying vec3 vCoinX;
varying vec3 vCoinZ;
`;

const COIN_VERTEX = /* glsl */ `
vCoinPosition = position;
vCoinUv = uv;
// The three directions the scratches can tilt the surface in, carried into view
// space so they line up with the normal the lighting code is holding.
vec3 coinRadialObject = normalize(vec3(position.x, 0.0, position.z) + vec3(1e-5, 0.0, 0.0));
vCoinRadial = normalize(normalMatrix * coinRadialObject);
vCoinAxis = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
vCoinTangent = normalize(normalMatrix * cross(vec3(0.0, 1.0, 0.0), coinRadialObject));
vCoinX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
vCoinZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
`;

const COIN_FRAGMENT_PARS = /* glsl */ `
#define COIN_WEAR_EXTENT ${COIN_WEAR_EXTENT.toFixed(3)}
#define COIN_WEAR_RANGE ${COIN_WEAR_RANGE.toFixed(3)}
#define COIN_SLOPE_MAX ${COIN_SLOPE_MAX.toFixed(3)}
varying vec3 vCoinPosition;
varying vec2 vCoinUv;
varying vec3 vCoinRadial;
varying vec3 vCoinAxis;
varying vec3 vCoinTangent;
varying vec3 vCoinX;
varying vec3 vCoinZ;
uniform float uCoinGrime;
uniform float uCoinPolish;
uniform float uCoinWearAmount;
uniform float uCoinScratches;
uniform float uCoinPatina;
uniform float uCoinPits;
uniform float uCoinHalfThickness;
uniform vec3 uCoinGold;
uniform vec3 uCoinGrimeColor;
uniform vec3 uCoinPatinaColor;
// Distance to the nearest wall foot as a fraction of COIN_WEAR_RANGE, in r for
// the heads face and g for tails, over ±COIN_WEAR_EXTENT of the coin's x and z.
uniform sampler2D uCoinWearMap;
// The faces' surface, heads in the left half and tails in the right, over the
// same extent: slopes along x and z in r and g, scratches in b, dents in a
// (inverted). And the edge's, around the circumference by y across it.
uniform sampler2D uCoinSurfaceMap;
uniform sampler2D uCoinEdgeMap;

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

// The strike's slow swell and the metal's grain, as a height at a point. Read
// at the point and a small step along two tangents, the differences tilt the
// normal. Sampled in the coin's own space so it turns with the metal.
float coinSwell(vec3 p) {
  return 0.004 * (coinFbm(p * 3.0 + vec3(4.0, 1.0, 7.0)) - 0.5)
    + 0.0004 * (coinNoise(p * 40.0 + vec3(9.0, 3.0, 2.0)) - 0.5);
}

// The surface map's four channels, decoded: slopes along the two sampling
// directions in coin units per unit, and the two damage masks.
vec4 coinDecodeSurface(vec4 texel) {
  return vec4((texel.rg * 2.0 - 1.0) * COIN_SLOPE_MAX, texel.b, 1.0 - texel.a);
}
`;

/** Runs after color_fragment; everything later reads what this works out. */
const COIN_FRAGMENT_COLOR = /* glsl */ `
vec3 coinP = vCoinPosition;
float coinCavity = clamp(vCoinUv.x, 0.0, 1.0);
float coinExposed = 1.0 - coinCavity;
float coinR = length(coinP.xz);
vec3 coinRadialObject = coinR > 1e-4 ? vec3(coinP.x, 0.0, coinP.z) / coinR : vec3(1.0, 0.0, 0.0);
vec3 coinTangentObject = cross(vec3(0.0, 1.0, 0.0), coinRadialObject);
// 0 on the faces, 1 on the edge and the walls of the relief.
float coinSideness = 1.0 - smoothstep(0.3, 0.8, abs(dot(normalize(vNormal), normalize(vCoinAxis))));

// Dirt collects in the recesses — heaviest at the foot of the walls, where a
// thumb cannot reach, thinner across the open field, and never evenly. A field
// that is uniformly dirty is a field that has been painted.
vec2 coinWearUv = (coinP.xz + COIN_WEAR_EXTENT) / (2.0 * COIN_WEAR_EXTENT);
vec2 coinWear = texture2D(uCoinWearMap, coinWearUv).rg;
float coinWallDistance = (coinP.y > 0.0 ? coinWear.r : coinWear.g) * COIN_WEAR_RANGE;
float coinFoot = 1.0 - smoothstep(0.0, 0.1, coinWallDistance);
float coinBlotch = coinFbm(coinP * 9.0 + vec3(3.1, 7.7, 1.3));
float coinGrime = uCoinGrime * coinCavity
  * (0.4 + 0.6 * coinFoot)
  * smoothstep(0.42, 0.62, coinBlotch + 0.5 * coinFoot);
// And the corner where field meets wall is in shadow from every direction at
// once, whether or not there is dirt in it.
float coinRecessShade = coinCavity * coinFoot;

// Wear. A broad, slow map of where the polish reached, sharpened by a finer one,
// sets how dull each patch of metal is: 0 is rubbed to a near mirror, 1 is the
// dull struck surface. The high points are rubbed hardest, so they lean bright.
float coinWearSlow = coinFbm(coinP * 2.4 + vec3(21.0, 4.0, 8.0));
float coinWearFine = coinFbm(coinP * 13.0 + vec3(2.0, 17.0, 6.0));
float coinDull = smoothstep(0.25, 0.75, coinWearSlow + 0.35 * (coinWearFine - 0.5) + 0.12 * coinCavity - 0.1 * coinExposed);
// The edge is rubbed by everything and polished by nothing.
coinDull = max(coinDull, 0.6 * coinSideness);
coinDull = mix(0.5, coinDull, uCoinWearAmount);

// Toning: soft patches of reddish-brown film, thickest in the sheltered field.
float coinPatina = uCoinPatina
  * smoothstep(0.42, 0.72, coinFbm(coinP * 3.4 + vec3(11.0, 2.0, 5.0)) + 0.15 * coinFoot)
  * (0.35 + 0.65 * coinCavity);

// The surface. On the faces the map is read by x and z, heads from the left
// half of the atlas and tails from the right; the edge reads its strip by the
// angle around the coin and by y. Where a wall of the relief runs from face to
// edge the two are blended by how far the normal has turned.
vec2 coinFaceUv = vec2(coinWearUv.x * 0.5 + (coinP.y > 0.0 ? 0.0 : 0.5), coinWearUv.y);
vec4 coinFace = coinDecodeSurface(texture2D(uCoinSurfaceMap, coinFaceUv));
float coinAngle = atan(coinP.z, coinP.x);
vec2 coinEdgeUv = vec2(coinAngle / (2.0 * PI) + 0.5, coinP.y / (2.0 * uCoinHalfThickness) + 0.5);
vec4 coinEdgeS = coinDecodeSurface(texture2D(uCoinEdgeMap, coinEdgeUv));
vec4 coinSurface = mix(coinFace, coinEdgeS, coinSideness);
float coinScratch = uCoinScratches * coinSurface.z;
float coinPit = uCoinPits * coinSurface.w;

// The swell and grain, as height differences over a fixed step across the
// surface, in the two directions the map's slopes are read along.
vec3 coinAcrossObject = normalize(mix(vec3(1.0, 0.0, 0.0), -coinTangentObject, coinSideness));
vec3 coinAlongObject = normalize(mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0), coinSideness));
float coinH0 = coinSwell(coinP);
float coinSlopeU = coinSurface.x + (coinSwell(coinP + coinAcrossObject * 0.004) - coinH0) / 0.004;
float coinSlopeV = coinSurface.y + (coinSwell(coinP + coinAlongObject * 0.004) - coinH0) / 0.004;
vec3 coinU = normalize(mix(vCoinX, -vCoinTangent, coinSideness));
vec3 coinV = normalize(mix(vCoinZ, vCoinAxis, coinSideness));

vec3 coinBase = uCoinGold;
// Dull metal is a shade darker and greyer than the polished: its surface is
// scattering rather than reflecting, and gold's colour is in its reflection.
coinBase = mix(coinBase, coinBase * vec3(0.62, 0.66, 0.72), 0.45 * coinDull);
coinBase = mix(coinBase, uCoinPatinaColor, 0.75 * coinPatina);
coinBase = mix(coinBase, uCoinGrimeColor, coinGrime);
// The floor of a dent has lost its polish, and a scratch shows fresher metal.
coinBase *= 1.0 - 0.35 * coinPit;
coinBase *= 1.0 + 0.05 * coinScratch;
// The rubbed high points are a shade brighter than the rest, and the field is
// toned below them. Measured in the probe, a field left as bright as the relief
// came out at 180 to the relief's 137 out of 255, since its rougher metal
// gathers more of the softbox than the polished high points do — the coin
// inside out. This puts the clean field below the relief and the grime below that.
coinBase *= 1.0 + 0.12 * coinExposed;
coinBase *= 1.0 - 0.4 * coinCavity;
diffuseColor.rgb = coinBase;
`;

const COIN_FRAGMENT_ROUGHNESS = /* glsl */ `
// The whole span, from the rubbed mirror to the dull struck surface, by the
// wear map; the high points shifted toward the polished end. Then a scratch is
// rougher along its floor, a dent rougher still, patina is a soft film, and
// grime is not metal at all.
roughnessFactor = mix(uCoinPolish, 0.78, coinDull);
roughnessFactor = mix(roughnessFactor, uCoinPolish, 0.45 * coinExposed * (1.0 - coinDull));
roughnessFactor += 0.28 * coinScratch + 0.3 * coinPit + 0.14 * coinPatina;
roughnessFactor = mix(roughnessFactor, 0.85, coinGrime);
roughnessFactor = clamp(roughnessFactor, 0.05, 0.95);
`;

const COIN_FRAGMENT_METALNESS = /* glsl */ `
// Grime is not metal. This is most of what makes it read as dirt rather than as
// a darker gold: it stops reflecting the room and starts scattering the key.
metalnessFactor = mix(1.0, 0.12, coinGrime);
`;

const COIN_FRAGMENT_NORMAL = /* glsl */ `
// For a height h over tangents U and V, the surface normal is N - h_u U - h_v V,
// whichever way round U and V are. The slopes are in the coin's units, the
// tangents are in view space, and the geometric normal is what the map tilts.
normal = normalize(normal - coinU * coinSlopeU - coinV * coinSlopeV);
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

/**
 * `halfThickness` is what the edge strip's y spans; the asset build bakes it to
 * the coin's inradius.
 */
export function createCoinMaterial(settings?: Partial<CoinSettings>, halfThickness = 0.1): CoinMaterial {
  const coin: CoinSettings = { ...DEFAULT_COIN, ...settings };
  // Clean until the map arrives: a single texel as far from any wall as the map
  // can say.
  const clean = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  clean.needsUpdate = true;
  const flat = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1);
  flat.needsUpdate = true;
  const uniforms = {
    uCoinWearMap: { value: clean as THREE.Texture },
    uCoinSurfaceMap: { value: flat as THREE.Texture },
    uCoinEdgeMap: { value: flat as THREE.Texture },
    uCoinHalfThickness: { value: halfThickness },
    uCoinGrime: { value: coin.grime },
    uCoinPolish: { value: coin.polish },
    uCoinWearAmount: { value: coin.wear },
    uCoinScratches: { value: coin.scratches },
    uCoinPatina: { value: coin.patina },
    uCoinPits: { value: coin.pits },
    // Linear, since it is written straight into the shader: gold's reflectance is
    // about this, and it is the colour the metal actually is rather than a tint.
    uCoinGold: { value: new THREE.Color(1.0, 0.71, 0.29) },
    uCoinGrimeColor: { value: new THREE.Color(0.05, 0.035, 0.02) },
    uCoinPatinaColor: { value: new THREE.Color(0.34, 0.16, 0.06) },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 1,
    roughness: 0.4,
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
  material.customProgramCacheKey = () => 'coin-ancient-baked';

  const loader = new THREE.TextureLoader();
  const load = (file: string, wrapS: THREE.Wrapping, mipmaps: boolean) =>
    loader.loadAsync(`${import.meta.env.BASE_URL}dice/${file}`).then((texture) => {
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = wrapS;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = mipmaps;
      texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      texture.anisotropy = 8;
      return texture;
    });
  const ready = Promise.all([
    load('coin-wear.png', THREE.ClampToEdgeWrapping, false).then((t) => void (uniforms.uCoinWearMap.value = t)),
    load('coin-surface.webp', THREE.ClampToEdgeWrapping, true).then((t) => void (uniforms.uCoinSurfaceMap.value = t)),
    load('coin-edge.webp', THREE.RepeatWrapping, true).then((t) => void (uniforms.uCoinEdgeMap.value = t)),
  ]).then(() => undefined);

  return {
    material,
    ready,
    setCoin(next) {
      Object.assign(coin, next);
      uniforms.uCoinGrime.value = coin.grime;
      uniforms.uCoinPolish.value = coin.polish;
      uniforms.uCoinWearAmount.value = coin.wear;
      uniforms.uCoinScratches.value = coin.scratches;
      uniforms.uCoinPatina.value = coin.patina;
      uniforms.uCoinPits.value = coin.pits;
    },
    getCoin: () => ({ ...coin }),
  };
}
