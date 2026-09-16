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
 *   medium  pixel ratio up to 1.5, half-resolution bloom, a lighter blur, a
 *           2048 shadow map, no chromatic aberration, nothing blurred behind
 *           the HUD
 *   low     pixel ratio 1 and no post chain at all: the scene is drawn straight
 *           to the canvas with tone mapping in the materials, the vignette is a
 *           CSS overlay, shadows are 1024 texels, the coin's procedural
 *           weathering runs fewer octaves, the ground is a Lambert surface, and
 *           idle frames render at half rate
 *
 * A tier is chosen at start-up from a `?quality=` override, a tier remembered
 * from an earlier session, or a look at the GPU; after that a monitor watches
 * the sustained frame rate and steps down a tier when it stays low. It also
 * steps up: when the frames of a throw sit at the display's refresh rate with
 * almost none dropped, the tier above is tried on probation, and kept if it
 * holds up. A tier that proves too slow becomes a ceiling — remembered for a
 * week — that the app does not probe into again.
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
  /** Anisotropic filtering on the dice and coin maps. */
  anisotropy: number;
  /** The coin shader's procedural detail: octaves of noise per pixel. */
  coinDetail: 'full' | 'lite';
  /** The tray's materials: the ground's shader, the felt's sheen, the leather's clear coat. */
  trayDetail: 'full' | 'lite';
  /** 2048 maps for the felt and the wood, where they are built; 1024 otherwise. */
  largeTrayMaps: boolean;
  /** The micro detail tiles under the tray's surfaces and over the dice's clear coat. */
  microDetail: boolean;
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
    anisotropy: 16,
    coinDetail: 'full',
    trayDetail: 'full',
    largeTrayMaps: true,
    microDetail: true,
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
    anisotropy: 4,
    coinDetail: 'full',
    trayDetail: 'full',
    largeTrayMaps: false,
    microDetail: true,
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
    anisotropy: 2,
    coinDetail: 'lite',
    trayDetail: 'lite',
    largeTrayMaps: false,
    microDetail: false,
    idleFrameSkip: 1,
  },
};

const STORAGE_KEY = 'dicer.quality';
/**
 * Bumped whenever the way a tier is chosen changes, so that a tier or a ceiling
 * remembered under the old rules is thrown away rather than trusted. Version 1
 * sent every iPhone to low on a core count Safari caps at four.
 */
const STORAGE_VERSION = '2';
const VERSION_KEY = 'dicer.quality.version';

function forgetStaleChoices() {
  try {
    if (localStorage.getItem(VERSION_KEY) === STORAGE_VERSION) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('dicer.quality.ceiling');
    localStorage.setItem(VERSION_KEY, STORAGE_VERSION);
  } catch {
    // Nothing stored, nothing stale.
  }
}

export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === 'string' && (QUALITY_TIERS as readonly string[]).includes(value);
}

/** The tier below, or the same one at the bottom. */
export function lowerTier(tier: QualityTier): QualityTier {
  const at = QUALITY_TIERS.indexOf(tier);
  return QUALITY_TIERS[Math.min(at + 1, QUALITY_TIERS.length - 1)];
}

/** The tier above, or the same one at the top. */
export function higherTier(tier: QualityTier): QualityTier {
  const at = QUALITY_TIERS.indexOf(tier);
  return QUALITY_TIERS[Math.max(at - 1, 0)];
}

/** Whether `a` is a better tier than `b`. */
export function tierAbove(a: QualityTier, b: QualityTier): boolean {
  return QUALITY_TIERS.indexOf(a) < QUALITY_TIERS.indexOf(b);
}

const CEILING_KEY = 'dicer.quality.ceiling';
/** How long a tier that proved too slow stays off limits. */
const CEILING_DAYS = 7;

/**
 * Records the best tier the device is allowed to try. Set when a tier proves
 * too slow — to the one below it — so the app does not keep probing into it.
 * Forgotten after a week: a phone that was hot, or on a bad day, gets another
 * chance.
 */
export function rememberCeiling(tier: QualityTier) {
  try {
    localStorage.setItem(CEILING_KEY, JSON.stringify({ tier, at: Date.now() }));
  } catch {
    // As above.
  }
}

export function rememberedCeiling(): QualityTier {
  forgetStaleChoices();
  try {
    const stored = JSON.parse(localStorage.getItem(CEILING_KEY) ?? 'null') as { tier?: unknown; at?: unknown } | null;
    if (!stored || !isQualityTier(stored.tier) || typeof stored.at !== 'number') return 'high';
    if (Date.now() - stored.at > CEILING_DAYS * 24 * 3600 * 1000) return 'high';
    return stored.tier;
  } catch {
    return 'high';
  }
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
  forgetStaleChoices();
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

  // Only signals that mean something. The core count is not one: Safari caps
  // navigator.hardwareConcurrency at four on every iPhone against
  // fingerprinting, so a rule on it sent an iPhone 17 Pro to the lowest tier.
  // deviceMemory is Chrome's alone and reports what it says.
  const nav = navigator as Navigator & { deviceMemory?: number };
  const touch = window.matchMedia('(pointer: coarse)').matches || nav.maxTouchPoints > 0;
  const memory = nav.deviceMemory ?? 0;

  if (WEAK_GPU.test(gpu)) return { tier: 'low', reason: `gpu ${gpu}`, pinned: false };
  if (touch && memory > 0 && memory <= 3) return { tier: 'low', reason: `${memory} GB`, pinned: false };
  if (MODEST_GPU.test(gpu)) return { tier: 'medium', reason: `gpu ${gpu}`, pinned: false };
  if (touch && memory > 0 && memory <= 4) return { tier: 'medium', reason: `${memory} GB`, pinned: false };
  return { tier: 'high', reason: gpu ? `gpu ${gpu}` : 'default', pinned: false };
}

