/**
 * Builds the tray's surface maps from Poly Haven's CC0 textures, and the
 * coin's metal from ambientCG's (see buildCoinMetal below).
 *
 *   leather  brown_leather     the walls        https://polyhaven.com/a/brown_leather
 *   felt     terry_cloth       the floor        https://polyhaven.com/a/terry_cloth
 *   wood     wood_table_worn   the ground       https://polyhaven.com/a/wood_table_worn
 *
 * Each becomes three WebP maps in public/tray/: the diffuse colour, the GL
 * normal map, and an ARM map — ambient occlusion in red, roughness in green,
 * metalness in blue, the packing Poly Haven ships and the one three reads with
 * `roughnessMap` (green) and `aoMap` (red) from a single texture.
 *
 * The source files come from one of two places:
 *
 *   --download        fetch the 2K JPGs from the Poly Haven API
 *   --source <dir>    look in a folder of downloaded files or zips (default:
 *                     the session's uploads folder), matched by asset name
 *
 * Poly Haven's file names carry the map: `brown_leather_diff_1k.jpg`,
 * `brown_leather_nor_gl_1k.jpg`, `brown_leather_arm_1k.jpg`, and where an
 * asset has separate `rough` and `ao` maps instead of `arm`, they are packed.
 *
 *   node tools/build-textures.mjs --download
 *   node tools/build-textures.mjs --source ~/Downloads
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const ASSETS = {
  leather: 'brown_leather',
  felt: 'terry_cloth',
  wood: 'wood_table_worn',
};

const OUT = 'public/tray';
const SIZE = { diff: 1024, normal: 1024, arm: 512 };
const QUALITY = { diff: 82, normal: 90, arm: 80 };
/**
 * Surfaces that also get a 2048 diffuse and normal, for the high quality tier.
 * The felt is under the dice in the closest shot and the wood fills most of
 * the wide one; the leather is seen at a slant and 1024 is enough for it.
 */
const LARGE = new Set(['felt', 'wood', 'leather']);
/** Surfaces whose diffuse is neutralised so the material's colour paints them. */
const NEUTRAL = new Set(['felt']);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const download = args.includes('--download');
const source = option('source', path.join(os.homedir(), '.claude', 'uploads'));

fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dicer-textures-'));

/** Every file under a folder, recursively, with zips unpacked beside it. */
function collect(dir) {
  const files = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.zip')) {
        const into = path.join(work, path.basename(entry.name, '.zip'));
        fs.mkdirSync(into, { recursive: true });
        execFileSync('python3', ['-m', 'zipfile', '-e', full, into]);
        walk(into);
      } else files.push(full);
    }
  };
  walk(dir);
  return files;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

/** The 1K JPG of each map an asset offers, downloaded into the work folder. */
async function fetchAsset(id) {
  const files = await fetchJson(`https://api.polyhaven.com/files/${id}`);
  const wanted = ['Diffuse', 'nor_gl', 'arm', 'Rough', 'AO'];
  const got = [];
  for (const map of wanted) {
    const entry = files[map]?.['2k']?.jpg ?? files[map]?.['1k']?.jpg;
    if (!entry) continue;
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error(`${entry.url}: ${response.status}`);
    const file = path.join(work, path.basename(entry.url));
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    got.push(file);
  }
  return got;
}

/** Which map a Poly Haven file name is. */
function kindOf(file) {
  const name = path.basename(file).toLowerCase();
  if (/_(?:diff(?:use)?|albedo|col(?:or)?)[_.]/.test(name)) return 'diff';
  if (/_nor_gl[_.]/.test(name)) return 'normal';
  if (/_arm[_.]/.test(name)) return 'arm';
  if (/_rough(?:ness)?[_.]/.test(name)) return 'rough';
  if (/_ao[_.]/.test(name)) return 'ao';
  return null;
}

const resize = (input, size) => sharp(input).resize(size, size, { fit: 'fill' });

