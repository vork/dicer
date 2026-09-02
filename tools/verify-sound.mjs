/**
 * Measures the impact sounds instead of describing them.
 *
 * "Muffled" and "same-y" are both measurable: muffled is how little energy sits
 * above a few kHz, and same-y is how alike two impacts are spectrally. Both are
 * taken off the real DiceAudio class, rendered through an OfflineAudioContext so
 * the samples can be inspected rather than listened to.
 *
 *   npm run verify:sound
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5206 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Log-spaced band energies, which is roughly how hearing compares timbres. */
function spectrum(samples, sampleRate) {
  const n = 16384;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const take = Math.min(n, samples.length);
  for (let i = 0; i < take; i++) {
    re[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (take - 1)));
  }
  fft(re, im);
  const bands = [];
  const edges = [];
  for (let f = 120; f <= 20000; f *= Math.pow(2, 1 / 3)) edges.push(f);
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = Math.round((edges[b] / sampleRate) * n);
    const hi = Math.round((edges[b + 1] / sampleRate) * n);
    let sum = 0;
    for (let k = lo; k < hi && k < n / 2; k++) sum += re[k] * re[k] + im[k] * im[k];
    bands.push({ lo: edges[b], hi: edges[b + 1], energy: sum });
  }
  return bands;
}

let failed = false;
try {
  await page.goto('http://127.0.0.1:5206/', { waitUntil: 'load' });
  await page.waitForFunction('window.dicer && window.dicer.debug', { timeout: 120000 });

  const rendered = await page.evaluate(async () => {
    const { DiceAudio } = await import('/src/audio.ts');
    const RATE = 44100;
    const out = [];
    const cases = [];
    // A spread of the contacts a real roll actually produces.
    for (const surface of ['floor', 'wall', 'dice']) {
      for (const strength of [0.25, 0.6, 0.95]) {
        for (let take = 0; take < 4; take++) cases.push({ surface, strength });
      }
    }

    for (const c of cases) {
      const ctx = new OfflineAudioContext(2, Math.ceil(RATE * 0.4), RATE);
      // DiceAudio refuses to play into a context that is not running, and an
      // offline one never is until it renders.
      Object.defineProperty(ctx, 'state', { get: () => 'running' });
      const audio = new DiceAudio();
      const Original = window.AudioContext;
      window.AudioContext = function () { return ctx; };
      audio.resume();
      window.AudioContext = Original;
      audio.impact(c.strength, 0, c.surface, 0.5);
      const buffer = await ctx.startRendering();
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      const mono = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
      out.push({ ...c, samples: Array.from(mono.subarray(0, 16384)) });
    }
    return { rate: RATE, out };
  });

  const analysed = rendered.out.map((r) => {
    const bands = spectrum(r.samples, rendered.rate);
    const total = bands.reduce((a, b) => a + b.energy, 0) || 1e-12;
    const high = bands.filter((b) => b.lo >= 6000).reduce((a, b) => a + b.energy, 0);
    // Log magnitudes make the comparison about shape rather than loudness.
    const shape = bands.map((b) => Math.log10(b.energy / total + 1e-9));
    const peak = Math.max(...r.samples.map(Math.abs));
    // How long it takes to fall 20dB below its loudest moment. A die is a click:
    // tens of milliseconds. Much past that and decaying sinusoids stop sounding
    // like plastic and start sounding like a chime, which is the other way to be
    // artificial.
    const env = [];
    const win = 64;
    for (let i = 0; i + win < r.samples.length; i += win) {
      let sum = 0;
      for (let k = 0; k < win; k++) sum += r.samples[i + k] * r.samples[i + k];
      env.push(Math.sqrt(sum / win));
    }
    const loudest = Math.max(...env);
    const at = env.findIndex((v, i) => i > env.indexOf(loudest) && v < loudest * 0.1);
    const decayMs = at < 0 ? Infinity : (at * win * 1000) / 44100;
    return { ...r, bright: high / total, shape, peak, decayMs };
  });

  // Correlation, not raw cosine. Log magnitudes are all negative numbers of
  // similar size, so plain cosine between two of them sits above 0.99 however
  // different the sounds are — it is measuring the shared offset. Centring each
  // spectrum first makes the comparison about shape, which is what "same-y"
  // means.
  const cosine = (a, b) => {
    const mean = (xs) => xs.reduce((p, q) => p + q, 0) / xs.length;
    const ma = mean(a);
    const mb = mean(b);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] - ma;
      const y = b[i] - mb;
      dot += x * y; na += x * x; nb += y * y;
    }
    return dot / Math.sqrt(na * nb);
  };

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const bright = mean(analysed.map((a) => a.bright));

  // How alike two impacts of the *same* kind are. This is the "same-y" number:
  // if every contact is the same noise burst through the same filter, it sits at
  // essentially 1.
  const sameKind = [];
  for (let i = 0; i < analysed.length; i++) {
    for (let j = i + 1; j < analysed.length; j++) {
      if (analysed[i].surface !== analysed[j].surface) continue;
      if (analysed[i].strength !== analysed[j].strength) continue;
      sameKind.push(cosine(analysed[i].shape, analysed[j].shape));
    }
  }

  console.log(`${analysed.length} impacts rendered offline\n`);
  for (const surface of ['floor', 'wall', 'dice']) {
    const rows = analysed.filter((a) => a.surface === surface);
    const decays = rows.map((r) => r.decayMs).filter((d) => Number.isFinite(d));
    const decay = decays.length ? mean(decays).toFixed(0) : '>370';
    console.log(`  ${surface.padEnd(6)} energy above 6kHz ${(mean(rows.map((r) => r.bright)) * 100).toFixed(1)}%   peak ${mean(rows.map((r) => r.peak)).toFixed(3)}   -20dB in ${decay}ms`);
  }
  console.log(`\n  energy above 6kHz, overall     ${(bright * 100).toFixed(1)}%`);
  console.log(`  likeness of two like impacts   ${mean(sameKind).toFixed(3)}  (1.000 = identical)`);

  // A hard little object is mostly top end. The single-bandpass version this
  // replaced measured 0.4% — uniformly, on all three surfaces, which is both
  // halves of the complaint in one number — against roughly 30% now.
  if (bright < 0.12) {
    console.error(`\n  FAIL only ${(bright * 100).toFixed(1)}% of the energy is above 6kHz — that is the muffled sound`);
    failed = true;
  }
  // Two impacts of the same kind should still differ audibly. The limit sits
  // between the version that reused one filter shape every time (0.99) and this
  // one (0.89); the same material struck the same way twice is meant to be
  // similar, just not identical.
  if (mean(sameKind) > 0.95) {
    console.error(`\n  FAIL two impacts of the same kind are ${mean(sameKind).toFixed(3)} alike — every contact sounds the same`);
    failed = true;
  }
  const slow = analysed.filter((a) => !Number.isFinite(a.decayMs) || a.decayMs > 220);
  if (slow.length) {
    console.error(`\n  FAIL ${slow.length} impact(s) ring on past 220ms — that is a chime, not a die`);
    failed = true;
  }
  if (analysed.some((a) => a.peak > 1.0)) {
    console.error('\n  FAIL an impact clips');
    failed = true;
  }
  if (!failed) console.log('\nthe impacts are bright, and no two of them are alike');
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
