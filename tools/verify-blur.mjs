/**
 * Motion blur must smear a moving die by an amount that follows the frame, and
 * must do nothing at all to a still one.
 *
 * Both halves matter. The whole point of tying the blur to the distance covered
 * between two frames rather than to a constant is that a long frame gets a long
 * exposure, which is what stops a big step reading as a jump — so that
 * proportionality is the thing to measure, not the mere presence of a smear.
 * And the numerals on a settled die are the one thing on screen that has to stay
 * legible, so a still frame has to come out bit-identical with the blur on.
 *
 * The dice are posed by hand rather than thrown. With the app paused, the check
 * writes a die's last-frame transform and its current one directly — which is
 * exactly what the physics does every frame — so the displacement is known
 * instead of measured, and the two frames under test are the only ones that
 * happen.
 *
 *   node tools/verify-blur.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5219 },
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

/**
 * Renders one frame with a die displaced by `shift` world units along x, as if
 * the frame had taken `delta` seconds.
 *
 * Rendered several times over rather than once: the shutter follows a smoothed
 * frame time, so a single frame at a new rate would be caught mid-way between the
 * old shutter and the new one. The pose does not change between the repeats, so
 * the velocity is the same every time and only the smoothing moves.
 */
async function shot(shift, blur, delta = 1 / 60) {
  await page.evaluate(async ({ shift, blur, delta }) => {
    const debug = window.dicer.debug;
    debug.setMotionBlur(blur);
    const meshes = debug.diceMeshes();
    for (const mesh of meshes) {
      // Put it back where the pose started, then say it was `shift` to the left
      // a frame ago. This is what syncMeshes does, with a displacement we chose.
      mesh.position.copy(mesh.userData.poseOrigin);
      mesh.updateMatrixWorld(true);
      mesh.userData.previousMatrixWorld.copy(mesh.matrixWorld);
      mesh.position.x += shift;
      mesh.updateMatrixWorld(true);
    }
    // Render until the shutter stops moving. Yielding between frames matters:
    // forty renders in one turn starves the compositor and the screenshot that
    // follows times out waiting for a frame that is never composited.
    let last = -1;
    for (let i = 0; i < 90; i++) {
      debug.renderFrame(delta);
      const now = debug.shutter();
      if (Math.abs(now - last) < 1e-4) break;
      last = now;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, { shift, blur, delta });
  const buffer = await page.screenshot({ type: 'png', timeout: 60000 });
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * The exposure the blur actually used, in pixels, found by asking which one
 * reproduces it.
 *
 * A screen-space motion blur is the frame averaged along the direction of travel
 * over the distance covered while the shutter was open. So the sharp frame,
 * averaged along x over a candidate length, should reproduce the blurred one —
 * and only the right length does. Scanning the candidates and taking the best fit
 * measures the exposure with no threshold in it anywhere, which is what defeated
 * measuring the width of the region that changed (a smear tapers, so its tail
 * sits under whatever threshold you pick) and what defeated recovering it from
 * the spread of the luminance gradient (the identity that a box adds its variance
 * holds for one edge, and a die in a tray is a window full of them).
 *
 * It also cannot pass by accident: a blur of the wrong length is a worse fit than
 * the right one, and the check below shows the curve either side of the minimum.
 */
function bestFitExposure(sharp, blurred, box, longest) {
  const taps = 11;
  const width = sharp.width;
  const luma = (image, x, y) => {
    const i = (y * width + x) * image.channels;
    return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
  };
  const fit = (length) => {
    let error = 0;
    let n = 0;
    for (let y = box.top; y < box.bottom; y++) {
      for (let x = box.left; x < box.right; x++) {
        let averaged = 0;
        for (let t = 0; t < taps; t++) {
          const at = x + Math.round(length * (t / (taps - 1) - 0.5));
          averaged += luma(sharp, Math.min(width - 1, Math.max(0, at)), y);
        }
        error += Math.abs(averaged / taps - luma(blurred, x, y));
        n++;
      }
    }
    return error / n;
  };
  let best = 0;
  let bestError = Infinity;
  const curve = [];
  for (let length = 0; length <= longest; length += 1) {
    const error = fit(length);
    curve.push({ length, error });
    if (error < bestError) {
      bestError = error;
      best = length;
    }
  }
  return { best, bestError, curve };
}

/**
 * Bounding box, along x, of the pixels that differ between two frames, and how
 * much they differ in total.
 */
function changed(a, b) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let total = 0;
  let count = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * a.channels;
      const d =
        Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d > 12) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        count++;
      }
      total += d;
    }
  }
  return { width: right >= left ? right - left + 1 : 0, left, right, top, bottom, total, count };
}

