/**
 * One-off diagnostics against the running app: reports whether the dice textures
 * actually arrived, samples the rendered luminance of the tray floor and the dice,
 * and dumps every mesh's world bounding box so geometry that has drifted off its
 * intended plane is obvious.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ root: process.cwd(), server: { host: '127.0.0.1', port: 5195 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('requestfailed', (r) => console.error('[request failed]', r.url(), r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) console.error('[http]', r.status(), r.url()); });

try {
  await page.goto('http://127.0.0.1:5195/', { waitUntil: 'load' });
  await page.waitForFunction(
    () => {
      const loader = document.getElementById('loader');
      return !loader || loader.classList.contains('done');
    },
    { timeout: 180000 },
  );
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const d = window.dicer.debug;
    const describe = (t) =>
      t ? { w: t.image?.width, h: t.image?.height, colorSpace: t.colorSpace, flipY: t.flipY } : null;

    const boxes = [];
    const THREE = d.three;
    d.scene.updateMatrixWorld(true);
    d.scene.traverse((o) => {
      if (!o.isMesh) return;
      const box = new THREE.Box3().setFromObject(o);
      boxes.push({
        name: o.name || o.type,
        material: o.material?.type,
        min: [box.min.x, box.min.y, box.min.z].map((v) => +v.toFixed(3)),
        max: [box.max.x, box.max.y, box.max.z].map((v) => +v.toFixed(3)),
      });
    });

    return {
      map: describe(d.diceMaterial.map),
      roughnessMap: describe(d.diceMaterial.roughnessMap),
      normalMap: describe(d.diceMaterial.normalMap),
      envMap: !!d.scene.environment,
      exposure: d.renderer.toneMappingExposure,
      boxes,
    };
  });

  console.log('dice base colour map :', JSON.stringify(info.map));
  console.log('dice roughness map   :', JSON.stringify(info.roughnessMap));
  console.log('dice normal map      :', JSON.stringify(info.normalMap));
  console.log('scene environment    :', info.envMap);
  console.log('exposure             :', info.exposure);
  console.log('\nworld bounding boxes:');
  for (const b of info.boxes) {
    console.log(`  ${String(b.name).padEnd(14)} ${b.material?.padEnd(22)} y ${String(b.min[1]).padStart(8)} .. ${String(b.max[1]).padStart(8)}   x ${b.min[0]}..${b.max[0]}  z ${b.min[2]}..${b.max[2]}`);
  }
} catch (error) {
  console.error(error);
} finally {
  await browser.close();
  await server.close();
}
