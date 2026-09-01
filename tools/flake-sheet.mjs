/**
 * Tuning rig for the metallic flake shader.
 *
 * Rolls one die, holds the reveal camera open, then walks a list of flake
 * settings, screenshotting a magnified crop of the die for each. One page load
 * and one roll covers the whole sweep, so a parameter search costs seconds
 * rather than a full roll per guess.
 *
 *   node tools/flake-sheet.mjs [--pool d20] [--set set1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
    const [k, ...v] = s.trim().split(/\s+/);
    return [k, v.join(' ') || 'true'];
  }),
);
const pool = (args.pool || 'd20').split(',');
const outDir = '.calibration';
fs.mkdirSync(outDir, { recursive: true });

/** The sweep. Each entry is a label plus a partial FlakeSettings override. */
const VARIANTS = JSON.parse(
  fs.readFileSync(args.variants || 'tools/flake-variants.json', 'utf8'),
);

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5198 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 832 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });

const frames = (n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let seen = 0;
        const tick = () => (++seen >= count ? resolve(seen) : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

try {
  await page.goto('http://127.0.0.1:5198/', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', { timeout: 120000 });
  await page.waitForFunction(
    () => {
      const loader = document.getElementById('loader');
      return !loader || loader.classList.contains('done');
    },
    { timeout: 180000 },
  );

  if (args.set) await page.evaluate((id) => window.dicer.debug.setSet(id), args.set);
  await page.evaluate((p) => window.dicer.debug.setPool(p), pool);
  await frames(10);

  // Did the patch actually reach the compiled program? A silently failed string
  // replace looks exactly like a shader that is simply too subtle.
  const patched = await page.evaluate(() => {
    const renderer = window.dicer.debug.renderer;
    const programs = [...renderer.info.programs];
    const hit = programs.find((p) => p.getUniforms().map.uFlakeStrength);
    return { programs: programs.length, patched: !!hit };
  });
  console.log(`flake uniform present in a compiled program: ${patched.patched} (${patched.programs} programs)`);
  if (!patched.patched) throw new Error('the flake shader patch never reached a compiled program');

  await page.evaluate(() => window.dicer.debug.roll(0, -1, 0.7));
  await page.waitForFunction('window.dicer.debug.state().settled === true', { timeout: 180000 });
  await page.evaluate(() => window.dicer.debug.holdReveal(true));
  await frames(140);

  // Where the die ended up on screen, so the crop follows it.
  const box = await page.evaluate(() => {
    const { camera, positions } = window.dicer.debug.diceScreenInfo();
    const THREE = window.dicer.debug.three;
    const p = positions[0];
    const v = new THREE.Vector3(p.x, p.y, p.z).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
      radius: p.radius,
    };
  });
  const half = 110;
  const crop = {
    left: Math.max(0, Math.round(box.x - half)),
    top: Math.max(0, Math.round(box.y - half)),
    width: half * 2,
    height: half * 2,
  };

  const tiles = [];
  for (const variant of VARIANTS) {
    const { label, bloom, set, ...flakes } = variant;
    // A variant can name a colourway, so one sweep can cover all seven.
    if (set) {
      await page.evaluate((id) => window.dicer.debug.setSet(id), set);
      await frames(6);
    }
    await page.evaluate((f) => window.dicer.debug.setFlakes(f), flakes);
    if (bloom) await page.evaluate((b) => window.dicer.debug.setBloom(b[0], b[1], b[2]), bloom);
    await frames(4);
    const shot = await page.screenshot();
    const tile = path.join(outDir, `flake-${label}.png`);
    await sharp(shot)
      .extract(crop)
      .resize(half * 2 * 2, half * 2 * 2, { kernel: 'nearest' })
      .toFile(tile);
    tiles.push({ label, tile });
    console.log(`  ${label}  ${JSON.stringify({ ...flakes, ...(set ? { set } : {}) })}`);
  }

  // Contact sheet, so the whole sweep can be read in one look.
  const size = half * 4;
  const columns = Math.min(4, tiles.length);
  const rows = Math.ceil(tiles.length / columns);
  await sharp({
    create: { width: columns * size, height: rows * size, channels: 3, background: '#101014' },
  })
    .composite(
      tiles.map((t, i) => ({
        input: t.tile,
        left: (i % columns) * size,
        top: Math.floor(i / columns) * size,
      })),
    )
    .toFile(path.join(outDir, 'flake-sheet.png'));
  console.log(`\n${path.join(outDir, 'flake-sheet.png')}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
