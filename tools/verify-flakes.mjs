/**
 * The flake field must not jump as the camera closes in.
 *
 * The lattice is mip-mapped, so somewhere in every dolly it crosses a level
 * boundary. If the two levels either side are not the same lattice at that
 * moment, the whole field re-randomises at once and the dice visibly fizz.
 *
 * Zooming is simulated by sweeping `grain` instead of moving the camera: the
 * level is chosen from log2(footprint * grain), so scaling grain walks the same
 * range as scaling the footprint, but with the camera, the dice and the lighting
 * held still. Anything that changes between two frames is then the lattice and
 * nothing else, which a moving camera could never tell you.
 *
 *   node tools/verify-flakes.mjs [--pool d20] [--octaves 4]
 */
import fs from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
    const [k, ...v] = s.trim().split(/\s+/);
    return [k, v.join(' ') || 'true'];
  }),
);
const pool = (args.pool || 'd20').split(',');
const octaves = Number(args.octaves || 4);
// Enough positions per octave that no boundary can hide between two of them.
const perOctave = 20;

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5202 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));

const frames = (n) =>
  page.evaluate((count) => new Promise((resolve) => {
    let seen = 0;
    const tick = () => (++seen >= count ? resolve(seen) : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

let failed = false;
try {
  await page.goto('http://127.0.0.1:5202/', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('loader');
    return !l || l.classList.contains('done');
  }, { timeout: 180000 });

  await page.evaluate((p) => window.dicer.debug.setPool(p), pool);
  await page.evaluate(() => window.dicer.debug.roll(0, -1, 0.7));
  await page.waitForFunction('window.dicer.debug.state().settled === true', { polling: 250, timeout: 300000 });
  await page.evaluate(() => window.dicer.debug.holdReveal(true));
  // The grade reseeds its film grain every frame, so with it running, the
  // difference between two frames is the grain and almost nothing else — it
  // buried the first version of this check under a flat noise floor four times
  // the size of anything the flakes were doing.
  await page.evaluate(() => window.dicer.debug.setGrain(0));
  await frames(160);
  // And the camera never stops drifting either, which was worse: normalising
  // each step by a locally measured drift blew up wherever the drift passed
  // through zero at a turning point of its own sine, and reported a 100x "pop"
  // at the same grain every run. Freeze it and the floor goes to nothing.
  await page.evaluate(() => window.dicer.debug.freezeCamera(true));
  await frames(4);

  // Freeze everything but the lattice: with the camera parked, any pixel that
  // changes between two samples changed because the flakes did.
  const box = await page.evaluate(() => {
    const { camera, positions } = window.dicer.debug.diceScreenInfo();
    const THREE = window.dicer.debug.three;
    const p = positions[0];
    const v = new THREE.Vector3(p.x, p.y, p.z).project(camera);
    return {
      x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
    };
  });
  const half = 70;
  const crop = {
    x: Math.max(0, box.x - half),
    y: Math.max(0, box.y - half),
    width: half * 2,
    height: half * 2,
  };

  const shoot = async () => {
    const shot = await page.screenshot({ clip: crop });
    return (await sharp(shot).greyscale().raw().toBuffer({ resolveWithObject: true })).data;
  };
  const meanAbs = (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  };

  const base = await page.evaluate(() => window.dicer.debug.getFlakes());
  const setGrain = (g) => page.evaluate((v) => window.dicer.debug.setFlakes({ grain: v }), g);

  // A statistical version of this — sweep the grain, look for an outlier step —
  // was too blunt: every step toggles a few percent of the flakes at random, so
  // the run scatters enough that the worst step sits 3-5x the median whether
  // anything is wrong or not.
  //
  // Straddling instead. A level boundary is crossed by a grain step of a fifth of
  // a percent, over which a working dissolve changes almost nothing, while a
  // mismatched handover swaps the entire field. So the question is not "is this
  // step unusually large" but "is it anywhere near as large as replacing every
  // flake", which is a difference of two orders of magnitude rather than a
  // judgement call about scatter.
  const REPLACED = await (async () => {
    await setGrain(base.grain);
    await frames(3);
    const a = await shoot();
    // Half an octave: a different lattice scale entirely, so nothing survives.
    await setGrain(base.grain * Math.SQRT2);
    await frames(3);
    const b = await shoot();
    return meanAbs(a, b);
  })();

  const STRADDLE = 0.002;
  const positions = octaves * perOctave;
  const pairs = [];
  for (let i = 0; i < positions; i++) {
    const g = base.grain * Math.pow(2, i / perOctave);
    await setGrain(g * (1 - STRADDLE));
    await frames(3);
    const before = await shoot();
    await setGrain(g * (1 + STRADDLE));
    await frames(3);
    const after = await shoot();
    pairs.push({ grain: g, delta: meanAbs(before, after) });
  }

  const sorted = pairs.map((p) => p.delta).slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = pairs.reduce((a, b) => (b.delta > a.delta ? b : a));
  const share = worst.delta / Math.max(REPLACED, 1e-6);

  if (args.series) {
    console.log('straddle deltas as a share of a full replacement:');
    console.log(pairs.map((p, i) => `${String(i).padStart(3)} grain ${p.grain.toFixed(3).padStart(7)}  ${(p.delta / REPLACED * 100).toFixed(1)}%`).join('\n'));
  }
  console.log(`${pairs.length} boundary straddles over ${octaves} octaves of zoom`);
  console.log(`  replacing every flake changes  ${REPLACED.toFixed(3)}`);
  console.log(`  median straddle                ${median.toFixed(3)}  (${(median / REPLACED * 100).toFixed(1)}%)`);
  console.log(`  worst straddle                 ${worst.delta.toFixed(3)}  (${(share * 100).toFixed(1)}%) at grain ${worst.grain.toFixed(2)}`);

  // A fifth of a percent of zoom cannot legitimately disturb a quarter of the
  // field. A mismatched handover disturbs nearly all of it.
  const LIMIT = 0.25;
  if (share > LIMIT) {
    console.error(`\n  FAIL the flake field jumps at grain ${worst.grain.toFixed(2)}: a 0.4% change of zoom replaces ${(share * 100).toFixed(0)}% of it`);
    failed = true;
  } else {
    console.log('\nthe flake field dissolves smoothly across every level boundary');
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
