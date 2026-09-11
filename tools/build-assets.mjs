/**
 * Turns the source Sketchfab dice GLB into the runtime assets the app ships:
 *
 *   public/dice/dice.glb          one centred, unit-scaled mesh per die type
 *   public/dice/faces.json        face normals / centroids / hull points per die type
 *   .calibration/faces-uv.json    UV islands, for the calibration tools only
 *   public/dice/sets/<id>-*.webp  re-encoded PBR textures, one triple per colourway
 *   public/dice/sets.json         colourway manifest
 *
 * The source file holds seven identical dice sets that differ only by texture, so
 * geometry is extracted once from whichever set has it and shared by all of them.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { MICRO_TILES_AROUND, bakeEdge, bakeFace, bakeMicro, bakeOutlineHeight, distanceTransform, downsample, rasteriseRaised } from './coin-surface.mjs';
import { readGlb, readAccessor, readImage, matrixScale, writeGlb } from './glb.mjs';

const SOURCE = process.argv[2] || '/root/.claude/uploads/80492aad-1b8b-5ad8-b105-0b761a0e5602/7bfb6e53-rpg_dice_set_1.glb';
const COIN_SOURCE =
  process.argv[3] || '/root/.claude/uploads/80492aad-1b8b-5ad8-b105-0b761a0e5602/155cae1a-coin20dragon20head20tail.stl';
const OUT_DIR = path.resolve('public/dice');
const SETS_DIR = path.join(OUT_DIR, 'sets');

// Die type is unambiguous from triangle+vertex count in this source file.
const DIE_BY_SIGNATURE = {
  '4:12': 'd4',
  '12:24': 'd6',
  '8:24': 'd8',
  '20:40': 'd10',
  '36:60': 'd12',
  '20:60': 'd20',
};
const DIE_ORDER = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'];

// A d20 measures ~20mm across; scaling it to 1.0 makes one world unit ~= 20mm,
// which keeps Rapier in a numerically comfortable range while staying physical.
const TARGET_D20_WIDTH = 1.0;

const HUMAN_SET_NAMES = {};
// The coin is struck from a different metal for each colourway, so the one
// row of swatches dresses the whole pool. Gold on the first, which is the
// default; the rest paired to the dice by feel — verdigris bronze with the
// green set, copper with the orange, iron with the grey.
const SET_METALS = {
  set1: 'gold',
  set2: 'bronze',
  set3: 'silver',
  set4: 'roseGold',
  set5: 'iron',
  set6: 'electrum',
  set7: 'copper',
};

/**
 * Reads a binary STL as a flat, unindexed triangle list. STL normals are advisory
 * and often garbage, so winding is checked against them once and the whole mesh
 * is flipped if the file was authored inside-out.
 */
function readStl(file) {
  const data = fs.readFileSync(file);
  const count = data.readUInt32LE(80);
  const position = new Float32Array(count * 9);
  let agree = 0;
  for (let t = 0; t < count; t++) {
    const off = 84 + t * 50;
    const nx = data.readFloatLE(off), ny = data.readFloatLE(off + 4), nz = data.readFloatLE(off + 8);
    for (let k = 0; k < 9; k++) position[t * 9 + k] = data.readFloatLE(off + 12 + k * 4);
    const p = position.subarray(t * 9, t * 9 + 9);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz > 0) agree++;
  }
  if (agree < count / 2) {
    for (let t = 0; t < count; t++) {
      const a = t * 9 + 3;
      for (let k = 0; k < 3; k++) {
        const tmp = position[a + k];
        position[a + k] = position[a + 3 + k];
        position[a + 3 + k] = tmp;
      }
    }
  }
  return position;
}

/**
 * Welds coincident corners into shared vertices and smooths normals across
 * shallow angles, splitting at anything sharper than `creaseDegrees`.
 *
 * A coin needs both: a rim that is one smooth curve, since polished metal shows
 * every facet, and relief edges that stay crisp rather than melting into the
 * field. Per-corner smoothing over the neighbours within the crease angle gives
 * the first; the split at the crease gives the second.
 */
