/**
 * Bakes the coin's surface: a slope map for the faces and one for the edge.
 *
 * The maps store the slope of a height field rather than a normal — how much
 * the surface rises per unit along each of the two directions it is sampled by
 * — because a slope is the same number whatever frame it is read in. The face
 * map is sampled by the coin's x and z, the edge map by the angle around the
 * coin and its y, and the shader tilts the geometric normal by the two slopes
 * along the matching tangents. Slopes also average correctly under mip
 * filtering, which is what keeps a scratch from turning into sparkle once the
 * coin is small on screen.
 *
 * Everything in the height field is wear:
 *
 * - The relief is domed, and its edges are rounded on the raised side of every
 *   outline, by profiles off the distance to the outline. This is the single
 *   thing that most says "old": a freshly struck coin has crisp edges, and a
 *   coin that has been in pockets for a lifetime has none. The foot of each
 *   wall gets a small concave fillet on the field side. The rim's outer edge
 *   and the edge's top and bottom are rounded the same way.
 * - Dents: shallow bowls of no particular shape.
 * - Nicks in the rim: short deep cuts.
 * - Scratches: hundreds of thin shallow grooves of every length and direction,
 *   a third of them swipes of several parallel hairlines.
 * - Casting porosity: sparse pinpoint pits.
 *
 * The scratch and dent masks ride in the blue and (inverted) alpha channels
 * for the shader's roughness and colour.
 *
 * And under all of that a micro tile (bakeMicro): a small seamless square of
 * the imperfections too fine for the surface map — hairline micro-scratches,
 * the metal's grain, pinpoint pores, the faint peel of the struck surface —
 * repeated many times across the coin. Mipmapped, it is real texture when the
 * coin fills the screen and fades to a soft matte, never a shimmer, when it
 * does not.
 */

/** Slopes are stored as a fraction of this; 1.5 is a 56 degree wall. */
export const SLOPE_MAX = 1.5;
/** The micro tile's slopes are gentler, so they get a finer scale. */
export const MICRO_SLOPE_MAX = 0.5;
/**
 * How many micro tiles go around the coin's edge; the tile's size in coin
 * units follows from the radius, so the strip wraps without a seam. The shader
 * carries the same number.
 */
export const MICRO_TILES_AROUND = 34;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z) {
  let px = (x * 0.3183099 + 0.1) % 1;
  let py = (y * 0.3183099 + 0.1) % 1;
  let pz = (z * 0.3183099 + 0.1) % 1;
  if (px < 0) px += 1;
  if (py < 0) py += 1;
  if (pz < 0) pz += 1;
  px *= 17;
  py *= 17;
  pz *= 17;
  const v = px * py * pz * (px + py + pz);
  return v - Math.floor(v);
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** Value noise, the same shape as the shader's. */
export function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  return lerp(
    lerp(lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx), lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx), fy),
    lerp(lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx), lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx), fy),
    fz,
  );
}

export function fbm3(x, y, z, octaves = 4) {
  let amplitude = 0.5;
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise3(x, y, z);
    x = x * 2.03 + 1.7;
    y = y * 2.03 + 9.2;
    z = z * 2.03 + 3.1;
    amplitude *= 0.5;
  }
  return sum;
}

/**
 * Exact Euclidean distance, in texels, from every texel to the nearest texel
 * where `inside` is set. Felzenszwalb and Huttenlocher's separable transform:
 * a lower envelope of parabolas per row, then per column.
 */
export function distanceTransform(inside, width, height) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(width, height));
  const d = new Float64Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float64Array(Math.max(width, height) + 1);
  const out = new Float64Array(width * height);

  const transform1d = (n) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) {
          k--;
          if (k < 0) {
            k = 0;
            break;
          }
        } else break;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[q] = (q - p) * (q - p) + f[p];
    }
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = inside[y * width + x] ? 0 : INF;
    transform1d(width);
    for (let x = 0; x < width; x++) out[y * width + x] = d[x];
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x];
    transform1d(height);
    for (let y = 0; y < height; y++) out[y * width + x] = Math.sqrt(d[y]);
  }
  return out;
}

