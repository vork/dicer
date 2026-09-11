/**
 * Renders the coin under the app's real material and lighting, in seconds.
 *
 *   npm run coin:look                       -> .calibration/coin-look.png
 *   npm run coin:look -- --tails
 *   npm run coin:look -- --debug coinGrime  (any expression in the coin's fragment shader)
 *   npm run coin:look -- --metal silver
 *   npm run coin:look -- --coin '{"polish":0.3}' --env 0.8 --elev 40 --dist 2.6 --yaw 2.2
 *
 * Each option becomes a query parameter of coin-look.html. Also prints the mean
 * colour of the clean field, the grimy field and the raised metal, which is how
 * the coin's tuning was done: by number, not by squinting at a headless render.
 */
import fs from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? 'true';
};
const query = new URLSearchParams();
for (const name of ['debug', 'coin', 'metal', 'env', 'elev', 'dist', 'yaw', 'size', 'noshadow', 'normalBias']) {
  const value = option(name);
  if (value !== null) query.set(name, value);
}
if (args.includes('--tails')) query.set('tails', '1');
const out = option('out') || '.calibration/coin-look.png';

const server = await createServer({ root: process.cwd(), server: { host: '127.0.0.1', port: 5235 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
try {
  const size = Number(query.get('size') || 512);
  const render = async (extra) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/404/.test(m.text())) console.log('console:', m.text().slice(0, 300));
    });
    const q = new URLSearchParams(query);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    await page.goto(`http://127.0.0.1:5235/tools/coin-look.html?${q}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__done === true', null, { timeout: 300000 });
    const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    return sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  };

  fs.mkdirSync('.calibration', { recursive: true });
  const image = await render({});
  await sharp(image.data, { raw: image.info }).png().toFile(out);
  console.log(`wrote ${out}`);

  if (!query.get('debug')) {
    // Where the field, the grime and the raised metal are, from the shader itself.
    const cavity = await render({ debug: 'coinCavity' });
    const grime = await render({ debug: 'coinGrime' });
    const ch = image.info.channels;
    const sums = { 'clean field': [0, 0, 0, 0], 'grimy field': [0, 0, 0, 0], 'raised metal': [0, 0, 0, 0] };
    for (let i = 0; i < size * size; i++) {
      const p = i * ch;
      let key = null;
      if (cavity.data[p] > 200) key = grime.data[p] > 160 ? 'grimy field' : grime.data[p] < 60 ? 'clean field' : null;
      else if (cavity.data[p] < 40 && grime.data[p] < 250) key = 'raised metal';
      if (!key) continue;
      const s = sums[key];
      s[0] += image.data[p];
      s[1] += image.data[p + 1];
      s[2] += image.data[p + 2];
      s[3]++;
    }
    for (const [key, s] of Object.entries(sums)) {
      if (!s[3]) continue;
      const [r, g, b] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
      const max = Math.max(r, g, b);
      const saturation = (max - Math.min(r, g, b)) / max;
      console.log(`  ${key.padEnd(13)} rgb ${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)}  saturation ${saturation.toFixed(2)}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
