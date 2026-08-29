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
import http from 'node:http';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
    const [k, ...v] = s.trim().split(/\s+/);
    return [k, v.join(' ') || 'true'];
  }),
);
const prefix = args.prefix || '/dicer/';
const root = path.resolve('dist');
const port = 5194;

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('no dist/index.html — run `npm run build` first');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const missing = [];

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (!url.pathname.startsWith(prefix)) {
    missing.push(`${url.pathname} (outside ${prefix})`);
    response.writeHead(404).end('not found');
    return;
  }

  let relative = url.pathname.slice(prefix.length) || 'index.html';
  if (relative.endsWith('/')) relative += 'index.html';
  // Resolve inside dist and refuse anything that climbs out of it.
  const file = path.join(root, relative);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    missing.push(url.pathname);
    response.writeHead(404).end('not found');
    return;
  }

  response.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

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
  await page.goto(`http://127.0.0.1:${port}${prefix}`, { waitUntil: 'load' });
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
// "Failed to load resource" console lines would only double-count it. Google
// Fonts being unreachable in a sandbox is not a build defect either.
const realMisses = missing;
const realErrors = consoleErrors.filter(
  (e) => !/fonts\.googleapis|fonts\.gstatic|ERR_CONNECTION_RESET|Failed to load resource/.test(e),
);

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