function weld(position, creaseDegrees) {
  const triangles = position.length / 9;
  // Unnormalised: twice the area times the normal, so the average is area-weighted.
  const faceNormal = new Float64Array(triangles * 3);
  const unit = new Float64Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const p = position.subarray(t * 9, t * 9 + 9);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    faceNormal[t * 3] = nx;
    faceNormal[t * 3 + 1] = ny;
    faceNormal[t * 3 + 2] = nz;
    const l = Math.hypot(nx, ny, nz) || 1;
    unit[t * 3] = nx / l;
    unit[t * 3 + 1] = ny / l;
    unit[t * 3 + 2] = nz / l;
  }
  const key = (i) => `${position[i].toFixed(4)},${position[i + 1].toFixed(4)},${position[i + 2].toFixed(4)}`;

  // Smoothing groups. Two faces that share an edge and meet at less than the
  // crease are in one group, and a corner's normal is the average of every face
  // of its group at that position. Averaging each corner against whatever faces
  // happened to lie within the crease of its own face — the usual shortcut — is
  // not the same thing: on an irregularly faceted surface the two faces either
  // side of an edge see different sets, get different normals for the same
  // point, and the edge shows as a seam. The coin's rim had a dozen of them.
  const parent = new Int32Array(triangles);
  for (let t = 0; t < triangles; t++) parent[t] = t;
  const find = (t) => {
    while (parent[t] !== t) {
      parent[t] = parent[parent[t]];
      t = parent[t];
    }
    return t;
  };
  const cosCrease = Math.cos((creaseDegrees * Math.PI) / 180);
  const edges = new Map();
  for (let t = 0; t < triangles; t++) {
    for (let c = 0; c < 3; c++) {
      const a = key(t * 9 + c * 3);
      const b = key(t * 9 + ((c + 1) % 3) * 3);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      const other = edges.get(e);
      if (other === undefined) {
        edges.set(e, t);
        continue;
      }
      const dot = unit[t * 3] * unit[other * 3] + unit[t * 3 + 1] * unit[other * 3 + 1] + unit[t * 3 + 2] * unit[other * 3 + 2];
      if (dot >= cosCrease) parent[find(t)] = find(other);
    }
  }

  const sums = new Map();
  for (let t = 0; t < triangles; t++) {
    const g = find(t);
    for (let c = 0; c < 3; c++) {
      const k = `${key(t * 9 + c * 3)}|${g}`;
      let sum = sums.get(k);
      if (!sum) sums.set(k, (sum = [0, 0, 0]));
      sum[0] += faceNormal[t * 3];
      sum[1] += faceNormal[t * 3 + 1];
      sum[2] += faceNormal[t * 3 + 2];
    }
  }

  const outPosition = [];
  const outNormal = [];
  const index = new Uint32Array(triangles * 3);
  const cache = new Map();
  for (let t = 0; t < triangles; t++) {
    const g = find(t);
    for (let c = 0; c < 3; c++) {
      const i = t * 9 + c * 3;
      const k = `${key(i)}|${g}`;
      let v = cache.get(k);
      if (v === undefined) {
        const [nx, ny, nz] = sums.get(k);
        const l = Math.hypot(nx, ny, nz) || 1;
        v = outPosition.length / 3;
        cache.set(k, v);
        outPosition.push(position[i], position[i + 1], position[i + 2]);
        outNormal.push(nx / l, ny / l, nz / l);
      }
      index[t * 3 + c] = v;
    }
  }
  return { position: Float32Array.from(outPosition), normal: Float32Array.from(outNormal), index };
}

function centroidOfConvexMesh(position, index) {
  // Exact volume centroid via signed tetrahedra from the origin.
  let volume = 0;
  const acc = [0, 0, 0];
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;
    const ax = position[a], ay = position[a + 1], az = position[a + 2];
    const bx = position[b], by = position[b + 1], bz = position[b + 2];
    const cx = position[c], cy = position[c + 1], cz = position[c + 2];
    const v =
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    volume += v;
    acc[0] += v * (ax + bx + cx) / 4;
    acc[1] += v * (ay + by + cy) / 4;
    acc[2] += v * (az + bz + cz) / 4;
  }
  return [acc[0] / volume, acc[1] / volume, acc[2] / volume];
}

