/**
 * Quality tiers, and how a device ends up on one.
 *
 * The app was built as one pipeline for every GPU: a 4x multisampled half-float
 * frame at twice the CSS resolution, drawn twice (once for velocity), then blurred,
 * bloomed, tone mapped and graded in four more full-screen passes. On a desktop or
 * a recent phone that is fine; on an older phone it is a slideshow, because every
 * one of those passes is paid per pixel and a 3x phone has a lot of pixels.
 *
 * Measured on tools/bench.mjs, a rolling frame divides up roughly as: the scene
 * itself 53%, motion blur 19%, tone mapping 13%, bloom 9%, the grade 3%, the
 * velocity pass and the shadow map 2% each, and the solver under a millisecond.
 * Pixel count multiplies all of it, so the pixel ratio is the first lever and
 * the post chain is the second. The tiers pull them in that order:
 *
 *   high    the full look — pixel ratio up to 2, MSAA 4x, the whole chain
 *   medium  pixel ratio up to 1.5, half-resolution bloom, a lighter blur, plain
 *           shadows, no chromatic aberration, nothing blurred behind the HUD
 *   low     pixel ratio 1 and no post chain at all: the scene is drawn straight
 *           to the canvas with tone mapping in the materials, the vignette is a
 *           CSS overlay, shadows are 1024 texels, the coin's procedural
 *           weathering runs fewer octaves, and idle frames render at half rate
 *
 * A tier is chosen at start-up from a `?quality=` override, a tier remembered
 * from an earlier session, or a look at the GPU; after that a monitor watches
 * the sustained frame rate and steps down a tier when it stays low. It never
 * steps up on its own: a device that has proved slow once is slow.
 */

export type QualityTier = 'high' | 'medium' | 'low';

export const QUALITY_TIERS: readonly QualityTier[] = ['high', 'medium', 'low'];

export interface QualitySettings {
  tier: QualityTier;
  /** Ceiling on the device pixel ratio the scene is rendered at. */
  pixelRatio: number;
  /**
   * Whether the frame goes through the post chain (HDR buffer, motion blur,
   * bloom, grade). Off, the scene is drawn straight to the canvas.
   */
  post: boolean;
  /** MSAA samples on the post chain's scene buffer. */
  samples: number;
  motionBlur: boolean;
  /** Motion blur's samples along the smear, and around it looking for one. */
  blurTaps: number;
  blurSearch: number;
  bloom: boolean;
  /** Bloom's working resolution as a share of the CSS size. */
  bloomScale: number;
  /** Chromatic aberration costs two extra taps of the frame per pixel. */
  aberration: boolean;
  /** Shadow map size in texels; 0 lets the screen decide (4096 on a large one). */
  shadowMap: number;
  /** Percentage-closer soft shadows against plain 2x2 PCF. */
  softShadows: boolean;
  /** Anisotropic filtering on the dice and coin maps. */
  anisotropy: number;
  /** The coin shader's procedural detail: octaves of noise per pixel. */
  coinDetail: 'full' | 'lite';
  /** Frames skipped between rendered ones while nothing is moving. */
  idleFrameSkip: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: {
    tier: 'high',
    pixelRatio: 2,
    post: true,
    samples: 4,
    motionBlur: true,
    blurTaps: 11,
    blurSearch: 12,
    bloom: true,
    bloomScale: 1,
    aberration: true,
    shadowMap: 0,
    softShadows: true,
    anisotropy: 16,
    coinDetail: 'full',
    idleFrameSkip: 0,
  },
  medium: {
    tier: 'medium',
    pixelRatio: 1.5,
    post: true,
    samples: 4,
    motionBlur: true,
    blurTaps: 7,
    blurSearch: 8,
    bloom: true,
    bloomScale: 0.5,
    aberration: false,
    shadowMap: 2048,
    softShadows: false,
    anisotropy: 4,
    coinDetail: 'full',
    idleFrameSkip: 0,
  },
  low: {
    tier: 'low',
    pixelRatio: 1,
    post: false,
    samples: 0,
    motionBlur: false,
    blurTaps: 5,
    blurSearch: 4,
    bloom: false,
    bloomScale: 0.25,
    aberration: false,
    shadowMap: 1024,
    softShadows: false,
    anisotropy: 2,
    coinDetail: 'lite',
    idleFrameSkip: 1,
  },
};

const STORAGE_KEY = 'dicer.quality';

export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === 'string' && (QUALITY_TIERS as readonly string[]).includes(value);
}