async function build(name, id, files) {
  const maps = {};
  for (const file of files) {
    const base = path.basename(file).toLowerCase();
    if (!base.startsWith(id)) continue;
    const kind = kindOf(file);
    if (!kind) continue;
    // Prefer the largest source when several resolutions are present.
    const size = (await sharp(file).metadata()).width ?? 0;
    if (!maps[kind] || size > maps[kind].size) maps[kind] = { file, size };
  }
  if (!maps.diff || !maps.normal) {
    console.log(`  ${name}: missing ${!maps.diff ? 'diffuse' : 'normal'} map for ${id} — skipped`);
    return false;
  }

  // The felt's colour belongs to the tray, not to the photograph: the cloth
  // was shot in a saturated blue that a tint can only darken, never pull
  // toward the slate the dice and swatches were tuned against. So its diffuse
  // is neutralised — greyscale, scaled to a mean of half grey — and the
  // material's colour paints it.
  const diffuse = async (size) => {
    const image = resize(maps.diff.file, size);
    if (!NEUTRAL.has(name)) return image;
    const grey = await image.greyscale().raw().toBuffer();
    let sum = 0;
    for (let i = 0; i < grey.length; i++) sum += grey[i];
    const scale = 128 / (sum / grey.length);
    for (let i = 0; i < grey.length; i++) grey[i] = Math.min(255, Math.round(grey[i] * scale));
    return sharp(grey, { raw: { width: size, height: size, channels: 1 } });
  };
  await (await diffuse(SIZE.diff)).webp({ quality: QUALITY.diff }).toFile(path.join(OUT, `${name}-diff.webp`));
  await resize(maps.normal.file, SIZE.normal).webp({ quality: QUALITY.normal }).toFile(path.join(OUT, `${name}-normal.webp`));
  if (LARGE.has(name) && maps.diff.size >= 2048 && maps.normal.size >= 2048) {
    await (await diffuse(2048)).webp({ quality: QUALITY.diff }).toFile(path.join(OUT, `${name}-diff-2k.webp`));
    await resize(maps.normal.file, 2048).webp({ quality: QUALITY.normal }).toFile(path.join(OUT, `${name}-normal-2k.webp`));
  }

  let arm;
  if (maps.arm) {
    arm = resize(maps.arm.file, SIZE.arm);
  } else if (maps.rough) {
    // Pack it: occlusion (or white) in red, roughness in green, nothing in blue.
    const rough = await resize(maps.rough.file, SIZE.arm).greyscale().raw().toBuffer();
    const ao = maps.ao
      ? await resize(maps.ao.file, SIZE.arm).greyscale().raw().toBuffer()
      : Buffer.alloc(rough.length, 255);
    const packed = Buffer.alloc(rough.length * 3);
    for (let i = 0; i < rough.length; i++) {
      packed[i * 3] = ao[i];
      packed[i * 3 + 1] = rough[i];
      packed[i * 3 + 2] = 0;
    }
    arm = sharp(packed, { raw: { width: SIZE.arm, height: SIZE.arm, channels: 3 } });
  } else {
    console.log(`  ${name}: no roughness map for ${id} — skipped`);
    return false;
  }
  await arm.webp({ quality: QUALITY.arm }).toFile(path.join(OUT, `${name}-arm.webp`));

  const built = ['diff', 'normal', 'arm', 'diff-2k', 'normal-2k'].filter((k) => fs.existsSync(path.join(OUT, `${name}-${k}.webp`)));
  const sizes = built.map((k) => `${k} ${(fs.statSync(path.join(OUT, `${name}-${k}.webp`)).size / 1024).toFixed(0)} KB`);
  console.log(`  ${name} (${id}): ${sizes.join(', ')}`);
  return true;
}

