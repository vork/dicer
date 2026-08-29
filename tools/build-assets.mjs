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
import { readGlb, readAccessor, readImage, matrixScale, writeGlb } from './glb.mjs';

const SOURCE = process.argv[2] || '/root/.claude/uploads/80492aad-1b8b-5ad8-b105-0b761a0e5602/7bfb6e53-rpg_dice_set_1.glb';
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
