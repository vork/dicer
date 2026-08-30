import * as THREE from 'three';
import { TRAY } from './scene/tray';

export type CameraMode = 'idle' | 'rolling' | 'reveal';

interface Pose {
  /** Radius of the sphere the shot must contain, in world units. */
  frameRadius: number;
  pitch: number;
  fov: number;
  /**
   * Whether this pose aims the subject at a requested place in the frame rather
   * than dead centre. Only the reveal does, so the flashed total can have the
   * space above and the controls the space below.
   */
  placeSubject: boolean;
  /** Exponential smoothing rate; higher snaps faster. */
  followRate: number;
  orbitRate: number;
  dollyRate: number;
}

const POSES: Record<CameraMode, Pose> = {
  // Wide and high: the whole tray, held still enough to read the controls.
  idle: { frameRadius: 7.7, pitch: 0.8, fov: 36, placeSubject: false, followRate: 1.8, orbitRate: 1.2, dollyRate: 1.6 },
  // Lower and looser, chasing the cluster while it scatters.
  rolling: { frameRadius: 6.2, pitch: 0.6, fov: 42, placeSubject: false, followRate: 5.2, orbitRate: 1.6, dollyRate: 2.6 },
  // Long lens, close in, and high enough to read the faces that landed up —
  // a low reveal angle sees the printed numbers edge-on and defeats the point.
  reveal: { frameRadius: 2.4, pitch: 1.02, fov: 28, placeSubject: true, followRate: 3.0, orbitRate: 0.7, dollyRate: 1.5 },
};

/**
 * Half the tray's inner diagonal, plus room for a die's own radius. Two dice in
 * opposite corners genuinely need the whole tray in frame, so at that point there
 * is no push-in left to give — but nothing is ever cut off.
 */
const REVEAL_MAX_RADIUS = Math.hypot(TRAY.innerWidth, TRAY.innerDepth) / 2 + 0.7;

/** How much further than a frame-filling shot the band may pull the camera back. */
const BAND_FIT_LIMIT = 1.4;

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
  private compose = 0;
  /**
   * The strip of screen the reveal should land in, in normalised device
   * coordinates: +1 is the top, -1 the bottom. The app measures the gap between
   * the flashed total and the controls, because that gap is a very different
   * shape on a phone than on a desktop.
   */
  private bandTop = 0.3;
  private bandBottom = -0.7;
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
   * Distance at which the subject fits inside the clear band rather than the whole
   * frame.
   *
   * Framing something to fill the frame leaves nowhere to move it, so asking for
   * it to sit clear of the controls achieves nothing — the tilt gets clamped back
   * to almost zero to avoid cropping. Fitting the band instead buys the room, at
   * the cost of a wider shot; on a short window that is the trade, because the
   * alternative is a die nobody can see.
   */
  private fitBandDistance(radius: number, fov: number): number {
    const verticalHalf = THREE.MathUtils.degToRad(fov) / 2;
    const bandHalf = (this.bandTop - this.bandBottom) / 2;
    return radius / Math.sin(Math.max(verticalHalf * bandHalf, 0.02));
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
    if (wanted === 0 || subjectRadius <= 0 || distance <= subjectRadius) return 0;
    const verticalHalf = THREE.MathUtils.degToRad(fov) / 2;
    const subjectHalf = Math.asin(Math.min(1, subjectRadius / distance));
    // A little slack so a die's shadow and highlight do not graze the edge.
    const room = Math.max(0, verticalHalf - subjectHalf - 0.02);
    return THREE.MathUtils.clamp(wanted, -room, room);
  }

  /**
   * Asks the reveal to land between these two heights, where +1 is the top of the
   * screen and -1 the bottom. Honoured as far as the framing allows.
   */
  setSubjectBand(top: number, bottom: number) {
    this.bandTop = THREE.MathUtils.clamp(top, -1, 1);
    this.bandBottom = THREE.MathUtils.clamp(bottom, -1, this.bandTop);
  }

  /**
   * Where to centre the subject vertically so it sits in the clear band.
   *
   * When the subject is taller than the band — a pool spread across the tray on a
   * short window — it cannot fit, and something has to give at one end. It gives
   * at the top: a die reaching up behind the flashed total is still visible,
   * while one that slides under the controls is simply gone.
   */
  private bandedPlacement(subjectRadius: number, distance: number, fov: number): number {
    const verticalHalf = THREE.MathUtils.degToRad(fov) / 2;
    if (subjectRadius <= 0 || distance <= subjectRadius || verticalHalf <= 0) {
      return (this.bandTop + this.bandBottom) / 2;
    }
    // The subject's own half-height, as a fraction of the frame's half-height.
    const half = Math.asin(Math.min(1, subjectRadius / distance)) / verticalHalf;
    const lowest = this.bandBottom + half;
    const highest = this.bandTop - half;
    if (lowest > highest) return lowest;
    return THREE.MathUtils.clamp((this.bandTop + this.bandBottom) / 2, lowest, highest);
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
      // A tall viewport is bound by its width, so the same framing radius leaves a
      // lone die small in a lot of empty height. Close in as the frame narrows.
      const closest = pose.frameRadius * THREE.MathUtils.clamp(0.45 + 0.55 * this.camera.aspect, 0.62, 1);
      // Whatever the caller framed has to fit — under sum that is every die, under
      // highest/lowest only the dice that won. The cap is the widest the tray can
      // ever demand, so it trims surplus margin and never crops a die.
      radius = THREE.MathUtils.clamp(bounds.radius * 1.15, closest, REVEAL_MAX_RADIUS);
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
    if (pose.placeSubject) {
      // Capped, because dice in opposite corners inside a shallow band would
      // otherwise pull back to several times the tray's width and turn the dice
      // into specks. Past this point a little overlap with the result text is the
      // better trade, and the placement below biases the overflow upward.
      const roomiest = this.desiredDistance * BAND_FIT_LIMIT;
      this.desiredDistance = Math.min(roomiest, Math.max(this.desiredDistance, this.fitBandDistance(bounds.radius * 1.06, fov)));
    }
    // Tilting up by an angle moves the subject down the frame by that same angle,
    // so the tilt that lands it where we want is that offset scaled by the frame's
    // vertical half-angle.
    const placement = pose.placeSubject
      ? this.bandedPlacement(bounds.radius, this.desiredDistance, fov)
      : 0;
    const wanted = -placement * (THREE.MathUtils.degToRad(fov) / 2);
    const compose = this.affordableCompose(wanted, bounds.radius, this.desiredDistance, fov);

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
