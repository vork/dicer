import * as THREE from 'three';
import { createFeltMaps, createLeatherMaps } from './textures';
import { applyFloorAoUv, createTrayFloorAo } from './tray-ao';
import type { TrayTextures } from '../assets';
import { addDetailLayer, type DetailLayer } from './detail';

/**
 * How big one tile of each Poly Haven map is on the tray, in world units (one
 * unit is 2cm), for a 1024 map; a 2048 map tiles twice as large, so the texel
 * density on the surface is the same either way and the repeats are fewer.
 *
 * Chosen from the closest shot rather than from life. In the reveal a die is
 * about a fifth of the screen high, some 170 screen pixels a centimetre on a
 * phone at the high tier, and a map is sharp there at about 146 texels a
 * centimetre — a 1024 tile every 7cm. Life size would be 28 texels a
 * centimetre (the cloth is 55.8 pixels a centimetre at 2048), far too soft.
 * The terry loops come out five times finer than life, which is what makes
 * the cloth read as felt nap; the leather grain (51.2 pixels a centimetre at
 * 2048) is four times finer than life and reads as fine-grained leather; the
 * wood (37.2) is far away and fogged, and at 2048 tiles at its true 55cm.
 */
const TILE_UNITS = {
  felt: 3.5,
  leather: 5,
  wood: 13.75,
};

/**
 * One tile of each micro detail map, in world units — a centimetre or two,
 * matching tools/build-detail.mjs. How much of it shows: the slopes are
 * height per unit and already physical, so the bump is one; the tone and
 * roughness variations are kept subtle.
 */
const DETAIL_TILE_UNITS = { felt: 1.0, leather: 0.75, wood: 1.0 };
// The felt's nap is carried by its tone more than its bump — a felt is flat
// to the light — and the leather's photographed grain leads, with the baked
// pebbles only filling in below it.
const DETAIL_LOOK = {
  felt: { bump: 0.6, rough: 0.5, tint: 1.0 },
  leather: { bump: 0.45, rough: 0.4, tint: 0.35 },
  wood: { bump: 0.8, rough: 0.5, tint: 0.6 },
};

/**
 * Surfaces whose 2048 map keeps the 1024 tile size rather than doubling it:
 * twice the texels a centimetre instead of half the repeats. The leather is
 * the one the eye lands on up close, where 100 texels a centimetre blurred
 * past the reveal's 170 screen pixels; at 205 it holds.
 */
const DENSE_LARGE = new Set<keyof typeof TILE_UNITS>(['leather']);

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
  /**
   * What the tray's materials spend per pixel. 'lite' is for a GPU that cannot
   * afford the full look: the ground, which fills most of the frame around the
   * tray, becomes a Lambert surface, and the felt's sheen and the leather's
   * clear coat are dropped. Measured on tools/bench.mjs, that is 22% of the
   * scene pass on the lowest tier.
   */
  setDetail(detail: TrayDetail): void;
  /** The micro detail tiles under the felt, leather and wood: one texture tap each. */
  setMicroDetail(enabled: boolean): void;
  dispose(): void;
}

export type TrayDetail = 'full' | 'lite';

/** Tiles per world unit of the wall's box UVs. */
const WALL_UV_SCALE = 0.28;
/** The ground disc, in world units. */
const GROUND_DIAMETER = 140;

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

