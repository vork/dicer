import * as THREE from 'three';
import { FACE_VALUES, READS_FROM_VERTEX, type DieType } from './values';
import type { DieGeometryInfo } from '../assets';

const UP = new THREE.Vector3(0, 1, 0);
const scratch = new THREE.Vector3();

/**
 * The local-space directions that decide a die's reading: face normals for most
 * dice, hull corners for the d4 (which is read from the apex that points up).
 */
export function readDirectionsFor(type: DieType, info: DieGeometryInfo): THREE.Vector3[] {
  const source = READS_FROM_VERTEX[type] ? info.hull : info.faces.map((face) => face.normal);
  return source.map((v) => new THREE.Vector3(v[0], v[1], v[2]).normalize());
}

export interface Reading {
  /** Index into FACE_VALUES for this die type. */
  index: number;
  value: number;
  /**
   * How squarely the winning direction points up: 1.0 is dead flat. Anything
   * meaningfully below that means the die is cocked against a wall or a neighbour.
   */
  dot: number;
}

/** Picks whichever slot points most directly at world up. */
export function readDie(
  type: DieType,
  directions: THREE.Vector3[],
  quaternion: THREE.Quaternion,
): Reading {
  let index = 0;
  let dot = -Infinity;
  for (let i = 0; i < directions.length; i++) {
    const candidate = scratch.copy(directions[i]).applyQuaternion(quaternion).dot(UP);
    if (candidate > dot) {
      dot = candidate;
      index = i;
    }
  }
  return { index, value: FACE_VALUES[type][index], dot };
}
