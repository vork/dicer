import * as THREE from 'three';

/**
 * GT7 Tone Mapping, installed as three's `CustomToneMapping`.
 *
 * Transcribed from the MIT-licensed reference implementation in Polyphony
 * Digital's 2025 SIGGRAPH course notes, "Physically Based Tone Mapping in GT7"
 * (Copyright (c) 2025 Polyphony Digital Inc.).
 *
 * This is not the GT curve of 2017, which is a per-channel operator. Per-channel
 * curves clip one channel before the others, so a saturated highlight does not
 * fade toward white, it slides toward whichever primary survives longest — a warm
 * glint measured here goes from 32 degrees of hue to 60, which is pure yellow.
 * GT7 moved to colour volume mapping to avoid exactly that.
 *
 * It runs the per-channel curve anyway, to get a deliberately twisted result,
 * then converts both the original and the twisted colour into a uniform colour
 * space, keeps the luminance of the twisted one and the chroma of the original,
 * fades that chroma out as luminance approaches the display peak, and blends the
 * two back in RGB. The blend is the whole idea: pure untwisted reads synthetic,
 * pure twisted is a camera, and 0.6 of the way is what they shipped.
 *
 * Why it is worth the trouble on a tray of dice: this scene is made of tinted
 * specular — metallic flake glints and a warm key on polished resin — and that is
 * precisely what a per-channel operator bleaches. Measured on a warm glint at the
 * brightness the scene actually reaches, GT7 holds saturation 0.51 where ACES
 * holds 0.15 and Khronos PBR Neutral holds 0.32, with hue unmoved.
 *
 * The cost is real: two colour space round trips through a PQ curve, so nine
 * transcendental-heavy conversions per pixel in one fullscreen pass.
 */

/** sRGB primaries to Rec.2020, both linear. GT7 works in Rec.2020. */
const REC709_TO_REC2020 = 'mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0114, 0.8956)';
const REC2020_TO_REC709 = 'mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187)';

/**
 * In GT, 1.0 in the linear frame buffer is 100 cd/m^2, and SDR paper white is
 * taken as 250 — so the curve maps up to 2.5 and the result is scaled back down
 * by 0.4 to land in sRGB's 0..1.
 */
const PAPER_WHITE = 2.5;

