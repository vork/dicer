import * as THREE from 'three';
import { TRAY } from './scene/tray';

export type CameraMode = 'idle' | 'rolling' | 'reveal';

interface Pose {
  /** Radius of the sphere the shot must contain, in world units. */
  frameRadius: number;
  pitch: number;
  fov: number;
  /**
   * Tilts the camera up after it has aimed, pushing the subject down the frame.
   * The reveal uses it to park the dice in the lower third and leave the top of
   * the screen clear for the flashed total.
   */
  compose: number;
  /** Exponential smoothing rate; higher snaps faster. */
  followRate: number;
  orbitRate: number;
  dollyRate: number;
}

const POSES: Record<CameraMode, Pose> = {
  // Wide and high: the whole tray, held still enough to read the controls.
  idle: { frameRadius: 7.7, pitch: 0.8, fov: 36, compose: 0, followRate: 1.8, orbitRate: 1.2, dollyRate: 1.6 },
  // Lower and looser, chasing the cluster while it scatters.
  rolling: { frameRadius: 6.2, pitch: 0.6, fov: 42, compose: 0, followRate: 5.2, orbitRate: 1.6, dollyRate: 2.6 },
  // Long lens, close in, and high enough to read the faces that landed up —
  // a low reveal angle sees the printed numbers edge-on and defeats the point.
  reveal: { frameRadius: 2.8, pitch: 1.02, fov: 28, compose: 0.13, followRate: 3.0, orbitRate: 0.7, dollyRate: 1.5 },
};

/** Frame-rate independent exponential smoothing. */
const damp = (current: number, target: number, rate: number, dt: number) =>
  THREE.MathUtils.lerp(current, target, 1 - Math.exp(-rate * dt));

export class CameraDirector {
  readonly camera: THREE.PerspectiveCamera;

  private mode: CameraMode = 'idle';
  private readonly target = new THREE.Vector3(0, TRAY.floorY + 0.6, 0);
  private readonly desiredTarget = new THREE.Vector3(0, TRAY.floorY + 0.6, 0);
  private distance = 26;
  private desiredDistance = 26;
  private yaw = 0;
  private pitch = POSES.idle.pitch;
  private fov = POSES.idle.fov;
  private compose = POSES.idle.compose;
  private time = 0;
  /** Grows while a reveal is held, for the slow continued push. */
  private revealTime = 0;
  private readonly offset = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(POSES.idle.fov, aspect, 0.1, 220);
    this.applyImmediate();
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'reveal') this.revealTime = 0;
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Distance at which a sphere of the given radius exactly fills the tighter of
   * the two frustum axes — so a portrait phone pulls back automatically.
   */
  private fitDistance(radius: number, fov: number): number {
    const vertical = THREE.MathUtils.degToRad(fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    return radius / Math.sin(Math.min(vertical, horizontal) / 2);
  }

  update(dt: number, bounds: THREE.Sphere) {
    this.time += dt;
    const pose = POSES[this.mode];

    if (this.mode === 'idle') {
      this.desiredTarget.set(0, TRAY.floorY + 0.5, 0);
    } else {
      this.desiredTarget.copy(bounds.center);
      // Keep the look-at inside the tray; a die skidding into a corner should not
      // swing the camera off the set.
      this.desiredTarget.x = THREE.MathUtils.clamp(this.desiredTarget.x, -TRAY.innerWidth * 0.36, TRAY.innerWidth * 0.36);
      this.desiredTarget.z = THREE.MathUtils.clamp(this.desiredTarget.z, -TRAY.innerDepth * 0.36, TRAY.innerDepth * 0.36);
      this.desiredTarget.y = THREE.MathUtils.clamp(this.desiredTarget.y, TRAY.floorY + 0.3, TRAY.floorY + 4);
    }

    let radius = pose.frameRadius;
    if (this.mode === 'rolling') radius = Math.max(pose.frameRadius, bounds.radius * 1.55);
    if (this.mode === 'reveal') {
      radius = Math.max(pose.frameRadius, bounds.radius * 1.9);
      this.revealTime += dt;
    }

    let fov = pose.fov;
    if (this.mode === 'reveal') {
      // Ease the last of the push in over the first second of the hold.
      fov -= 2.5 * (1 - Math.exp(-this.revealTime * 1.4));
    }

    this.desiredDistance = this.fitDistance(radius, fov);

    // Slow drift keeps the frame alive; the reveal adds a touch of orbit for parallax.
    const drift = Math.sin(this.time * 0.11) * 0.1 + Math.sin(this.time * 0.043) * 0.06;
    const revealOrbit = this.mode === 'reveal' ? -0.16 * (1 - Math.exp(-this.revealTime * 0.7)) : 0;
    const desiredYaw = drift + revealOrbit;

    this.target.x = damp(this.target.x, this.desiredTarget.x, pose.followRate, dt);
    this.target.y = damp(this.target.y, this.desiredTarget.y, pose.followRate, dt);
    this.target.z = damp(this.target.z, this.desiredTarget.z, pose.followRate, dt);
    this.distance = damp(this.distance, this.desiredDistance, pose.dollyRate, dt);
    this.yaw = damp(this.yaw, desiredYaw, pose.orbitRate, dt);
    this.pitch = damp(this.pitch, pose.pitch, pose.orbitRate, dt);
    this.fov = damp(this.fov, fov, pose.dollyRate, dt);
    this.compose = damp(this.compose, pose.compose, pose.dollyRate, dt);

    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.place();
  }

  private place() {
    this.offset.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.position.copy(this.target).addScaledVector(this.offset, this.distance);
    // Never dip below the rim — the shot would look up through the tray wall.
    this.camera.position.y = Math.max(this.camera.position.y, TRAY.floorY + TRAY.wallHeight + 1.2);
    this.camera.lookAt(this.target);
    // Tilt up after aiming so the subject drops down the frame.
    if (Math.abs(this.compose) > 1e-4) this.camera.rotateX(this.compose);
  }

  private applyImmediate() {
    this.distance = this.fitDistance(POSES.idle.frameRadius, POSES.idle.fov);
    this.desiredDistance = this.distance;
    this.place();
  }

  /** How far the reveal push has progressed, 0..1, for the grade to follow. */
  get revealProgress(): number {
    if (this.mode !== 'reveal') return 0;
    return 1 - Math.exp(-this.revealTime * 1.8);
  }
}
