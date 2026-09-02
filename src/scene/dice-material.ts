import * as THREE from 'three';

/**
 * The dice material: cast resin over metallic flake, the way automotive paint is
 * built up.
 *
 * Real metallic paint is a pigmented base loaded with tiny aluminium flakes under
 * a clear coat. Each flake is a mirror lying at its own slight angle, so at any
 * moment only the few whose tilt happens to line a light up with your eye fire —
 * and which few that is changes as the object turns. That is why the sparkle
 * crawls across a car as you walk past it, and it is why this cannot be a
 * texture: a painted-on glitter map slides with the surface instead of firing
 * and dying.
 *
 * So the flakes are procedural, from a lattice in the die's own object space —
 * they are embedded in the resin, so they have to be locked to the die and tumble
 * with it. Each one reflects the environment map through `getIBLRadiance`, at
 * near-mirror roughness. That is the whole trick: the same little room that lights
 * everything else is what the flakes glint at, so a flake tilted toward the key
 * panel goes white-hot, one tilted at the cool rim strip goes blue, and one facing
 * the black shell stays dark. Nothing has to be told where the lights are.
 *
 * The base stays non-metallic. Turning the whole material metallic would take the
 * painted numerals down with it, and the numerals are the entire point of the app.
 */

export interface FlakeSettings {
  /** Overall brightness of the sparkle. 0 turns it off entirely. */
  strength: number;
  /**
   * Flakes per world unit at full detail; a die is one unit, or about 20mm. 240
   * puts a flake at roughly 0.08mm, which is the right order for real metallic
   * paint. It is a ceiling rather than a promise: what actually gets drawn is
   * this lattice coarsened until a flake is `grain` pixels across, so the number
   * only bites when the camera is close enough to resolve it.
   */
  density: number;
  /**
   * How far a flake tilts out of the surface. 1.0 is about 45 degrees. Real
   * paint is milder than this, but real paint is also lit by a whole sky; with
   * one small room to catch, the flakes need to be pointing in more directions
   * for any of them to find it.
   */
  spread: number;
  /**
   * Flake mirror roughness. Near zero the flake reflects one small part of the
   * room, so a few degrees of turn swap what it sees and it snaps on or off;
   * blur it and it reflects an average of everything and never stops glowing.
   */
  polish: number;
  /** Fraction of lattice cells that carry a flake at all. */
  coverage: number;
  /** How much each flake takes on the die's own colour. 0 = neutral silver. */
  tint: number;
  /**
   * Exponent on each flake's own brightness. 1 leaves the environment as it is
   * and produces an even speckle; above that, the many flakes catching only the
   * dim shell fall away and the few that caught a panel blow past 1.0 into the
   * bloom threshold, which is what turns a field of grey grit into a handful of
   * points that flare and die as the die turns.
   */
  contrast: number;
  /**
   * How many pixels across a flake should be on screen. The lattice coarsens by
   * powers of two until it hits this, so 1.2 gives specks about a pixel wide at
   * any distance. Raising it makes the sparkle chunkier, not denser.
   */
  grain: number;
}

export const DEFAULT_FLAKES: FlakeSettings = {
  strength: 1.7,
  density: 240,
  spread: 1.3,
  polish: 0.01,
  coverage: 0.75,
  tint: 0.4,
  contrast: 3,
  grain: 1.2,
};

export interface DiceMaterial {
  material: THREE.MeshPhysicalMaterial;
  setFlakes(settings: Partial<FlakeSettings>): void;
  getFlakes(): FlakeSettings;
}

