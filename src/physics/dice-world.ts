import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { DiceAssets } from '../assets';
import { type DieType } from '../dice/values';
import { readDie, readDirectionsFor } from '../dice/read';
import { TRAY } from '../scene/tray';

/**
 * One world unit is ~20mm (the scale the asset pipeline normalised the d20 to), so
 * real gravity is 9.81 m/s^2 / 0.02 m = ~490 units/s^2. Running the simulation at
 * true scale is what makes the dice feel like dense little objects rather than
 * balloons: they accelerate hard, land dead, and stop spinning fast.
 */
const GRAVITY = 490;

/** Fixed physics step. Fast dice cross a die-width per 1/60s, so we substep. */
const FIXED_DT = 1 / 180;
const MAX_SUBSTEPS = 8;

/**
 * Playback slow-down.
 *
 * Settling time scales as sqrt(size / gravity), so a real 20mm die simulated at
 * true scale comes to rest in about six tenths of a second — accurate, but over
 * before the camera has finished moving. Feeding the solver less simulated time
 * per real second stretches the timeline without touching the dynamics: the
 * trajectories, bounce heights and tumble are bit-for-bit the ones true gravity
 * produces, just watched a little slower. Scaling gravity down instead would
 * have made the dice look light, which is the opposite of what we want.
 */
const TIME_SCALE = 1.7;

/** Rest thresholds, in units/s and rad/s, held for this long before reading. */
const REST_LINEAR = 0.4;
const REST_ANGULAR = 0.55;
const REST_SECONDS = 0.22;

/** A face this far off vertical means the die is leaning on a wall or a neighbour. */
const COCKED_DOT = 0.965;
const MAX_UNCOCK_NUDGES = 4;

export interface Die {
  type: DieType;
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  settled: boolean;
  restSeconds: number;
  nudges: number;
  value: number | null;
  /** Local-space directions to test against world up: face normals, or hull corners for a d4. */
  readDirections: THREE.Vector3[];
  previousSpeed: number;
}

export interface Impact {
  strength: number;
  /** Sideways position across the tray, -1..1, for stereo placement. */
  pan: number;
}

export interface StepResult {
  impacts: Impact[];
  /** True on the frame every die first comes to rest. */
  justSettled: boolean;
}

export class DiceWorld {
  readonly world: RAPIER.World;
  readonly dice: Die[] = [];
  readonly group = new THREE.Group();

  private readonly rapier: typeof RAPIER;
  private readonly assets: DiceAssets;
  private readonly material: THREE.Material;
  private accumulator = 0;
  private rolling = false;
  private settleReported = true;
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly scratchVector = new THREE.Vector3();
  private readonly scratchBox = new THREE.Box3();

  constructor(rapier: typeof RAPIER, assets: DiceAssets, material: THREE.Material) {
    this.rapier = rapier;
    this.assets = assets;
    this.material = material;

    this.world = new rapier.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = FIXED_DT;
    // Dice land in a heap; extra iterations keep contacts from jittering apart.
    this.world.numSolverIterations = 8;

    this.buildTray();
  }

  private buildTray() {
    const { rapier, world } = this;
    const halfWidth = TRAY.innerWidth / 2;
    const halfDepth = TRAY.innerDepth / 2;
    // Taller than the visible rim: the extra height is invisible and almost never
    // touched, but it stops a hard throw from launching a die out of the world.
    const wallHalfHeight = TRAY.wallHeight * 1.6;
    const thickness = 0.5;

    const staticBody = world.createRigidBody(rapier.RigidBodyDesc.fixed());

    // Felt floor: grippy and nearly dead, so dice thud rather than ping.
    world.createCollider(
      rapier.ColliderDesc.cuboid(halfWidth, thickness, halfDepth)
        .setTranslation(0, TRAY.floorY - thickness, 0)
        .setRestitution(0.22)
        .setFriction(0.5),
      staticBody,
    );

    const wall = (x: number, z: number, hx: number, hz: number) => {
      world.createCollider(
        rapier.ColliderDesc.cuboid(hx, wallHalfHeight, hz)
          .setTranslation(x, TRAY.floorY + wallHalfHeight, z)
          .setRestitution(0.36)
          .setFriction(0.45),
        staticBody,
      );
    };
    wall(halfWidth + thickness, 0, thickness, halfDepth + thickness * 2);
    wall(-halfWidth - thickness, 0, thickness, halfDepth + thickness * 2);
    wall(0, halfDepth + thickness, halfWidth + thickness * 2, thickness);
    wall(0, -halfDepth - thickness, halfWidth + thickness * 2, thickness);

    // Ceiling, purely as a backstop for an extreme throw.
    world.createCollider(
      rapier.ColliderDesc.cuboid(halfWidth + 2, thickness, halfDepth + 2)
        .setTranslation(0, TRAY.floorY + 22, 0)
        .setRestitution(0.05)
        .setFriction(0.7),
      staticBody,
    );
  }

  get isRolling() {
    return this.rolling;
  }