let failed = false;
try {
  await page.goto('http://127.0.0.1:5219/?quality=high', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', null, { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById('loader');
    return !l || l.classList.contains('done');
  }, { timeout: 180000 });

  // A fixed throw. These checks measure the picture after the dice land, and an
  // unseeded roll measures a different pose every run — which is how this one
  // came to report anything between 8.6% and 53.6% on code that had not changed.
  await page.evaluate(() => window.dicer.debug.seed(2));
  await page.evaluate(() => window.dicer.debug.setPool(['d20']));
  await page.evaluate(() => window.dicer.debug.roll(0, -1, 0.7));
  await page.waitForFunction('window.dicer.debug.state().settled === true', null, { polling: 250, timeout: 300000 });
  await page.evaluate(() => window.dicer.debug.holdReveal(true));
  // Grain reseeds every frame and the camera never stops drifting; either one
  // would swamp a comparison of two frames. Same reason as verify:flakes.
  await page.evaluate(() => window.dicer.debug.setGrain(0));
  // Bloom sits downstream of the blur, so a smeared highlight then blooms and the
  // region that changed comes out wider than the exposure that caused it — the
  // first run of this measured a smear growing at twice the rate the geometry
  // predicts, all of it bloom. With it off, what is left is the smear.
  await page.evaluate(() => window.dicer.debug.setBloom(0, 0.55, 1.08));
  await frames(120);
  await page.evaluate(() => window.dicer.debug.freezeCamera(true));
  await frames(6);
  await page.evaluate(() => {
    const debug = window.dicer.debug;
    debug.pause(true);
    for (const mesh of debug.diceMeshes()) {
      mesh.userData.poseOrigin = mesh.position.clone();
    }
  });

  // --- what two identical frames look like, before believing anything else ---
  //
  // Everything below is a difference between two renders, so the first thing to
  // establish is what a difference of nothing measures. Skip this and any
  // instability in the capture reads as a result.
  const control = changed(await shot(0, 0), await shot(0, 0));
  console.log(`  two identical frames   ${control.count} pixels differ, spanning ${control.width}px`);

  // --- the velocity buffer itself, which is what the blur works from ---------
  //
  // Checked directly as well as through the picture, because this is where the
  // one real bug lived and a screenshot only said that something was wrong.
  const velocity = await page.evaluate(() => {
    const debug = window.dicer.debug;
    const look = (shift) => {
      for (const mesh of debug.diceMeshes()) {
        mesh.position.copy(mesh.userData.poseOrigin);
        mesh.updateMatrixWorld(true);
        mesh.userData.previousMatrixWorld.copy(mesh.matrixWorld);
        mesh.position.x += shift;
        mesh.updateMatrixWorld(true);
      }
      debug.renderFrame(1 / 60);
      const buffer = debug.readVelocity();
      let longest = 0;
      let moving = 0;
      for (let i = 0; i < buffer.data.length; i += 4) {
        const size = Math.hypot(buffer.data[i], buffer.data[i + 1]);
        if (size > longest) longest = size;
        if (size > 1e-4) moving++;
      }
      return { longest, moving, pixels: buffer.width * buffer.height };
    };
    return { still: look(0), moved: look(0.2) };
  });
  console.log(
    `  a still scene          longest velocity ${velocity.still.longest.toExponential(1)} uv, ` +
      `${velocity.still.moving} of ${velocity.still.pixels} texels moving`,
  );
  console.log(
    `  one die moved          longest velocity ${velocity.moved.longest.toExponential(1)} uv, ` +
      `${velocity.moved.moving} of ${velocity.moved.pixels} texels moving`,
  );
  if (velocity.still.moving > 0) {
    console.error(
      `\n  FAIL ${velocity.still.moving} texels carry a velocity in a scene where nothing moved`,
    );
    failed = true;
  }
  // One die of this size covers a few percent of the frame. Much more than that
  // and the velocity has leaked onto scenery that did not move — which is exactly
  // what happened when the per-object uniform was uploaded once for the whole
  // pass instead of once per object, and every mesh drawn after the first
  // carried the first one's transform.
  if (velocity.moved.moving === 0 || velocity.moved.moving > velocity.moved.pixels * 0.12) {
    console.error(
      `\n  FAIL ${velocity.moved.moving} of ${velocity.moved.pixels} texels moved when one die did`,
    );
    failed = true;
  }

  // --- a still die must be untouched -----------------------------------------
  const stillOff = await shot(0, 0);
  const stillOn = await shot(0, 1);
  const still = changed(stillOff, stillOn);
  console.log(`  a still die            ${still.count} pixels differ with the blur on`);
  if (still.count > control.count) {
    console.error(`\n  FAIL the blur alters a frame in which nothing moved — ${still.count} pixels`);
    failed = true;
  }

  // --- how far a die travels on screen per world unit, so the sweep below can
  // be read in pixels rather than in guesses ---------------------------------
  const scale = await page.evaluate(() => {
    const THREE = window.dicer.debug.three;
    const camera = window.dicer.debug.camera;
    const mesh = window.dicer.debug.diceMeshes()[0];
    const at = mesh.userData.poseOrigin.clone().project(camera);
    const shifted = mesh.userData.poseOrigin.clone().add(new THREE.Vector3(1, 0, 0)).project(camera);
    return Math.abs(shifted.x - at.x) * 0.5 * 900;
  });
  const ceiling = 700 * 0.05;
  console.log(`  one world unit is      ${scale.toFixed(0)}px across the frame`);
  console.log(`  the smear is capped at ${ceiling.toFixed(0)}px`);

  // --- a moving die must smear by the distance it covered --------------------
  //
  // Swept rather than sampled at two points. The first version of this check
  // picked 0.22 and 0.44 units out of the air; both were already past the cap, so
  // both smeared by exactly the ceiling and the check reported that doubling the
  // step changed nothing. The sweep shows where the response is linear and where
  // it saturates, which is the only way to tell those two apart.
  // The die's own patch of screen, so the profile is not diluted by the tray.
  const box = changed(stillOff, await shot(0.30, 0));
  const band = {
    left: Math.max(0, box.left - 50),
    right: Math.min(900, box.right + 50),
    top: Math.max(0, box.top),
    bottom: Math.min(700, box.bottom),
  };

  // In pixels, converted to world units through the measured scale, rather than
  // in world units directly. Where the die settles decides how close the camera
  // frames it, so a fixed world displacement is a different number of pixels
  // every run — which made this check pass or fail on the throw.
  const sweep = [7, 14, 22, 31].map((pixels) => pixels / scale);
  const measured = [];
  for (const shift of sweep) {
    const sharp = await shot(shift, 0);
    const blurred = await shot(shift, 1);
    const { best, curve } = bestFitExposure(sharp, blurred, band, 60);
    measured.push(best);
    const predicted = shift * scale * 0.5;
    // How much worse the fit is at nothing and at double, so the minimum is
    // visibly a minimum rather than a number that came out of a loop.
    const at = (length) => curve[Math.min(curve.length - 1, Math.max(0, Math.round(length)))].error;
    console.log(
      `  moved ${(shift * scale).toFixed(0).padStart(2)}px       best fit ${String(best).padStart(2)}px  ` +
        `against ${predicted.toFixed(1).padStart(5)}px predicted   ` +
        `(fit error ${at(best).toFixed(2)} here, ${at(0).toFixed(2)} unblurred, ${at(best * 2).toFixed(2)} at double)`,
    );
  }

  if (measured[0] <= 0) {
    console.error('\n  FAIL a moving die is not blurred at all');
    failed = true;
  }
  for (let i = 1; i < measured.length; i++) {
    if (measured[i] <= measured[i - 1]) {
      console.error(
        `\n  FAIL moving ${sweep[i]} units exposed no longer than moving ${sweep[i - 1]} — ` +
          'the blur is not following the distance covered',
      );
      failed = true;
      break;
    }
  }
  // Straight-line fit through the sweep. The slope is the shutter: how many
  // pixels of exposure the blur spends per pixel the die actually travelled.
  const travelled = sweep.map((shift) => shift * scale);
  const meanX = travelled.reduce((a, b) => a + b, 0) / travelled.length;
  const meanY = measured.reduce((a, b) => a + b, 0) / measured.length;
  let top = 0;
  let bottom = 0;
  for (let i = 0; i < sweep.length; i++) {
    top += (travelled[i] - meanX) * (measured[i] - meanY);
    bottom += (travelled[i] - meanX) ** 2;
  }
  const shutter = top / bottom;
  console.log(`  across the sweep       the exposure runs ${shutter.toFixed(2)} of the distance covered, against the 0.50 of a 60fps frame`);
  if (shutter < 0.3 || shutter > 0.75) {
    console.error(
      `\n  FAIL the exposure is ${shutter.toFixed(2)} of the distance covered where the shutter at this rate is 0.50`,
    );
    failed = true;
  }

  // --- the same throw at different frame rates must judder the same ----------
  //
  // This is the whole point of tying the shutter to the frame time. What the eye
  // reads as a stutter is the gap left unexposed between one frame's smear and
  // the next one's, so a die moving at a fixed speed should leave the same gap
  // whatever the frame rate — covering twice the ground per frame at 30fps, and
  // a larger share of it. A fixed shutter cannot do that: it holds the gap at a
  // fixed fraction of the step, which is twice as many pixels at half the rate.
  console.log('');
  // Held constant in pixels a frame at the reference rate, for the same reason.
  const speed = (14 * 60) / scale;
  const rates = [120, 60, 30, 20];
  const gaps = [];
  for (const fps of rates) {
    const step = speed / fps;
    const sharp = await shot(step, 0, 1 / fps);
    const blurred = await shot(step, 1, 1 / fps);
    const { best } = bestFitExposure(sharp, blurred, band, 60);
    const travelledPx = step * scale;
    const openTo = await page.evaluate(() => window.dicer.debug.shutter());
    gaps.push(travelledPx - best);
    const wanted = travelledPx * openTo;
    console.log(
      `  the same die at ${String(fps).padStart(3)}fps  travels ${travelledPx.toFixed(1).padStart(5)}px a frame, ` +
        `shutter ${openTo.toFixed(2)}, exposure ${String(best).padStart(2)}px, ` +
        `leaving a ${(travelledPx - best).toFixed(1).padStart(4)}px gap` +
        (wanted > ceiling ? `  (the ${ceiling.toFixed(0)}px ceiling is binding here)` : ''),
    );
  }

  // 120fps sits under the floor by design — up there the gap is already smaller
  // than the one being held, so there is nothing to close and the shutter tapers
  // off to a trace. The rates at and below the reference are the ones that must
  // agree with each other.
  const held = gaps.slice(1);
  const widest = Math.max(...held);
  const narrowest = Math.min(...held);
  // What a fixed shutter would have left, for the comparison this is all about.
  const fixed = rates.slice(1).map((fps) => (speed / fps) * scale * (1 - 0.5));
  console.log(
    `  across 60 to 20fps     the gap runs ${narrowest.toFixed(1)}px to ${widest.toFixed(1)}px, ` +
      `where a fixed shutter would run ${Math.min(...fixed).toFixed(1)}px to ${Math.max(...fixed).toFixed(1)}px`,
  );
  if (widest - narrowest > 8) {
    console.error(
      `\n  FAIL the unblurred gap runs ${narrowest.toFixed(1)}px to ${widest.toFixed(1)}px across the frame rates — ` +
        'a slow frame rate still judders more than a fast one',
    );
    failed = true;
  }
  if (gaps[1] <= 0 || gaps[2] <= 0) {
    console.error('\n  FAIL the exposure covers the whole step, which is more blur than the motion calls for');
    failed = true;
  }

  // --- and a jump must not streak across the screen --------------------------
  //
  // Kept small enough that the die is still in frame: at six units it left the
  // viewport altogether and the check passed on an empty picture.
  // Far enough to be a jump, near enough that the die is still in frame: at a
  // fixed 1.6 world units it left the viewport whenever the camera framed close,
  // and the check then passed on an empty picture.
  const jump = 150 / scale;
  const streak = changed(await shot(jump, 0), await shot(jump, 1));
  const allowed = (box.right - box.left) + ceiling * 2 + 30;
  console.log(`  a jump of ${(jump * scale).toFixed(0)}px      spans ${streak.width}px, and must stay under ${allowed.toFixed(0)}px`);
  if (streak.width === 0) {
    console.error('\n  FAIL nothing changed on the jump — the die is out of frame and this proves nothing');
    failed = true;
  } else if (streak.width > allowed) {
    console.error(`\n  FAIL a single huge step smeared ${streak.width}px — the ceiling is not holding`);
    failed = true;
  }

  console.log(
    failed
      ? '\nthe motion blur does not do what it claims'
      : '\nthe throw is smeared by the distance it covers, and a settled die is untouched',
  );
} finally {
  await browser.close();
  await server.close();
}

process.exit(failed ? 1 : 0);
