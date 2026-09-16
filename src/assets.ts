import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DIE_TYPES, type DieType } from './dice/values';
import type { CoinMetal } from './scene/coin-material';

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
  /** What the coin is struck from when this colourway is chosen. */
  metal: CoinMetal;
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

/** The three surface maps of one tray material, from Poly Haven via tools/build-textures.mjs. */
export interface TraySurface {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** Ambient occlusion in red, roughness in green, metalness in blue. */
  armMap: THREE.Texture;
}

export interface TrayTextures {
  leather: TraySurface;
  felt: TraySurface;
  wood: TraySurface;
  /** The micro detail tiles from tools/build-detail.mjs, where built. */
  detail: { leather: THREE.Texture | null; felt: THREE.Texture | null; wood: THREE.Texture | null };
}

/**
 * Loads the tray's surface maps, or resolves to null if they are not there —
 * the tray then falls back to its procedural maps. Tiling and repeat are the
 * tray's business; this only sets what every map shares.
 */
export async function loadTrayTextures(anisotropy: number, large = false): Promise<TrayTextures | null> {
  const loader = new THREE.TextureLoader();
  const base = `${import.meta.env.BASE_URL}tray/`;
  const load = (file: string, colorSpace: string) =>
    loader.loadAsync(`${base}${file}`).then((texture) => {
      texture.colorSpace = colorSpace;
      texture.anisotropy = anisotropy;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      return texture;
    });
  const surface = async (name: string, hasLarge: boolean): Promise<TraySurface> => {
    // The 2048 maps exist for the felt and the wood; a tier that wants them
    // and finds them missing falls back to the 1024 ones.
    const suffix = large && hasLarge ? '-2k' : '';
    const pick = (kind: string, colorSpace: string) =>
      load(`${name}-${kind}${suffix}.webp`, colorSpace).catch(() =>
        suffix ? load(`${name}-${kind}.webp`, colorSpace) : Promise.reject(new Error(`no ${name} ${kind} map`)),
      );
    const [map, normalMap, armMap] = await Promise.all([
      pick('diff', THREE.SRGBColorSpace),
      pick('normal', THREE.NoColorSpace),
      load(`${name}-arm.webp`, THREE.NoColorSpace),
    ]);
    return { map, normalMap, armMap };
  };
  const detail = (name: string) => load(`${name}-detail.webp`, THREE.NoColorSpace).catch(() => null);
  try {
    const [leather, felt, wood, leatherDetail, feltDetail, woodDetail] = await Promise.all([
      surface('leather', true),
      surface('felt', true),
      surface('wood', true),
      detail('leather'),
      detail('felt'),
      detail('wood'),
    ]);
    return { leather, felt, wood, detail: { leather: leatherDetail, felt: feltDetail, wood: woodDetail } };
  } catch {
    return null;
  }
}

/**
 * The dice's clear coat tile: orange peel and hairlines as a tangent-space
 * normal map, tiled over the atlas. Null if not built.
 */
export async function loadClearcoatDetail(anisotropy: number): Promise<THREE.Texture | null> {
  try {
    const texture = await new THREE.TextureLoader().loadAsync(`${BASE}clearcoat-detail.webp`);
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = anisotropy;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  } catch {
    return null;
  }
}
