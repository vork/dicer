/**
 * Bakes the micro detail tiles: small, seamless maps laid under the tray's
 * photographed surfaces and over the dice's clear coat at a fixed physical
 * size of a centimetre or two, so that up close there is grain finer than any
 * atlas could hold. All procedural — a felt is fibres, a leather is pebbles, a
 * wood is fibres and pores, a clear coat is orange peel and hairlines — and
 * deterministic, so the tiles are the same every build.
 *
 *   public/tray/felt-detail.webp      slopes (rg), roughness (b), tone (a)
 *   public/tray/leather-detail.webp   the same
 *   public/tray/wood-detail.webp      the same
 *   public/dice/clearcoat-detail.webp a tangent-space normal map
 *   public/dice/smudge-detail.webp    fingerprints and smudges, a roughness map
 *
 * Slopes are height differences per world unit, encoded about half grey and
 * clamped at DETAIL_SLOPE_MAX; roughness and tone are variations about half
 * grey, so the material's own values are the mean. The v slope is taken with
 * v up, the way a GL normal map is, since the tiles are loaded with flipY on.
 *
 *   node tools/build-detail.mjs
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { mulberry32, periodicNoise } from './coin-surface.mjs';

export const DETAIL_SLOPE_MAX = 1.0;
const SIZE = 512;

/** Physical size of one tile, in world units (one unit is 2cm). */
export const DETAIL_TILE_UNITS = { felt: 1.0, leather: 0.75, wood: 1.0 };

const wrap = (i) => ((i % SIZE) + SIZE) % SIZE;

/** Adds a signed height profile around a point, wrapping at the tile's edges. */
function stampSigned(height, cx, cy, reach, profileAt) {
  for (let py = Math.floor(cy - reach); py <= Math.ceil(cy + reach); py++) {
    for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
      const h = profileAt(px, py);
      if (h === 0) continue;
      height[wrap(py) * SIZE + wrap(px)] += h;
    }
  }
}

/** A stroke of a given length, direction and half-width, with a rounded cross-section. */
function stroke(height, random, { length, halfWidth, amplitude, direction }) {
  const ax = random() * SIZE;
  const ay = random() * SIZE;
  const dx = Math.cos(direction) * length;
  const dy = Math.sin(direction) * length;
  const len2 = dx * dx + dy * dy || 1;
  stampSigned(height, ax + dx / 2, ay + dy / 2, length / 2 + halfWidth + 1, (px, py) => {
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) / halfWidth;
    if (d >= 1) return 0;
    // Rounded across, and tapered toward both ends.
    const across = Math.sqrt(1 - d * d);
    const along = Math.sin(Math.PI * t);
    return amplitude * across * Math.min(1, along * 2.5);
  });
}

/**
 * Felt: a nap of fibres lying every way, in clumps, on a faint fuzz.
 *
 * Not at a fibre's true scale. A real felt fibre is twenty microns across and
 * would be a fraction of a pixel at the closest view the app ever takes —
 * about 170 screen pixels a centimetre in the reveal — where the mip chain
 * averages it to nothing. What reads as felt at that distance is the nap's
 * clumping at a third of a millimetre to a millimetre, so the fibres here are
 * tufts of that size, on a 2cm tile at 39 microns a texel.
 */