/**
 * Rasterises the raised tops of one face into a mask over ±extent, plus the
 * outside of the coin, which counts as raised so the rim's inner foot is found.
 */
export function rasteriseRaised({ position, index, cavityOf, side, rim, size, extent }) {
  const mask = new Uint8Array(size * size);
  const toTexel = (v) => ((v + extent) / (2 * extent)) * size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 * extent - extent;
      const z = ((py + 0.5) / size) * 2 * extent - extent;
      if (Math.hypot(x, z) > rim * 0.985) mask[py * size + px] = 1;
    }
  }
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    if (cavityOf[a] >= 0.5 || cavityOf[b] >= 0.5 || cavityOf[c] >= 0.5) continue;
    if (Math.sign(position[a * 3 + 1]) !== side || Math.sign(position[b * 3 + 1]) !== side) continue;
    if (Math.sign(position[c * 3 + 1]) !== side) continue;
    const xs = [a, b, c].map((i) => toTexel(position[i * 3]));
    const zs = [a, b, c].map((i) => toTexel(position[i * 3 + 2]));
    const minX = Math.max(0, Math.floor(Math.min(...xs)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(...xs)));
    const minZ = Math.max(0, Math.floor(Math.min(...zs)));
    const maxZ = Math.min(size - 1, Math.ceil(Math.max(...zs)));
    const area = (xs[1] - xs[0]) * (zs[2] - zs[0]) - (xs[2] - xs[0]) * (zs[1] - zs[0]);
    if (Math.abs(area) < 1e-9) continue;
    for (let py = minZ; py <= maxZ; py++) {
      for (let px = minX; px <= maxX; px++) {
        const qx = px + 0.5, qz = py + 0.5;
        const w0 = ((xs[1] - qx) * (zs[2] - qz) - (xs[2] - qx) * (zs[1] - qz)) / area;
        const w1 = ((xs[2] - qx) * (zs[0] - qz) - (xs[0] - qx) * (zs[2] - qz)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) mask[py * size + px] = 1;
      }
    }
  }
  return mask;
}

/**
 * A rounded-off edge: a parabolic drop over a width r in from the edge, to a
 * depth of half that, steepest at the edge where its slope is exactly 1. A
 * full quarter circle read as a pillow — the relief looked melted rather than
 * worn — and an elliptical profile, like a circle, stands vertical at the edge:
 * an infinite slope that the map could only clamp, texel by texel along a
 * staircase outline, which drew as a beaded line along every edge.
 */
function rounding(d, r) {
  if (d >= r) return 0;
  const s = Math.max(0, d) / r;
  return -0.5 * r * (1 - s) * (1 - s);
}

/** Box-filters a square field down by an integer ratio. */
export function downsample(field, size, ratio) {
  const out = new Float64Array((size / ratio) * (size / ratio));
  const small = size / ratio;
  for (let y = 0; y < small; y++) {
    for (let x = 0; x < small; x++) {
      let sum = 0;
      for (let dy = 0; dy < ratio; dy++) {
        for (let dx = 0; dx < ratio; dx++) sum += field[(y * ratio + dy) * size + x * ratio + dx];
      }
      out[y * small + x] = sum / (ratio * ratio);
    }
  }
  return out;
}

/**
 * The part of a face's height that follows the relief's outline: the doming,
 * the rounded edges, the fillets at the feet, the rim. Computed at whatever
 * resolution the mask comes in at — the build uses four times the map's, and
 * filters the result down — because a distance field off a binary outline is
 * a staircase at texel scale, and a rounding driven by a staircase is a
 * serrated rounding.
 */
