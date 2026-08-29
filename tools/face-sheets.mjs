/**
 * Renders a labelled contact sheet per die type by cropping each face's UV island
 * out of a colourway's base-colour map. Used once, by hand, to author the
 * face-index -> printed-value tables in src/dice/values.ts.
 *
 *   node tools/face-sheets.mjs [setId] [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const setId = process.argv[2] || 'set7';
const outDir = process.argv[3] || path.resolve('.calibration');

const faces = JSON.parse(fs.readFileSync('.calibration/faces-uv.json', 'utf8'));
const sets = JSON.parse(fs.readFileSync('public/dice/sets.json', 'utf8'));
const set = sets.find((s) => s.id === setId);
if (!set) throw new Error(`no such set ${setId}`);

const TEXTURE = path.join('public/dice', set.baseColor);
const TILE = 190;
const LABEL = 26;
const GRID = { d4: 2, d6: 3, d8: 4, d10: 5, d12: 4, d20: 5 };

fs.mkdirSync(outDir, { recursive: true });

const source = sharp(TEXTURE);
const { width, height } = await source.metadata();

for (const [die, data] of Object.entries(faces)) {
  const columns = GRID[die];
  const rows = Math.ceil(data.faces.length / columns);
  const composites = [];

  for (let i = 0; i < data.faces.length; i++) {
    const face = data.faces[i];
    // Pad the island a little so glyphs that sit near an edge stay visible.
    const padU = (face.uvMax[0] - face.uvMin[0]) * 0.06 + 0.004;
    const padV = (face.uvMax[1] - face.uvMin[1]) * 0.06 + 0.004;
    const left = Math.max(0, Math.round((face.uvMin[0] - padU) * width));
    const top = Math.max(0, Math.round((face.uvMin[1] - padV) * height));
    const right = Math.min(width, Math.round((face.uvMax[0] + padU) * width));
    const bottom = Math.min(height, Math.round((face.uvMax[1] + padV) * height));

    const crop = await sharp(TEXTURE)
      .extract({ left, top, width: Math.max(2, right - left), height: Math.max(2, bottom - top) })
      .resize(TILE, TILE, { fit: 'contain', background: '#101014' })
      .png()
      .toBuffer();

    const column = i % columns;
    const row = Math.floor(i / columns);
    composites.push({
      input: crop,
      left: column * TILE,
      top: row * (TILE + LABEL) + LABEL,
    });
    composites.push({
      input: Buffer.from(
        `<svg width="${TILE}" height="${LABEL}"><rect width="${TILE}" height="${LABEL}" fill="#f5c542"/>` +
          `<text x="${TILE / 2}" y="${LABEL - 7}" font-family="monospace" font-size="18" font-weight="bold" fill="#101014" text-anchor="middle">face ${i}</text></svg>`,
      ),
      left: column * TILE,
      top: row * (TILE + LABEL),
    });
  }

  const out = path.join(outDir, `${die}-${setId}.png`);
  await sharp({
    create: {
      width: columns * TILE,
      height: rows * (TILE + LABEL),
      channels: 3,
      background: '#101014',
    },
  })
    .composite(composites)
    .png()
    .toFile(out);
  console.log(`${out}  (${data.faces.length} faces, ${columns}x${rows})`);
}