function bakeFelt(seed) {
  const random = mulberry32(seed);
  const height = new Float64Array(SIZE * SIZE);
  const tone = new Float64Array(SIZE * SIZE).fill(0.5);
  const rough = new Float64Array(SIZE * SIZE);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const u = px / SIZE, v = py / SIZE;
      const i = py * SIZE + px;
      // The clumping of the nap: a millimetre or two, and a finer fuzz.
      const clump = periodicNoise(u * 11, v * 11, 11, seed) - 0.5;
      height[i] = 0.0012 * clump + 0.0005 * (periodicNoise(u * 31, v * 31, 31, seed + 1) - 0.5);
      tone[i] = 0.5 + 0.1 * clump;
      rough[i] = 0.5 + 0.12 * (periodicNoise(u * 19, v * 19, 19, seed + 2) - 0.5);
    }
  }
  // Tufts: raised strokes a third of a millimetre wide and a few long, each a
  // little lighter or darker than the nap around it.
  for (let n = 0; n < 2600; n++) {
    const length = 14 + random() ** 1.5 * 90;
    const halfWidth = 2.2 + random() * 3.0;
    const amplitude = 0.0009 + random() * 0.0014;
    const direction = random() * Math.PI * 2;
    const shade = (random() - 0.5) * 0.28;
    const ax = random() * SIZE, ay = random() * SIZE;
    const dx = Math.cos(direction) * length, dy = Math.sin(direction) * length;
    const len2 = dx * dx + dy * dy || 1;
    stampSigned(height, ax + dx / 2, ay + dy / 2, length / 2 + halfWidth + 1, (px, py) => {
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) / halfWidth;
      if (d >= 1) return 0;
      const across = Math.sqrt(1 - d * d);
      const along = Math.min(1, Math.sin(Math.PI * t) * 2.5);
      const w = across * along;
      const i = wrap(py) * SIZE + wrap(px);
      tone[i] += shade * w * 0.8;
      rough[i] -= 0.06 * w;
      return amplitude * w;
    });
  }
  return { height, tone, rough, tile: DETAIL_TILE_UNITS.felt };
}

/** Leather: pebbles at two sizes, creased between, with a fine grain on top. */
function bakeLeather(seed) {
  const random = mulberry32(seed);
  const height = new Float64Array(SIZE * SIZE);
  const tone = new Float64Array(SIZE * SIZE);
  const rough = new Float64Array(SIZE * SIZE);
  const cells = (count, radius) => {
    const points = [];
    for (let n = 0; n < count; n++) points.push([random() * SIZE, random() * SIZE, radius * (0.75 + random() * 0.5)]);
    return points;
  };
  // Nearest pebble, with the tile wrapping, from a coarse grid so it stays quick.
  const nearest = (points, px, py) => {
    let best = Infinity, bestR = 1;
    for (const [x, y, r] of points) {
      let dx = Math.abs(px - x), dy = Math.abs(py - y);
      if (dx > SIZE / 2) dx = SIZE - dx;
      if (dy > SIZE / 2) dy = SIZE - dy;
      const d = (dx * dx + dy * dy) / (r * r);
      if (d < best) { best = d; bestR = r; }
    }
    return { d: Math.sqrt(best), r: bestR };
  };
  const coarse = cells(70, 34);
  const fine = cells(420, 13);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const u = px / SIZE, v = py / SIZE;
      const i = py * SIZE + px;
      const a = nearest(coarse, px, py);
      const b = nearest(fine, px, py);
      // A pebble is a dome; past its rim is the crease, lowest between pebbles.
      const dome = (n) => Math.max(0, 1 - n.d * n.d);
      const h = 0.0022 * dome(a) + 0.0009 * dome(b) + 0.0003 * (periodicNoise(u * 61, v * 61, 61, seed) - 0.5);
      height[i] = h;
      const crease = Math.min(1, Math.max(0, a.d - 0.8) * 3);
      tone[i] = 0.5 - 0.12 * crease + 0.05 * (periodicNoise(u * 23, v * 23, 23, seed + 1) - 0.5);
      rough[i] = 0.5 + 0.18 * crease + 0.08 * (periodicNoise(u * 41, v * 41, 41, seed + 2) - 0.5);
    }
  }
  return { height, tone, rough, tile: DETAIL_TILE_UNITS.leather };
}

/** Wood: fibres running along x, and pores cut along them. */
function bakeWood(seed) {
  const random = mulberry32(seed);
  const height = new Float64Array(SIZE * SIZE);
  const tone = new Float64Array(SIZE * SIZE);
  const rough = new Float64Array(SIZE * SIZE);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const u = px / SIZE, v = py / SIZE;
      const i = py * SIZE + px;
      // Long along x, fine across: the noise is stretched thirty to one.
      const fibre = periodicNoise(u * 3, v * 96, 96, seed) - 0.5;
      const fibre2 = periodicNoise(u * 7, v * 160, 160, seed + 1) - 0.5;
      height[i] = 0.0007 * fibre + 0.0003 * fibre2;
      tone[i] = 0.5 + 0.08 * fibre + 0.04 * fibre2;
      rough[i] = 0.5 + 0.1 * (periodicNoise(u * 5, v * 40, 40, seed + 2) - 0.5);
    }
  }
  // Pores: short troughs along the grain, dark inside.
  for (let n = 0; n < 260; n++) {
    const length = 10 + random() ** 1.5 * 70;
    const halfWidth = 0.8 + random() * 1.4;
    const depth = 0.0006 + random() * 0.0012;
    const direction = (random() - 0.5) * 0.06;
    const ax = random() * SIZE, ay = random() * SIZE;
    const dx = Math.cos(direction) * length, dy = Math.sin(direction) * length;
    const len2 = dx * dx + dy * dy || 1;
    stampSigned(height, ax + dx / 2, ay + dy / 2, length / 2 + halfWidth + 1, (px, py) => {
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) / halfWidth;
      if (d >= 1) return 0;
      const w = (1 - d * d) * Math.min(1, Math.sin(Math.PI * t) * 3);
      const i = wrap(py) * SIZE + wrap(px);
      tone[i] -= 0.2 * w;
      rough[i] += 0.15 * w;
      return -depth * w;
    });
  }
  return { height, tone, rough, tile: DETAIL_TILE_UNITS.wood };
}

