/**
 * The tray floor must darken toward the walls.
 *
 * The tray is a box, so felt near a wall can see less of the room than felt in
 * the middle and should receive less ambient light for it. Without that a box
 * reads as a painted rectangle, and it is invisible to every other check here
 * because nothing about it is wrong in geometry, timing or colour — it is a
 * gradient that is missing.
 *
 * Measured by silencing every direct light, so what is left on the felt is the
 * ambient and environment term alone and the spotlights cannot be mistaken for
 * occlusion. The check is the ratio between felt against a wall and felt in the
 * open: with no occlusion it is 1, and the geometry says it should be about 0.7.
 *
 *   node tools/verify-ao.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5225 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 720, height: 560 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));

const frames = (n) =>
  page.evaluate((count) => new Promise((resolve) => {
    let seen = 0;
    const tick = () => (++seen >= count ? resolve(seen) : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

let failed = false;
try {
  await page.goto('http://127.0.0.1:5225/?quality=high', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', null, { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('loader');
    return !l || l.classList.contains('done');
  }, { timeout: 180000 });

  // An empty tray, seen from the idle camera, so nothing is standing on the felt
  // and the reveal is not closing in on anything.
  await page.evaluate(() => window.dicer.debug.setPool([]));
  await page.evaluate(() => window.dicer.debug.setGrain(0));
  await frames(90);
  await page.evaluate(() => window.dicer.debug.freezeCamera(true));
  await frames(6);

  // Silence everything that casts, leaving the hemisphere and the environment.
  // Occlusion only scales indirect light, so this is the only lighting under
  // which it is the thing being measured rather than a spotlight's falloff.
  const silenced = await page.evaluate(() => {
    let n = 0;
    window.dicer.debug.scene.traverse((o) => {
      if (o.isLight && !o.isHemisphereLight) { o.intensity = 0; n++; }
    });
    return n;
  });
  await frames(4);

  // Sampled along the tray's long axis, which runs across the screen and is the
  // best resolved direction, and read twice: once with the occlusion applied and
  // once with it switched off at the same points, under the same lights, with the
  // same camera. The ratio between the two is the occlusion and nothing else.
  //
  // Comparing the edge of the floor against its middle instead does not work. The
  // environment is a room with a key panel on one side, so ambient light is not
  // uniform across the felt to begin with, and the far edge is foreshortened
  // enough that a pixel of error is half a unit of floor. Both of those cancel in
  // a ratio taken at a fixed point.
  const samples = [0, 1.5, 3.0, 4.2, 5.0, 5.4];

  const project = () => page.evaluate((xs) => {
    const THREE = window.dicer.debug.three;
    const camera = window.dicer.debug.camera;
    return xs.map((x) => {
      const v = new THREE.Vector3(x, 0, 0).project(camera);
      return [Math.round((v.x * 0.5 + 0.5) * 720), Math.round((-v.y * 0.5 + 0.5) * 560)];
    });
  }, samples);

  const setOcclusion = (on) => page.evaluate((enabled) => {
    let found = 0;
    window.dicer.debug.scene.traverse((o) => {
      const material = o.material;
      if (material && material.aoMap) {
        material.aoMapIntensity = enabled ? 1 : 0;
        found++;
      }
    });
    return found;
  }, on);

  const read = async (points) => {
    await frames(3);
    const { data, info } = await sharp(await page.screenshot({ type: 'png' }))
      .raw().toBuffer({ resolveWithObject: true });
    return points.map(([x, y]) => {
      if (x < 0 || y < 0 || x >= info.width || y >= info.height) return NaN;
      const i = (y * info.width + x) * info.channels;
      return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    });
  };

  const points = await project();
  const materials = await setOcclusion(true);
  const occluded = await read(points);
  await setOcclusion(false);
  const open = await read(points);
  await setOcclusion(true);

  if (materials === 0) {
    console.error('\n  FAIL nothing in the scene carries an occlusion map');
    failed = true;
  }
  console.log(`  ${silenced} direct lights silenced, ${materials} material carrying occlusion\n`);

  // The same closed form the bake uses, so the check and the bake can disagree.
  const corner = (a, b, c) => {
    if (a <= 0 || b <= 0 || c <= 0) return 0;
    const x = a / c;
    const y = b / c;
    const rx = Math.sqrt(1 + x * x);
    const ry = Math.sqrt(1 + y * y);
    return ((x / rx) * Math.atan(y / rx) + (y / ry) * Math.atan(x / ry)) / (2 * Math.PI);
  };
  const seen = (x) => {
    const hw = 11.5 / 2;
    const hd = 8.5 / 2;
    const h = 2.3;
    return corner(hw + x, hd, h) * 2 + corner(hw - x, hd, h) * 2;
  };
  const brightest = seen(0);

  console.log('   across the floor    measured   predicted   difference');
  let worst = 0;
  samples.forEach((x, i) => {
    const measured = occluded[i] / open[i];
    const predicted = seen(x) / brightest;
    const gap = Math.abs(measured - predicted);
    if (Number.isFinite(gap) && gap > worst) worst = gap;
    console.log(
      `   x = ${x.toFixed(1).padStart(4)}            ${measured.toFixed(3)}      ${predicted.toFixed(3)}       ${gap.toFixed(3)}`,
    );
  });

  const edge = occluded[samples.length - 1] / open[samples.length - 1];
  console.log(`\n  the felt by the wall is ${edge.toFixed(3)} of what it would be unoccluded`);
  if (!Number.isFinite(worst)) {
    console.error('\n  FAIL could not read the felt — the sample points are off screen');
    failed = true;
  } else if (worst > 0.06) {
    console.error(
      `\n  FAIL the occlusion is ${worst.toFixed(3)} away from what the geometry asks for at its worst`,
    );
    failed = true;
  } else if (edge > 0.9) {
    console.error(`\n  FAIL the felt by the wall is ${edge.toFixed(3)} of open — it is not darkening`);
    failed = true;
  }

  console.log(failed ? '' : '\nthe felt darkens toward the walls, by what the geometry says it should');
} finally {
  await browser.close();
  await server.close();
}

process.exit(failed ? 1 : 0);
