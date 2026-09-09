/**
 * Renders the coin's two faces side by side — +Y on the left, -Y on the right —
 * so a person can say which one is heads. The value table in src/dice/values.ts
 * records the answer; this is how it was got.
 *
 *   npm run coin:faces        -> .calibration/coin-faces.png
 */
import fs from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ root: process.cwd(), server: { host: '127.0.0.1', port: 5232 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 512 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));
try {
  const normals = process.argv.includes('--normals');
  await page.goto(`http://127.0.0.1:5232/tools/coin-faces.html${normals ? '?normals' : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__done === true', null, { timeout: 120000 });
  fs.mkdirSync('.calibration', { recursive: true });
  const out = normals ? '.calibration/coin-normals.png' : '.calibration/coin-faces.png';
  await page.screenshot({ path: out });
  console.log(`  ${out}   left: the +Y face (slot 0), right: the -Y face (slot 1)`);
} finally {
  await browser.close();
  await server.close();
}
