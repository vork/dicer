import * as THREE from 'three';

/**
 * A micro detail layer for a textured material: a small seamless tile laid
 * under the material's maps at a fixed physical size, adding grain finer than
 * any atlas holds — the felt's fibres, the leather's pebbles, the wood's pores.
 *
 * The tile carries height slopes in red and green (per world unit, about half
 * grey, clamped at DETAIL_SLOPE_MAX), a roughness variation in blue and a tone
 * variation in alpha, both about half grey so the material's own values are
 * the mean. Baked by tools/build-detail.mjs.
 *
 * Three has no such slot, so the material's shader is patched the way the
 * coin's is: the tile is sampled once, ahead of the colour, roughness and
 * normal chunks, and each takes its part. The normal is tilted in the tangent
 * frame three has already built for the material's own normal map, which is
 * what keeps the two in the same handedness. Its mip chain fades the tilt out
 * with distance on its own — averaged normals flatten — so the far tray shows
 * no shimmer, and the roughness and tone variations are kept small enough not
 * to need a fade of their own.
 */
export const DETAIL_SLOPE_MAX = 1.0;

export interface DetailOptions {
  map: THREE.Texture;
  /** Detail tiles per tile of the material's diffuse map. */
  scale: number;
  /** Multiplier on the tile's slopes. */
  bump: number;
  /** Multiplier on the tile's roughness variation. */
  rough: number;
  /** Multiplier on the tile's tone variation. */
  tint: number;
}

export interface DetailLayer {
  setEnabled(enabled: boolean): void;
  setScale(scale: number): void;
}

const PARS = /* glsl */ `
uniform sampler2D uDetailMap;
uniform float uDetailScale;
uniform float uDetailBump;
uniform float uDetailRough;
uniform float uDetailTint;
`;

export function addDetailLayer(material: THREE.MeshPhysicalMaterial, options: DetailOptions): DetailLayer {
  const uniforms = {
    uDetailMap: { value: options.map },
    uDetailScale: { value: options.scale },
    uDetailBump: { value: options.bump },
    uDetailRough: { value: options.rough },
    uDetailTint: { value: options.tint },
  };
  let enabled = true;

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n#define DETAIL_SLOPE_MAX ${DETAIL_SLOPE_MAX.toFixed(2)}\n${PARS}`)
      // Sampled once, in the diffuse map's UV space scaled to the tile's size.
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_DETAIL
  vec4 detailTexel = texture2D(uDetailMap, vMapUv * uDetailScale);
#endif
#include <map_fragment>
#ifdef USE_DETAIL
  diffuseColor.rgb *= mix(1.0, detailTexel.a * 2.0, uDetailTint);
#endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
#ifdef USE_DETAIL
  roughnessFactor = clamp(roughnessFactor + (detailTexel.b - 0.5) * uDetailRough, 0.04, 1.0);
#endif`,
      )
      // For a height h over tangents T and B, the normal is N - h_u T - h_v B.
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
#ifdef USE_DETAIL
  {
    vec2 detailSlope = (detailTexel.rg * 2.0 - 1.0) * DETAIL_SLOPE_MAX * uDetailBump;
    normal = normalize(normal - tbn[0] * detailSlope.x - tbn[1] * detailSlope.y);
  }
#endif`,
      );
  };
  const key = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${key ? key.call(material) : ''}-detail-${enabled ? 'on' : 'off'}`;
  material.defines = { ...material.defines, USE_DETAIL: '' };
  material.needsUpdate = true;

  return {
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      const defines = { ...material.defines };
      if (enabled) defines.USE_DETAIL = '';
      else delete defines.USE_DETAIL;
      material.defines = defines;
      material.needsUpdate = true;
    },
    setScale(scale) {
      uniforms.uDetailScale.value = scale;
    },
  };
}