/**
 * The coin's metal: ambientCG's Metal007 (CC0), a polished gold with faint
 * scratches, packed into one RGBA tile in public/dice/ for the coin shader —
 * red and green the normal's slopes in the coin's convention, blue the
 * roughness and alpha the albedo, both scaled to a mean of half grey so they
 * read as variation about whatever the metal's own colour and polish are.
 * The coin recolours it per metal; the photograph's gold is not used.
 */
const COIN_METAL = 'metal007';
const COIN_METAL_SIZE = 1024;
const COIN_METAL_SLOPE_MAX = 0.1;

async function buildCoinMetal(files) {
  const find = (kind) => files.find((f) => path.basename(f).toLowerCase().startsWith(COIN_METAL) && new RegExp(`_${kind}\\.`, 'i').test(path.basename(f)));
  const color = find('color');
  const normal = find('normalgl');
  const rough = find('roughness');
  if (!color || !normal || !rough) {
    console.log(`  coin metal: ${COIN_METAL} not found — skipped`);
    return false;
  }
  const size = COIN_METAL_SIZE;
  const n = size * size;
  const grey = await resize(color, size).greyscale().raw().toBuffer();
  const roughness = await resize(rough, size).greyscale().raw().toBuffer();
  const normals = await resize(normal, size).removeAlpha().raw().toBuffer();
  const mean = (buffer, stride = 1) => {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += stride) sum += buffer[i];
    return sum / (buffer.length / stride);
  };
  const greyScale = 128 / mean(grey);
  const roughScale = 128 / mean(roughness);
  // A normal n stands on a height h with n ∝ (-h_x, -h_up, 1); the map's rows
  // run down, so the slope along a row is the negative of the slope up. The
  // mean slope is taken out: a photograph's slight overall tilt would tilt the
  // whole coin.
  const slopes = new Float32Array(n * 2);
  let meanU = 0;
  let meanV = 0;
  for (let i = 0; i < n; i++) {
    const nx = normals[i * 3] / 127.5 - 1;
    const ny = normals[i * 3 + 1] / 127.5 - 1;
    const nz = Math.max(0.05, normals[i * 3 + 2] / 127.5 - 1);
    slopes[i * 2] = -nx / nz;
    slopes[i * 2 + 1] = ny / nz;
    meanU += slopes[i * 2];
    meanV += slopes[i * 2 + 1];
  }
  meanU /= n;
  meanV /= n;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const su = slopes[i * 2] - meanU;
    const sv = slopes[i * 2 + 1] - meanV;
    out[i * 4] = Math.round(128 + 127 * Math.max(-1, Math.min(1, su / COIN_METAL_SLOPE_MAX)));
    out[i * 4 + 1] = Math.round(128 + 127 * Math.max(-1, Math.min(1, sv / COIN_METAL_SLOPE_MAX)));
    out[i * 4 + 2] = Math.min(255, Math.round(roughness[i] * roughScale));
    out[i * 4 + 3] = Math.min(255, Math.round(grey[i] * greyScale));
  }
  const file = 'public/dice/coin-metal.webp';
  await sharp(out, { raw: { width: size, height: size, channels: 4 } }).webp({ quality: 90 }).toFile(file);
  console.log(`  coin metal (${COIN_METAL}): ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  return true;
}

let files;
if (download) {
  console.log('downloading from Poly Haven');
  files = [];
  for (const id of Object.values(ASSETS)) files.push(...(await fetchAsset(id)));
} else {
  if (!fs.existsSync(source)) {
    console.error(`no such folder: ${source}`);
    process.exit(1);
  }
  console.log(`reading ${source}`);
  files = collect(source);
}

let built = 0;
for (const [name, id] of Object.entries(ASSETS)) if (await build(name, id, files)) built++;
await buildCoinMetal(files);
fs.rmSync(work, { recursive: true, force: true });
console.log(built === Object.keys(ASSETS).length ? 'all tray maps built' : `${built} of ${Object.keys(ASSETS).length} built`);
if (built < Object.keys(ASSETS).length) process.exit(1);