  get allSettled() {
    return this.dice.length > 0 && this.dice.every((d) => d.settled);
  }

  /** Rebuilds the pool, resting the dice in the tray without starting a roll. */
  setPool(types: DieType[]) {
    for (const die of this.dice) {
      this.world.removeRigidBody(die.body);
      this.group.remove(die.mesh);
    }
    this.dice.length = 0;

    const columns = Math.ceil(Math.sqrt(types.length));
    const spacing = 1.5;
    types.forEach((type, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = (column - (columns - 1) / 2) * spacing;
      const z = (row - (Math.ceil(types.length / columns) - 1) / 2) * spacing;
      const die = this.createDie(type);
      const info = this.assets.info[type];
      die.body.setTranslation({ x, y: TRAY.floorY + info.inradius + 0.02, z }, true);
      die.body.setRotation(randomQuaternion(), true);
      this.dice.push(die);
    });

    this.rolling = false;
    this.settleReported = true;
    this.syncMeshes();
  }

  private createDie(type: DieType): Die {
    const { rapier, world, assets } = this;
    const info = assets.info[type];

    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setCcdEnabled(true)
      .setLinearDamping(0.02)
      // Felt bleeds off spin quickly, but not so fast the tumble stops being fun
      // to watch: this is the main dial between "lively" and "dead".
      .setAngularDamping(0.11)
      .setCanSleep(true);
    const body = world.createRigidBody(bodyDesc);

    const points = new Float32Array(info.hull.length * 3);
    info.hull.forEach((p, i) => {
      points[i * 3] = p[0];
      points[i * 3 + 1] = p[1];
      points[i * 3 + 2] = p[2];
    });
    const colliderDesc = rapier.ColliderDesc.convexHull(points);
    if (!colliderDesc) throw new Error(`could not build a convex hull for ${type}`);
    world.createCollider(
      colliderDesc
        // Acrylic is ~1.2 g/cm^3; at 20mm per unit that lands near this figure.
        .setDensity(1.5)
        .setRestitution(0.4)
        .setFriction(0.34),
      body,
    );

    const mesh = new THREE.Mesh(assets.geometries[type], this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);

    const readDirections = readDirectionsFor(type, info);

    return {
      type,
      body,
      mesh,
      settled: false,
      restSeconds: 0,
      nudges: 0,
      value: null,
      readDirections,
      previousSpeed: 0,
    };
  }

  /**
   * Launches the pool across the tray.
   *
   * @param direction unit vector in the XZ plane — where the dice should travel
   * @param power 0..1, from a tap through to a hard flick
   */
  roll(direction: THREE.Vector2, power: number) {
    if (this.dice.length === 0) return;

    const clamped = THREE.MathUtils.clamp(power, 0, 1);
    // Mostly horizontal: the dice should skate the length of the tray and come
    // back off the far wall, not lob up and drop dead in the middle.
    const speed = THREE.MathUtils.lerp(32, 70, clamped);
    const lift = THREE.MathUtils.lerp(4, 9, clamped);
    const spin = THREE.MathUtils.lerp(24, 58, clamped);

    const heading = direction.lengthSq() > 1e-6 ? direction.clone().normalize() : new THREE.Vector2(0, -1);
    // Start from the edge the throw came from, so the dice cross the whole tray.
    const originX = -heading.x * TRAY.innerWidth * 0.3;
    const originZ = -heading.y * TRAY.innerDepth * 0.3;

    this.dice.forEach((die, index) => {
      const jitter = 0.6;
      const angle = (index / Math.max(1, this.dice.length)) * Math.PI * 2;
      const x = originX + Math.cos(angle) * jitter + (Math.random() - 0.5) * 0.5;
      const z = originZ + Math.sin(angle) * jitter + (Math.random() - 0.5) * 0.5;
      const y = TRAY.floorY + 4.2 + Math.random() * 1.8 + index * 0.3;

      die.body.setTranslation({ x, y, z }, true);
      die.body.setRotation(randomQuaternion(), true);

      const spread = (Math.random() - 0.5) * 0.22;
      const cos = Math.cos(spread);
      const sin = Math.sin(spread);
      const dx = heading.x * cos - heading.y * sin;
      const dz = heading.x * sin + heading.y * cos;
      const variance = 0.86 + Math.random() * 0.28;

      die.body.setLinvel(
        { x: dx * speed * variance, y: lift * (0.75 + Math.random() * 0.5), z: dz * speed * variance },
        true,
      );
      die.body.setAngvel(
        {
          x: (Math.random() - 0.5) * 2 * spin,
          y: (Math.random() - 0.5) * 2 * spin,
          z: (Math.random() - 0.5) * 2 * spin,
        },
        true,
      );
      die.body.wakeUp();

      die.settled = false;
      die.restSeconds = 0;
      die.nudges = 0;
      die.value = null;
      // Seed from the real launch speed so the first frame's velocity change is
      // zero and does not register as a phantom collision.
      const velocity = die.body.linvel();
      die.previousSpeed = Math.hypot(velocity.x, velocity.y, velocity.z);
    });

    this.rolling = true;
    this.settleReported = false;
  }