export function createTray(textures: TrayTextures | null = null): Tray {
  const group = new THREE.Group();
  // ShapeGeometry hands through the shape's own coordinates as UVs, so for the
  // floor `repeat` reads as tiles per world unit — one tile per ~1.4 units for
  // the procedural felt, which is the fallback when the Poly Haven maps are not
  // built (tools/build-textures.mjs).
  const felt = createFeltMaps(512, 0.7);
  const leather = createLeatherMaps();
  const mapTileUnits: Record<keyof typeof TILE_UNITS, number> = { felt: 0, leather: 0, wood: 0 };
  const tile = (surface: keyof typeof TILE_UNITS, perUnit: number) => {
    const maps = textures?.[surface];
    if (!maps) return;
    const width = (maps.map.image as { width?: number } | undefined)?.width ?? 1024;
    mapTileUnits[surface] = TILE_UNITS[surface] * (DENSE_LARGE.has(surface) ? 1 : width / 1024);
    const repeat = perUnit / mapTileUnits[surface];
    for (const map of [maps.map, maps.normalMap, maps.armMap]) map.repeat.set(repeat, repeat);
  };
  const layers: DetailLayer[] = [];
  const detailOn = (surface: keyof typeof TILE_UNITS, material: THREE.MeshPhysicalMaterial) => {
    const map = textures?.detail[surface];
    if (!map || !mapTileUnits[surface]) return;
    layers.push(
      addDetailLayer(material, {
        map,
        // Detail tiles per diffuse tile.
        scale: mapTileUnits[surface] / DETAIL_TILE_UNITS[surface],
        ...DETAIL_LOOK[surface],
      }),
    );
  };
  // The floor's UVs are world units; the wall's box UVs are 0.28 tiles a unit;
  // the ground's run 0..1 across its 140-unit circle.
  tile('felt', 1);
  tile('leather', 1 / WALL_UV_SCALE);
  tile('wood', GROUND_DIAMETER);

  const inner = { w: TRAY.innerWidth, d: TRAY.innerDepth };
  const outer = { w: inner.w + TRAY.wallThickness * 2, d: inner.d + TRAY.wallThickness * 2 };

  // --- floor -------------------------------------------------------------
  const floorMaterial = new THREE.MeshPhysicalMaterial({
    // The cloth's diffuse is neutralised to half grey by the build, so this is
    // the felt's colour: the slate of the procedural felt, doubled to undo the
    // map's mean.
    color: textures ? 0x2e4058 : 0x17202c,
    roughness: 1,
    metalness: 0,
    map: textures?.felt.map ?? null,
    normalMap: textures?.felt.normalMap ?? felt.normalMap,
    // A felt lies flat to the light; the cloth's loops, five times finer than
    // life here, would otherwise read as a knit.
    normalScale: textures ? new THREE.Vector2(0.5, 0.5) : new THREE.Vector2(1.1, 1.1),
    roughnessMap: textures?.felt.armMap ?? felt.roughnessMap,
    sheen: 0.75,
    sheenRoughness: 0.85,
    sheenColor: new THREE.Color(0x3c5a72),
    envMapIntensity: 0.35,
  });

  const floorShape = roundedRect(inner.w, inner.d, TRAY.innerFillet);
  const floorGeometry = new THREE.ShapeGeometry(floorShape, 24);
  // The felt's own UVs are world coordinates so the grain tiles; the occlusion
  // map must not tile, so it gets a set of its own. `aoMap` reads uv1 by default.
  applyFloorAoUv(floorGeometry, inner.w, inner.d);
  floorMaterial.aoMap = createTrayFloorAo(inner.w, inner.d, TRAY.wallHeight);
  detailOn('felt', floorMaterial);
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
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
  applyBoxUv(wallGeometry, WALL_UV_SCALE);

  const wallMaterial = new THREE.MeshPhysicalMaterial({
    // The leather map carries its own brown; the tint only takes it down to
    // the tray's dark room. Its roughness map averages 0.66, dry for a
    // finished hide, so it is scaled toward the satin a real one has.
    color: textures ? 0xa0948a : 0x322820,
    roughness: textures ? 0.82 : 0.62,
    metalness: 0,
    map: textures?.leather.map ?? null,
    normalMap: textures?.leather.normalMap ?? leather.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: textures?.leather.armMap ?? leather.roughnessMap,
    clearcoat: 0.35,
    clearcoatRoughness: 0.62,
    envMapIntensity: 0.85,
  });

  detailOn('leather', wallMaterial);
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
  // Its top face is under the floor and the walls, never seen, and a GPU with
  // no early depth rejection shades all of it before throwing it away: hiding
  // the whole pedestal took 15% off the scene pass on tools/bench.mjs, and
  // drawing it last changed nothing. So the face is simply not there.
  dropTopFace(baseGeometry);
  const base = new THREE.Mesh(
    baseGeometry,
    new THREE.MeshPhysicalMaterial({ color: 0x0c0d11, roughness: 0.55, metalness: 0.2, envMapIntensity: 0.5 }),
  );
  // No shadow lookups on the pedestal or the ground. Both are nearly black, and
  // the wall's shadow on them measured invisible — a mean difference of 0.03
  // levels — for 4% of the scene pass on tools/bench.mjs.
  base.receiveShadow = false;
  group.add(base);

  // --- ground the tray on something, so it is not floating in a void --------
  const groundMaterial = new THREE.MeshPhysicalMaterial({
    // A worn table under the tray. The photograph is dark already, and the
    // vignette and fog take the edges down further, so it is barely tinted.
    color: textures ? 0xa09890 : 0x08080b,
    roughness: textures ? 1 : 0.72,
    metalness: textures ? 0 : 0.15,
    map: textures?.wood.map ?? null,
    normalMap: textures?.wood.normalMap ?? leather.normalMap,
    normalScale: new THREE.Vector2(textures ? 0.6 : 0.25, textures ? 0.6 : 0.25),
    roughnessMap: textures?.wood.armMap ?? null,
    envMapIntensity: 0.35,
  });
  // The ground covers more of the frame than anything else, so on a slow GPU
  // it is the cheapest shader that still shows the wood.
  const groundLite = new THREE.MeshLambertMaterial({
    color: textures ? 0xa09890 : 0x08080b,
    map: textures?.wood.map ?? null,
  });
  detailOn('wood', groundMaterial);
  const ground = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(new THREE.CircleGeometry(GROUND_DIAMETER / 2, 64), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = TRAY.floorY - 0.78;
  ground.receiveShadow = false;
  group.add(ground);

  const fullSheen = floorMaterial.sheen;
  const fullClearcoat = wallMaterial.clearcoat;
  let detail: TrayDetail = 'full';

  return {
    group,
    setMicroDetail(enabled) {
      for (const layer of layers) layer.setEnabled(enabled);
    },
    setDetail(next) {
      if (next === detail) return;
      detail = next;
      ground.material = next === 'lite' ? groundLite : groundMaterial;
      floorMaterial.sheen = next === 'lite' ? 0 : fullSheen;
      wallMaterial.clearcoat = next === 'lite' ? 0 : fullClearcoat;
    },
    dispose() {
      groundLite.dispose();
      groundMaterial.dispose();
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
      if (textures) {
        for (const surface of [textures.leather, textures.felt, textures.wood]) {
          surface.map.dispose();
          surface.normalMap.dispose();
          surface.armMap.dispose();
        }
        for (const map of Object.values(textures.detail)) map?.dispose();
      }
    },
  };
}

/**
 * Removes the triangles that make up a solid's flat top: every face whose
 * three normals point straight up and whose vertices all sit at the highest y.
 * The bevel around the top is kept; only the cap goes.
 */
function dropTopFace(geometry: THREE.BufferGeometry) {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  let top = -Infinity;
  for (let i = 0; i < position.count; i++) top = Math.max(top, position.getY(i));
  const onTop = (i: number) => normal.getY(i) > 0.999 && position.getY(i) > top - 1e-4;
  const kept: number[] = [];
  const index = geometry.index;
  const triangles = index ? index.count / 3 : position.count / 3;
  for (let t = 0; t < triangles; t++) {
    const a = index ? index.getX(t * 3) : t * 3;
    const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    if (onTop(a) && onTop(b) && onTop(c)) continue;
    kept.push(a, b, c);
  }
  geometry.setIndex(kept);
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
