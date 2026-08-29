// Minimal GLB reader/writer helpers shared by the asset tools.
import fs from 'node:fs';

const COMPONENT = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGlb(path) {
  const buf = fs.readFileSync(path);
  const totalLength = buf.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < totalLength) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    if (chunkType === 0x004e4942) bin = body;
    offset += 8 + chunkLength;
  }
  return { json, bin };
}

export function readAccessor({ json, bin }, index) {
  const accessor = json.accessors[index];
  const { array: Ctor, size: componentSize } = COMPONENT[accessor.componentType];
  const components = NUM_COMPONENTS[accessor.type];
  const view = json.bufferViews[accessor.bufferView];
  const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const stride = view.byteStride || components * componentSize;
  const out = new Ctor(accessor.count * components);
  if (stride === components * componentSize) {
    const src = new Ctor(
      bin.buffer.slice(bin.byteOffset + base, bin.byteOffset + base + accessor.count * components * componentSize),
    );
    out.set(src);
  } else {
    for (let i = 0; i < accessor.count; i++) {
      const src = new Ctor(
        bin.buffer.slice(
          bin.byteOffset + base + i * stride,
          bin.byteOffset + base + i * stride + components * componentSize,
        ),
      );
      out.set(src, i * components);
    }
  }
  return out;
}

export function readImage({ json, bin }, index) {
  const view = json.bufferViews[json.images[index].bufferView];
  const start = view.byteOffset || 0;
  return Buffer.from(bin.subarray(start, start + view.byteLength));
}

/** Uniform scale factor baked into a 4x4 column-major node matrix. */
export function matrixScale(matrix) {
  const column = (i) => Math.hypot(matrix[i * 4], matrix[i * 4 + 1], matrix[i * 4 + 2]);
  return (column(0) + column(1) + column(2)) / 3;
}

const pad4 = (n) => (n + 3) & ~3;

/**
 * Build a GLB from a list of { name, position, normal, uv, index } geometries.
 * Every geometry becomes one mesh on one node in the default scene.
 */
export function writeGlb(path, geometries) {
  const bufferViews = [];
  const accessors = [];
  const chunks = [];
  let byteOffset = 0;

  const pushView = (typedArray, target) => {
    const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const padding = pad4(bytes.length) - bytes.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target });
    chunks.push(bytes);
    if (padding) chunks.push(Buffer.alloc(padding));
    byteOffset += bytes.length + padding;
    return bufferViews.length - 1;
  };

  const pushAccessor = (typedArray, type, componentType, target, withBounds) => {
    const components = NUM_COMPONENTS[type];
    const count = typedArray.length / components;
    const accessor = { bufferView: pushView(typedArray, target), componentType, count, type };
    if (withBounds) {
      const min = new Array(components).fill(Infinity);
      const max = new Array(components).fill(-Infinity);
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < components; c++) {
          const v = typedArray[i * components + c];
          if (v < min[c]) min[c] = v;
          if (v > max[c]) max[c] = v;
        }
      }
      accessor.min = min;
      accessor.max = max;
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const meshes = [];
  const nodes = [];
  for (const geometry of geometries) {
    const attributes = {
      POSITION: pushAccessor(geometry.position, 'VEC3', 5126, 34962, true),
      NORMAL: pushAccessor(geometry.normal, 'VEC3', 5126, 34962, false),
      TEXCOORD_0: pushAccessor(geometry.uv, 'VEC2', 5126, 34962, false),
    };
    const indices = pushAccessor(geometry.index, 'SCALAR', 5125, 34963, false);
    meshes.push({ name: geometry.name, primitives: [{ attributes, indices }] });
    nodes.push({ name: geometry.name, mesh: meshes.length - 1 });
  }

  const json = {
    asset: { version: '2.0', generator: 'dicer-asset-pipeline' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };

  const binChunk = Buffer.concat(chunks);
  let jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonChunk.length % 4) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(4 - (jsonChunk.length % 4), 0x20)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  fs.writeFileSync(path, Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]));
  return 12 + 8 + jsonChunk.length + 8 + binChunk.length;
}
