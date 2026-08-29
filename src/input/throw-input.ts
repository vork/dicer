import * as THREE from 'three';

export interface ThrowGesture {
  /** Unit direction in the world XZ plane the dice should travel. */
  direction: THREE.Vector2;
  /** 0..1, from a tap through to a hard flick. */
  power: number;
}

export interface DragState {
  active: boolean;
  /** Screen-space start point, in CSS pixels. */
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
  power: number;
}

interface Sample {
  x: number;
  y: number;
  time: number;
}

/** Swipe speeds, in CSS pixels per second, mapped onto the 0..1 power range. */
const SLOW_SWIPE = 260;
const FAST_SWIPE = 2700;
/** Below this much movement the gesture counts as a tap, not a flick. */
const TAP_SLOP = 10;

export class ThrowInput {
  readonly drag: DragState = { active: false, originX: 0, originY: 0, currentX: 0, currentY: 0, power: 0 };

  private readonly element: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly samples: Sample[] = [];
  private pointerId: number | null = null;

  onThrow: (gesture: ThrowGesture) => void = () => {};
  onDragChange: (drag: DragState) => void = () => {};

  constructor(element: HTMLElement, camera: THREE.Camera) {
    this.element = element;
    this.camera = camera;

    element.addEventListener('pointerdown', this.handleDown);
    element.addEventListener('pointermove', this.handleMove);
    element.addEventListener('pointerup', this.handleUp);
    element.addEventListener('pointercancel', this.handleCancel);
    element.addEventListener('lostpointercapture', this.handleCancel);
  }

  dispose() {
    const element = this.element;
    element.removeEventListener('pointerdown', this.handleDown);
    element.removeEventListener('pointermove', this.handleMove);
    element.removeEventListener('pointerup', this.handleUp);
    element.removeEventListener('pointercancel', this.handleCancel);
    element.removeEventListener('lostpointercapture', this.handleCancel);
  }

  private handleDown = (event: PointerEvent) => {
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.element.setPointerCapture(event.pointerId);
    this.samples.length = 0;
    this.samples.push({ x: event.clientX, y: event.clientY, time: performance.now() });
    this.drag.active = true;
    this.drag.originX = event.clientX;
    this.drag.originY = event.clientY;
    this.drag.currentX = event.clientX;
    this.drag.currentY = event.clientY;
    this.drag.power = 0;
    this.onDragChange(this.drag);
  };

  private handleMove = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    const time = performance.now();
    this.samples.push({ x: event.clientX, y: event.clientY, time });
    // Keep a short trailing window; only the end of the flick should set the power.
    while (this.samples.length > 2 && time - this.samples[0].time > 140) this.samples.shift();

    this.drag.currentX = event.clientX;
    this.drag.currentY = event.clientY;
    this.drag.power = this.measure().power;
    this.onDragChange(this.drag);
  };

  private handleUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.release(event);
    const { direction, power, moved } = this.measure();

    if (!moved) {
      // A plain tap: throw away from the camera with a little randomness.
      const away = this.screenToWorld(0, -1);
      const angle = (Math.random() - 0.5) * 0.7;
      const rotated = new THREE.Vector2(
        away.x * Math.cos(angle) - away.y * Math.sin(angle),
        away.x * Math.sin(angle) + away.y * Math.cos(angle),
      );
      this.onThrow({ direction: rotated, power: 0.42 + Math.random() * 0.2 });
      return;
    }

    this.onThrow({ direction, power });
  };

  private handleCancel = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.release(event);
  };

  private release(event: PointerEvent) {
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.drag.active = false;
    this.drag.power = 0;
    this.onDragChange(this.drag);
  }

  /** Velocity of the last few samples, converted into a world heading and power. */
  private measure(): { direction: THREE.Vector2; power: number; moved: boolean } {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last === first) {
      return { direction: this.screenToWorld(0, -1), power: 0, moved: false };
    }

    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const distance = Math.hypot(dx, dy);
    const seconds = Math.max((last.time - first.time) / 1000, 0.016);
    const speed = distance / seconds;

    const moved = Math.hypot(this.drag.currentX - this.drag.originX, this.drag.currentY - this.drag.originY) > TAP_SLOP;
    const power = THREE.MathUtils.clamp((speed - SLOW_SWIPE) / (FAST_SWIPE - SLOW_SWIPE), 0, 1);

    return { direction: this.screenToWorld(dx, dy), power, moved };
  }

  /**
   * Maps a screen-space swipe onto the ground plane using the camera's own basis,
   * so a flick "up the screen" always sends the dice away from the viewer no
   * matter where the camera has orbited to.
   */
  private screenToWorld(dx: number, dy: number): THREE.Vector2 {
    const basis = this.camera.matrixWorld.elements;
    const right = new THREE.Vector2(basis[0], basis[2]);
    const forward = new THREE.Vector2(-basis[8], -basis[10]);
    if (right.lengthSq() < 1e-8) right.set(1, 0);
    if (forward.lengthSq() < 1e-8) forward.set(0, -1);
    right.normalize();
    forward.normalize();

    const direction = new THREE.Vector2()
      .addScaledVector(right, dx)
      .addScaledVector(forward, -dy);
    if (direction.lengthSq() < 1e-8) return forward;
    return direction.normalize();
  }
}
