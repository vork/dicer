/**
 * Edges must actually be antialiased.
 *
 * This check exists because the obvious way to ask the question gives the wrong
 * answer. The renderer was constructed with `antialias: true` and the default
 * frame buffer really did report four MSAA samples — but with an EffectComposer
 * in the chain nothing is ever drawn to the default frame buffer, so the picture
 * had no antialiasing whatsoever while every flag said it did. Asking the
 * renderer proves nothing; the only thing that settles it is the image.
 *
 * So this measures the frame. It walks scanlines across a settled die, finds
 * every high-contrast edge, and counts how many pixels each takes to cross. A
 * hard, unantialiased edge moves in one pixel. Multisampling puts intermediate
 * samples in between, and the median transition widens.
 *
 *   node tools/verify-aa.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5228 },
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
  await page.goto('http://127.0.0.1:5228/', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', null, { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('loader');
    return !l || l.classList.contains('done');
  }, { timeout: 180000 });

  const setup = await page.evaluate(() => {
    const renderer = window.dicer.debug.renderer;
    const gl = renderer.getContext();
    return {
      requested: gl.getContextAttributes().antialias,
      defaultSamples: gl.getParameter(gl.SAMPLES),
      pixelRatio: renderer.getPixelRatio(),
    };
  });
  console.log(
    `  the default frame buffer has ${setup.defaultSamples} samples (antialias: ${setup.requested}), ` +
      `and nothing is drawn to it`,
  );
  console.log(`  pixel ratio ${setup.pixelRatio}, so nothing is being supersampled either\n`);

  // A fixed throw. These checks measure the picture after the dice land, and an
  // unseeded roll measures a different pose every run — which is how this one
  // came to report anything between 8.6% and 53.6% on code that had not changed.
  await page.evaluate(() => window.dicer.debug.seed(3));
  await page.evaluate(() => window.dicer.debug.setPool(['d20', 'd12']));
  await page.evaluate(() => window.dicer.debug.roll(0.15, -1, 0.72));
  await page.waitForFunction('window.dicer.debug.state().settled === true', null, { polling: 250, timeout: 300000 });
  await page.evaluate(() => window.dicer.debug.holdReveal(true));
  // Grain would be read as edge detail everywhere, and the camera drifting would
  // move the edges between the measurement and itself.
  await page.evaluate(() => window.dicer.debug.setGrain(0));
  await frames(120);
  await page.evaluate(() => window.dicer.debug.freezeCamera(true));
  await frames(6);

  /** Widths, in pixels, of every high-contrast horizontal transition in the frame. */
  const edgeWidths = async () => {
    await frames(3);
    const { data, info } = await sharp(await page.screenshot({ type: 'png' }))
      .raw().toBuffer({ resolveWithObject: true });
    const luma = (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    };
    const found = [];
    for (let y = 100; y < 430; y += 2) {
      for (let x = 60; x < 660; x++) {
        if (Math.abs(luma(x + 1, y) - luma(x, y)) <= 0.10) continue;
        // Follow the transition while it keeps moving the same way, so a ramp
        // spread over several pixels counts as one edge rather than several.
        let end = x + 1;
        const direction = Math.sign(luma(end, y) - luma(x, y));
        while (
          end < 660 &&
          Math.sign(luma(end + 1, y) - luma(end, y)) === direction &&
          Math.abs(luma(end + 1, y) - luma(end, y)) > 0.012
        ) end++;
        // How many pixels the edge really takes, as a continuous number rather
        // than a count of them: the whole change across the edge divided by its
        // steepest single step. A hard edge does all of its change in one step
        // and scores 1.0; spreading the same change over a ramp scores higher.
        // Counting whole pixels quantises to 1 or 2 and flips between runs on
        // where the dice happened to settle.
        let steepest = 0;
        for (let i = x; i < end; i++) steepest = Math.max(steepest, Math.abs(luma(i + 1, y) - luma(i, y)));
        const change = Math.abs(luma(end, y) - luma(x, y));
        if (steepest > 0) found.push(change / steepest);
        x = end;
      }
    }
    found.sort((a, b) => a - b);
    const mean = found.reduce((a, b) => a + b, 0) / Math.max(found.length, 1);
    return {
      count: found.length,
      mean,
      median: found[Math.floor(found.length / 2)] ?? 0,
      hardShare: found.filter((w) => w < 1.05).length / Math.max(found.length, 1),
    };
  };

  // The structural check, and the reason it is worth making: the renderer's own
  // `antialias` flag was true this whole time, and the default frame buffer really
  // did carry four samples — but nothing is ever drawn there, so the picture had
  // none. This reads the buffers every pass actually writes into, and asks not
  // only what they are configured for but whether a multisampled frame buffer was
  // genuinely allocated for them, which is the part a setting cannot promise.
  const buffers = await page.evaluate(() => window.dicer.debug.samplesReport());
  buffers.forEach((buffer, i) => {
    console.log(
      `  composer buffer ${i + 1}: ${buffer.samples} samples, ` +
        `multisampled frame buffer ${buffer.multisampledFrameBuffer ? 'allocated' : 'MISSING'}`,
    );
  });
  const antialiased = buffers.length > 0 && buffers.every((b) => b.samples > 1 && b.multisampledFrameBuffer);
  if (!antialiased) {
    console.error('\n  FAIL the buffers the scene is drawn into are not multisampled');
    failed = true;
  }

  // And what that looks like in the picture. Reported rather than asserted on:
  // multisampling antialiases geometry coverage and nothing else — it runs the
  // fragment shader once per pixel — while most of the high-contrast edges in this
  // frame are painted numerals, flake glints and normal-mapped leather, which stay
  // exactly as hard however many samples the buffer has. A tight bound here would
  // be demanding something MSAA cannot deliver.
  const edges = await edgeWidths();
  console.log(
    `\n  ${edges.count} high-contrast edges: mean width ${edges.mean.toFixed(3)}px, ` +
      `${(edges.hardShare * 100).toFixed(0)}% cross in a single step`,
  );
  if (edges.count < 200) {
    console.error('\n  FAIL too few edges found to judge — the dice are probably not in frame');
    failed = true;
  } else if (edges.hardShare > 0.85) {
    console.error(
      `\n  FAIL ${(edges.hardShare * 100).toFixed(0)}% of edges are perfectly hard — nothing is being resolved`,
    );
    failed = true;
  }

  console.log(
    failed ? '' : '\nthe buffers the scene is drawn into are multisampled, and the frame shows it',
  );
} finally {
  await browser.close();
  await server.close();
}

process.exit(failed ? 1 : 0);
