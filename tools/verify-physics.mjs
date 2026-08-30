/**
 * Steps the real DiceWorld headlessly, with no renderer, to check that rolls
 * settle, stay inside the tray, and land on every face.
 *
 *   node tools/verify-physics.mjs [--trials 200]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
    const [k, ...v] = s.trim().split(/\s+/);
    return [k, v.join(' ') || 'true'];
  }),
);
const trials = args.trials || '200';
const only = args.only ? `&only=${args.only}` : '';
const pairs = args.pairs ? `&pairs=${args.pairs}` : '';
const path = args.path ? `&path=${args.path}` : '';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5197 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });

let failed = false;
try {
  await page.goto(`http://127.0.0.1:5197/tools/verify-physics.html?trials=${trials}${only}${pairs}${path}`, {
    // The page's module script runs every trial synchronously, so 'load' does not
    // fire until the whole run is over — waiting for it would time out.
    waitUntil: 'commit',
    timeout: 120000,
  });
  // Report progress while waiting, so a long run is visibly alive.
  const progress = setInterval(() => {
    page
      .evaluate('window.__progress')
      .then((p) => p && process.stderr.write(`\r  ${p}          `))
      .catch(() => {});
  }, 5000);
  try {
    await page.waitForFunction('window.__done === true', { timeout: 3600000 });
  } finally {
    clearInterval(progress);
    process.stderr.write('\r');
  }
  const { report, problems } = await page.evaluate('window.__result');
  console.log(report.join('\n'));
  if (problems.length) {
    console.error('\n' + problems.map((p) => `  PROBLEM ${p}`).join('\n'));
    failed = true;
  } else {
    console.log('\nevery roll settled inside the tray');
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}

process.exit(failed ? 1 : 0);
