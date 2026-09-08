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

/**
 * Per-pixel screen-space velocity, written by re-rendering the scene with every
 * material swapped for this one.
 *
 * Each vertex is projected twice — once with this frame's model and camera
 * matrices, once with last frame's — and the difference between the two, in UV
 * units, is the distance that point travelled across the screen since the last
 * frame. That is the exposure: a shutter open for the frame smears each point
 * along exactly this vector.
 *
 * Doing it from matrices rather than from a velocity guess means it is right for
 * both kinds of motion at once. A tumbling die moves because its own transform
 * changed; the tray moves because the camera did; a die that is both falling and
 * being tracked gets the sum, with the rotation about its own centre included,
 * which is most of what a thrown die is doing.
 */
const VelocityShader = {
  uniforms: {
    uPreviousModelMatrix: { value: new THREE.Matrix4() },
    uPreviousViewProjection: { value: new THREE.Matrix4() },
  },
  vertexShader: /* glsl */ `
    uniform mat4 uPreviousModelMatrix;
    uniform mat4 uPreviousViewProjection;
    varying vec4 vCurrent;
    varying vec4 vPrevious;
    void main() {
      vec4 local = vec4(position, 1.0);
      vCurrent = projectionMatrix * viewMatrix * modelMatrix * local;
      vPrevious = uPreviousViewProjection * uPreviousModelMatrix * local;
      gl_Position = vCurrent;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec4 vCurrent;
    varying vec4 vPrevious;
    void main() {
      // Nothing behind the camera has a screen velocity worth the name, and the
      // divide below is meaningless once w goes non-positive. The ground plane is
      // 140 units across against a camera 18 up and 17 back, so its triangles
      // cross the camera plane every frame — interpolating across one of those
      // produced velocities of nearly two screen widths, which then won every
      // neighbourhood in the blur and smeared frames in which nothing had moved.
      if (vCurrent.w <= 0.0001 || vPrevious.w <= 0.0001) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      // Perspective divide has to happen here rather than in the vertex shader:
      // interpolating a divided value across a triangle is not the same as
      // dividing the interpolated one, and at these angles the difference shows.
      vec2 here = vCurrent.xy / vCurrent.w;
      vec2 before = vPrevious.xy / vPrevious.w;
      // Clip space spans -1..1 and UV spans 0..1, so halve it.
      vec2 velocity = (here - before) * 0.5;
      // Belt and braces against anything else pathological reaching the blur,
      // where a single bad texel is picked up by every neighbourhood around it.
      float length2 = dot(velocity, velocity);
      if (length2 > 0.35 * 0.35) velocity *= 0.35 / sqrt(length2);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
  `,
};

/**
 * Motion blur: for each pixel, average the frame along the direction that pixel
 * moved, over the length it travelled while the shutter was open.
 *
 * The length is whatever actually happened between the last two frames, and the
 * shutter on top of it opens wider as frames get longer, so a slow frame rate is
 * blurred more than proportionally. See SHUTTER for why.
 */
const MotionBlurShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tVelocity: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    /**
     * How much of the frame interval the shutter is open. Set per frame from how
     * long the frames are actually taking — see SHUTTER below.
     */
    uShutter: { value: 0.5 },
    /** Hard ceiling on the smear, in pixels, so a dropped frame cannot streak. */
    uMaxPixels: { value: 48 },
    /** Master amount. Falls to zero for the reveal, where legibility wins. */
    uAmount: { value: 1 },
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
    uniform sampler2D tVelocity;
    uniform vec2 uResolution;
    uniform float uShutter;
    uniform float uMaxPixels;
    uniform float uAmount;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }

    const int TAPS = 11;

    void main() {
      vec4 here = texture2D(tDiffuse, vUv);
      if (uAmount <= 0.001) {
        gl_FragColor = here;
        return;
      }

      // Look for something whose smear reaches this pixel, not just this pixel's
      // own velocity.
      //
      // A pixel just outside a moving die has no velocity of its own, so taking
      // it literally blurs the die within its own silhouette and leaves a hard
      // edge around the smear, which looks worse than no blur at all. The search
      // has to reach as far as the longest smear can travel — half of it, since
      // the exposure is centred — or a long smear is simply clipped back to the
      // outline. Measured: a 35px exposure came out 21px when this reached only
      // three pixels, and the shortfall grew with the length.
      //
      // A point is only allowed to claim this pixel if its own smear actually
      // covers the distance, which is what keeps the reach from dragging a fast
      // die's velocity onto scenery it never passed over.
      float open = uShutter * uAmount;
      vec2 velocity = texture2D(tVelocity, vUv).xy;
      float longest = length(velocity * uResolution) * open;
      float reach = uMaxPixels * 0.5;
      for (int i = 0; i < 12; i++) {
        // Golden angle, so twelve samples spread evenly over the disc rather than
        // lining up into spokes.
        float turn = float(i) * 2.399963;
        float radius = reach * sqrt((float(i) + 0.5) / 12.0);
        vec2 away = vec2(cos(turn), sin(turn)) * radius;
        vec2 found = texture2D(tVelocity, vUv + away / uResolution).xy;
        float smear = length(found * uResolution) * open;
        if (smear * 0.5 >= radius && smear > longest) {
          longest = smear;
          velocity = found;
        }
      }

      vec2 offset = velocity * open;
      float pixels = length(offset * uResolution);
      // Below about a pixel there is nothing to average, and sampling anyway just
      // costs a little sharpness on a scene that is barely moving.
      if (pixels < 0.75) {
        gl_FragColor = here;
        return;
      }
      offset *= min(1.0, uMaxPixels / pixels);

      // Dither the sample positions. Eleven taps across a long smear would
      // otherwise land as eleven distinct ghosts rather than one streak.
      float jitter = hash(vUv * uResolution) - 0.5;
      vec4 sum = vec4(0.0);
      for (int i = 0; i < TAPS; i++) {
        float t = (float(i) + jitter) / float(TAPS - 1) - 0.5;
        sum += texture2D(tDiffuse, vUv + offset * t);
      }
      gl_FragColor = sum / float(TAPS);
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
  /**
   * Motion blur strength, 1 being the shutter as configured. Exposed so a test
   * can turn it off and compare, and so the reveal can stand it down.
   */
  setMotionBlur(amount: number): void;
  /**
   * What the buffers the scene is drawn into are actually backed by. The
   * renderer's own `antialias` flag says nothing useful once a composer is in the
   * chain — it was true while the picture had no antialiasing at all — so this
   * reports both the setting and whether a multisampled frame buffer was really
   * allocated for it.
   */
  samplesReport(): { samples: number; multisampledFrameBuffer: boolean }[];
  /** How far the shutter is currently open, which follows the frame rate. */
  shutter(): number;
  /** The velocity buffer, for a test to inspect what the blur is working from. */
  readVelocity(): { width: number; height: number; data: Float32Array };
  dispose(): void;
}

