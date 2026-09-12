import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

import { loadDiceAssets, loadSetTextures, type DiceAssets, type DiceSet } from './assets';
import { createEnvironment, createLights } from './scene/environment';
import { createTray, TRAY, type Tray } from './scene/tray';
import { createDiceMaterial, type DiceMaterial, type FlakeSettings } from './scene/dice-material';
import { createCoinMaterial, type CoinMaterial, type CoinSettings } from './scene/coin-material';
import { createPostFx, type PostFx } from './scene/postfx';
import { installGT7ToneMapping } from './scene/tonemap';
import { DiceWorld, SEEDED_FRAME } from './physics/dice-world';
import { CameraDirector } from './camera-director';
import { ThrowInput } from './input/throw-input';
import { Hud } from './ui/hud';
import { DiceAudio } from './audio';
import type { DieType } from './dice/values';
import { resolveRoll, type ResultMode } from './dice/outcome';
import {
  chooseQuality,
  describeGpu,
  FrameRateMonitor,
  lowerTier,
  QUALITY,
  rememberTier,
  type QualityChoice,
  type QualitySettings,
  type QualityTier,
} from './quality';

/**
 * How long the close-up holds after the dice stop before easing back out. Long
 * enough for the slower dolly to actually arrive before it starts leaving again.
 */
/**
 * How long the reveal's camera move is given to settle, for the tools that
 * time it. The reveal itself no longer times out: the result stays up until it
 * is dismissed.
 */
export const REVEAL_HOLD_SECONDS = 3.2;

async function loadRapier(): Promise<typeof RAPIER> {
  const module = await import('@dimforge/rapier3d-compat');
  await module.default.init();
  return module.default;
}

