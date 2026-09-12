/**
 * Where a frame's time goes, stage by stage, on a phone-sized canvas.
 *
 * Runs the real app headlessly on a software GPU, so the absolute numbers are
 * nothing like a phone's — but a software rasteriser is bound by the same
 * things a weak mobile GPU is, fill and shader work per pixel, so the *share*
 * each stage takes and the *ratio* between two configurations carry over.
 * That is what this measures: a mid-throw frame (velocity, motion blur and the
 * shadow map all live) and a settled one, for each quality tier, and the
 * solver's own cost per frame across the throw.
 *
 *   node tools/bench.mjs                 # every tier
 *   node tools/bench.mjs --tier low      # one tier
 *   node tools/bench.mjs --dpr 2 --width 412 --height 915
 *   node tools/bench.mjs --json          # machine-readable
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);

const width = Number(option('width', 390));
const height = Number(option('height', 844));
const dpr = Number(option('dpr', 3));
const frames = Number(option('frames', 6));
const tiers = option('tier', 'high,medium,low').split(',');
const pool = option('pool', 'd20,d12,d6,coin').split(',');
const json = flag('json');

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5241 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** One tier, measured from a fresh page so its start-up path is the real one. */
async function measure(tier) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  const waitFrames = (n) =>
    page.evaluate(
      (count) =>
        new Promise((resolve) => {
          let seen = 0;
          const tick = () => (++seen >= count ? resolve(seen) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
      n,
    );

  await page.goto(`http://127.0.0.1:5241/?quality=${tier}`, { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', null, { timeout: 120000 });
  await page.waitForFunction(
    () => {
      const l = document.getElementById('loader');
      return !l || l.classList.contains('done');
    },
    { timeout: 180000 },
  );

  const setup = await page.evaluate(() => {
    const d = window.dicer.debug;
    const renderer = d.renderer;
    const size = renderer.getSize(new d.three.Vector2());
    return {
      pixelRatio: renderer.getPixelRatio(),
      canvas: [Math.round(size.x * renderer.getPixelRatio()), Math.round(size.y * renderer.getPixelRatio())],
      quality: d.quality ? d.quality() : null,
    };
  });

  await page.evaluate((types) => window.dicer.debug.setPool(types), pool);
  await page.evaluate(() => window.dicer.debug.seed(11));
  await page.evaluate(() => window.dicer.debug.roll(0.2, -1, 0.7));
  // Mid-throw: everything is moving, so the shadow map, velocity and blur all
  // have work to do.
  await waitFrames(20);
  let info = { calls: 0, triangles: 0 };
  const profile = async () => {
    const runs = [];
    for (let i = 0; i < frames; i++) runs.push(await page.evaluate(() => window.dicer.debug.profileFrame(1 / 60)));
    const stages = {};
    for (const key of Object.keys(runs[0].stages)) stages[key] = median(runs.map((run) => run.stages[key] ?? 0));
    info = { calls: runs[0].calls, triangles: runs[0].triangles };
    return stages;
  };
  await page.evaluate(() => window.dicer.debug.pause(true));
  const rolling = await profile();
  await page.evaluate(() => window.dicer.debug.pause(false));

  await page.waitForFunction('window.dicer.debug.state().settled === true', null, { polling: 250, timeout: 300000 });
  const stepTimes = await page.evaluate(() => window.dicer.debug.stepTimes());
  await waitFrames(30);
  await page.evaluate(() => window.dicer.debug.pause(true));
  const settled = await profile();
  await page.evaluate(() => window.dicer.debug.pause(false));

  // Wall-clock frame rate of the real loop, settled, as a cross-check on the
  // drained per-stage numbers: this is what a player would feel.
  const loop = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          if (times.length >= 40) resolve(times);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

  await page.close();
  const active = stepTimes.filter((t) => t > 0);
  return {
    tier,
    setup,
    info,
    rolling,
    settled,
    step: { median: median(active), max: Math.max(0, ...active) },
    loopFrame: median(loop.slice(5)),
  };
}

const results = [];
try {
  for (const tier of tiers) results.push(await measure(tier));
} finally {
  await browser.close();
  await server.close();
}

const total = (stages) => Object.values(stages).reduce((a, b) => a + b, 0);

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`\n  ${width}x${height} css px at ${dpr}x, pool ${pool.join(' ')}, software GPU (ratios matter, not the numbers)\n`);
  for (const result of results) {
    const { tier, setup, rolling, settled, step, info, loopFrame } = result;
    console.log(
      `  [${tier}] canvas ${setup.canvas.join('x')} (pixel ratio ${setup.pixelRatio}), ` +
        `${info.calls} draw calls, ${info.triangles} triangles` +
        (setup.quality ? `, tier settings ${JSON.stringify(setup.quality)}` : ''),
    );
    const stages = Object.keys(rolling);
    const widest = Math.max(...stages.map((s) => s.length));
    for (const stage of stages) {
      console.log(
        `    ${stage.padEnd(widest)}  rolling ${rolling[stage].toFixed(1).padStart(7)} ms   settled ${(settled[stage] ?? 0).toFixed(1).padStart(7)} ms`,
      );
    }
    console.log(
      `    ${'total'.padEnd(widest)}  rolling ${total(rolling).toFixed(1).padStart(7)} ms   settled ${total(settled).toFixed(1).padStart(7)} ms`,
    );
    console.log(`    solver per frame: median ${step.median.toFixed(2)} ms, worst ${step.max.toFixed(2)} ms`);
    console.log(`    settled loop frame: ${loopFrame.toFixed(1)} ms\n`);
  }
  if (results.length > 1) {
    const base = total(results[0].rolling);
    for (const result of results.slice(1)) {
      console.log(`  ${result.tier} renders a rolling frame in ${(100 * total(result.rolling) / base).toFixed(0)}% of ${results[0].tier}'s time`);
    }
    console.log();
  }
}
