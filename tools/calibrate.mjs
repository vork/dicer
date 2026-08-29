/**
 * Drives tools/calibrate.html in headless Chromium and writes one contact sheet
 * per die type into .calibration/. Each tile is the die rendered looking straight
 * down that face's normal (or hull vertex, in `vertex` mode) — exactly the axis the
 * runtime uses to decide which face landed up.
 *
 *   node tools/calibrate.mjs [--set set7] [--mode face|vertex] [--spin 0] [--only d20]
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
const setId = args.set || 'set7';
const mode = args.mode || 'face';
const spin = args.spin || '0';
const outDir = '.calibration';

fs.mkdirSync(outDir, { recursive: true });

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5199, fs: { allow: [process.cwd()] } },
  logLevel: 'warn',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[page error]', e.message));

const url = `http://127.0.0.1:5199/tools/calibrate.html?set=${setId}&mode=${mode}&spin=${spin}&zoom=${args.zoom || 1.25}`;
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__done === true', { timeout: 120000 });

const sheets = await page.evaluate('window.__sheets');
for (const [die, dataUrl] of Object.entries(sheets)) {
  if (args.only && args.only !== die) continue;
  const file = path.join(outDir, `r-${die}-${mode}${spin !== '0' ? '-s' + spin : ''}${args.zoom ? '-z' + args.zoom : ''}.png`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(file);
}

await browser.close();
await server.close();
