/**
 * Serves the production build from a sub-path — the way a GitHub Pages project
 * site is hosted, at /<repo>/ rather than at the domain root — then loads it and
 * rolls once. Catches the classic Pages failure where an asset is requested from
 * an absolute path and 404s in production while working fine on the dev server.
 *
 *   npm run build && node tools/verify-build.mjs [--prefix /dicer/]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveBuild } from './static-server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
    const [k, ...v] = s.trim().split(/\s+/);
    return [k, v.join(' ') || 'true'];
  }),
);
const prefix = args.prefix || '/dicer/';
const root = path.resolve('dist');

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('no dist/index.html — run `npm run build` first');
  process.exit(1);
}

const { server, missing, url } = await serveBuild({ root, prefix, port: 5194 });

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

let failed = false;
try {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    () => {
      const loader = document.getElementById('loader');
      return !loader || loader.classList.contains('done');
    },
    { timeout: 180000 },
  );
  console.log(`loaded from ${prefix}`);

  await page.evaluate(() => window.dicer.debug.setPool(['d20', 'd6']));
  await page.evaluate(() => window.dicer.debug.roll(0, -1, 0.7));
  await page.waitForFunction('window.dicer.debug.state().settled === true', { timeout: 180000 });
  const state = await page.evaluate(() => window.dicer.debug.state());
  console.log('rolled:', JSON.stringify(state.values));

  if (state.values.some((v) => !v.value)) {
    console.error('  FAIL a die reported no value');
    failed = true;
  }
} catch (error) {
  console.error(error.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}

// The server's own 404 log is the authoritative record, so generic
// "Failed to load resource" console lines would only double-count it. Nothing is
// fetched from a third party any more, so there is nothing else to excuse.
const realMisses = missing;
const realErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));

if (realMisses.length) {
  console.error(`\n  FAIL ${realMisses.length} asset(s) 404ed under ${prefix}:`);
  for (const m of [...new Set(realMisses)]) console.error(`    ${m}`);
  failed = true;
}
if (realErrors.length) {
  console.error(`\n  FAIL console errors:`);
  for (const e of [...new Set(realErrors)]) console.error(`    ${e}`);
  failed = true;
}

if (!failed) console.log(`\nthe production build runs correctly from ${prefix}`);
process.exit(failed ? 1 : 0);
