/**
 * Drives the real CameraDirector in reveal mode against dice parked at each tray
 * corner and wall, and checks each one actually lands inside the frame. The
 * look-at used to be clamped well inside the tray, so a die resting in a corner
 * was never centred and the reveal looked like it had not panned at all.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5193 },
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
  await page.goto('http://127.0.0.1:5193/tools/verify-camera.html', { waitUntil: 'load' });
  await page.waitForFunction('window.__done === true', { timeout: 60000 });
  const { lines, failures } = await page.evaluate('window.__result');
  console.log(lines.join('\n'));
  if (failures.length) {
    console.error('\n' + failures.map((f) => `  FAIL ${f}`).join('\n'));
    failed = true;
  } else {
    console.log('\nthe reveal frames a die anywhere in the tray');
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}

process.exit(failed ? 1 : 0);