export function bakeOutlineHeight({ raised, size, extent, rim }) {
  const texel = (2 * extent) / size;
  const height = new Float64Array(size * size);
  const field = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) field[i] = raised[i] ? 0 : 1;
  const intoRaised = distanceTransform(field, size, size);
  const intoField = distanceTransform(raised, size, size);

  const ROUND = 0.02;
  const FILLET = 0.01;
  const RIM_ROUND = 0.03;
  const DOME = 0.012;
  const DOME_WIDTH = 0.05;
  for (let py = 0; py < size; py++) {
    const z = ((py + 0.5) / size) * 2 * extent - extent;
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 * extent - extent;
      const i = py * size + px;
      const r = Math.hypot(x, z);
      let h = 0;
      if (raised[i]) {
        const inFromOutline = Math.min(intoRaised[i] * texel, rim - r);
        h += rounding(inFromOutline, ROUND);
        // The rim's outer edge. Continuous past the rim — the same depth all
        // the way out — so nothing outside the coin can bleed a step back in
        // through the mip chain.
        h += rounding(rim - r, RIM_ROUND);
        // Struck relief is not a flat plate on a flat field: the die's engraving
        // is convex, so every stroke of the design swells from its edges to a
        // crown along its middle, and the rim likewise. An extrusion with a
        // level top read as cut out of sheet, whatever was done to its edges.
        const t = Math.max(0, Math.min(1, inFromOutline / DOME_WIDTH));
        h += DOME * t * t * (3 - 2 * t);
      } else {
        // A concave fillet at the foot: the surface rises to meet the wall.
        const d = intoField[i] * texel;
        if (d < FILLET) h += FILLET * (1 - d / FILLET) ** 2 * 0.5;
      }
      height[i] = h;
    }
  }
  return height;
}

/** Stamps a capsule-shaped groove: depth along its spine, falling off across it. */
function groove(height, mask, maskWeight, size, texel, wrapX, ax, ay, bx, by, halfWidth, depth) {
  const minX = Math.floor(Math.min(ax, bx) - halfWidth - 1), maxX = Math.ceil(Math.max(ax, bx) + halfWidth + 1);
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - halfWidth - 1));
  const maxY = Math.min(size.height - 1, Math.ceil(Math.max(ay, by) + halfWidth + 1));
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const dist = Math.hypot(px - cx, py - cy) / halfWidth;
      if (dist >= 1) continue;
      // A V with a rounded floor, deepest on the spine, gone at the lip.
      const profile = 1 - dist * dist;
      const x = wrapX ? ((px % size.width) + size.width) % size.width : px;
      if (x < 0 || x >= size.width) continue;
      const i = py * size.width + x;
      height[i] -= depth * profile;
      mask[i] = Math.max(mask[i], maskWeight * profile);
    }
  }
}

/**
 * Stamps a bowl. Not a round one: its outline wanders by up to a third of its
 * radius around three harmonics, and it may be stretched, because a dent is
 * the shape of whatever struck it, and nothing that strikes a coin is round.
 */
function bowl(height, mask, maskWeight, size, wrapX, cx, cy, radius, depth, random) {
  const wobble = [1, 2, 3].map((k) => ({ k, amplitude: (random ? random() : 0) * 0.12, phase: (random ? random() : 0) * Math.PI * 2 }));
  const stretch = random ? 1 + random() * 0.8 : 1;
  const heading = random ? random() * Math.PI : 0;
  const cosH = Math.cos(heading), sinH = Math.sin(heading);
  const reach = radius * stretch * 1.4;
  for (let py = Math.max(0, Math.floor(cy - reach)); py <= Math.min(size.height - 1, Math.ceil(cy + reach)); py++) {
    for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
      const dx = px - cx, dy = py - cy;
      const ex = (dx * cosH + dy * sinH) / stretch, ey = -dx * sinH + dy * cosH;
      const angle = Math.atan2(ey, ex);
      let r = 1;
      for (const w of wobble) r += w.amplitude * Math.cos(w.k * angle + w.phase);
      const d = Math.hypot(ex, ey) / (radius * r);
      if (d >= 1) continue;
      const profile = (1 - d * d) * (1 - d * d);
      const x = wrapX ? ((px % size.width) + size.width) % size.width : px;
      if (x < 0 || x >= size.width) continue;
      const i = py * size.width + x;
      height[i] -= depth * profile;
      mask[i] = Math.max(mask[i], maskWeight * profile);
    }
  }
}

