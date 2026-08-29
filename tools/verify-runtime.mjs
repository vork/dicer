/**
 * Runs tools/verify-runtime.html in headless Chromium: for every die type and
 * every slot, rotate that slot to point up, spin the die about the vertical axis,
 * and confirm the runtime reader picks the slot back out — using the same
 * src/dice/read.ts the app itself uses.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5198 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));

let failed = false;
try {
  await page.goto('http://127.0.0.1:5198/tools/verify-runtime.html', { waitUntil: 'load' });
  await page.waitForFunction('window.__done === true', { timeout: 60000 });
  const { lines, failures } = await page.evaluate('window.__result');
  console.log(lines.join('\n'));
  if (failures.length) {
    console.error('\n' + failures.map((f) => `  FAIL ${f}`).join('\n'));
    console.error(`\n${failures.length} failure(s)`);
    failed = true;
  } else {
    console.log('\nevery slot reads back correctly from every yaw');
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}

process.exit(failed ? 1 : 0);
