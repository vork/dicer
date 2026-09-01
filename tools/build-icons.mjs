/**
 * Renders the install icons from public/favicon.svg, so the tab icon, the home
 * screen icon and the splash all show the same mark.
 *
 * A maskable icon is cropped to a circle-ish shape by the launcher, so it gets its
 * own version with the mark shrunk into the safe zone and the background bled to
 * the edges — otherwise Android would clip the corners off the rounded square.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.resolve('public/icons');
fs.mkdirSync(OUT, { recursive: true });

const BACKGROUND = '#0b0b10';
const source = fs.readFileSync('public/favicon.svg');

/** The mark on its own, without the rounded-square plate. */
const markOnly = source.toString().replace(/<rect[^>]*\/>/, '');

async function write(name, size, svg, insetFraction) {
  const inner = Math.round(size * (1 - insetFraction * 2));
  const mark = await sharp(Buffer.from(svg), { density: 384 }).resize(inner, inner).png().toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: BACKGROUND },
  })
    .composite([{ input: mark, top: Math.round((size - inner) / 2), left: Math.round((size - inner) / 2) }])
    .png()
    .toFile(path.join(OUT, name));
  console.log(`${name}  ${size}x${size}`);
}

// Plain icons keep the plate; the launcher shows them as-is.
await write('icon-192.png', 192, source.toString(), 0);
await write('icon-512.png', 512, source.toString(), 0);
// Maskable: the mark alone, inside the 80% safe zone, background to the edges.
await write('icon-maskable-512.png', 512, markOnly, 0.18);
// iOS does not honour transparency and applies its own rounding.
await write('apple-touch-icon.png', 180, markOnly, 0.14);