export function createDiceMaterial(flakeSettings?: Partial<FlakeSettings>): DiceMaterial {
  const flakes: FlakeSettings = { ...DEFAULT_FLAKES, ...flakeSettings };

  // Held across recompiles: assigning a colourway sets needsUpdate, which runs
  // onBeforeCompile again, and the new program has to pick up the same objects.
  const uniforms = {
    uFlakeStrength: { value: flakes.strength },
    uFlakeDensity: { value: flakes.density },
    uFlakeSpread: { value: flakes.spread },
    uFlakePolish: { value: flakes.polish },
    uFlakeCoverage: { value: flakes.coverage },
    uFlakeTint: { value: flakes.tint },
    uFlakeContrast: { value: flakes.contrast },
    uFlakeGrain: { value: flakes.grain },
  };

  const material = new THREE.MeshPhysicalMaterial({
    roughness: 1,
    metalness: 0,
    // Cast resin: a clear coat over a pigmented, slightly translucent body.
    // A near-mirror clearcoat put a blown highlight across whole faces and hid
    // the very numbers the reveal is meant to show; this spreads it out.
    clearcoat: 0.62,
    clearcoatRoughness: 0.26,
    sheen: 0.2,
    sheenRoughness: 0.4,
    envMapIntensity: 1.1,
    normalScale: new THREE.Vector2(0.85, 0.85),
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FLAKE_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FLAKE_VERTEX}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FLAKE_FRAGMENT_PARS}`)
      .replace('#include <opaque_fragment>', `${FLAKE_FRAGMENT}\n#include <opaque_fragment>`);
  };

  return {
    material,
    setFlakes(next) {
      Object.assign(flakes, next);
      uniforms.uFlakeStrength.value = flakes.strength;
      uniforms.uFlakeDensity.value = flakes.density;
      uniforms.uFlakeSpread.value = flakes.spread;
      uniforms.uFlakePolish.value = flakes.polish;
      uniforms.uFlakeCoverage.value = flakes.coverage;
      uniforms.uFlakeTint.value = flakes.tint;
      uniforms.uFlakeContrast.value = flakes.contrast;
      uniforms.uFlakeGrain.value = flakes.grain;
    },
    getFlakes: () => ({ ...flakes }),
  };
}

const FLAKE_VERTEX_PARS = /* glsl */ `
varying vec3 vFlakePosition;
varying vec3 vFlakeTangent;
`;

const FLAKE_VERTEX = /* glsl */ `
vFlakePosition = transformed;
// A tangent picked off the object-space normal and then carried into world
// space, so the frame a flake tilts in turns with the die rather than with the
// camera. The dice carry per-face normals, so this is constant across a face.
vec3 flakeRef = abs(objectNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
vFlakeTangent = mat3(modelMatrix) * normalize(cross(flakeRef, objectNormal));
`;

const FLAKE_FRAGMENT_PARS = /* glsl */ `
varying vec3 vFlakePosition;
varying vec3 vFlakeTangent;
uniform float uFlakeStrength;
uniform float uFlakeDensity;
uniform float uFlakeSpread;
uniform float uFlakePolish;
uniform float uFlakeCoverage;
uniform float uFlakeTint;
uniform float uFlakeContrast;
uniform float uFlakeGrain;

/**
 * How many lattice cells one pixel step covers, along whichever screen axis is
 * worse. This is what picks the mip level below, so it has to be the real
 * number: fwidth() sums both derivatives across all three components and comes
 * out around twice the true footprint, which would coarsen the lattice a whole
 * level too early and double the size of every speck.
 */
float flakeFootprint(vec3 p) {
  return max(length(dFdx(p)), length(dFdy(p)));
}

vec4 flakeHash(vec3 cell) {
  vec4 p = vec4(
    dot(cell, vec3(127.1, 311.7, 74.7)),
    dot(cell, vec3(269.5, 183.3, 246.1)),
    dot(cell, vec3(113.5, 271.9, 124.6)),
    dot(cell, vec3(57.3, 88.1, 191.7))
  );
  return fract(sin(p) * 43758.5453123);
}
`;