  step(delta: number): StepResult {
    const impacts: Impact[] = [];
    this.accumulator += Math.min(delta, 0.1) / TIME_SCALE;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.world.step();
      this.accumulator -= FIXED_DT;
      steps++;
    }
    // If we fell far behind, drop the backlog rather than spiralling.
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    for (const die of this.dice) {
      const linear = die.body.linvel();
      const angular = die.body.angvel();
      const speed = Math.hypot(linear.x, linear.y, linear.z);
      const spin = Math.hypot(angular.x, angular.y, angular.z);

      // A sharp drop in speed is a collision; its size is how hard the hit was.
      const deceleration = die.previousSpeed - speed;
      if (deceleration > 3.5) {
        const t = die.body.translation();
        impacts.push({
          strength: THREE.MathUtils.clamp(deceleration / 34, 0, 1),
          pan: THREE.MathUtils.clamp(t.x / (TRAY.innerWidth / 2), -1, 1),
        });
      }
      die.previousSpeed = speed;

      // Rescue anything that somehow escaped the tray.
      if (die.body.translation().y < TRAY.floorY - 6) {
        die.body.setTranslation({ x: 0, y: TRAY.floorY + 6, z: 0 }, true);
        die.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        die.settled = false;
        die.restSeconds = 0;
        continue;
      }

      if (speed < REST_LINEAR && spin < REST_ANGULAR) {
        die.restSeconds += delta;
      } else {
        die.restSeconds = 0;
        die.settled = false;
        die.value = null;
      }

      if (!die.settled && die.restSeconds >= REST_SECONDS) {
        const reading = this.read(die);
        if (reading.dot < COCKED_DOT && die.nudges < MAX_UNCOCK_NUDGES) {
          this.nudge(die);
        } else {
          die.settled = true;
          die.value = reading.value;
        }
      }
    }

    this.syncMeshes();

    let justSettled = false;
    if (this.rolling && !this.settleReported && this.allSettled) {
      this.settleReported = true;
      this.rolling = false;
      justSettled = true;
    }

    return { impacts, justSettled };
  }

  /** Finds the slot pointing most directly up and returns its printed value. */
  private read(die: Die) {
    const rotation = die.body.rotation();
    this.scratchQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    return readDie(die.type, die.readDirections, this.scratchQuaternion);
  }

  /** Topples a die that came to rest against a wall or on top of another. */
  private nudge(die: Die) {
    die.nudges++;
    die.restSeconds = 0;
    const kick = 3.4 + die.nudges * 1.2;
    die.body.setLinvel({ x: (Math.random() - 0.5) * kick, y: kick, z: (Math.random() - 0.5) * kick }, true);
    die.body.setAngvel(
      { x: (Math.random() - 0.5) * 22, y: (Math.random() - 0.5) * 22, z: (Math.random() - 0.5) * 22 },
      true,
    );
    die.body.wakeUp();
  }

  private syncMeshes() {
    for (const die of this.dice) {
      const t = die.body.translation();
      const r = die.body.rotation();
      die.mesh.position.set(t.x, t.y, t.z);
      die.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /**
   * Bounding sphere of the dice for the camera to frame. Pass `indices` to frame
   * only some of them — the reveal uses it to close in on the dice that won.
   */
  getBounds(target: THREE.Sphere, indices?: readonly number[]): THREE.Sphere {
    const framed =
      indices && indices.length
        ? indices.map((i) => this.dice[i]).filter((die): die is Die => die !== undefined)
        : this.dice;

    if (framed.length === 0) {
      target.center.set(0, TRAY.floorY + 0.5, 0);
      target.radius = Math.max(TRAY.innerWidth, TRAY.innerDepth) * 0.5;
      return target;
    }
    const box = this.scratchBox.makeEmpty();
    for (const die of framed) {
      const t = die.body.translation();
      const radius = this.assets.info[die.type].radius;
      box.expandByPoint(this.scratchVector.set(t.x - radius, t.y - radius, t.z - radius));
      box.expandByPoint(this.scratchVector.set(t.x + radius, t.y + radius, t.z + radius));
    }
    box.getBoundingSphere(target);
    return target;
  }

  values(): { type: DieType; value: number }[] {
    return this.dice.map((die) => ({ type: die.type, value: die.value ?? 0 }));
  }

  dispose() {
    for (const die of this.dice) this.group.remove(die.mesh);
    this.dice.length = 0;
    this.world.free();
  }
}

function randomQuaternion(): { x: number; y: number; z: number; w: number } {
  // Shoemake's uniform random rotation.
  const u1 = Math.random();
  const u2 = Math.random() * Math.PI * 2;
  const u3 = Math.random() * Math.PI * 2;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return { x: a * Math.sin(u2), y: a * Math.cos(u2), z: b * Math.sin(u3), w: b * Math.cos(u3) };
}