export class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly director: CameraDirector;
  private readonly clock = new THREE.Clock();
  private paused = false;
  private readonly bounds = new THREE.Sphere();
  private readonly audio = new DiceAudio();
  private quality: QualitySettings;
  private readonly qualityChoice: QualityChoice;
  private readonly gpu: string;
  private readonly monitor = new FrameRateMonitor();
  /** The key light, whose shadow map a change of tier resizes. */
  private keyLight!: THREE.DirectionalLight;
  /**
   * Frames the shadow map is still redrawn for. The light and the tray never
   * move, so once the dice have stopped the map cannot change; it is redrawn
   * only while something is moving, plus a couple of frames after anything is
   * placed, and cached the rest of the time.
   */
  private shadowFramesDue = 2;
  /** Time carried over from frames the idle throttle skipped. */
  private skippedDelta = 0;
  private frameParity = 0;

  private rapier!: typeof RAPIER;
  private assets!: DiceAssets;
  private diceWorld!: DiceWorld;
  private postFx!: PostFx;
  private hud!: Hud;
  private input!: ThrowInput;
  private dice!: DiceMaterial;
  private coin!: CoinMaterial;
  private tray!: Tray;
  private diceMaterial!: THREE.MeshPhysicalMaterial;

  private activeSet!: DiceSet;
  private resultMode: ResultMode = 'sum';
  /** Guards against out-of-order colourway loads. */
  private setRequest = 0;
  private revealTimer = 0;
  private revealing = false;
  /** Test hook: holds the close-up open so a headless run can measure it. */
  private revealHeld = false;
  /**
   * Stops the camera dead. Only a test uses this: the camera drifts and orbits
   * continuously, so it is never actually still, and anything measuring what
   * changed between two frames is otherwise measuring the camera.
   */
  private cameraFrozen = false;
  /** Which dice the reveal closes in on; empty means all of them. */
  private revealFocus: number[] = [];
  private running = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Decided before the context exists: whether the canvas itself needs
    // multisampling depends on the tier, and that cannot change afterwards.
    this.gpu = describeGpu();
    this.qualityChoice = chooseQuality(window.location.search, this.gpu);
    this.quality = QUALITY[this.qualityChoice.tier];
    console.info(`quality: ${this.quality.tier} (${this.qualityChoice.reason})`);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Multisampling on the canvas only helps when the scene is drawn straight
      // to it, which the lowest tier does. With the composer in the chain nothing
      // is ever drawn there — it would cost a multisampled buffer nobody wrote to
      // — and the antialiasing that matters is on the composer's own target, in
      // scene/postfx.ts.
      antialias: !this.quality.post,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Redrawn on demand — see shadowFramesDue.
    this.renderer.shadowMap.autoUpdate = false;
    this.applyQualityToDocument();
    // GT7's operator, not ACES. See src/scene/tonemap.ts for why, and
    // tools/tonemap-curves.py for the measurement that decided it.
    installGT7ToneMapping();
    this.renderer.toneMapping = THREE.CustomToneMapping;
    // Higher than the 1.28 ACES wanted, because GT7's SDR path maps a frame
    // buffer where 1.0 is 100 nits up to a 250-nit paper white and scales back
    // down. Chosen by matching the frame's median luminance to what ACES gave, so
    // the swap changes colour rather than brightness — tools/tonemap-sheet.mjs
    // does that search.
    this.renderer.toneMappingExposure = 2.89;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color(0x050507);
    this.scene.fog = new THREE.FogExp2(0x050507, 0.012);

    this.director = new CameraDirector(window.innerWidth / window.innerHeight);
  }

  async start() {
    // Rapier inlines its wasm as base64, which is most of the bundle. Importing it
    // dynamically puts it in its own chunk that loads alongside the dice assets.
    const [rapier, assets] = await Promise.all([loadRapier(), loadDiceAssets()]);
    this.rapier = rapier;
    this.assets = assets;
    this.activeSet = this.assets.sets[0];

    const environment = createEnvironment(this.renderer);
    this.scene.environment = environment;

    const lights = createLights(TRAY.innerWidth, TRAY.innerDepth, this.shadowMapSize());
    this.keyLight = lights[0] as THREE.DirectionalLight;
    for (const light of lights) this.scene.add(light);

    this.tray = createTray();
    this.tray.setDetail(this.quality.trayDetail);
    this.scene.add(this.tray.group);

    this.dice = createDiceMaterial();
    this.diceMaterial = this.dice.material;
    this.coin = createCoinMaterial(
      undefined,
      this.assets.info.coin.inradius,
      this.assets.info.coin.faces[0].extent,
      Math.min(this.quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy()),
    );
    this.coin.setDetail(this.quality.coinDetail);
    // Its own room: the plain one shows a flat face nothing but the dark shell.
    this.coin.material.envMap = createEnvironment(this.renderer, true);
    await this.coin.ready;
    await this.applySet(this.activeSet);

    this.diceWorld = new DiceWorld(this.rapier, this.assets, this.diceMaterial, this.coin.material);
    this.scene.add(this.diceWorld.group);

    this.postFx = createPostFx(this.renderer, this.scene, this.director.camera, this.quality);
    this.postFx.setSize(window.innerWidth, window.innerHeight, this.pixelRatio());

    this.hud = new Hud({
      onPoolChange: (pool) => this.setPool(pool),
      onRoll: () => this.rollFromButton(),
      onSetChange: (id) => void this.selectSet(id),
      onSoundToggle: (enabled) => this.audio.setEnabled(enabled),
      onModeChange: (mode) => {
        this.resultMode = mode;
      },
    });
    this.resultMode = this.hud.getMode();
    this.hud.buildSwatches(this.assets.sets, this.activeSet.id);

    this.input = new ThrowInput(this.canvas, this.director.camera);
    this.input.onThrow = ({ direction, power, tap }) => {
      this.audio.resume();
      // A tap while the result is up puts it away; a flick throws again.
      if (tap && this.revealing) {
        this.dismissReveal();
        return;
      }
      this.throwDice(direction, power);
    };
    window.addEventListener('keydown', this.handleKey);
    this.input.onDragChange = (drag) => this.hud.updateAim(drag);

    this.setPool(this.hud.getPool());

    window.addEventListener('resize', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibility);

    if (new URLSearchParams(window.location.search).has('stats')) {
      this.stats = document.createElement('div');
      this.stats.className = 'stats';
      document.body.appendChild(this.stats);
    }

    this.hud.hideLoader();
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.tick);
  }

  private async applySet(set: DiceSet) {
    const request = ++this.setRequest;
    // The coin changes at once; it has nothing to download. Its voice with it.
    this.coin.setMetal(set.metal);
    this.audio.setCoinMetal(set.metal);
    const maps = await loadSetTextures(
      set,
      Math.min(this.quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy()),
    );

    // Two quick taps on the colour swatches race each other, and whichever
    // download finishes last would otherwise win regardless of what was clicked
    // last. Drop anything that has been superseded.
    if (request !== this.setRequest) {
      maps.map.dispose();
      maps.roughnessMap.dispose();
      maps.normalMap.dispose();
      return;
    }

    this.diceMaterial.map?.dispose();
    this.diceMaterial.roughnessMap?.dispose();
    this.diceMaterial.normalMap?.dispose();
    this.diceMaterial.map = maps.map;
    this.diceMaterial.roughnessMap = maps.roughnessMap;
    this.diceMaterial.normalMap = maps.normalMap;
    this.diceMaterial.needsUpdate = true;
    this.activeSet = set;
  }

  private async selectSet(id: string) {
    const set = this.assets.sets.find((s) => s.id === id);
    if (!set || set.id === this.activeSet.id) return;
    await this.applySet(set);
  }

  private setPool(pool: DieType[]) {
    this.diceWorld.setPool(pool);
    this.revealing = false;
    this.revealFocus = [];
    this.director.setMode('idle');
    this.shadowFramesDue = 2;
  }

  private pixelRatio() {
    return Math.min(window.devicePixelRatio, this.quality.pixelRatio);
  }

  private shadowMapSize() {
    if (this.quality.shadowMap > 0) return this.quality.shadowMap;
    // A die is one world unit across; a 2048 map over the tray gives it barely
    // two shadow texels, so spend 4096 where the GPU can afford it.
    return this.renderer.capabilities.maxTextureSize >= 8192 && window.innerWidth > 700 ? 4096 : 2048;
  }

  /** The HUD's translucency and the CSS vignette follow the tier. */
  private applyQualityToDocument() {
    document.body.dataset.quality = this.quality.tier;
    document.body.classList.toggle('post-off', !this.quality.post);
  }

  /**
   * Moves to another tier while running. Everything the tier touches is
   * re-applied; what cannot change on a live context — multisampling on the
   * canvas itself — is left as it was, so a step down to the lowest tier on a
   * context created for the post chain draws straight to an unsampled canvas
   * until the next launch, which starts on the remembered tier.
   */
  private applyQuality(tier: QualityTier, remember: boolean) {
    if (tier === this.quality.tier) return;
    this.quality = QUALITY[tier];
    console.info(`quality: ${tier}`);
    if (remember) rememberTier(tier);
    this.monitor.reset();
    this.applyQualityToDocument();

    const size = this.shadowMapSize();
    if (this.keyLight && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    this.shadowFramesDue = 2;
    this.coin?.setDetail(this.quality.coinDetail);
    this.tray?.setDetail(this.quality.trayDetail);
    this.postFx?.configure(this.quality);
    this.handleResize();
  }

  private rollFromButton() {
    this.audio.resume();
    // Straight away from the camera, with a mid-strength throw.
    const basis = this.director.camera.matrixWorld.elements;
    const forward = new THREE.Vector2(-basis[8], -basis[10]);
    if (forward.lengthSq() < 1e-8) forward.set(0, -1);
    this.throwDice(forward.normalize(), 0.5 + Math.random() * 0.25);
  }

  private throwDice(direction: THREE.Vector2, power: number) {
    if (this.diceWorld.dice.length === 0) return;
    this.diceWorld.roll(direction, power);
    this.shadowFramesDue = 2;
    this.revealing = false;
    this.revealFocus = [];
    this.revealTimer = 0;
    this.director.setMode('rolling');
    this.hud.setRolling(true);
    this.postFx.setFocus(0);
  }

  private tick = () => {
    if (!this.running) return;
    // Pinned for a seeded run, so the camera's drift and the reveal's timers are
    // as repeatable as the throw. Pinning the solver alone was not enough: the
    // same seed put the dice in the same place but framed them from slightly
    // different ones, because the frames in between were still wall-clock.
    const measured = this.clock.getDelta();
    const frame = this.diceWorld.seeded ? SEEDED_FRAME : Math.min(measured, 0.05);
    // Held still so a tool can pose the scene by hand and render single frames.
    // Motion blur is a function of where things were drawn last frame, so
    // measuring it needs the frames under test to be the only ones happening.
    if (this.paused) return;

    // A device that cannot keep up is moved down a tier. Not while a tool has
    // pinned the tier, and not for a seeded run, which is timed by the frame
    // count rather than the clock.
    if (!this.qualityChoice.pinned && !this.diceWorld.seeded && !document.hidden && this.quality.tier !== 'low') {
      const drop = this.monitor.sample(measured * 1000);
      if (drop === 2) this.applyQuality('low', true);
      else if (drop === 1) this.applyQuality(lowerTier(this.quality.tier), true);
    }
    this.updateStats(measured);

    // While nothing moves, the lowest tier draws every other frame. The time
    // is carried, so the camera's drift covers the same ground.
    const delta = frame + this.skippedDelta;
    this.skippedDelta = 0;
    if (
      this.quality.idleFrameSkip > 0 &&
      !this.diceWorld.seeded &&
      !this.diceWorld.isRolling &&
      this.diceWorld.allSettled
    ) {
      this.frameParity = (this.frameParity + 1) % (this.quality.idleFrameSkip + 1);
      if (this.frameParity !== 0) {
        this.skippedDelta = delta;
        return;
      }
    }

    const stepStarted = performance.now();
    const { impacts, justSettled } = this.diceWorld.step(delta);
    this.recordStepTime(performance.now() - stepStarted);
    for (const impact of impacts) {
      this.audio.impact(impact.strength, impact.pan, impact.surface, impact.radius, impact.when, impact.metal);
    }

    if (justSettled) this.onSettled();

    // The result stays up until it is dismissed — a tap, a key, or the next
    // throw. It used to fade after a few seconds, which was never long enough
    // to read a breakdown, and gone by the time anyone looked up from the dice.
    if (this.revealing) this.revealTimer += delta;

    // Under highest/lowest the shot tightens onto the dice that won; under sum
    // every die counts, so every die stays in frame.
    this.diceWorld.getBounds(this.bounds, this.revealing ? this.revealFocus : undefined);
    if (!this.cameraFrozen) this.director.update(delta, this.bounds);
    this.postFx.setFocus(this.director.revealProgress);
    // Stood down as the reveal closes in. The blur is there to smooth a throw,
    // and by the reveal nothing is moving but the camera — all it could do then
    // is soften the numerals, which are the one thing on screen that has to be
    // legible.
    this.postFx.setMotionBlur(1 - this.director.revealProgress);
    // And skipped altogether, velocity pass included, while the dice are at
    // rest: the only motion then is the camera's slow drift, whose smear is
    // under a pixel — the pass was reading the whole frame to leave it alone.
    this.postFx.setMoving(this.diceWorld.isRolling);
    this.renderer.shadowMap.needsUpdate = this.shadowFramesDue > 0 || !this.diceWorld.allSettled;
    if (this.shadowFramesDue > 0) this.shadowFramesDue--;
    this.postFx.render(delta);
  };

  /**
   * A readout for testing on a phone, where there is no console: `?stats` on
   * the URL shows the tier, where it came from, the frame rate and the GPU.
   */
  private stats: HTMLElement | null = null;
  private statsFrames = 0;
  private statsMs = 0;
  private updateStats(measured: number) {
    if (!this.stats) return;
    this.statsFrames++;
    this.statsMs += measured * 1000;
    if (this.statsMs < 500) return;
    const fps = (1000 * this.statsFrames) / this.statsMs;
    this.statsFrames = 0;
    this.statsMs = 0;
    const judged = this.monitor.median ? `, monitor median ${this.monitor.median.toFixed(0)} ms` : '';
    this.stats.textContent =
      `${this.quality.tier} (${this.qualityChoice.reason}) · ${fps.toFixed(0)} fps${judged} · ` +
      `${this.renderer.getPixelRatio()}x · ${this.gpu || 'gpu unknown'}`;
  }

  /** Solver time per frame over the last few seconds, for the benchmark. */
  private readonly stepTimes: number[] = [];
  private recordStepTime(ms: number) {
    this.stepTimes.push(ms);
    if (this.stepTimes.length > 600) this.stepTimes.shift();
  }

  /** Puts the result away and lets the camera drift back. */
  private dismissReveal() {
    if (!this.revealing) return;
    this.revealing = false;
    this.revealFocus = [];
    this.revealTimer = 0;
    this.hud.hideResult();
    this.director.setMode('idle');
  }

  private handleKey = (event: KeyboardEvent) => {
    if (!this.revealing) return;
    if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.dismissReveal();
    }
  };

  private onSettled() {
    const rolls = this.diceWorld.values();
    const outcome = resolveRoll(rolls, this.resultMode);
    this.hud.showResult(rolls, outcome);
    // The controls come back with the result, since the result now waits for
    // the player rather than the other way round.
    this.hud.setRolling(false);
    // The clear strip between the flashed total and the controls is a different
    // shape on every viewport, so let the layout decide where the dice sit.
    const band = this.hud.getSubjectBand();
    this.director.setSubjectBand(band.top, band.bottom);
    this.audio.reveal(outcome.critical);

    this.revealFocus = outcome.keptIndices;
    this.revealing = true;
    this.revealTimer = 0;
    this.director.setMode('reveal');
    // The final pose, once the solver has stopped touching it.
    this.shadowFramesDue = 2;
  }

  /**
   * Hook for the headless capture and smoke tools in tools/, so they drive the
   * real app rather than a stand-in.
   */
  get debug() {
    return {
      three: THREE,
      scene: this.scene,
      renderer: this.renderer,
      camera: this.director.camera,
      diceMaterial: this.diceMaterial,
      setFlakes: (settings: Partial<FlakeSettings>) => this.dice.setFlakes(settings),
      getFlakes: () => this.dice.getFlakes(),
      setCoin: (settings: Partial<CoinSettings>) => this.coin.setCoin(settings),
      getCoin: () => this.coin.getCoin(),
      setBloom: (strength: number, radius: number, threshold: number) =>
        this.postFx.setBloom(strength, radius, threshold),
      setGrain: (amount: number) => this.postFx.setGrain(amount),
      setMotionBlur: (amount: number) => this.postFx.setMotionBlur(amount),
      quality: () => ({
        ...this.quality,
        reason: this.qualityChoice.reason,
        pinned: this.qualityChoice.pinned,
        gpu: this.gpu,
        monitorMedian: this.monitor.median,
      }),
      setQuality: (tier: QualityTier) => this.applyQuality(tier, false),
      samplesReport: () => this.postFx.samplesReport(),
      readVelocity: () => this.postFx.readVelocity(),
      shutter: () => this.postFx.shutter(),
      freezeCamera: (frozen: boolean) => {
        this.cameraFrozen = frozen;
      },
      pause: (paused: boolean) => {
        this.paused = paused;
      },
      // A frame rendered by hand runs the whole chain, velocity pass included,
      // whatever the dice are doing: the tools that pose a scene and read the
      // velocity buffer back expect it to describe the frame they just drew.
      renderFrame: (delta = 1 / 60) => {
        this.postFx.setMoving(true);
        this.postFx.render(delta);
      },
      /**
       * Times one frame stage by stage, GPU drained between them, with the
       * shadow map's share separated out by rendering the scene pass twice:
       * once against the cached map and once forced to redraw it.
       */
      profileFrame: (delta = 1 / 60) => {
        const renderer = this.renderer;
        const auto = renderer.shadowMap.autoUpdate;
        renderer.shadowMap.autoUpdate = false;
        const cached = this.postFx.profileFrame(delta);
        renderer.shadowMap.autoUpdate = true;
        renderer.shadowMap.needsUpdate = true;
        const fresh = this.postFx.profileFrame(delta);
        renderer.shadowMap.autoUpdate = auto;
        // Whichever stage drew the scene carries the shadow map's cost.
        const scenePass = fresh.stages.Direct !== undefined ? 'Direct' : 'RenderPass';
        const shadow = Math.max(0, (fresh.stages[scenePass] ?? 0) - (cached.stages[scenePass] ?? 0));
        return {
          stages: { ...fresh.stages, [scenePass]: (fresh.stages[scenePass] ?? 0) - shadow, ShadowMap: shadow },
          calls: fresh.calls,
          triangles: fresh.triangles,
        };
      },
      setCoinDetail: (detail: 'full' | 'lite') => this.coin.setDetail(detail),
      stepTimes: () => this.stepTimes.slice(),
      diceMeshes: () => this.diceWorld.dice.map((die) => die.mesh),
      wallDistance: (y: number, dx: number, dz: number) => this.diceWorld.wallDistance(y, dx, dz),
      roll: (x: number, z: number, power: number) => this.throwDice(new THREE.Vector2(x, z), power),
      setPool: (pool: DieType[]) => this.hud.setPool(pool),
      seed: (seed: number | null) => this.diceWorld.setSeed(seed),
      setSet: (id: string) => this.selectSet(id),
      setMode: (mode: ResultMode) => {
        this.resultMode = mode;
      },
      dismissReveal: () => this.dismissReveal(),
      holdReveal: (hold: boolean) => {
        this.revealHeld = hold;
      },
      diceScreenInfo: () => ({
        camera: this.director.camera,
        positions: this.diceWorld.dice.map((die) => {
          const t = die.body.translation();
          return { x: t.x, y: t.y, z: t.z, radius: this.assets.info[die.type].radius };
        }),
      }),
      state: () => ({
        rolling: this.diceWorld.isRolling,
        settled: this.diceWorld.allSettled,
        revealing: this.revealing,
        revealHeld: this.revealHeld,
        values: this.diceWorld.values(),
      }),
    };
  }

  private handleResize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const pixelRatio = this.pixelRatio();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.director.setAspect(width / height);
    const band = this.hud.getSubjectBand();
    this.director.setSubjectBand(band.top, band.bottom);
    this.postFx.setSize(width, height, pixelRatio);
  };

  private handleVisibility = () => {
    // Coming back from a background tab would otherwise deliver one huge delta.
    if (!document.hidden) this.clock.getDelta();
  };
}