/**
 * Watches the sustained frame rate and says when the tier should change.
 *
 * Down: windows of recent frame intervals, judged by their median so that a
 * lone hitch — a shader compiling, a tab coming back — cannot trip it. The
 * first stretch after a change of tier is ignored altogether: every new program
 * compiles on its first draw, and those frames say nothing about the device.
 *
 * Everything here is in time, not frames. The first version counted frames —
 * ninety to warm up, sixty to judge — and on a phone crawling at five frames a
 * second that was half a minute before it did anything, while frames over a
 * quarter of a second were thrown out as stalls, which on the slowest phones
 * was every frame. The device it existed for was the one it could not see.
 *
 * Up is a different question, because requestAnimationFrame is capped at the
 * display's refresh: a device with headroom to spare and one only just keeping
 * up both report sixteen milliseconds a frame. What separates them is the
 * frames they drop. So the up verdict looks only at frames drawn while the
 * dice were moving — idle frames are cheaper, with no blur, no velocity pass
 * and a cached shadow map, and prove nothing — and asks for at least a
 * throw's worth of them at the refresh rate with almost none dropped. Even
 * then it is a guess, which is why the tier above is taken on probation.
 */
export class FrameRateMonitor {
  /** After a reset, this much time is ignored, and never fewer frames than this. */
  static readonly WARMUP_MS = 1500;
  static readonly WARMUP_FRAMES = 12;
  /** A window is judged once it spans this much time, or holds this many frames. */
  static readonly WINDOW_MS = 2000;
  static readonly WINDOW_FRAMES = 60;
  /** But never on fewer than this: a median of two frames is not a rate. */
  static readonly MIN_FRAMES = 6;
  /** A median frame longer than this, in ms, is a device that cannot keep up. */
  static readonly LIMIT_MS = 1000 / 38;
  /** A median this long is a crawl: skip straight to the lowest tier. */
  static readonly CRAWL_MS = 90;
  /** A frame this long is not a frame, it is the tab having been away. */
  static readonly STALL_MS = 2000;
  /** A moving frame at or under this is at a 60Hz display's refresh. */
  static readonly FAST_MS = 17.5;
  /** A moving frame over this was dropped. */
  static readonly DROP_MS = 25;
  /** Moving frames needed before an up verdict: about one throw at 60fps. */
  static readonly UP_FRAMES = 90;
  /** Of which at most this share may be dropped, and at least this share fast. */
  static readonly UP_DROPS = 0.03;
  static readonly UP_FAST = 0.9;

  private warmupMs = FrameRateMonitor.WARMUP_MS;
  private warmupFrames = FrameRateMonitor.WARMUP_FRAMES;
  private readonly frames: number[] = [];
  private windowMs = 0;
  private movingFrames = 0;
  private movingFast = 0;
  private movingDrops = 0;
  /** The last window's median, for a readout. */
  median = 0;

  reset() {
    this.warmupMs = FrameRateMonitor.WARMUP_MS;
    this.warmupFrames = FrameRateMonitor.WARMUP_FRAMES;
    this.frames.length = 0;
    this.windowMs = 0;
    this.movingFrames = 0;
    this.movingFast = 0;
    this.movingDrops = 0;
  }

  /**
   * Records one frame interval, and whether the dice were moving during it.
   * Returns the verdict: 'down' when the device is slow, 'crawl' when it is
   * far too slow for anything but the lowest tier, 'up' when a throw's worth
   * of moving frames sat at the refresh rate, 'hold' otherwise.
   */
  sample(ms: number, moving: boolean): 'hold' | 'down' | 'crawl' | 'up' {
    if (ms <= 0 || ms >= FrameRateMonitor.STALL_MS) return 'hold';
    if (this.warmupMs > 0 || this.warmupFrames > 0) {
      this.warmupMs -= ms;
      this.warmupFrames--;
      return 'hold';
    }
    this.frames.push(ms);
    this.windowMs += ms;
    if (moving) {
      this.movingFrames++;
      if (ms <= FrameRateMonitor.FAST_MS) this.movingFast++;
      if (ms > FrameRateMonitor.DROP_MS) this.movingDrops++;
    }
    if (this.frames.length < FrameRateMonitor.MIN_FRAMES) return 'hold';
    if (this.frames.length < FrameRateMonitor.WINDOW_FRAMES && this.windowMs < FrameRateMonitor.WINDOW_MS) return 'hold';
    const sorted = [...this.frames].sort((a, b) => a - b);
    this.median = sorted[sorted.length >> 1];
    this.frames.length = 0;
    this.windowMs = 0;
    if (this.median > FrameRateMonitor.CRAWL_MS) return 'crawl';
    if (this.median > FrameRateMonitor.LIMIT_MS) return 'down';
    if (this.movingFrames >= FrameRateMonitor.UP_FRAMES) {
      const up =
        this.movingDrops <= this.movingFrames * FrameRateMonitor.UP_DROPS &&
        this.movingFast >= this.movingFrames * FrameRateMonitor.UP_FAST;
      // Judged; the next verdict wants a fresh throw's worth either way.
      this.movingFrames = 0;
      this.movingFast = 0;
      this.movingDrops = 0;
      if (up) return 'up';
    }
    return 'hold';
  }
}