/** Slopes and masks into RGBA bytes: r, g slopes; b scratches; a dents. */
function encode(height, scratches, dents, width, height_, texelU, texelV, wrapX) {
  const out = Buffer.alloc(width * height_ * 4);
  for (let y = 0; y < height_; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(height_ - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const x0 = wrapX ? (x - 1 + width) % width : Math.max(0, x - 1);
      const x1 = wrapX ? (x + 1) % width : Math.min(width - 1, x + 1);
      const su = (height[y * width + x1] - height[y * width + x0]) / ((wrapX ? 2 : x1 - x0 || 1) * texelU);
      const sv = (height[y1 * width + x] - height[y0 * width + x]) / ((y1 - y0 || 1) * texelV);
      const i = (y * width + x) * 4;
      out[i] = Math.round(128 + 127 * Math.max(-1, Math.min(1, su / SLOPE_MAX)));
      out[i + 1] = Math.round(128 + 127 * Math.max(-1, Math.min(1, sv / SLOPE_MAX)));
      out[i + 2] = Math.round(255 * Math.min(1, scratches[y * width + x]));
      // Inverted: WebP discards the colour of any texel whose alpha is zero,
      // and the slopes are the colour. So no dent is ever fully transparent.
      out[i + 3] = 255 - Math.round(254 * Math.min(1, dents[y * width + x]));
    }
  }
  return out;
}

/**
 * One face: the damage, stamped over the outline height from bakeOutlineHeight
 * (already at this size). `seed` differs per face so the two are not the same
 * coin twice.
 */
export function bakeFace({ baseHeight, size, extent, rim, seed }) {
  const texel = (2 * extent) / size;
  const height = Float64Array.from(baseHeight);
  const scratches = new Float64Array(size * size);
  const dents = new Float64Array(size * size);
  const random = mulberry32(seed);

  const grid = { width: size, height: size };
  const toTexel = (v) => ((v + extent) / (2 * extent)) * size;
  const inCoin = (x, z) => Math.hypot(x, z) < rim;

  // Scratches: many, thin, shallow, every length and direction. Favouring the
  // exposed metal a little, since the field is sheltered by the relief.
  for (let n = 0; n < 150; n++) {
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * rim;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const direction = random() * Math.PI * 2;
    const length = 0.03 + random() ** 2 * 0.4;
    const halfWidth = (0.002 + random() * 0.003) / texel;
    // Shallow: a hairline is seen by its highlight, not its depth. Three times
    // this and the faces read as hatched.
    const depth = 0.0004 + random() ** 2 * 0.0012;
    const ex = x + Math.cos(direction) * length, ez = z + Math.sin(direction) * length;
    if (!inCoin(x, z)) continue;
    groove(height, scratches, 0.5, grid, texel, false, toTexel(x), toTexel(z), toTexel(ex), toTexel(ez), halfWidth, depth);
    // A third of them are a swipe, not a single line: a few parallel hairlines
    // a texel or two apart, of differing lengths, the mark of a coin dragged
    // across grit. The most characteristic mark on a handled coin.
    if (random() < 0.35) {
      const lines = 2 + Math.floor(random() * 4);
      const nx = -Math.sin(direction), nz = Math.cos(direction);
      for (let k = 1; k <= lines; k++) {
        const offset = k * (0.002 + random() * 0.003) * (random() < 0.5 ? -1 : 1);
        const trim = random() * 0.4;
        const sx = x + nx * offset + Math.cos(direction) * length * trim * random();
        const sz = z + nz * offset + Math.sin(direction) * length * trim * random();
        const fx = ex + nx * offset - Math.cos(direction) * length * trim * random();
        const fz = ez + nz * offset - Math.sin(direction) * length * trim * random();
        groove(height, scratches, 0.4, grid, texel, false, toTexel(sx), toTexel(sz), toTexel(fx), toTexel(fz), halfWidth * (0.6 + random() * 0.6), depth * (0.5 + random() * 0.6));
      }
    }
  }
  // Dents.
  for (let n = 0; n < 70; n++) {
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * rim;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const radius = (0.008 + random() ** 2 * 0.028) / texel;
    const depth = 0.003 + random() * 0.008;
    bowl(height, dents, 1, grid, false, toTexel(x), toTexel(z), radius, depth, random);
  }
  // Nicks on the rim.
  for (let n = 0; n < 14; n++) {
    const a = random() * Math.PI * 2;
    const r = rim - 0.01 - random() * 0.05;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const direction = a + Math.PI / 2 + (random() - 0.5) * 1.2;
    const length = 0.02 + random() * 0.05;
    const ex = x + Math.cos(direction) * length, ez = z + Math.sin(direction) * length;
    groove(height, dents, 1, grid, texel, false, toTexel(x), toTexel(z), toTexel(ex), toTexel(ez), (0.004 + random() * 0.004) / texel, 0.005 + random() * 0.006);
  }
  // Porosity.
  for (let n = 0; n < 260; n++) {
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * rim;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    bowl(height, dents, 0.6, grid, false, toTexel(x), toTexel(z), (0.002 + random() * 0.003) / texel, 0.002 + random() * 0.002, random);
  }

  return encode(height, scratches, dents, size, size, texel, texel, false);
}

