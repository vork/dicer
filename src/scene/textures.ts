import * as THREE from 'three';

/** Cheap value noise, tiled so the generated maps repeat seamlessly. */
function valueNoise(size: number, cells: number, seed: number): Float32Array {
  const grid = new Float32Array(cells * cells);
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  for (let i = 0; i < grid.length; i++) grid[i] = random();

  const out = new Float32Array(size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const at = (cx: number, cy: number) => grid[(cy % cells) * cells + (cx % cells)];
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      out[y * size + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

function fbm(size: number, octaves: { cells: number; weight: number }[], seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let total = 0;
  octaves.forEach((octave, i) => {
    const layer = valueNoise(size, octave.cells, seed + i * 7919);
    for (let p = 0; p < out.length; p++) out[p] += layer[p] * octave.weight;
    total += octave.weight;
  });
  for (let p = 0; p < out.length; p++) out[p] /= total;
  return out;
}

function toTexture(data: Uint8Array, size: number, channels: 3 | 4, colorSpace: string, repeat: number) {
  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    channels === 3 ? THREE.RGBAFormat : THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Height field -> tangent-space normal map, via central differences. */
function heightToNormal(height: Float32Array, size: number, strength: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const length = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / length) * 0.5 * 255 + 127.5);
      data[i + 3] = 255;
    }
  }
  return data;
}

export interface SurfaceMaps {
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/** Dense short-fibre felt for the tray floor: fine grain, matte, slightly uneven. */
export function createFeltMaps(size = 512, repeat = 5): SurfaceMaps {
  const fine = fbm(size, [{ cells: 48, weight: 1 }, { cells: 110, weight: 0.55 }], 1337);
  const broad = fbm(size, [{ cells: 5, weight: 1 }, { cells: 12, weight: 0.5 }], 4242);

  const rough = new Uint8Array(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    // High and narrow: felt is uniformly matte, with just enough variation to
    // break up the specular from the key light.
    const value = 0.82 + fine[p] * 0.12 + broad[p] * 0.06;
    const byte = Math.round(Math.min(1, value) * 255);
    rough[p * 4] = byte;
    rough[p * 4 + 1] = byte;
    rough[p * 4 + 2] = byte;
    rough[p * 4 + 3] = 255;
  }

  const height = new Float32Array(size * size);
  for (let p = 0; p < height.length; p++) height[p] = fine[p] * 0.75 + broad[p] * 0.25;

  return {
    normalMap: toTexture(heightToNormal(height, size, 2.4), size, 4, THREE.NoColorSpace, repeat),
    roughnessMap: toTexture(rough, size, 4, THREE.NoColorSpace, repeat),
  };
}

/** Pebbled leather for the tray rim: coarser cells, semi-gloss with worn highlights. */
export function createLeatherMaps(size = 512, repeat = 3): SurfaceMaps {
  const grain = fbm(size, [{ cells: 40, weight: 1 }, { cells: 96, weight: 0.45 }], 8080);
  const wear = fbm(size, [{ cells: 5, weight: 1 }, { cells: 11, weight: 0.4 }], 606);

  const rough = new Uint8Array(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const value = 0.34 + grain[p] * 0.3 + wear[p] * 0.2;
    const byte = Math.round(Math.min(1, value) * 255);
    rough[p * 4] = byte;
    rough[p * 4 + 1] = byte;
    rough[p * 4 + 2] = byte;
    rough[p * 4 + 3] = 255;
  }

  const height = new Float32Array(size * size);
  for (let p = 0; p < height.length; p++) height[p] = grain[p] * 0.8 + wear[p] * 0.2;

  return {
    normalMap: toTexture(heightToNormal(height, size, 5.5), size, 4, THREE.NoColorSpace, repeat),
    roughnessMap: toTexture(rough, size, 4, THREE.NoColorSpace, repeat),
  };
}