/** Merge coplanar triangles into the polygonal faces a player actually reads. */
function groupFaces(position, uv, index) {
  const triangles = [];
  for (let i = 0; i < index.length; i += 3) {
    const [ia, ib, ic] = [index[i], index[i + 1], index[i + 2]];
    const a = [position[ia * 3], position[ia * 3 + 1], position[ia * 3 + 2]];
    const b = [position[ib * 3], position[ib * 3 + 1], position[ib * 3 + 2]];
    const c = [position[ic * 3], position[ic * 3 + 1], position[ic * 3 + 2]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(...n);
    n = [n[0] / len, n[1] / len, n[2] / len];
    const plane = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    triangles.push({ verts: [ia, ib, ic], normal: n, plane, area: len / 2 });
  }

  const faces = [];
  for (const tri of triangles) {
    const match = faces.find(
      (f) =>
        f.normal[0] * tri.normal[0] + f.normal[1] * tri.normal[1] + f.normal[2] * tri.normal[2] > 0.9995 &&
        Math.abs(f.plane - tri.plane) < 1e-3,
    );
    if (match) match.triangles.push(tri);
    else faces.push({ normal: [...tri.normal], plane: tri.plane, triangles: [tri] });
  }

  return faces.map((face) => {
    // Area-weighted normal and centroid so the values are robust to triangulation.
    const n = [0, 0, 0];
    let area = 0;
    const verts = new Set();
    for (const tri of face.triangles) {
      for (let k = 0; k < 3; k++) n[k] += tri.normal[k] * tri.area;
      area += tri.area;
      tri.verts.forEach((v) => verts.add(v));
    }
    const nl = Math.hypot(...n);
    const normal = [n[0] / nl, n[1] / nl, n[2] / nl];

    const vertexList = [...verts];
    const centroid = [0, 0, 0];
    let extent = 0;
    const uvCentroid = [0, 0];
    const uvMin = [Infinity, Infinity];
    const uvMax = [-Infinity, -Infinity];
    for (const v of vertexList) {
      for (let k = 0; k < 3; k++) centroid[k] += position[v * 3 + k] / vertexList.length;
      const u = uv[v * 2];
      const w = uv[v * 2 + 1];
      uvCentroid[0] += u / vertexList.length;
      uvCentroid[1] += w / vertexList.length;
      uvMin[0] = Math.min(uvMin[0], u);
      uvMin[1] = Math.min(uvMin[1], w);
      uvMax[0] = Math.max(uvMax[0], u);
      uvMax[1] = Math.max(uvMax[1], w);
    }
    for (const v of vertexList) {
      extent = Math.max(
        extent,
        Math.hypot(position[v * 3] - centroid[0], position[v * 3 + 1] - centroid[1], position[v * 3 + 2] - centroid[2]),
      );
    }

    return {
      normal,
      centroid,
      area,
      extent,
      uvCentroid,
      uvMin,
      uvMax,
      uvPolygon: vertexList.map((v) => [uv[v * 2], uv[v * 2 + 1]]),
      vertices: vertexList,
    };
  });
}

/** Unique corner points of the hull, for the physics collider and d4 apex lookup. */
function uniqueVertices(position) {
  const seen = new Map();
  const out = [];
  for (let i = 0; i < position.length; i += 3) {
    const key = [position[i], position[i + 1], position[i + 2]].map((v) => v.toFixed(4)).join(',');
    if (seen.has(key)) continue;
    seen.set(key, true);
    out.push([position[i], position[i + 1], position[i + 2]]);
  }
  return out;
}

async function main() {
  const glb = readGlb(SOURCE);
  const { json } = glb;

  fs.mkdirSync(SETS_DIR, { recursive: true });

  // Map every mesh to its owning node (which carries the scale) and its material.
  const meshInfo = new Map();
  for (const node of json.nodes) {
    if (!node.children) continue;
    for (const childIndex of node.children) {
      const child = json.nodes[childIndex];
      if (child.mesh === undefined) continue;
      meshInfo.set(child.mesh, { scale: matrixScale(node.matrix), node: node.name });
    }
  }

  // One representative mesh per die type, plus the material list per colourway.
  const representative = new Map();
  const materialMeshes = new Map();
  json.meshes.forEach((mesh, meshIndex) => {
    const primitive = mesh.primitives[0];
    const triangles = json.accessors[primitive.indices].count / 3;
    const vertices = json.accessors[primitive.attributes.POSITION].count;
    const die = DIE_BY_SIGNATURE[`${triangles}:${vertices}`];
    if (!die) throw new Error(`unrecognised die signature ${triangles}:${vertices} on mesh ${meshIndex}`);
    if (!representative.has(die)) representative.set(die, meshIndex);
    if (!materialMeshes.has(primitive.material)) materialMeshes.set(primitive.material, []);
    materialMeshes.get(primitive.material).push({ meshIndex, die });
  });

  // Pass one: raw extraction so we can work out the shared world scale.
  const raw = {};
  for (const die of DIE_ORDER) {
    const meshIndex = representative.get(die);
    const primitive = json.meshes[meshIndex].primitives[0];
    const nodeScale = meshInfo.get(meshIndex).scale * 0.01; // 0.01 is the fbx import scale on the root
    const position = Float32Array.from(readAccessor(glb, primitive.attributes.POSITION), (v) => v * nodeScale);
    const normal = Float32Array.from(readAccessor(glb, primitive.attributes.NORMAL));
    const uv = Float32Array.from(readAccessor(glb, primitive.attributes.TEXCOORD_0));
    const index = Uint32Array.from(readAccessor(glb, primitive.indices));
    raw[die] = { position, normal, uv, index, meshIndex };
  }

  const d20 = raw.d20.position;
  let d20Width = 0;
  for (let axis = 0; axis < 3; axis++) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = axis; i < d20.length; i += 3) {
      min = Math.min(min, d20[i]);
      max = Math.max(max, d20[i]);
    }
    d20Width = Math.max(d20Width, max - min);
  }
  const worldScale = TARGET_D20_WIDTH / d20Width;

  // Pass two: centre, scale, group faces.
  const geometries = [];
  const faceData = {};
  const uvData = {};
  for (const die of DIE_ORDER) {
    const { position, normal, uv, index } = raw[die];
    for (let i = 0; i < position.length; i++) position[i] *= worldScale;
    const centre = centroidOfConvexMesh(position, index);
    for (let i = 0; i < position.length; i += 3) {
      position[i] -= centre[0];
      position[i + 1] -= centre[1];
      position[i + 2] -= centre[2];
    }

    const faces = groupFaces(position, uv, index);
    const hull = uniqueVertices(position);

    let radius = 0;
    let inradius = Infinity;
    for (const v of hull) radius = Math.max(radius, Math.hypot(...v));
    for (const f of faces) inradius = Math.min(inradius, Math.hypot(...f.centroid));

    geometries.push({ name: die, position, normal, uv, index });
    const round = (v) => +v.toFixed(6);
    faceData[die] = {
      radius: round(radius),
      inradius: round(inradius),
      hull: hull.map((v) => v.map(round)),
      faces: faces.map((f) => ({
        normal: f.normal.map(round),
        centroid: f.centroid.map(round),
        extent: round(f.extent),
      })),
    };
    uvData[die] = {
      faces: faces.map((f) => ({
        uvCentroid: f.uvCentroid.map(round),
        uvMin: f.uvMin.map(round),
        uvMax: f.uvMax.map(round),
        uvPolygon: f.uvPolygon.map((p) => p.map(round)),
      })),
    };
    console.log(
      `${die}: ${faces.length} faces, ${hull.length} hull points, radius ${radius.toFixed(3)}, inradius ${inradius.toFixed(3)}`,
    );
  }

  // --- the coin ---------------------------------------------------------------
  //
  // A separate source: a 25mm coin with a dragon in relief on each face, as an STL
  // in millimetres. One world unit is 20mm, so it comes in at 1.25 across.
  {
    const raw = readStl(COIN_SOURCE);
    // Its axis is Z in the file; the dice are read against world up, so the coin
    // wants Y. (x, y, z) -> (x, z, -y) is a rotation, not a reflection, so the
    // winding survives.
    for (let i = 0; i < raw.length; i += 3) {
      const y = raw[i + 1];
      raw[i + 1] = raw[i + 2];
      raw[i + 2] = -y;
    }
    for (let i = 0; i < raw.length; i++) raw[i] *= 0.05;

    const { position, normal, index } = weld(raw, 42);
    const centre = centroidOfConvexMesh(position, index);
    for (let i = 0; i < position.length; i += 3) {
      position[i] -= centre[0];
      position[i + 1] -= centre[1];
      position[i + 2] -= centre[2];
    }

    let rim = 0;
    let top = 0;
    for (let i = 0; i < position.length; i += 3) {
      rim = Math.max(rim, Math.hypot(position[i], position[i + 2]));
      top = Math.max(top, Math.abs(position[i + 1]));
    }
    // The relief stands proud of a recessed field. Find the field by looking for
    // the most populated height below the top; the gap between them is how deep
    // the recesses are, and that is what the weathering keys off.
    const levels = new Map();
    for (let i = 1; i < position.length; i += 3) {
      const h = Math.abs(position[i]);
      if (h > top - 0.004) continue;
      const bin = Math.round(h / 0.002) * 0.002;
      levels.set(bin, (levels.get(bin) || 0) + 1);
    }
    const measuredField = [...levels.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const measuredDepth = Math.max(top - measuredField, 0.01);

    // The model's relief is a millimetre deep on a 25mm coin, which is four
    // times what a struck coin carries and read as a stamping rather than a
    // coin. Everything above the field is compressed toward the top by this
    // factor — the field rises, the rim and the relief's tops stay where they
    // are — so the coin keeps its thickness and its rim height and only the
    // relief shallows. The side's ring at the field's height moves with it.
    const RELIEF = 0.35;
    for (let i = 1; i < position.length; i += 3) {
      const y = position[i];
      if (Math.abs(y) < measuredField - 0.002) continue;
      position[i] = Math.sign(y) * (top - (top - Math.abs(y)) * RELIEF);
    }
    const depth = measuredDepth * RELIEF;
    const field = top - depth;

    // One channel the shader reads as weathering rather than as texture space.
    // The coin carries no texture, so the UV slot is free.
    //
    // u: how deep into a recess a point is — 0 on the rim and the raised relief,
    //    1 on the field. Every wall has a vertex at its top and one at its foot,
    //    so this interpolates correctly down the wall.
    const vertexCount = position.length / 3;
    const uv = new Float32Array(vertexCount * 2);
    const cavityOf = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2];
      const r = Math.hypot(x, z);
      // The coin's outer side, by its normal as well as its radius. The side is
      // not a perfect cylinder — its radius wanders by over a percent — and it
      // has a vertex ring part-way down, at the field's height; a ring vertex
      // that fell just inside the radius test was given the field's cavity of
      // 1, the quads below it interpolated that, and the shader toned them dark
      // like the field: rectangular blocks on the rim, hard-edged between
      // quads, with a level top at the ring.
      const sideways = Math.abs(normal[i * 3 + 1]) < 0.5 && r > rim * 0.9;
      const onRim = r > rim * 0.985 || sideways;
      const cavity = onRim ? 0 : Math.min(1, Math.max(0, (top - Math.abs(y)) / depth));
      uv[i * 2] = cavity;
      cavityOf[i] = cavity;
    }

    // How far each point of the field is from the foot of a wall — the base of
    // the relief or of the rim — is where dirt gathers and where the light does
    // not reach, and it is the difference between a coin that looks worn and a
    // coin whose field has been painted brown. It cannot ride on the vertices:
    // the field is flat, so its only vertices are the ones on the wall feet
    // themselves, and a per-vertex distance came out as 1 everywhere. So it is
    // baked as a small texture instead, one channel per face, that the shader
    // samples by the coin's own x and z. Raised tops are rasterised into a mask
    // and the field is the distance from it.
    //
    // The same masks drive the surface bake (see coin-surface.mjs): the slope
    // maps that round the relief's edges, and cut the scratches and dents.
    const SURFACE_SIZE = 512;
    // The outline is rasterised and its distances taken at this size, and the
    // heights that follow from it filtered down to the map's: a distance field
    // off a binary outline is a staircase at texel scale.
    const OUTLINE_SIZE = 2048;
    const WEAR_SIZE = 256;
    // The textures span this many units either side of the axis, for every
    // coin, so nothing has to be told the coin's radius to read them.
    const WEAR_EXTENT = 0.7;
    if (rim > WEAR_EXTENT) throw new Error(`coin radius ${rim} exceeds the wear texture's ${WEAR_EXTENT}`);
    // Distances are stored as a fraction of this, so 255 is this far from any wall.
    const WEAR_RANGE = 0.25;
    const wear = Buffer.alloc(WEAR_SIZE * WEAR_SIZE * 3);
    const faceMaps = [];
    for (const [channel, side] of [[0, 1], [1, -1]]) {
      const raised = rasteriseRaised({ position, index, cavityOf, side, rim, size: OUTLINE_SIZE, extent: WEAR_EXTENT });
      const distance = distanceTransform(raised, OUTLINE_SIZE, OUTLINE_SIZE);
      const texel = (2 * WEAR_EXTENT) / OUTLINE_SIZE;
      const fraction = new Float64Array(OUTLINE_SIZE * OUTLINE_SIZE);
      for (let i = 0; i < fraction.length; i++) fraction[i] = Math.min(1, (distance[i] * texel) / WEAR_RANGE);
      const wearField = downsample(fraction, OUTLINE_SIZE, OUTLINE_SIZE / WEAR_SIZE);
      for (let i = 0; i < WEAR_SIZE * WEAR_SIZE; i++) wear[i * 3 + channel] = Math.round(wearField[i] * 255);
      const outline = bakeOutlineHeight({ raised, size: OUTLINE_SIZE, extent: WEAR_EXTENT, rim });
      const baseHeight = downsample(outline, OUTLINE_SIZE, OUTLINE_SIZE / SURFACE_SIZE);
      faceMaps.push(bakeFace({ baseHeight, size: SURFACE_SIZE, extent: WEAR_EXTENT, rim, seed: 11 + channel * 97 }));
    }
    await sharp(wear, { raw: { width: WEAR_SIZE, height: WEAR_SIZE, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toFile(path.join(OUT_DIR, 'coin-wear.png'));

    // The two faces side by side in one atlas, heads on the left; the edge as a
    // strip. Lossless: a slope map does not survive a lossy codec.
    const atlas = Buffer.alloc(SURFACE_SIZE * 2 * SURFACE_SIZE * 4);
    for (let y = 0; y < SURFACE_SIZE; y++) {
      faceMaps[0].copy(atlas, y * SURFACE_SIZE * 2 * 4, y * SURFACE_SIZE * 4, (y + 1) * SURFACE_SIZE * 4);
      faceMaps[1].copy(atlas, (y * SURFACE_SIZE * 2 + SURFACE_SIZE) * 4, y * SURFACE_SIZE * 4, (y + 1) * SURFACE_SIZE * 4);
    }
    await sharp(atlas, { raw: { width: SURFACE_SIZE * 2, height: SURFACE_SIZE, channels: 4 } })
      .webp({ lossless: true })
      .toFile(path.join(OUT_DIR, 'coin-surface.webp'));
    const EDGE_WIDTH = 2048;
    const EDGE_HEIGHT = 128;
    await sharp(bakeEdge({ width: EDGE_WIDTH, height: EDGE_HEIGHT, rim, top, seed: 5 }), {
      raw: { width: EDGE_WIDTH, height: EDGE_HEIGHT, channels: 4 },
    })
      .webp({ lossless: true })
      .toFile(path.join(OUT_DIR, 'coin-edge.webp'));
    // The micro tile: sized so a whole number of them go around the edge.
    const MICRO_SIZE = 256;
    const microTile = (2 * Math.PI * rim) / MICRO_TILES_AROUND;
    await sharp(bakeMicro({ size: MICRO_SIZE, tile: microTile, seed: 21 }), { raw: { width: MICRO_SIZE, height: MICRO_SIZE, channels: 4 } })
      .webp({ lossless: true })
      .toFile(path.join(OUT_DIR, 'coin-micro.webp'));
    // One unit is 20mm, so this is real micrometres.
    console.log(`coin micro tile: ${microTile.toFixed(4)} units, ${((microTile / MICRO_SIZE) * 20000).toFixed(1)} µm per texel`);

    // Reads from the two flat faces only. The collider is a cylinder rather than
    // the hull, so the physics never sees the relief; the hull here is a ring for
    // anything that reads it for extent.
    const ring = [];
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      ring.push([Math.cos(a) * rim, top, Math.sin(a) * rim], [Math.cos(a) * rim, -top, Math.sin(a) * rim]);
    }
    const round = (v) => +v.toFixed(6);
    geometries.push({ name: 'coin', position, normal, uv, index });
    faceData.coin = {
      radius: round(Math.hypot(rim, top)),
      inradius: round(top),
      hull: ring.map((v) => v.map(round)),
      faces: [
        { normal: [0, 1, 0], centroid: [0, round(top), 0], extent: round(rim) },
        { normal: [0, -1, 0], centroid: [0, round(-top), 0], extent: round(rim) },
      ],
    };
    uvData.coin = { faces: [] };
    console.log(
      `coin: ${index.length / 3} triangles, ${position.length / 3} vertices after welding, ` +
        `radius ${rim.toFixed(3)}, half thickness ${top.toFixed(3)}, relief ${depth.toFixed(3)} deep`,
    );
  }

  const glbBytes = writeGlb(path.join(OUT_DIR, 'dice.glb'), geometries);
  console.log(`\ndice.glb: ${(glbBytes / 1024).toFixed(1)} KB`);

  // Textures. Normal maps are byte-identical across several colourways, so dedupe.
  const normalHashes = new Map();
  const sets = [];
  const materialIndices = [...materialMeshes.keys()].sort((a, b) => a - b);

  for (let i = 0; i < materialIndices.length; i++) {
    const materialIndex = materialIndices[i];
    const material = json.materials[materialIndex];
    const id = `set${i + 1}`;
    const pbr = material.pbrMetallicRoughness;

    const baseColorImage = json.textures[pbr.baseColorTexture.index].source;
    const roughnessImage = json.textures[pbr.metallicRoughnessTexture.index].source;
    const normalImage = json.textures[material.normalTexture.index].source;

    const baseColorFile = `${id}-basecolor.webp`;
    await sharp(readImage(glb, baseColorImage)).webp({ quality: 90 }).toFile(path.join(SETS_DIR, baseColorFile));

    // glTF packs roughness in G; ship it as a single grey channel to save bytes.
    const roughnessFile = `${id}-roughness.webp`;
    await sharp(readImage(glb, roughnessImage))
      .extractChannel('green')
      .webp({ quality: 85 })
      .toFile(path.join(SETS_DIR, roughnessFile));

    const normalBuffer = readImage(glb, normalImage);
    const hash = crypto.createHash('md5').update(normalBuffer).digest('hex');
    let normalFile = normalHashes.get(hash);
    if (!normalFile) {
      normalFile = `normal-${hash.slice(0, 8)}.webp`;
      await sharp(normalBuffer).webp({ quality: 94 }).toFile(path.join(SETS_DIR, normalFile));
      normalHashes.set(hash, normalFile);
    }

    // Average colour of the base map, for the picker swatches.
    const stats = await sharp(readImage(glb, baseColorImage)).stats();
    const swatch =
      '#' +
      stats.channels
        .slice(0, 3)
        .map((c) => Math.round(c.mean).toString(16).padStart(2, '0'))
        .join('');

    sets.push({
      id,
      name: HUMAN_SET_NAMES[id] || `Set ${i + 1}`,
      swatch,
      metal: SET_METALS[id] || 'gold',
      baseColor: `sets/${baseColorFile}`,
      roughness: `sets/${roughnessFile}`,
      normal: `sets/${normalFile}`,
    });
    console.log(`${id}: material ${material.name} swatch ${swatch}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'faces.json'), JSON.stringify(faceData));
  // UV islands are only needed by tools/face-sheets.mjs, so keep them out of the bundle.
  fs.mkdirSync('.calibration', { recursive: true });
  fs.writeFileSync(path.join('.calibration', 'faces-uv.json'), JSON.stringify(uvData));
  fs.writeFileSync(path.join(OUT_DIR, 'sets.json'), JSON.stringify(sets, null, 2));

  const totalTextureBytes = fs
    .readdirSync(SETS_DIR)
    .reduce((sum, f) => sum + fs.statSync(path.join(SETS_DIR, f)).size, 0);
  console.log(`\ntextures: ${(totalTextureBytes / 1024 / 1024).toFixed(2)} MB across ${fs.readdirSync(SETS_DIR).length} files`);
  console.log(`faces.json: ${(fs.statSync(path.join(OUT_DIR, 'faces.json')).size / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
