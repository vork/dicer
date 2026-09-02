import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * Final grade, run after tone mapping so it works in display space: radial
 * chromatic aberration, a heavy vignette, split toning and animated grain.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 1.15 },
    uGrain: { value: 0.05 },
    uAberration: { value: 0.0016 },
    /** Rises during a reveal to pull the eye to the centre. */
    uFocus: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform vec2 uResolution;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uFocus;
    varying vec2 vUv;

    // Hoskins hash: cheap, and free of the axis-aligned banding a two-term
    // sin/fract hash produces at low amplitude over a near-black frame.
    float hash(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }

    void main() {
      vec2 centred = vUv - 0.5;
      // Correct for aspect so the vignette stays circular, not stretched.
      vec2 scaled = vec2(centred.x * uAspect, centred.y);
      float r = length(scaled) / length(vec2(uAspect, 1.0) * 0.5);

      // Lateral chromatic aberration grows with the square of the radius, the way
      // a real lens does, so the centre stays clean.
      float shift = uAberration * r * r * (1.0 + uFocus * 1.6);
      vec2 direction = centred * shift;
      vec3 color;
      color.r = texture2D(tDiffuse, vUv - direction).r;
      color.g = texture2D(tDiffuse, vUv).g;
      color.b = texture2D(tDiffuse, vUv + direction).b;

      // Vignette: a wide soft falloff plus a harder edge crush.
      float vignette = smoothstep(1.06, 0.16, r);
      vignette = pow(vignette, uVignette + uFocus * 1.1);
      color *= mix(1.0, vignette, 0.94);

      // Split tone: cool the shadows, warm the highlights.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(color * vec3(0.90, 0.96, 1.12), color * vec3(1.06, 1.00, 0.93), smoothstep(0.12, 0.75, luma));
      // Gentle S-curve for contrast without clipping.
      color = clamp(color, 0.0, 1.0);
      color = color * color * (3.0 - 2.0 * color) * 0.34 + color * 0.66;

      // Grain, weighted into the shadows where a sensor actually shows it.
      float grain = hash(vUv * uResolution + fract(uTime) * 137.0) - 0.5;
      color += grain * uGrain * (1.25 - luma);

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export interface PostFx {
  setSize(width: number, height: number, pixelRatio: number): void;
  render(delta: number): void;
  /** 0 = neutral, 1 = tightened for the reveal. */
  setFocus(value: number): void;
  /** Exposed for tuning from the headless shooter. */
  setBloom(strength: number, radius: number, threshold: number): void;
  /**
   * Film grain amount. Exposed so a test can silence it: the grain is reseeded
   * every frame, so any measurement of what changed between two frames is
   * otherwise measuring the grain and nothing else.
   */
  setGrain(amount: number): void;
  dispose(): void;
}

export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFx {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Bloom is here for atmosphere, not for glow. It used to start at 0.95, which
  // in linear HDR is below what a clearcoat highlight on a die reaches, so whole
  // corners of a die bloomed into a soft white blob and took the numerals with
  // them. Starting above 1.0 confines it to genuinely blown highlights — the
  // flake glints, the hot edge of the pool of light — and a shorter radius keeps
  // what does bloom tight enough to still read as a highlight.
  const bloom = new UnrealBloomPass(size, 0.26, 0.55, 1.08);
  composer.addPass(bloom);

  composer.addPass(new OutputPass());

  const grade = new ShaderPass(GradeShader);
  grade.renderToScreen = true;
  composer.addPass(grade);

  let time = 0;

  return {
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      bloom.setSize(width, height);
      grade.uniforms.uAspect.value = width / height;
      grade.uniforms.uResolution.value.set(width, height);
    },
    render(delta) {
      time += delta;
      grade.uniforms.uTime.value = time;
      composer.render(delta);
    },
    setFocus(value) {
      grade.uniforms.uFocus.value = value;
    },
    setBloom(strength, radius, threshold) {
      bloom.strength = strength;
      bloom.radius = radius;
      bloom.threshold = threshold;
    },
    setGrain(amount) {
      grade.uniforms.uGrain.value = amount;
    },
    dispose() {
      bloom.dispose();
      composer.dispose();
    },
  };
}
