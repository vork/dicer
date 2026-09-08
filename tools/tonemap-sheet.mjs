/**
 * Renders one settled pool through several tone mapping operators and lays them
 * out side by side, with the numbers that decide between them.
 *
 * The thing this scene is made of is tinted specular: metallic flake glints and a
 * warm key on polished resin. What separates the operators is not the shape of
 * their curve but what they do to the colour of a highlight as it gets brighter —
 * ACES bleaches a warm glint to white, and whether that is wanted is the whole
 * question.
 *
 * Every operator is exposure-matched before it is judged, by searching for the
 * exposure that puts the frame's median luminance where the current one puts it.
 * Without that the comparison is between brightnesses rather than between
 * operators, and the darker one always looks more saturated.
 *
 *   node tools/tonemap-sheet.mjs [--pool d20,d6,d6,d12]
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
const pool = (args.pool || 'd20,d6,d6,d12').split(',');

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5222 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 720, height: 560 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));

const frames = (n) =>
  page.evaluate((count) => new Promise((resolve) => {
    let seen = 0;
    const tick = () => (++seen >= count ? resolve(seen) : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

/** Median luminance, and the colour of the brightest pixels. */
function measure(image) {
  const { data, info } = image;
  const luma = [];
  const hot = [];
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma.push(l);
    hot.push({ l, r, g, b });
  }
  luma.sort((a, b) => a - b);
  hot.sort((a, b) => b.l - a.l);
  const saturationOf = (pixels) => {
    if (!pixels.length) return 0;
    let sum = 0;
    for (const p of pixels) {
      const mx = Math.max(p.r, p.g, p.b);
      const mn = Math.min(p.r, p.g, p.b);
      sum += mx <= 0 ? 0 : (mx - mn) / mx;
    }
    return sum / pixels.length;
  };
  // Whether the operator's shoulder is even being reached matters more than what
  // it does up there. A scene that never goes near white is not being bleached by
  // anything, and the choice of operator is then a matter of taste rather than a
  // fix.
  return {
    median: luma[Math.floor(luma.length / 2)],
    brightest: luma[luma.length - 1],
    over50: hot.filter((p) => p.l > 0.5).length / hot.length,
    over80: hot.filter((p) => p.l > 0.8).length / hot.length,
    over95: hot.filter((p) => p.l > 0.95).length / hot.length,
    // The top 0.2% is the glints themselves, not the lit felt around them.
    highlightSaturation: saturationOf(hot.slice(0, Math.max(1, Math.floor(hot.length * 0.002)))),
    brightSaturation: saturationOf(hot.filter((p) => p.l > 0.8)),
  };
}

const shot = async () => sharp(await page.screenshot({ type: 'png', timeout: 60000 }))
  .raw().toBuffer({ resolveWithObject: true });

let failed = false;
try {
  await page.goto('http://127.0.0.1:5222/', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('loader');
    return !l || l.classList.contains('done');
  }, { timeout: 180000 });

  // The GT curve, injected as three's CustomToneMapping so it can be judged
  // against the built-ins without building a pass for it. Two variants: the way
  // it is normally published, per channel, and the same curve run on luminance
  // with the chroma carried through — which is the part of GT7 that matters here.
  // Only the operators three ships are compared here, and that is a limitation
  // rather than a choice. Dropping the GT curve in as three's CustomToneMapping
  // does not work at runtime: three keys its program cache on the material's own
  // shader source, which never changes when a ShaderChunk is swapped underneath
  // it, so the second variant silently reuses the first one's compiled program
  // and reports numbers identical to three decimal places. GT is compared exactly
  // in tools/tonemap-curves.py instead, where there is no GPU to argue with.

  await page.evaluate((p) => window.dicer.debug.setPool(p), pool);
  await page.evaluate(() => window.dicer.debug.roll(0.15, -1, 0.72));
  await page.waitForFunction('window.dicer.debug.state().settled === true', { polling: 250, timeout: 300000 });
  await page.evaluate(() => window.dicer.debug.holdReveal(true));
  await page.evaluate(() => window.dicer.debug.setGrain(0));
  await frames(120);
  await page.evaluate(() => window.dicer.debug.freezeCamera(true));
  await frames(6);

  const setOperator = (name, exposure) =>
    page.evaluate(({ name, exposure }) => {
      const THREE = window.dicer.debug.three;
      const renderer = window.dicer.debug.renderer;
      const modes = {
        aces: THREE.ACESFilmicToneMapping,
        agx: THREE.AgXToneMapping,
        neutral: THREE.NeutralToneMapping,
        cineon: THREE.CineonToneMapping,
      };
      renderer.toneMapping = modes[name];
      renderer.toneMappingExposure = exposure;
    }, { name, exposure });

  const OPERATORS = [
    { name: 'aces', label: 'ACESFilmic (what it uses now)' },
    { name: 'neutral', label: 'Khronos PBR Neutral' },
    { name: 'agx', label: 'AgX' },
    { name: 'cineon', label: 'Cineon' },
  ];

  // What the current setting produces, which everything else is matched to.
  await setOperator('aces', 1.28);
  await frames(3);
  const reference = measure(await shot());
  console.log(`  the frame as it stands: median luminance ${reference.median.toFixed(4)}\n`);

  const tiles = [];
  for (const operator of OPERATORS) {
    // Search for the exposure that lands on the reference median.
    let low = 0.05;
    let high = 6.0;
    let found = 1;
    let stats = null;
    for (let i = 0; i < 12; i++) {
      found = (low + high) / 2;
      await setOperator(operator.name, found);
      await frames(3);
      stats = measure(await shot());
      if (stats.median < reference.median) low = found;
      else high = found;
    }
    console.log(
      `  ${operator.label.padEnd(30)} x${found.toFixed(2).padStart(5)}  ` +
        `median ${stats.median.toFixed(4)}  peak ${stats.brightest.toFixed(3)}  ` +
        `over 0.5 ${(stats.over50 * 100).toFixed(2)}%  over 0.8 ${(stats.over80 * 100).toFixed(3)}%  ` +
        `glint sat ${stats.highlightSaturation.toFixed(3)}  bright sat ${stats.brightSaturation.toFixed(3)}`,
    );
    tiles.push({ ...operator, exposure: found, ...stats, png: await page.screenshot({ type: 'png' }) });
  }

  const out = path.resolve('.calibration');
  fs.mkdirSync(out, { recursive: true });
  const width = 720;
  const height = 560;
  const composite = [];
  tiles.forEach((tile, i) => {
    composite.push({ input: tile.png, left: (i % 2) * width, top: Math.floor(i / 2) * height });
  });
  const sheetPath = path.join(out, 'tonemap.png');
  await sharp({
    create: { width: width * 2, height: height * Math.ceil(tiles.length / 2), channels: 3, background: '#000' },
  }).composite(composite).png().toFile(sheetPath);
  console.log(`\n  sheet written to ${sheetPath}`);
  console.log('  reading order: ' + tiles.map((t) => t.label).join(' | '));
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
