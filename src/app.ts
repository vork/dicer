import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

import { loadDiceAssets, loadSetTextures, type DiceAssets, type DiceSet } from './assets';
import { createEnvironment, createLights } from './scene/environment';
import { createTray, TRAY } from './scene/tray';
import { createPostFx, type PostFx } from './scene/postfx';
import { DiceWorld } from './physics/dice-world';
import { CameraDirector } from './camera-director';
import { ThrowInput } from './input/throw-input';
import { Hud } from './ui/hud';
import { DiceAudio } from './audio';
import type { DieType } from './dice/values';
import { resolveRoll, type ResultMode } from './dice/outcome';

/** How long the close-up holds after the dice stop before easing back out. */
const REVEAL_HOLD_SECONDS = 2.4;

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
  private readonly bounds = new THREE.Sphere();
  private readonly audio = new DiceAudio();

  private rapier!: typeof RAPIER;
  private assets!: DiceAssets;
  private diceWorld!: DiceWorld;
  private postFx!: PostFx;
  private hud!: Hud;
  private input!: ThrowInput;
  private diceMaterial!: THREE.MeshPhysicalMaterial;

  private activeSet!: DiceSet;
  private resultMode: ResultMode = 'sum';
  /** Guards against out-of-order colourway loads. */
  private setRequest = 0;
  private revealTimer = 0;
  private revealing = false;
  /** Test hook: holds the close-up open so a headless run can measure it. */
  private revealHeld = false;
  /** Which dice the reveal closes in on; empty means all of them. */
  private revealFocus: number[] = [];
  private running = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
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

    // A die is one world unit across; a 2048 map over the tray gives it barely two
    // shadow texels, so spend 4096 where the GPU can afford it.
    const shadowMapSize = this.renderer.capabilities.maxTextureSize >= 8192 && window.innerWidth > 700 ? 4096 : 2048;
    for (const light of createLights(TRAY.innerWidth, TRAY.innerDepth, shadowMapSize)) this.scene.add(light);

    const tray = createTray();
    this.scene.add(tray.group);

    this.diceMaterial = new THREE.MeshPhysicalMaterial({
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
    await this.applySet(this.activeSet);

    this.diceWorld = new DiceWorld(this.rapier, this.assets, this.diceMaterial);
    this.scene.add(this.diceWorld.group);

    this.postFx = createPostFx(this.renderer, this.scene, this.director.camera);
    this.postFx.setSize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio, 2));

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
    this.input.onThrow = ({ direction, power }) => {
      this.audio.resume();
      this.throwDice(direction, power);
    };
    this.input.onDragChange = (drag) => this.hud.updateAim(drag);

    this.setPool(this.hud.getPool());

    window.addEventListener('resize', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibility);

    this.hud.hideLoader();
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.tick);
  }

  private async applySet(set: DiceSet) {
    const request = ++this.setRequest;
    const maps = await loadSetTextures(set, this.renderer.capabilities.getMaxAnisotropy());

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
    this.revealing = false;
    this.revealFocus = [];
    this.revealTimer = 0;
    this.director.setMode('rolling');
    this.hud.setRolling(true);
    this.postFx.setFocus(0);
  }

  private tick = () => {
    if (!this.running) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);

    const { impacts, justSettled } = this.diceWorld.step(delta);
    for (const impact of impacts) this.audio.impact(impact.strength, impact.pan);

    if (justSettled) this.onSettled();

    if (this.revealing && !this.revealHeld) {
      this.revealTimer += delta;
      if (this.revealTimer > REVEAL_HOLD_SECONDS) {
        this.revealing = false;
        this.director.setMode('idle');
        this.hud.setRolling(false);
      }
    }

    // Under highest/lowest the shot tightens onto the dice that won; under sum
    // every die counts, so every die stays in frame.
    this.diceWorld.getBounds(this.bounds, this.revealing ? this.revealFocus : undefined);
    this.director.update(delta, this.bounds);
    this.postFx.setFocus(this.director.revealProgress);
    this.postFx.render(delta);
  };

  private onSettled() {
    const rolls = this.diceWorld.values();
    const outcome = resolveRoll(rolls, this.resultMode);
    this.hud.showResult(rolls, outcome);
    // The clear strip between the flashed total and the controls is a different
    // shape on every viewport, so let the layout decide where the dice sit.
    this.director.setSubjectPlacement(this.hud.getSubjectPlacement());
    this.audio.reveal(outcome.critical);

    this.revealFocus = outcome.keptIndices;
    this.revealing = true;
    this.revealTimer = 0;
    this.director.setMode('reveal');
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
      roll: (x: number, z: number, power: number) => this.throwDice(new THREE.Vector2(x, z), power),
      setPool: (pool: DieType[]) => this.hud.setPool(pool),
      setSet: (id: string) => this.selectSet(id),
      setMode: (mode: ResultMode) => {
        this.resultMode = mode;
      },
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
        values: this.diceWorld.values(),
      }),
    };
  }

  private handleResize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.director.setAspect(width / height);
    this.director.setSubjectPlacement(this.hud.getSubjectPlacement());
    this.postFx.setSize(width, height, pixelRatio);
  };

  private handleVisibility = () => {
    // Coming back from a background tab would otherwise deliver one huge delta.
    if (!document.hidden) this.clock.getDelta();
  };
}