const GT7 = /* glsl */`
  const float GT7_M1 = 0.1593017578125;
  const float GT7_M2 = 78.84375;
  const float GT7_C1 = 0.8359375;
  const float GT7_C2 = 18.8515625;
  const float GT7_C3 = 18.6875;
  // 10000 cd/m^2 is the range PQ covers; 100 is what 1.0 in the frame buffer means.
  const float GT7_PQ_SCALE = 100.0;
  const float GT7_PEAK = ${PAPER_WHITE.toFixed(1)};
  // gt7ToICtCp(vec3(GT7_PEAK)).x, worked out once in tools/tonemap-curves.py.
  const float GT7_PEAK_UCS = 0.60255915;

  float gt7InversePQ(float v) {
    float y = max(v * GT7_PQ_SCALE, 0.0) / 10000.0;
    float ym = pow(y, GT7_M1);
    return exp2(GT7_M2 * (log2(GT7_C1 + GT7_C2 * ym) - log2(1.0 + GT7_C3 * ym)));
  }

  float gt7PQ(float n) {
    n = clamp(n, 0.0, 1.0);
    float np = pow(n, 1.0 / GT7_M2);
    float l = max(np - GT7_C1, 0.0) / (GT7_C2 - GT7_C3 * np);
    return pow(l, 1.0 / GT7_M1) * 10000.0 / GT7_PQ_SCALE;
  }

  // ICtCp, the uniform colour space GT7 uses: two matrices around a PQ curve.
  vec3 gt7ToICtCp(vec3 rgb) {
    float l = dot(rgb, vec3(1688.0, 2146.0, 262.0)) / 4096.0;
    float m = dot(rgb, vec3(683.0, 2951.0, 462.0)) / 4096.0;
    float s = dot(rgb, vec3(99.0, 309.0, 3688.0)) / 4096.0;
    float lp = gt7InversePQ(l);
    float mp = gt7InversePQ(m);
    float sp = gt7InversePQ(s);
    return vec3(
      (2048.0 * lp + 2048.0 * mp) / 4096.0,
      (6610.0 * lp - 13613.0 * mp + 7003.0 * sp) / 4096.0,
      (17933.0 * lp - 17390.0 * mp - 543.0 * sp) / 4096.0
    );
  }

  vec3 gt7FromICtCp(vec3 ictcp) {
    float l = gt7PQ(ictcp.x + 0.00860904 * ictcp.y + 0.11103 * ictcp.z);
    float m = gt7PQ(ictcp.x - 0.00860904 * ictcp.y - 0.11103 * ictcp.z);
    float s = gt7PQ(ictcp.x + 0.560031 * ictcp.y - 0.320627 * ictcp.z);
    return max(vec3(
      3.43661 * l - 2.50645 * m + 0.0698454 * s,
      -0.79133 * l + 1.9836 * m - 0.192271 * s,
      -0.0259499 * l - 0.0989137 * m + 1.12486 * s
    ), 0.0);
  }

  // The GT curve with a convergent shoulder. The 2017 one never reached its peak,
  // which left the output range ill-defined; this one is bounded by construction.
  float gt7Curve(float x) {
    const float alpha = 0.25;
    const float midPoint = 0.538;
    const float linearSection = 0.444;
    const float toeStrength = 1.280;
    const float k = (linearSection - 1.0) / (alpha - 1.0);
    const float kA = GT7_PEAK * linearSection + GT7_PEAK * k;
    const float kB = -GT7_PEAK * k * exp(linearSection / k);
    const float kC = -1.0 / (k * GT7_PEAK);
    if (x < 0.0) return 0.0;
    if (x < linearSection * GT7_PEAK) {
      float weightLinear = smoothstep(0.0, midPoint, x);
      float toeMapped = midPoint * pow(max(x, 1e-8) / midPoint, toeStrength);
      return (1.0 - weightLinear) * toeMapped + weightLinear * x;
    }
    return kA + kB * exp(x * kC);
  }

  vec3 CustomToneMapping(vec3 color) {
    color *= toneMappingExposure;
    vec3 rgb = ${REC709_TO_REC2020} * max(color, 0.0);

    vec3 ucs = gt7ToICtCp(rgb);
    // The per-channel pass, kept for its hue twist rather than in spite of it.
    vec3 skewed = vec3(gt7Curve(rgb.r), gt7Curve(rgb.g), gt7Curve(rgb.b));
    vec3 skewedUcs = gt7ToICtCp(skewed);

    // Chroma is faded out as luminance approaches the display peak, because a
    // highlight at the peak really is white. The peak's own UCS luminance is a
    // constant, so it is one here rather than three more PQ evaluations a pixel.
    float chromaScale = 1.0 - smoothstep(0.98, 1.16, ucs.x / GT7_PEAK_UCS);
    // Luminance from the twisted colour, chroma from the untwisted one.
    vec3 scaled = gt7FromICtCp(vec3(skewedUcs.x, ucs.yz * chromaScale));

    const float blendRatio = 0.6;
    vec3 blended = min(mix(skewed, scaled, blendRatio), GT7_PEAK) / GT7_PEAK;
    return clamp(${REC2020_TO_REC709} * blended, 0.0, 1.0);
  }
`;

let installed = false;

/**
 * Must be called before anything that tone maps is compiled. three resolves
 * `#include` at compile time and then caches the program against the material's
 * own source, which does not change when a chunk is swapped underneath it — so a
 * chunk replaced after the first compile is silently ignored.
 */
export function installGT7ToneMapping() {
  if (installed) return;
  installed = true;
  const stub = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (!chunk.includes(stub)) {
    throw new Error('three no longer ships the CustomToneMapping stub that GT7 replaces');
  }
  THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(stub, GT7);
}
