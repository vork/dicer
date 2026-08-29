/**
 * Boots the real app in headless Chromium, drives a roll through the same debug
 * hook the smoke test uses, and captures stills at each stage.
 *
 *   node tools/shoot.mjs [--width 1280] [--height 832] [--set set1] [--pool d20]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
    const [k, ...v] = s.trim().split(/\s+/);
    return [k, v.join(' ') || 'true'];
  }),
);
const width = Number(args.width || 1280);
const height = Number(args.height || 832);
const pool = (args.pool || 'd20').split(',');
const label = args.label || 'shot';
const outDir = '.calibration';
fs.mkdirSync(outDir, { recursive: true });

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5196 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });

const shot = async (name) => {
  const file = path.join(outDir, `${label}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
};

/** Waits for a number of animation frames to pass, so the scene actually advances. */
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
  await page.goto('http://127.0.0.1:5196/', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', { timeout: 120000 });
  // The loader fades out and then removes itself, so "visible and .done" is a
  // race; accept either state.
  await page.waitForFunction(
    () => {
      const loader = document.getElementById('loader');
      return !loader || loader.classList.contains('done');
    },
    { timeout: 180000 },
  );

  if (args.set) await page.evaluate((id) => window.dicer.debug.setSet(id), args.set);
  await page.evaluate((p) => window.dicer.debug.setPool(p), pool);
  await frames(24);
  await shot('idle');

  await page.evaluate(() => window.dicer.debug.roll(0, -1, 0.72));
  await frames(6);
  await shot('launch');
  await frames(14);
  await shot('midroll');

  await page.waitForFunction('window.dicer.debug.state().settled === true', { timeout: 180000 });
  // Grab it promptly: the result flash is a 2.6s CSS animation, and headless
  // frames are slow enough that waiting long would miss it entirely.
  const flash = await page.evaluate(() => ({
    total: document.getElementById('reveal-total').textContent,
    caption: document.getElementById('reveal-caption').textContent,
    opacity: getComputedStyle(document.getElementById('reveal')).opacity,
  }));
  console.log('result flash:', JSON.stringify(flash));
  await shot('reveal');

  // Headless frames are far too slow to land inside a 2.6s CSS animation, so
  // replay it frozen at the point where the number is fully up.
  await page.evaluate(() => {
    const el = document.getElementById('reveal');
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    el.style.animationPlayState = 'paused';
    el.style.animationDelay = '-800ms';
  });
  await shot('flash');
  await page.evaluate(() => {
    const el = document.getElementById('reveal');
    el.style.animationPlayState = '';
    el.style.animationDelay = '';
  });
  await frames(6);
  await shot('settled');

  const state = await page.evaluate(() => window.dicer.debug.state());
  console.log('values:', JSON.stringify(state.values));
} catch (error) {
  console.error(error);
  await shot('error');
} finally {
  await browser.close();
  await server.close();
}