/** Clear coat: orange peel and a few hairline scratches, as a normal map. */
function bakeClearcoat(seed) {
  const random = mulberry32(seed);
  const height = new Float64Array(SIZE * SIZE);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const u = px / SIZE, v = py / SIZE;
      height[py * SIZE + px] = 1.0 * (periodicNoise(u * 7, v * 7, 7, seed) - 0.5) + 0.45 * (periodicNoise(u * 19, v * 19, 19, seed + 1) - 0.5);
    }
  }
  for (let n = 0; n < 70; n++) {
    stroke(height, random, { length: 20 + random() ** 2 * 200, halfWidth: 0.7 + random() * 0.8, amplitude: -(0.3 + random() * 0.6), direction: random() * Math.PI * 2 });
  }
  return height;
}

/**
 * Fingerprints and smudges, as a roughness map: the baseline sits at
 * SMUDGE_BASE so a material's own clear coat roughness, divided by it, is the
 * clean value, and the prints and wipes rise from there toward one. A print
 * is a patch of ridges — near-parallel, gently curved, a third of a
 * millimetre apart — bounded by a soft oval; a smudge is a broad soft patch
 * of deposited oil; a wipe is a streak of it. All periodic.
 */
export const SMUDGE_BASE = 0.37;
function bakeSmudge(seed) {
  const random = mulberry32(seed);
  const value = new Float64Array(SIZE * SIZE).fill(SMUDGE_BASE);
  // The oily haze a handled surface carries: thin, uneven, in patches with
  // ragged edges rather than blobs.
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const u = px / SIZE, v = py / SIZE;
      const broad = periodicNoise(u * 5, v * 5, 5, seed) - 0.5;
      const mid = periodicNoise(u * 17, v * 17, 17, seed + 1) - 0.5;
      const fine = periodicNoise(u * 61, v * 61, 61, seed + 2) - 0.5;
      const haze = Math.max(0, broad * 1.4 + mid * 0.7 + fine * 0.3 - 0.1);
      value[py * SIZE + px] += 0.22 * Math.min(1, haze * 2.5);
    }
  }
  // Fingerprints. The ridges of a print run in near-parallel arcs — an arch
  // or a loop — not in rings: the phase is a parabola across the print, bent
  // by a slow warp so no two prints agree, and the ridges break where the
  // skin did not touch.
  for (let n = 0; n < 8; n++) {
    const cx = random() * SIZE, cy = random() * SIZE;
    const rx = 30 + random() * 34, ry = rx * (1.3 + random() * 0.5);
    const angle = random() * Math.PI;
    const spacing = 6 + random() * 2.5;
    const strength = 0.4 + random() * 0.3;
    const bend = (0.4 + random() * 0.8) / rx;
    const warpSeed = seed + 10 + n;
    const reach = Math.max(rx, ry) + 4;
    for (let py = Math.floor(cy - reach); py <= Math.ceil(cy + reach); py++) {
      for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
        const dx = px - cx, dy = py - cy;
        const lx = dx * Math.cos(angle) + dy * Math.sin(angle);
        const ly = -dx * Math.sin(angle) + dy * Math.cos(angle);
        // A ragged oval: the print's edge is where the finger's pressure ran out.
        const rag = 0.25 * (periodicNoise(px / 23, py / 23, 22, warpSeed + 100) - 0.5);
        const oval = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) + rag;
        if (oval >= 1) continue;
        const warp = (periodicNoise(px / 34, py / 34, 15, warpSeed) - 0.5) * spacing * 2.6;
        const phase = ly + bend * lx * lx + warp;
        const ridge = 0.5 + 0.5 * Math.cos((2 * Math.PI * phase) / spacing);
        // Ridges break: a fine noise decides where the skin touched.
        const touch = periodicNoise(px / 7, py / 7, 73, warpSeed + 50);
        const contact = Math.min(1, Math.max(0, (touch - 0.3) * 3));
        const edge = Math.min(1, (1 - oval) * 2.5);
        const deposit = Math.pow(ridge, 2.2) * contact * edge * strength;
        const i = wrap(py) * SIZE + wrap(px);
        value[i] += deposit;
      }
    }
  }
  // Wipes: long feathered streaks where a thumb dragged.
  for (let n = 0; n < 4; n++) {
    stroke(value, random, { length: 140 + random() * 240, halfWidth: 9 + random() * 14, amplitude: 0.08 + random() * 0.08, direction: random() * Math.PI * 2 });
  }
  const out = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = Math.round(255 * Math.max(0, Math.min(1, value[i])));
    out[i * 3] = v;
    out[i * 3 + 1] = v;
    out[i * 3 + 2] = v;
  }
  return out;
}

