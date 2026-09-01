/**
 * Proves the installed app is a real offline app, not just a manifest.
 *
 * Serves dist/ from a sub-path the way GitHub Pages does, lets the service
 * worker install, then cuts the network at the browser and reloads. If anything
 * the app needs was left out of the precache — a colourway texture, the dice
 * GLB, Rapier's wasm chunk — the reload cannot boot and cannot roll.
 *
 *   node tools/verify-pwa.mjs [--prefix /dicer/] [--root dist]
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
const root = path.resolve(args.root || 'dist');

if (!fs.existsSync(path.join(root, 'sw.js'))) {
  console.error('no dist/sw.js — run `npm run build` first');
  process.exit(1);
}

const { server, missing, url } = await serveBuild({ root, prefix, port: 5197 });

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
// A fresh profile, so an earlier run's service worker cannot make this one pass.
const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

/** The app is up once the loader has faded and taken itself out of the page. */
const waitForApp = () =>
  page.waitForFunction(
    () => {
      const loader = document.getElementById('loader');
      return (!loader || loader.classList.contains('done')) && !!window.dicer?.debug;
    },
    { timeout: 180000 },
  );

try {
  await page.goto(url, { waitUntil: 'load' });
  await waitForApp();
  console.log(`online: loaded from ${prefix}`);

  // --- the manifest ---------------------------------------------------------
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return { error: 'no <link rel="manifest">' };
    const response = await fetch(link.href);
    if (!response.ok) return { error: `manifest ${response.status}` };
    const body = await response.json();
    // Resolve every icon against the manifest's own URL, the way a launcher does.
    const icons = [];
    for (const icon of body.icons ?? []) {
      const resolved = new URL(icon.src, link.href).href;
      const head = await fetch(resolved);
      icons.push({ src: icon.src, sizes: icon.sizes, purpose: icon.purpose, status: head.status });
    }
    return { href: link.href, body, icons, type: link.type };
  });

  if (manifest.error) {
    check(false, manifest.error);
  } else {
    const m = manifest.body;
    check(!!m.name && !!m.short_name, `name "${m.name}" / short_name "${m.short_name}"`);
    check(m.display === 'standalone', `display is ${m.display}`);
    check(!!m.theme_color && !!m.background_color, `theme ${m.theme_color} on ${m.background_color}`);
    // Absolute paths would break the moment the site moved to a sub-path, which
    // is exactly where it lives on Pages.
    check(
      !String(m.start_url).startsWith('/') && !String(m.scope).startsWith('/'),
      `start_url "${m.start_url}" and scope "${m.scope}" are relative`,
    );
    check(
      new URL(m.start_url, manifest.href).href.startsWith(new URL(prefix, url).href),
      `start_url resolves inside ${prefix}`,
    );
    const sizes = manifest.icons.map((i) => i.sizes);
    check(sizes.includes('192x192') && sizes.includes('512x512'), `icon sizes ${sizes.join(', ')}`);
    check(
      manifest.icons.some((i) => i.purpose === 'maskable'),
      'a maskable icon is declared',
    );
    const badIcons = manifest.icons.filter((i) => i.status !== 200);
    check(badIcons.length === 0, badIcons.length ? `icons 404: ${badIcons.map((i) => i.src).join(', ')}` : 'every icon resolves');
  }

  const appleIcon = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="apple-touch-icon"]');
    if (!link) return 0;
    return (await fetch(link.href)).status;
  });
  check(appleIcon === 200, `apple-touch-icon resolves (${appleIcon || 'missing'})`);

  // --- the service worker ---------------------------------------------------
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      scope: registration.scope,
      state: registration.active?.state,
      script: registration.active?.scriptURL,
    };
  });
  check(worker.state === 'activated', `service worker ${worker.state} at ${worker.scope}`);
  check(worker.scope.endsWith(prefix), `worker scope covers ${prefix}`);

  // It only controls this page once it has claimed it; autoUpdate claims
  // immediately, but a reload is the guarantee.
  await page.reload({ waitUntil: 'load' });
  await waitForApp();
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check(controlled, 'the worker controls the page');

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    let total = 0;
    for (const name of names) total += (await (await caches.open(name)).keys()).length;
    return { names, total };
  });
  check(cached.total > 0, `${cached.total} responses precached across ${cached.names.length} cache(s)`);

  // --- offline --------------------------------------------------------------
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await waitForApp();
  console.log('offline: the app booted with no network');
  // Nothing could have come off the network, so the document itself was served
  // by the worker; without it the reload would have been the offline dinosaur.
  check(
    await page.evaluate(() => !!navigator.serviceWorker.controller),
    'the offline document was served by the worker',
  );

  await page.evaluate(() => window.dicer.debug.setPool(['d20', 'd6', 'd6']));
  await page.evaluate(() => window.dicer.debug.roll(0, -1, 0.7));
  await page.waitForFunction('window.dicer.debug.state().settled === true', { timeout: 180000 });
  const state = await page.evaluate(() => window.dicer.debug.state());
  check(
    state.values.length === 3 && state.values.every((v) => v.value > 0),
    `offline roll: ${JSON.stringify(state.values.map((v) => `${v.type}=${v.value}`))}`,
  );

  // The reveal number is set in Cormorant Garamond. If it were still coming from
  // Google it would silently fall back to Georgia here, which is the whole
  // reason the fonts are vendored.
  const fonts = await page.evaluate(async () => {
    const faces = ["600 64px 'Cormorant Garamond'", "500 16px 'Inter'"];
    const loaded = [];
    for (const face of faces) {
      await document.fonts.load(face, '0123456789');
      loaded.push({ face, ok: document.fonts.check(face, '0123456789') });
    }
    return loaded;
  });
  for (const font of fonts) check(font.ok, `${font.face} is available offline`);

  // Only one colourway was ever displayed online, so the other six prove whether
  // the precache covers the whole app or only the parts that happened to load.
  const assets = await page.evaluate(async () => {
    const base = new URL('dice/', document.baseURI).href;
    const sets = await (await fetch(new URL('sets.json', base))).json();
    const urls = ['dice.glb', 'faces.json'];
    for (const set of sets) urls.push(set.baseColor, set.roughness, set.normal);
    const results = [];
    for (const url of [...new Set(urls)]) {
      try {
        const response = await fetch(new URL(url, base));
        results.push({ url, status: response.status, bytes: (await response.blob()).size });
      } catch (error) {
        results.push({ url, status: 0, bytes: 0, error: String(error) });
      }
    }
    return results;
  });
  const unreachable = assets.filter((a) => a.status !== 200 || a.bytes === 0);
  check(
    unreachable.length === 0,
    unreachable.length
      ? `not precached: ${unreachable.map((a) => a.url).join(', ')}`
      : `all ${assets.length} dice assets served from cache, including six unused colourways`,
  );

} catch (error) {
  console.error(error.message);
  failures.push(error.message);
} finally {
  await browser.close();
  server.close();
}

if (missing.length) {
  console.error(`\n  FAIL ${missing.length} asset(s) 404ed under ${prefix}:`);
  for (const m of [...new Set(missing)]) console.error(`    ${m}`);
  failures.push('404s');
}

// The generic "Failed to load resource" line only ever restates a request the
// server already logged as a 404, so it would double-count rather than add
// anything.
const realErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
if (realErrors.length) {
  console.error('\n  FAIL console errors:');
  for (const e of [...new Set(realErrors)]) console.error(`    ${e}`);
  failures.push('console errors');
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nthe app installs and runs fully offline');