const FLAKE_FRAGMENT = /* glsl */ `
#ifdef USE_ENVMAP
if (uFlakeStrength > 0.0) {
  // The lattice rides in the die's object space and the room the flakes reflect
  // is fixed in world space, so the flake frame is built in world space. Only
  // the final lookup drops into view space, which is what getIBLRadiance wants.
  vec3 flakeN = transformDirectionByInverseViewMatrix(normal, viewMatrix);
  vec3 viewDirView = normalize(vViewPosition);
  vec3 viewDirWorld = transformDirectionByInverseViewMatrix(viewDirView, viewMatrix);
  vec3 flakeT = normalize(vFlakeTangent - flakeN * dot(flakeN, vFlakeTangent));
  vec3 flakeB = cross(flakeN, flakeT);

  // Real flakes are far finer than a pixel, and a flake finer than a pixel
  // cannot be point-sampled without turning the sparkle into crawling noise.
  // Fading them out was the first answer and it was the wrong one: it made the
  // dice go flat exactly when they were small, and it capped how fine the
  // flakes could ever be, because anything finer simply faded away.
  //
  // So the lattice is mip-mapped instead. It coarsens by powers of two until a
  // cell is about uFlakeGrain pixels across, and cross-fades between the two
  // levels either side. Up close you get the flake size the paint actually has;
  // further away you get the same speck size on screen drawn from a coarser
  // lattice, which is a fair sample of the same distribution rather than a blur
  // of it — so the dice stay sparkly at any distance instead of dulling off.
  vec3 base = vFlakePosition * uFlakeDensity;
  float lod = max(0.0, log2(max(flakeFootprint(base) * uFlakeGrain, 1e-6)));
  float coarse = floor(lod);
  float blend = lod - coarse;

  // The two levels get different skews so neither reads as a cubic grid sliced
  // flat by a die face, which is what a single axis-aligned lattice looks like.
  mat3 skewA = mat3(0.80, 0.42, -0.43, -0.53, 0.83, -0.18, 0.28, 0.36, 0.89);
  mat3 skewB = mat3(0.36, -0.80, 0.48, 0.87, 0.47, 0.13, -0.33, 0.37, 0.87);
  vec3 pA = skewA * base * exp2(-coarse);
  vec3 pB = skewB * base * exp2(-coarse - 1.0);

  vec3 sparkle = vec3(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float fade = layer == 0 ? 1.0 - blend : blend;
    if (fade <= 0.0) continue;

    vec3 cell = floor(layer == 0 ? pA : pB);
    vec4 h = flakeHash(cell);
    if (h.w > uFlakeCoverage) continue;

    // Tilt in the tangent plane, rejected to a disc: a square of tilts leaves a
    // faint cross-hatch in the highlight distribution.
    vec2 tilt = h.xy * 2.0 - 1.0;
    if (dot(tilt, tilt) > 1.0) continue;

    vec3 flakeNormal = normalize(flakeN + (tilt.x * flakeT + tilt.y * flakeB) * uFlakeSpread);
    // Flakes differ in how well they are polished, but only a little: a flake
    // given several times the roughness reflects a blur of the whole room and
    // sits there softly lit whichever way the die turns, which is the opposite
    // of a glint.
    float polish = uFlakePolish * mix(1.0, 3.0, h.z);
    vec3 radiance = getIBLRadiance(viewDirView, transformDirection(flakeNormal, viewMatrix), polish);
    // A mirror either catches a light or it does not, and the environment's own
    // range is too gentle to say so. Weighting each flake by its own brightness
    // separates the two: the shell-facing majority drop away and the few that
    // found a panel keep their level, up past 1.0 where the bloom pass is
    // waiting for them.
    //
    // Normalised against the key panel's radiance so that contrast redistributes
    // rather than amplifies — a flake already as bright as the key is left alone
    // whatever the setting, so strength and contrast can be tuned apart.
    float lum = max(dot(radiance, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    radiance *= pow(lum / 3.0, uFlakeContrast - 1.0);
    sparkle += radiance * fade;
  }

  // Seen through a clear coat, so flakes fire harder at glancing angles.
  float grazing = 1.0 - clamp(dot(flakeN, viewDirWorld), 0.0, 1.0);
  float fresnel = 0.45 + 0.55 * pow(grazing, 2.5);

  // Aluminium is neutral, but letting a little of the die's own colour through
  // keeps the sparkle sitting in the resin rather than on top of it.
  vec3 flakeColor = mix(vec3(1.0), diffuseColor.rgb * 2.0, uFlakeTint);

  outgoingLight += sparkle * flakeColor * fresnel * uFlakeStrength;
}
#endif
`;