/** Slopes by central difference, wrapping, with v taken upward. */
function encodeSurface({ height, tone, rough, tile }) {
  const texel = tile / SIZE;
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    const y0 = wrap(y - 1), y1 = wrap(y + 1);
    for (let x = 0; x < SIZE; x++) {
      const x0 = wrap(x - 1), x1 = wrap(x + 1);
      const su = (height[y * SIZE + x1] - height[y * SIZE + x0]) / (2 * texel);
      const sv = -(height[y1 * SIZE + x] - height[y0 * SIZE + x]) / (2 * texel);
      const i = (y * SIZE + x) * 4;
      out[i] = Math.round(128 + 127 * Math.max(-1, Math.min(1, su / DETAIL_SLOPE_MAX)));
      out[i + 1] = Math.round(128 + 127 * Math.max(-1, Math.min(1, sv / DETAIL_SLOPE_MAX)));
      out[i + 2] = Math.round(255 * Math.max(0, Math.min(1, rough[y * SIZE + x])));
      out[i + 3] = Math.round(255 * Math.max(0, Math.min(1, tone[y * SIZE + x])));
    }
  }
  return out;
}

/** A tangent-space normal map from a height, scaled so the peel tilts a little. */
function encodeNormal(height, strength) {
  const out = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    const y0 = wrap(y - 1), y1 = wrap(y + 1);
    for (let x = 0; x < SIZE; x++) {
      const x0 = wrap(x - 1), x1 = wrap(x + 1);
      const hx = (height[y * SIZE + x1] - height[y * SIZE + x0]) * strength;
      const hy = -(height[y1 * SIZE + x] - height[y0 * SIZE + x]) * strength;
      const len = Math.hypot(hx, hy, 1);
      const i = (y * SIZE + x) * 3;
      out[i] = Math.round(127.5 + 127.5 * (-hx / len));
      out[i + 1] = Math.round(127.5 + 127.5 * (-hy / len));
      out[i + 2] = Math.round(127.5 + 127.5 * (1 / len));
    }
  }
  return out;
}

const write = async (buffer, channels, file, quality) => {
  await sharp(buffer, { raw: { width: SIZE, height: SIZE, channels } }).webp({ quality }).toFile(file);
  console.log(`  ${file}: ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
};

fs.mkdirSync('public/tray', { recursive: true });
await write(encodeSurface(bakeFelt(11)), 4, 'public/tray/felt-detail.webp', 90);
await write(encodeSurface(bakeLeather(23)), 4, 'public/tray/leather-detail.webp', 90);
await write(encodeSurface(bakeWood(37)), 4, 'public/tray/wood-detail.webp', 90);
await write(encodeNormal(bakeClearcoat(41), 0.9), 3, 'public/dice/clearcoat-detail.webp', 90);
await write(bakeSmudge(53), 3, 'public/dice/smudge-detail.webp', 88);
console.log('detail tiles baked');
