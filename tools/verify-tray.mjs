/**
 * A die must never be able to reach past the leather you can see.
 *
 * The physics walls are flat planes on nominal dimensions; the visible wall is
 * an extruded rounded rectangle whose bevel pulls its inner face inward and
 * whose corners are filleted. Neither offset is in the extrude options in a form
 * you can read off, so this measures the built geometry directly: raycast
 * outward from inside the tray and compare where the leather is against where a
 * collider stops a die.
 *
 *   npm run verify:tray
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5204 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));

let failed = false;
try {
  await page.goto('http://127.0.0.1:5204/', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('loader');
    return !l || l.classList.contains('done');
  }, { timeout: 180000 });

  // The loader going away is not the same as the tray being in the scene and the
  // physics world answering queries, and acting too early reported "no wall
  // anywhere" — which looks identical to a catastrophic regression.
  await page.waitForFunction(
    () => {
      let meshes = 0;
      window.dicer.debug.scene.traverse((o) => {
        if (o.isMesh && o.geometry?.attributes?.position) meshes++;
      });
      return meshes >= 4 && window.dicer.debug.wallDistance(0.5, 1, 0) !== null;
    },
    { timeout: 120000 },
  );

  const rows = await page.evaluate(async () => {
    const THREE = window.dicer.debug.three;
    const meshes = [];
    window.dicer.debug.scene.traverse((o) => {
      if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o);
    });

    const ray = new THREE.Raycaster();
    ray.far = 40;
    const out = [];

    // Where the colliders actually are, asked of the physics world itself rather
    // than recomputed from the same constants the colliders were built from —
    // that would only prove the arithmetic agrees with itself, and would sit
    // there passing if the walls were wired back to the nominal dimensions.

    const headings = [];
    for (let deg = 0; deg <= 90; deg += 7.5) {
      const a = (deg * Math.PI) / 180;
      headings.push([deg, Math.cos(a), Math.sin(a)]);
    }

    for (const y of [0.06, 0.25, 0.5, 1.0, 1.8, 2.2]) {
      for (const [deg, dx, dz] of headings) {
        ray.set(new THREE.Vector3(0, y, 0), new THREE.Vector3(dx, 0, dz).normalize());
        const hits = ray.intersectObjects(meshes, false).filter((h) => h.distance > 0.5);
        const play = window.dicer.debug.wallDistance(y, dx, dz);
        if (!hits.length || play === null) { out.push({ y, deg, leather: null, play }); continue; }
        out.push({ y, deg, leather: hits[0].distance, play });
      }
    }
    return out;
  });

  const measured = rows.filter((r) => r.leather !== null && r.play !== null);
  const misses = rows.filter((r) => r.leather === null || r.play === null);

  console.log(`${rows.length} sight lines, 6 heights x 13 headings`);
  if (misses.length) {
    const sample = misses[0];
    console.error(`\n  FAIL ${misses.length} ray(s) found no wall — first: y ${sample.y}, ${sample.deg} deg, leather ${sample.leather}, physics ${sample.play}`);
    failed = true;
  }
  if (!measured.length) {
    console.error('  FAIL nothing could be measured at all');
    process.exit(1);
  }

  const over = measured
    .filter((r) => r.play - r.leather > 0.02)
    .sort((a, b) => (b.play - b.leather) - (a.play - a.leather));
  const worst = measured.reduce((a, b) => (b.play - b.leather > a.play - a.leather ? b : a));

  console.log(`  worst overhang  ${(worst.play - worst.leather).toFixed(3)} at y ${worst.y}, ${worst.deg} deg`);
  console.log(`  (positive means a die can reach past the leather)`);
  if (over.length) {
    console.error(`\n  FAIL a die can sink into the tray wall at ${over.length} of ${rows.length} sight lines:`);
    for (const r of over.slice(0, 8)) {
      console.error(`    y ${r.y.toFixed(2)}  ${String(r.deg).padStart(4)} deg  leather ${r.leather.toFixed(3)}  play ${r.play.toFixed(3)}  over by ${(r.play - r.leather).toFixed(3)}`);
    }
    failed = true;
  }
  if (!failed) console.log('\nevery die stops at or before the leather, all the way round');
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
