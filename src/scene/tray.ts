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
   * How far inside the nominal opening the leather stands. The nominal figures
   * size the felt, the lights and the throws; the wall's cross-section starts
   * this far inside them and runs `wallThickness` plus twice this outward, so
   * the wall you see is ~23 mm thick and the play area is the opening less
   * this all round — see PLAY.
   */
  wallInset: 0.16,
  /** Radius of the roundover along the top of the wall, inside and out. */
  rimRadius: 0.4,
  floorY: 0,
};

/**
 * Where a die may actually come to rest: the surface a player can see, not the
 * nominal opening.
 *
 * The wall's inner face stands `wallInset` inside `innerWidth / 2`, with the
 * fillet shrunk to match. Colliders built on the nominal figure would let every
 * die resting against a wall sink that far into it, and more at a corner. The
 * wall is swept from these same figures, and `npm run verify:tray` measures
 * both the built geometry and the physics world rather than trusting either.
 */
export const PLAY = {
  halfWidth: TRAY.innerWidth / 2 - TRAY.wallInset,
  halfDepth: TRAY.innerDepth / 2 - TRAY.wallInset,
  fillet: TRAY.innerFillet - TRAY.wallInset,
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
/** How far below the felt the pedestal's ledge sits, so the wall's foot stands on it. */
const PEDESTAL_DROP = 0.06;

/**
 * A point on a cross-section swept around the opening: how far outside the
 * nominal opening it stands, its height, and the section's outward normal there.
 */
interface ProfilePoint {
  d: number;
  y: number;
  nd: number;
  ny: number;
}

/** Segments on each of the four corner arcs of a swept ring. */
const CORNER_SEGMENTS = 24;

/**
 * The opening's outline grown by `offset` on every side: the same corner
 * centres, straight sides of the same length, corner arcs of a larger radius.
 * Every ring so built has the same number of points, at the same parameters,
 * so rings at different offsets can be joined into a surface.
 *
 * True arcs, not the quadratic curves `roundedRect` draws: the colliders stand
 * in for arcs of `PLAY.fillet`, and the wall has to be the surface they
 * approximate.
 */
function ring(offset: number): { x: number; z: number; ox: number; oz: number }[] {
  const cx = TRAY.innerWidth / 2 - TRAY.innerFillet;
  const cz = TRAY.innerDepth / 2 - TRAY.innerFillet;
  const radius = TRAY.innerFillet + offset;
  const points: { x: number; z: number; ox: number; oz: number }[] = [];
  const corners = [
    [cx, cz],
    [-cx, cz],
    [-cx, -cz],
    [cx, -cz],
  ];
  corners.forEach(([px, pz], corner) => {
    for (let i = 0; i <= CORNER_SEGMENTS; i++) {
      const angle = ((corner + i / CORNER_SEGMENTS) * Math.PI) / 2;
      const ox = Math.cos(angle);
      const oz = Math.sin(angle);
      points.push({ x: px + radius * ox, z: pz + radius * oz, ox, oz });
    }
  });
  return points;
}

/**
 * Sweeps a cross-section around the opening into a surface: one ring per
 * profile point, quads between neighbouring rings.
 *
 * Normals come from the profile, not from the triangles, so a roundover shades
 * as the curve it is rather than as the facets that approximate it. The UVs
 * unwrap the sweep the way a hide is wrapped over a rim: u runs around the
 * tray, an exact whole number of tiles so the seam closes, and v runs across
 * the section from its first point, both in world units times `uvScale`. Rings
 * at different offsets have different perimeters and one u between them, so
 * the grain is compressed a little around the inner corners and stretched
 * around the outer ones; u follows the ring whose corner radius is the
 * geometric mean of the two extremes, which splits the difference.
 */
function sweepAroundOpening(profile: ProfilePoint[], uvScale: number): THREE.BufferGeometry {
  const around = ring(0).length;
  const columns = around + 1;

  const offsets = profile.map((p) => p.d);
  const reference = Math.sqrt(
    (TRAY.innerFillet + Math.min(...offsets)) * (TRAY.innerFillet + Math.max(...offsets)),
  );
  const guide = ring(reference - TRAY.innerFillet);
  const along: number[] = [0];
  for (let i = 0; i < around; i++) {
    const a = guide[i];
    const b = guide[(i + 1) % around];
    along.push(along[i] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const perimeter = along[around];
  const tiles = Math.max(1, Math.round(perimeter * uvScale));
  const u = along.map((s) => (tiles * s) / perimeter);

  const across: number[] = [0];
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    across.push(across[i - 1] + Math.hypot(b.d - a.d, b.y - a.y));
  }

  const rows = profile.length;
  const position = new Float32Array(rows * columns * 3);
  const normal = new Float32Array(rows * columns * 3);
  const uv = new Float32Array(rows * columns * 2);
  profile.forEach((point, row) => {
    const points = ring(point.d);
    for (let column = 0; column < columns; column++) {
      const p = points[column % around];
      const at = row * columns + column;
      position[at * 3] = p.x;
      position[at * 3 + 1] = point.y;
      position[at * 3 + 2] = p.z;
      normal[at * 3] = point.nd * p.ox;
      normal[at * 3 + 1] = point.ny;
      normal[at * 3 + 2] = point.nd * p.oz;
      uv[at * 2] = u[column];
      uv[at * 2 + 1] = across[row] * uvScale;
    }
  });

  const index: number[] = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns + 1;
      const d = a + columns;
      index.push(a, b, c, a, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

/** A quarter circle of the profile, from the direction `from` to `to`, with the normals along it. */
function roundover(
  centreD: number,
  centreY: number,
  radius: number,
  from: number,
  to: number,
  segments: number,
): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = from + ((to - from) * i) / segments;
    const nd = Math.cos(angle);
    const ny = Math.sin(angle);
    points.push({ d: centreD + radius * nd, y: centreY + radius * ny, nd, ny });
  }
  return points;
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
  // A cross-section swept around the opening: the inner face rises from the
  // felt, rolls over the top in a quarter circle, crosses the flat of the rim,
  // rolls down the outside and stops on the pedestal. One smooth surface, so
  // the rim reads as a rounded edge rather than a run of chamfers.
  const rim = TRAY.rimRadius;
  const top = TRAY.floorY + TRAY.wallHeight;
  const insideD = -TRAY.wallInset;
  const outsideD = TRAY.wallThickness + TRAY.wallInset;
  const footY = TRAY.floorY - PEDESTAL_DROP;
  const footRadius = 0.08;
  const wallProfile: ProfilePoint[] = [
    { d: insideD, y: TRAY.floorY, nd: -1, ny: 0 },
    ...roundover(insideD + rim, top - rim, rim, Math.PI, Math.PI / 2, 12),
    ...roundover(outsideD - rim, top - rim, rim, Math.PI / 2, 0, 12),
    ...roundover(outsideD - footRadius, footY + footRadius, footRadius, 0, -Math.PI / 2, 3),
  ];
  const wallGeometry = sweepAroundOpening(wallProfile, WALL_UV_SCALE);

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
  // Piping laid into the crown of the inner roundover, half sunk into the
  // leather, so it catches the light as a line along the rim.
  const crown = Math.PI / 4;
  const lipPoints = ring(insideD + rim - rim * Math.cos(crown)).map((p) => new THREE.Vector3(p.x, 0, p.z));
  const lip = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lipPoints, true, 'centripetal'), 240, 0.035, 8, true),
    new THREE.MeshPhysicalMaterial({
      color: 0x9d7c3c,
      roughness: 0.28,
      metalness: 1,
      envMapIntensity: 1.6,
    }),
  );
  lip.position.y = top - rim + rim * Math.sin(crown);
  group.add(lip);

  // --- pedestal beneath, so the tray reads as an object on a surface ------
  // Only its ledge and rounded edge can ever be seen, so that is all there is:
  // a ledge tucked under the wall's foot, an edge, and a side down to the
  // table. A closed solid's top face would run under the whole floor, and a
  // GPU with no early depth rejection shades all of it before throwing it
  // away — hiding the old pedestal took 15% off the scene pass on
  // tools/bench.mjs.
  const ledge = 0.25;
  const edgeRadius = 0.12;
  const baseProfile: ProfilePoint[] = [
    { d: outsideD - 0.05, y: footY, nd: 0, ny: 1 },
    ...roundover(outsideD + ledge - edgeRadius, footY - edgeRadius, edgeRadius, Math.PI / 2, 0, 4),
    { d: outsideD + ledge, y: footY - 0.5, nd: 1, ny: 0 },
  ];
  const baseGeometry = sweepAroundOpening(baseProfile, 1);
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