export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFx {
/**
 * How wide to open the shutter, given how long the frames are taking.
 *
 * A fixed shutter makes the smear strictly proportional to the distance covered,
 * which sounds right and is not quite. What the eye reads as judder is the gap
 * left *unexposed* between one frame's smear and the next one's, and with a fixed
 * shutter that gap stays a fixed fraction of the step — so at 30fps it is twice as
 * many pixels as at 60, and the throw still stutters more at the lower rate.
 *
 * Holding that gap constant instead is what makes the two look alike:
 *
 *   (1 - shutter) * delta = (1 - BASE) * REFERENCE
 *
 * which is the formula below. At 60fps it gives the 0.5 of a film camera's
 * 180-degree shutter; at 30 it gives 0.75, at 15 it gives 0.88, and the smear
 * comes out three times longer at 30fps than at 60 for the same die — twice the
 * ground to cover, and a larger share of it covered. Above 60 it tapers off to a
 * trace, because up there the gap is already smaller than the one being held.
 */
const SHUTTER = {
  /** The frame rate the look is pinned to. */
  REFERENCE: 1 / 60,
  /** The shutter at that rate. */
  BASE: 0.5,
  /** Never quite nothing, and never the whole frame. */
  LEAST: 0.15,
  MOST: 0.95,
  /**
   * How quickly the shutter follows a change of frame rate. A rate is a rate and
   * not one interval, so this tracks the sustained one: a lone hitched frame is
   * already handled by the smear being as long as that frame's own displacement,
   * and letting it swing the shutter as well would show up as a flash of smear.
   */
  FOLLOW: 0.2,
};

  const size = renderer.getSize(new THREE.Vector2());

  // Multisampled, which the composer's own buffer is not.
  //
  // `antialias: true` on the renderer only ever applies to the default frame
  // buffer, and with a composer in the chain nothing is drawn there — every pass
  // writes into these targets and the last one blits to the screen. So the
  // renderer dutifully allocated a 4x multisampled frame buffer that was never
  // drawn to, while the actual picture had no antialiasing at all: measured over
  // a settled frame, 52% of its high-contrast edges moved in a single pixel.
  //
  // EffectComposer takes a target to use instead of building its own, and clones
  // it for the second buffer, carrying `samples` across. Only the geometry pass
  // needs it — everything after runs on the resolved texture.
  const multisampled = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, multisampled);
  composer.addPass(new RenderPass(scene, camera));

  // Velocity is signed and often far below a 255th, so it needs a float target;
  // an 8-bit one would quantise every slow movement to zero. Half resolution is
  // plenty — it feeds the length and direction of a blur, not an edge.
  const velocityTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  const velocityMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(VelocityShader.uniforms),
    vertexShader: VelocityShader.vertexShader,
    fragmentShader: VelocityShader.fragmentShader,
  });
  const previousViewProjection = new THREE.Matrix4();
  const currentViewProjection = new THREE.Matrix4();
  const viewMatrix = new THREE.Matrix4();
  const clearColour = new THREE.Color();
  let havePreviousFrame = false;

  // Each object hands the velocity material its own last-frame transform as it is
  // drawn. Anything that has not been given one has not moved, so its current
  // transform stands in and it comes out with only the camera's motion on it.
  const hook = (object: THREE.Object3D) => {
    // Meshes only. The scene itself has an onBeforeRender of its own with a
    // different signature — its fifth argument is the render target, not a
    // material — so hooking the root throws on the first frame.
    if (object.userData.velocityHooked || !(object as THREE.Mesh).isMesh) return;
    object.userData.velocityHooked = true;
    object.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
      const shader = material as THREE.ShaderMaterial | undefined;
      const uniforms = shader?.uniforms;
      if (!shader || !uniforms?.uPreviousModelMatrix) return;
      const previous = object.userData.previousMatrixWorld as THREE.Matrix4 | undefined;
      uniforms.uPreviousModelMatrix.value.copy(previous ?? object.matrixWorld);
      // Without this the uniform is uploaded once for the whole pass rather than
      // once per object, and every mesh after the first is drawn holding the
      // first one's transform — so everything on screen came out with a velocity
      // of whatever the difference between it and that first mesh happened to be.
      // This flag exists for exactly this: changing uniforms from onBeforeRender.
      shader.uniformsNeedUpdate = true;
    };
  };

  const motionBlur = new ShaderPass(MotionBlurShader);
  motionBlur.uniforms.tVelocity.value = velocityTarget.texture;
  composer.addPass(motionBlur);

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
  // Seeded at the reference rate so the first frames of a session are not blurred
  // as if the whole app were running slowly.
  let smoothedDelta = SHUTTER.REFERENCE;

  return {
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      bloom.setSize(width, height);
      grade.uniforms.uAspect.value = width / height;
      grade.uniforms.uResolution.value.set(width, height);
      const pixels = new THREE.Vector2(width * pixelRatio, height * pixelRatio);
      velocityTarget.setSize(Math.max(1, Math.round(pixels.x / 2)), Math.max(1, Math.round(pixels.y / 2)));
      motionBlur.uniforms.uResolution.value.copy(pixels);
      // A ceiling set as a share of the frame rather than a pixel count, so the
      // longest smear is the same gesture on a phone as on a desktop.
      motionBlur.uniforms.uMaxPixels.value = pixels.y * 0.05;
    },
    render(delta) {
      time += delta;
      grade.uniforms.uTime.value = time;

      // Follow the sustained frame rate, and open the shutter to hold the gap
      // between one frame's exposure and the next at what it is at 60fps.
      if (delta > 0) {
        const follow = Math.min(1, delta / SHUTTER.FOLLOW);
        smoothedDelta += (delta - smoothedDelta) * follow;
      }
      motionBlur.uniforms.uShutter.value = Math.min(
        SHUTTER.MOST,
        Math.max(SHUTTER.LEAST, 1 - ((1 - SHUTTER.BASE) * SHUTTER.REFERENCE) / smoothedDelta),
      );

      // Velocity first, into its own target, before the composer touches the
      // frame — the blur pass needs it in hand by the time it runs.
      // Inverted here rather than read from camera.matrixWorldInverse, which the
      // renderer only refreshes inside its own render() — taking it as it stands
      // would compare this frame's geometry against a view matrix one frame old,
      // and put a velocity on every static thing in the scene.
      camera.updateMatrixWorld();
      viewMatrix.copy(camera.matrixWorld).invert();
      currentViewProjection.multiplyMatrices(camera.projectionMatrix, viewMatrix);
      if (!havePreviousFrame) previousViewProjection.copy(currentViewProjection);
      velocityMaterial.uniforms.uPreviousViewProjection.value.copy(previousViewProjection);

      scene.traverse(hook);
      const background = scene.background;
      const shadowsAuto = renderer.shadowMap.autoUpdate;
      // The background is not a material and would otherwise be painted straight
      // into the velocity buffer as if it were a velocity. Shadow maps are turned
      // off for the same reason they are turned off in any depth-only pass: this
      // render cannot see them, and the composer's render is about to redo them.
      scene.background = null;
      renderer.shadowMap.autoUpdate = false;
      scene.overrideMaterial = velocityMaterial;
      const previousTarget = renderer.getRenderTarget();
      // The clear colour is the renderer's, not this pass's, so it has to go back
      // — leaving it set to transparent black would hand the next render a
      // background it never asked for.
      renderer.getClearColor(clearColour);
      const clearAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(velocityTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(clearColour, clearAlpha);
      scene.overrideMaterial = null;
      renderer.shadowMap.autoUpdate = shadowsAuto;
      scene.background = background;

      composer.render(delta);

      previousViewProjection.copy(currentViewProjection);
      havePreviousFrame = true;
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
    setMotionBlur(amount) {
      motionBlur.uniforms.uAmount.value = amount;
    },
    samplesReport() {
      const properties = (renderer as unknown as { properties: { get(o: object): Record<string, unknown> } }).properties;
      return [composer.renderTarget1, composer.renderTarget2].map((target) => ({
        samples: target.samples,
        multisampledFrameBuffer: Boolean(properties.get(target).__webglMultisampledFramebuffer),
      }));
    },
    shutter() {
      return motionBlur.uniforms.uShutter.value as number;
    },
    readVelocity() {
      const { width, height } = velocityTarget;
      const raw = new Uint16Array(width * height * 4);
      renderer.readRenderTargetPixels(velocityTarget, 0, 0, width, height, raw);
      const data = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = THREE.DataUtils.fromHalfFloat(raw[i]);
      return { width, height, data };
    },
    dispose() {
      bloom.dispose();
      multisampled.dispose();
      velocityTarget.dispose();
      velocityMaterial.dispose();
      composer.dispose();
    },
  };
}
