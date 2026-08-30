import * as THREE from 'three';
import { TRAY } from './scene/tray';

export type CameraMode = 'idle' | 'rolling' | 'reveal';

interface Pose {
  /** Radius of the sphere the shot must contain, in world units. */
  frameRadius: number;
  pitch: number;
  fov: number;
  /**
   * How far to tilt the camera up after aiming, pushing the subject down the
   * frame so the flashed total has the top of the screen. This is the most the
   * pose ever asks for; how much is actually applied depends on the room left
   * over once the subject has been fitted.
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
  reveal: { frameRadius: 2.4, pitch: 1.02, fov: 28, compose: 0.13, followRate: 3.0, orbitRate: 0.7, dollyRate: 1.5 },
};

/**
 * Half the tray's inner diagonal, plus room for a die's own radius. Two dice in
 * opposite corners genuinely need the whole tray in frame, so at that point there
 * is no push-in left to give — but nothing is ever cut off.
 */
const REVEAL_MAX_RADIUS = Math.hypot(TRAY.innerWidth, TRAY.innerDepth) / 2 + 0.7;

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

  /**
   * The largest upward tilt that still keeps the subject fully in shot.
   *
   * Tilting moves the subject down by that angle, so the room available is the
   * frame's vertical half-angle less the angle the subject itself subtends. One
   * small die leaves plenty; a pool spread across the tray already fills the
   * frame and leaves almost none — tilting anyway would push the nearest dice off
   * the bottom edge, which is exactly what it used to do.
   */
  private affordableCompose(wanted: number, subjectRadius: number, distance: number, fov: number): number {
    if (wanted <= 0 || subjectRadius <= 0 || distance <= subjectRadius) return 0;
    const verticalHalf = THREE.MathUtils.degToRad(fov) / 2;
    const subjectHalf = Math.asin(Math.min(1, subjectRadius / distance));
    // A little slack so a die's shadow and highlight do not graze the edge.
    const room = verticalHalf - subjectHalf - 0.02;
    return THREE.MathUtils.clamp(wanted, 0, Math.max(0, room));
  }

  update(dt: number, bounds: THREE.Sphere) {
    this.time += dt;
    const pose = POSES[this.mode];

    if (this.mode === 'idle') {
      this.desiredTarget.set(0, TRAY.floorY + 0.5, 0);
    } else {
      this.desiredTarget.copy(bounds.center);
      // A safety net against a stray value, not a restriction: the look-at has to
      // be able to reach the tray walls, or a die resting in a corner never gets
      // centred and the reveal appears not to pan at all.
      this.desiredTarget.x = THREE.MathUtils.clamp(this.desiredTarget.x, -TRAY.innerWidth / 2, TRAY.innerWidth / 2);
      this.desiredTarget.z = THREE.MathUtils.clamp(this.desiredTarget.z, -TRAY.innerDepth / 2, TRAY.innerDepth / 2);
      this.desiredTarget.y = THREE.MathUtils.clamp(this.desiredTarget.y, TRAY.floorY + 0.3, TRAY.floorY + 4);
    }

    let radius = pose.frameRadius;
    if (this.mode === 'rolling') radius = Math.max(pose.frameRadius, bounds.radius * 1.55);
    if (this.mode === 'reveal') {
      // Whatever the caller framed has to fit — under sum that is every die, under
      // highest/lowest only the dice that won. The cap is the widest the tray can
      // ever demand, so it trims surplus margin and never crops a die.
      radius = THREE.MathUtils.clamp(bounds.radius * 1.15, pose.frameRadius, REVEAL_MAX_RADIUS);
      this.revealTime += dt;
    }

    // A tall, narrow viewport fits the tray by width and leaves the frame
    // half empty. Looking down more squares the tray's projected shape up with
    // the screen's, so it fills the frame instead of floating in a band.
    const portraitLift = THREE.MathUtils.clamp((1 - this.camera.aspect) * 0.45, 0, 0.28);

    let fov = pose.fov;
    if (this.mode === 'reveal') {
      // Ease the last of the push in over the first second of the hold.
      fov -= 2.5 * (1 - Math.exp(-this.revealTime * 1.4));
    }

    this.desiredDistance = this.fitDistance(radius, fov);
    const compose = this.affordableCompose(pose.compose, bounds.radius, this.desiredDistance, fov);

    // Slow drift keeps the frame alive; the reveal adds a touch of orbit for parallax.
    const drift = Math.sin(this.time * 0.11) * 0.1 + Math.sin(this.time * 0.043) * 0.06;
    const revealOrbit = this.mode === 'reveal' ? -0.16 * (1 - Math.exp(-this.revealTime * 0.7)) : 0;
    const desiredYaw = drift + revealOrbit;

    this.target.x = damp(this.target.x, this.desiredTarget.x, pose.followRate, dt);
    this.target.y = damp(this.target.y, this.desiredTarget.y, pose.followRate, dt);
    this.target.z = damp(this.target.z, this.desiredTarget.z, pose.followRate, dt);
    this.distance = damp(this.distance, this.desiredDistance, pose.dollyRate, dt);
    this.yaw = damp(this.yaw, desiredYaw, pose.orbitRate, dt);
    this.pitch = damp(this.pitch, pose.pitch + portraitLift, pose.orbitRate, dt);
    this.fov = damp(this.fov, fov, pose.dollyRate, dt);
    this.compose = damp(this.compose, compose, pose.dollyRate, dt);

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
