import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DIE_TYPES, type DieType } from './dice/values';

export interface FaceInfo {
  /** Outward unit normal in the die's local space. */
  normal: [number, number, number];
  centroid: [number, number, number];
  extent: number;
}

export interface DieGeometryInfo {
  /** Distance from centre of mass to the furthest corner. */
  radius: number;
  /** Distance from centre of mass to the nearest face — the resting half-height. */
  inradius: number;
  /** Unique corner points, used for the convex collider and for reading a d4. */
  hull: [number, number, number][];
  faces: FaceInfo[];
}

export interface DiceSet {
  id: string;
  name: string;
  swatch: string;
  baseColor: string;
  roughness: string;
  normal: string;
}

export interface DiceAssets {
  geometries: Record<DieType, THREE.BufferGeometry>;
  info: Record<DieType, DieGeometryInfo>;
  sets: DiceSet[];
}

const BASE = `${import.meta.env.BASE_URL}dice/`;

export async function loadDiceAssets(): Promise<DiceAssets> {
  const [gltf, info, sets] = await Promise.all([
    new GLTFLoader().loadAsync(`${BASE}dice.glb`),
    fetch(`${BASE}faces.json`).then((r) => r.json() as Promise<Record<DieType, DieGeometryInfo>>),
    fetch(`${BASE}sets.json`).then((r) => r.json() as Promise<DiceSet[]>),
  ]);

  const geometries = {} as Record<DieType, THREE.BufferGeometry>;
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const die = mesh.name as DieType;
    if (!DIE_TYPES.includes(die)) return;
    mesh.geometry.computeBoundingSphere();
    geometries[die] = mesh.geometry;
  });

  for (const die of DIE_TYPES) {
    if (!geometries[die]) throw new Error(`dice.glb is missing the ${die} mesh`);
    if (!info[die]) throw new Error(`faces.json is missing ${die}`);
  }

  return { geometries, info, sets };
}

/**
 * Loads one colourway's PBR maps. The source maps are authored with a
 * top-left UV origin, so flipY stays off to match the glTF convention.
 */
export async function loadSetTextures(
  set: DiceSet,
  anisotropy: number,
): Promise<{ map: THREE.Texture; roughnessMap: THREE.Texture; normalMap: THREE.Texture }> {
  const loader = new THREE.TextureLoader();
  const load = (url: string, colorSpace: string) =>
    loader.loadAsync(`${BASE}${url}`).then((texture) => {
      texture.flipY = false;
      texture.colorSpace = colorSpace;
      texture.anisotropy = anisotropy;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      return texture;
    });

  const [map, roughnessMap, normalMap] = await Promise.all([
    load(set.baseColor, THREE.SRGBColorSpace),
    load(set.roughness, THREE.NoColorSpace),
    load(set.normal, THREE.NoColorSpace),
  ]);

  return { map, roughnessMap, normalMap };
}