/**
 * The edge, as a strip around the circumference (u, wrapping) by y across the
 * thickness (v). Its height is radial, positive outward.
 */
export function bakeEdge({ width, height: rows, rim, top, seed }) {
  const circumference = 2 * Math.PI * rim;
  const texelU = circumference / width;
  const texelV = (2 * top) / rows;
  const height = new Float64Array(width * rows);
  const scratches = new Float64Array(width * rows);
  const dents = new Float64Array(width * rows);
  const random = mulberry32(seed);
  const grid = { width, height: rows };

  const ROUND = 0.025;
  for (let py = 0; py < rows; py++) {
    const y = ((py + 0.5) / rows) * 2 * top - top;
    for (let px = 0; px < width; px++) {
      height[py * width + px] = rounding(top - Math.abs(y), ROUND);
    }
  }
  // Rubbed around the circumference: short, fine, shallow hairlines along u.
  // The first version ran them up to two thirds of the way round, a few texels
  // wide and deep enough that both walls tilted away from the light, and each
  // one read as a dark trough across the rim — a seam, not a scratch.
  for (let n = 0; n < 70; n++) {
    const u = random() * width;
    const v = random() * rows;
    const length = (0.02 + random() ** 2 * 0.12) / texelU;
    const drift = (random() - 0.5) * 0.12;
    groove(height, scratches, 0.4, grid, texelU, true, u, v, u + length, v + drift * length, (0.0012 + random() * 0.0018) / texelV, 0.0002 + random() ** 2 * 0.0005);
  }
  for (let n = 0; n < 24; n++) {
    bowl(height, dents, 0.8, grid, true, random() * width, random() * rows, (0.003 + random() ** 2 * 0.008) / texelV, 0.0008 + random() * 0.0018, random);
  }

  return encode(height, scratches, dents, width, rows, texelU, texelV, true);
}

/** Periodic 2D value noise over a lattice of `period` cells, for a tile that wraps. */
function periodicNoise(x, y, period, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const at = (i, j) => hash3(((i % period) + period) % period, ((j % period) + period) % period, seed);
  return lerp(lerp(at(ix, iy), at(ix + 1, iy), fx), lerp(at(ix, iy + 1), at(ix + 1, iy + 1), fx), fy);
}

