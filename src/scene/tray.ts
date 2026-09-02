import * as THREE from 'three';
import { createFeltMaps, createLeatherMaps } from './textures';

/**
 * Tray dimensions in world units. One unit is roughly 20mm — the scale the asset
 * pipeline normalised the d20 to — so this is a ~230 x 170mm tray with a 45mm wall,
 * which is about the size of a real leather rolling tray.
 */
export const TRAY = {
  innerWidth: 11.5,
  innerDepth: 8.5,
  wallHeight: 2.3,
  wallThickness: 0.85,
  /** Corner radius of the opening. */
  innerFillet: 0.7,
  /**
   * The extrude bevel on the wall ring. It rounds the top and bottom edges, but
   * it also pulls the whole inner face in by this much, so the leather you can
   * see is not where `innerWidth` says it is — see PLAY.
   */
  wallBevel: 0.16,
  floorY: 0,
};

/**
 * Where a die may actually come to rest: the surface a player can see, not the
 * nominal opening.
 *
 * ExtrudeGeometry's bevel insets the hole along its whole height, so the visible
 * leather stands `wallBevel` proud of `innerWidth / 2`. Colliders built on the
 * nominal figure let every die resting against a wall sink that far into it, and
 * more at a corner, where the visible fillet cuts the sharp corner off as well.
 * Both were measured by raycasting the built geometry rather than derived from
 * the extrude options, and `npm run verify:tray` keeps them honest.
 */
export const PLAY = {
  halfWidth: TRAY.innerWidth / 2 - TRAY.wallBevel,
  halfDepth: TRAY.innerDepth / 2 - TRAY.wallBevel,
  fillet: TRAY.innerFillet - TRAY.wallBevel,
};

function roundedRect(width: number, depth: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const x = width / 2;
  const z = depth / 2;
  shape.moveTo(-x + radius, -z);
  shape.lineTo(x - radius, -z);
  shape.quadraticCurveTo(x, -z, x, -z + radius);
  shape.lineTo(x, z - radius);
  shape.quadraticCurveTo(x, z, x - radius, z);
  shape.lineTo(-x + radius, z);
  shape.quadraticCurveTo(-x, z, -x, z - radius);
  shape.lineTo(-x, -z + radius);
  shape.quadraticCurveTo(-x, -z, -x + radius, -z);
  return shape;
}

export interface Tray {
  group: THREE.Group;
  dispose(): void;
}

/**
 * Extrudes a flat profile into an upright solid.
 *
 * ExtrudeGeometry builds along +Z, so the profile has to be laid down; rotating
 * -90 degrees about X maps +Z onto +Y. The bevel makes the result overshoot the
 * requested depth at both ends, so the solid is then anchored by its measured
 * bounding box rather than by the nominal depth.
 */
function extrudeUpright(
  shape: THREE.Shape,
  options: THREE.ExtrudeGeometryOptions,
  anchor: 'above' | 'below',
): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(shape, options);
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  geometry.translate(0, anchor === 'above' ? -box.min.y : -box.max.y, 0);
  return geometry;
}