/** The tier below, or the same one at the bottom. */
export function lowerTier(tier: QualityTier): QualityTier {
  const at = QUALITY_TIERS.indexOf(tier);
  return QUALITY_TIERS[Math.min(at + 1, QUALITY_TIERS.length - 1)];
}

export function rememberTier(tier: QualityTier | null) {
  try {
    if (tier) localStorage.setItem(STORAGE_KEY, tier);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode, or storage blocked: the tier is simply chosen again next time.
  }
}

function rememberedTier(): QualityTier | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isQualityTier(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Asks a throwaway context what the GPU is. Only the name is wanted; the
 * context is released straight away so the real one is not competing with it.
 */
export function describeGpu(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

/**
 * GPUs known to struggle with a full-screen HDR post chain at phone resolutions.
 * Deliberately a short list of the clearly weak: a device this misses starts a
 * tier too high and is stepped down by the monitor within a couple of seconds,
 * whereas a device this catches wrongly is stuck looking worse than it should.
 */
const WEAK_GPU =
  /Mali-4\d\d|Mali-T\d{3}|Mali-G(?:31|51|52|71)\b|Adreno \(TM\) [345]\d\d|Adreno \(TM\) 6[01]\d|PowerVR|Vivante|VideoCore|SwiftShader/i;

/** Desktop parts that cope with the chain, just not at 4K and 2x. */
const MODEST_GPU = /Intel\(R\) (?:HD|UHD) Graphics|Intel\(R\) Iris|Apple M1\b/i;

export interface QualityChoice {
  tier: QualityTier;
  /** Where the choice came from, for the debug hook and the console. */
  reason: string;
  /** An explicit `?quality=` pins the tier: no remembering, no stepping down. */
  pinned: boolean;
}

export function chooseQuality(search = window.location.search, gpu = describeGpu()): QualityChoice {
  const requested = new URLSearchParams(search).get('quality');
  if (isQualityTier(requested)) return { tier: requested, reason: 'url', pinned: true };

  const remembered = rememberedTier();
  if (remembered) return { tier: remembered, reason: 'remembered', pinned: false };

  const nav = navigator as Navigator & { deviceMemory?: number };
  const touch = window.matchMedia('(pointer: coarse)').matches || nav.maxTouchPoints > 0;
  const cores = nav.hardwareConcurrency ?? 0;
  const memory = nav.deviceMemory ?? 0;

  if (WEAK_GPU.test(gpu)) return { tier: 'low', reason: `gpu ${gpu}`, pinned: false };
  if (touch && ((cores > 0 && cores <= 4) || (memory > 0 && memory <= 3))) {
    return { tier: 'low', reason: `${cores} cores, ${memory || '?'} GB`, pinned: false };
  }
  if (MODEST_GPU.test(gpu)) return { tier: 'medium', reason: `gpu ${gpu}`, pinned: false };
  if (touch && memory > 0 && memory <= 4) return { tier: 'medium', reason: `${memory} GB`, pinned: false };
  return { tier: 'high', reason: gpu ? `gpu ${gpu}` : 'default', pinned: false };
}

/**
 * Watches the sustained frame rate and says when it has stayed too low.
 *
 * Works on a window of recent frame intervals, judged by their median so that
 * a lone hitch — a shader compiling, a tab coming back — cannot trip it. The
 * first frames after a change of tier are ignored altogether: every new program
 * compiles on its first draw, and those frames say nothing about the device.
 */
export class FrameRateMonitor {
  /** Frames ignored after a reset. */
  static readonly WARMUP = 90;
  /** Frames judged at a time. */
  static readonly WINDOW = 60;
  /** A median frame longer than this, in ms, is a device that cannot keep up. */
  static readonly LIMIT_MS = 1000 / 38;
  /** Anything this long is a stall, not a frame, and is left out. */
  static readonly HITCH_MS = 250;

  private warmup = FrameRateMonitor.WARMUP;
  private readonly frames: number[] = [];

  reset() {
    this.warmup = FrameRateMonitor.WARMUP;
    this.frames.length = 0;
  }

  /** Records one frame interval and reports whether the window has judged it slow. */
  sample(ms: number): boolean {
    if (ms <= 0 || ms >= FrameRateMonitor.HITCH_MS) return false;
    if (this.warmup > 0) {
      this.warmup--;
      return false;
    }
    this.frames.push(ms);
    if (this.frames.length < FrameRateMonitor.WINDOW) return false;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.frames.length = 0;
    return median > FrameRateMonitor.LIMIT_MS;
  }
}