/** Stamps into a tile that wraps in both directions. */
function stampWrapped(height, mask, maskWeight, size, cx, cy, reach, profileAt) {
  for (let py = Math.floor(cy - reach); py <= Math.ceil(cy + reach); py++) {
    for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
      const { depth, weight } = profileAt(px, py);
      if (depth <= 0) continue;
      const i = (((py % size) + size) % size) * size + (((px % size) + size) % size);
      height[i] -= depth;
      mask[i] = Math.max(mask[i], maskWeight * weight);
    }
  }
}

/**
 * The micro tile: `size` texels square, covering `tile` coin units, seamless.
 * Heights are tiny — the whole tile is a couple of millimetres across.
 */
export function bakeMicro({ size, tile, seed }) {
  const texel = tile / size;
  const height = new Float64Array(size * size);
  const scratches = new Float64Array(size * size);
  const pores = new Float64Array(size * size);
  const random = mulberry32(seed);

  // Grain and peel, periodic so the tile joins itself.
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px / size, v = py / size;
      let h = 0;
      // Peel: a slow undulation, a couple of cells per tile.
      h += 0.0005 * (periodicNoise(u * 3, v * 3, 3, seed) - 0.5);
      // Grain, three octaves.
      h += 0.0003 * (periodicNoise(u * 9, v * 9, 9, seed + 1) - 0.5);
      h += 0.00018 * (periodicNoise(u * 21, v * 21, 21, seed + 2) - 0.5);
      h += 0.0001 * (periodicNoise(u * 47, v * 47, 47, seed + 3) - 0.5);
      height[py * size + px] = h;
    }
  }

  // Micro-scratches: short, a texel or two wide, barely deep.
  for (let n = 0; n < 110; n++) {
    const ax = random() * size, ay = random() * size;
    const direction = random() * Math.PI * 2;
    const length = (4 + random() ** 2 * 60);
    const bx = ax + Math.cos(direction) * length, by = ay + Math.sin(direction) * length;
    const halfWidth = 0.8 + random() * 1.4;
    const depth = 0.00008 + random() ** 2 * 0.00025;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const reach = Math.hypot(dx, dy) + halfWidth + 1;
    stampWrapped(height, scratches, 0.6, size, (ax + bx) / 2, (ay + by) / 2, reach / 2 + halfWidth + 1, (px, py) => {
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) / halfWidth;
      if (d >= 1) return { depth: 0, weight: 0 };
      const profile = 1 - d * d;
      return { depth: depth * profile, weight: profile };
    });
  }
  // Pores.
  for (let n = 0; n < 90; n++) {
    const cx = random() * size, cy = random() * size;
    const radius = 1 + random() ** 2 * 3.5;
    const depth = 0.0001 + random() * 0.0003;
    stampWrapped(height, pores, 1, size, cx, cy, radius + 1, (px, py) => {
      const d = Math.hypot(px - cx, py - cy) / radius;
      if (d >= 1) return { depth: 0, weight: 0 };
      const profile = (1 - d * d) * (1 - d * d);
      return { depth: depth * profile, weight: profile };
    });
  }

  // Slopes by central difference, wrapping both ways.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = (y - 1 + size) % size, y1 = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const x0 = (x - 1 + size) % size, x1 = (x + 1) % size;
      const su = (height[y * size + x1] - height[y * size + x0]) / (2 * texel);
      const sv = (height[y1 * size + x] - height[y0 * size + x]) / (2 * texel);
      const i = (y * size + x) * 4;
      out[i] = Math.round(128 + 127 * Math.max(-1, Math.min(1, su / MICRO_SLOPE_MAX)));
      out[i + 1] = Math.round(128 + 127 * Math.max(-1, Math.min(1, sv / MICRO_SLOPE_MAX)));
      out[i + 2] = Math.round(255 * Math.min(1, scratches[y * size + x]));
      out[i + 3] = 255 - Math.round(254 * Math.min(1, pores[y * size + x]));
    }
  }
  return out;
}