export function createTray(): Tray {
  const group = new THREE.Group();
  // ShapeGeometry hands through the shape's own coordinates as UVs, so for the
  // floor `repeat` reads as tiles per world unit — one tile per ~1.4 units here.
  const felt = createFeltMaps(512, 0.7);
  const leather = createLeatherMaps();

  const inner = { w: TRAY.innerWidth, d: TRAY.innerDepth };
  const outer = { w: inner.w + TRAY.wallThickness * 2, d: inner.d + TRAY.wallThickness * 2 };

  // --- floor -------------------------------------------------------------
  const floorMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x17202c,
    roughness: 1,
    metalness: 0,
    normalMap: felt.normalMap,
    normalScale: new THREE.Vector2(1.1, 1.1),
    roughnessMap: felt.roughnessMap,
    sheen: 0.75,
    sheenRoughness: 0.85,
    sheenColor: new THREE.Color(0x3c5a72),
    envMapIntensity: 0.35,
  });

  const floorShape = roundedRect(inner.w, inner.d, TRAY.innerFillet);
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(floorShape, 24), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = TRAY.floorY;
  floor.receiveShadow = true;
  group.add(floor);

  // --- wall ring ---------------------------------------------------------
  const wallShape = roundedRect(outer.w, outer.d, 1.3);
  wallShape.holes.push(roundedRect(inner.w, inner.d, TRAY.innerFillet));

  const wallGeometry = extrudeUpright(
    wallShape,
    {
      depth: TRAY.wallHeight,
      bevelEnabled: true,
      bevelThickness: 0.18,
      bevelSize: TRAY.wallBevel,
      bevelSegments: 4,
      curveSegments: 24,
    },
    'above',
  );
  wallGeometry.translate(0, TRAY.floorY, 0);
  // Extruded sides carry no useful UVs for a tiling grain, so derive box UVs.
  applyBoxUv(wallGeometry, 0.28);

  const wallMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x322820,
    roughness: 0.62,
    metalness: 0,
    normalMap: leather.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: leather.roughnessMap,
    clearcoat: 0.35,
    clearcoatRoughness: 0.62,
    envMapIntensity: 0.85,
  });

  const walls = new THREE.Mesh(wallGeometry, wallMaterial);
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  // --- thin gold bead along the inner lip --------------------------------
  const lipShape = roundedRect(inner.w + 0.06, inner.d + 0.06, TRAY.innerFillet + 0.02);
  const lip = new THREE.Mesh(
    new THREE.TubeGeometry(shapeToCurve(lipShape), 240, 0.035, 8, true),
    new THREE.MeshPhysicalMaterial({
      color: 0x9d7c3c,
      roughness: 0.28,
      metalness: 1,
      envMapIntensity: 1.6,
    }),
  );
  lip.position.y = TRAY.floorY + TRAY.wallHeight;
  group.add(lip);

  // --- pedestal beneath, so the tray reads as an object on a surface ------
  const baseShape = roundedRect(outer.w + 0.5, outer.d + 0.5, 1.5);
  const baseGeometry = extrudeUpright(
    baseShape,
    {
      depth: 0.5,
      bevelEnabled: true,
      bevelThickness: 0.12,
      bevelSize: 0.12,
      bevelSegments: 3,
      curveSegments: 20,
    },
    // Hangs below the floor, so only its lip shows past the wall. The small gap
    // keeps its top face out of the floor plane, which would otherwise z-fight.
    'below',
  );
  baseGeometry.translate(0, TRAY.floorY - 0.06, 0);
  const base = new THREE.Mesh(
    baseGeometry,
    new THREE.MeshPhysicalMaterial({ color: 0x0c0d11, roughness: 0.55, metalness: 0.2, envMapIntensity: 0.5 }),
  );
  base.receiveShadow = true;
  group.add(base);

  // --- ground the tray on something, so it is not floating in a void --------
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(70, 64),
    new THREE.MeshPhysicalMaterial({
      color: 0x08080b,
      roughness: 0.72,
      metalness: 0.15,
      normalMap: leather.normalMap,
      normalScale: new THREE.Vector2(0.25, 0.25),
      envMapIntensity: 0.35,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = TRAY.floorY - 0.78;
  ground.receiveShadow = true;
  group.add(ground);

  return {
    group,
    dispose() {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      });
      felt.normalMap.dispose();
      felt.roughnessMap.dispose();
      leather.normalMap.dispose();
      leather.roughnessMap.dispose();
    },
  };
}

/** Planar UVs picked per-triangle from the dominant normal axis. */
function applyBoxUv(geometry: THREE.BufferGeometry, scale: number) {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = x; v = z;
    } else if (nx >= nz) {
      u = z; v = y;
    } else {
      u = x; v = y;
    }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Samples a flat Shape into an XZ-plane curve for the lip tube. */
function shapeToCurve(shape: THREE.Shape): THREE.CurvePath<THREE.Vector3> {
  const points = shape.getSpacedPoints(240);
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(p.x, 0, p.y)),
    true,
    'catmullrom',
    0.02,
  );
  const path = new THREE.CurvePath<THREE.Vector3>();
  path.add(curve);
  return path;
}
