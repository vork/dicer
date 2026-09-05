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

/**
 * Spectral flatness over raw bins: the geometric mean of bin power over the
 * arithmetic mean. Near zero means the energy stands in a few narrow places,
 * which is what a pitch is; near one means it is spread, which is what a clatter
 * is. This is the number for "does it sound like a tuned instrument".
 */
function binFlatness(re, im, lo, hi, rate, n) {
  const a = Math.max(1, Math.round((lo / rate) * n));
  const b = Math.min(n / 2, Math.round((hi / rate) * n));
  let logSum = 0;
  let linSum = 0;
  let count = 0;
  for (let k = a; k < b; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    logSum += Math.log(p + 1e-20);
    linSum += p;
    count++;
  }
  if (!count) return 0;
  return Math.exp(logSum / count) / (linSum / count);
}

/** Log-spaced band energies, which is roughly how hearing compares timbres. */
function spectrum(samples, sampleRate) {
  const n = 16384;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const take = Math.min(n, samples.length);
  // Half a Hann: full weight at sample zero, tapering to nothing at the end.
  //
  // A symmetric Hann is zero at both ends, and an impact starts at sample zero —
  // so it multiplied the few milliseconds of contact noise by about 0.002 and
  // erased the very thing being measured. It reported 0.3% of the energy above
  // 5.5kHz for a sound with an obvious top end, and would have had me chasing a
  // brightness problem that was in the analysis rather than the audio. This
  // shape keeps the transient and still avoids a discontinuity at the far end.
  for (let i = 0; i < take; i++) {
    re[i] = samples[i] * 0.5 * (1 + Math.cos((Math.PI * i) / (take - 1)));
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
  return { bands, re, im, n };
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
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < left.length; i++) { dot += left[i] * right[i]; na += left[i] * left[i]; nb += right[i] * right[i]; }
      out.push({
        ...c,
        samples: Array.from(mono.subarray(0, 16384)),
        correlation: dot / Math.sqrt(na * nb || 1e-12),
      });
    }
    return { rate: RATE, out };
  });

  const analysed = rendered.out.map((r) => {
    const { bands, re, im, n } = spectrum(r.samples, rendered.rate);
    const sampleRate = rendered.rate;
    const total = bands.reduce((a, b) => a + b.energy, 0) || 1e-12;
    const high = bands.filter((b) => b.lo >= 6000).reduce((a, b) => a + b.energy, 0);
    // Where the sound sits, not just how bright it is. 2.5-5.5kHz is where human
    // hearing is most sensitive, so it is also where a sound turns from present
    // to piercing; a die with nothing under 2.5k has no body and reads as thin.
    const share = (lo, hi) =>
      bands.filter((b) => b.lo >= lo && b.hi <= hi).reduce((a, b) => a + b.energy, 0) / total;
    const body = share(150, 700);
    const mid = share(700, 2500);
    const harsh = share(2500, 5500);
    const air = share(5500, 22000);
    // One number for "how high does this sit", and the one that compares most
    // directly against a real recording.
    let num = 0;
    let den = 0;
    for (const b of bands) {
      const centre = Math.sqrt(b.lo * b.hi);
      num += b.energy * centre;
      den += b.energy;
    }
    const centroid = den > 0 ? num / den : 0;
    // Spectral flatness: the geometric mean of the band energies over their
    // arithmetic mean. Near zero means the energy is concentrated in a few
    // places, which is what a pitch is; near one means it is spread, which is
    // what a clatter is. This is the number for "does it sound like a tuned
    // instrument", and nothing else here measures it.
    // Computed on raw FFT bins, not on the third-octave bands above. A resonator
    // at 1kHz with a Q of 20 is 50Hz wide; a third-octave band there is 230Hz, so
    // banding averages away the very peaks that make a pitch and reports the same
    // number for a chord and a clatter.
    const flatness = binFlatness(re, im, 150, 12000, sampleRate, n);
    // Log magnitudes make the comparison about shape rather than loudness.
    const shape = bands.map((b) => Math.log10(b.energy / total + 1e-9));
    const peak = Math.max(...r.samples.map(Math.abs));
    // Energy arriving after the strike is over. A dry synthetic impact stops when
    // its modes stop; a recorded one keeps going, because the table and the room
    // are still returning it.
    const energyIn = (a, b) => {
      let sum = 0;
      const lo = Math.round(44100 * a);
      const hi = Math.min(r.samples.length, Math.round(44100 * b));
      for (let i = lo; i < hi; i++) sum += r.samples[i] * r.samples[i];
      return sum;
    };
    const tail = energyIn(0.025, 0.2) / (energyIn(0, 0.025) || 1e-12);
    // What is still there long after the strike. The ratio above could not see
    // this: it was dominated by the 25-40ms region, where there was plenty, and
    // reported a healthy number for a sound that was already at absolute zero by
    // 56ms. Both recordings still have content in every band at 96ms, and a cut
    // to digital silence is one of the most recognisable synthetic tells there
    // is, so this window looks only at the far end.
    const far = energyIn(0.08, 0.2) / (energyIn(0, 0.025) || 1e-12);
    // Peak over RMS across the strike. Smooth enveloped noise sits low; a real
    // contact is spiky, being a great many tiny collisions between surface
    // asperities rather than one smooth push.
    const head = r.samples.slice(0, Math.round(44100 * 0.03));
    let sq = 0;
    let pk = 0;
    for (const v of head) { sq += v * v; pk = Math.max(pk, Math.abs(v)); }
    const crest = pk / (Math.sqrt(sq / head.length) || 1e-12);
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
    return { ...r, bright: high / total, shape, peak, decayMs, body, mid, harsh, air, centroid, flatness, tail, far, crest, correlation: r.correlation };
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
  console.log(`\n  where the energy sits:`);
  console.log(`    150-700Hz  body    ${(mean(analysed.map((a) => a.body)) * 100).toFixed(1)}%`);
  console.log(`    0.7-2.5kHz mid     ${(mean(analysed.map((a) => a.mid)) * 100).toFixed(1)}%`);
  console.log(`    2.5-5.5kHz harsh   ${(mean(analysed.map((a) => a.harsh)) * 100).toFixed(1)}%`);
  console.log(`    5.5kHz+    air     ${(mean(analysed.map((a) => a.air)) * 100).toFixed(1)}%`);
  const centroid = mean(analysed.map((a) => a.centroid));
  const below = mean(analysed.map((a) => a.body + a.mid));
  const above = mean(analysed.map((a) => a.harsh + a.air));
  console.log(`\n  spectral centroid              ${centroid.toFixed(0)}Hz`);
  console.log(`  below 2.5kHz vs above          ${(below / Math.max(above, 1e-6)).toFixed(1)}x`);
  console.log(`  spectral flatness              ${mean(analysed.map((a) => a.flatness)).toFixed(3)}  (low = tonal, high = clattery)`);
  console.log(`  tail after 25ms                ${(mean(analysed.map((a) => a.tail)) * 100).toFixed(1)}% of the strike's energy`);
  console.log(`  still there at 80-200ms        ${(mean(analysed.map((a) => a.far)) * 100).toFixed(2)}% of it`);
  console.log(`  L/R correlation                ${mean(analysed.map((a) => a.correlation)).toFixed(3)}  (1.000 = the same signal twice)`);
  console.log(`  crest factor                   ${mean(analysed.map((a) => a.crest)).toFixed(2)}  (peak over RMS, first 30ms)`);
  console.log('');
  console.log('  two real recordings, measured the same way:');
  console.log('    freesound rpg dice   body 11.9  mid 84.6  harsh  3.4  air 0.0   1383Hz  24ms');
  console.log('    pixabay dice 142528  body 10.6  mid 47.8  harsh 38.9  air 4.7   2500Hz  38ms');
  console.log(`\n  energy above 6kHz, overall     ${(bright * 100).toFixed(1)}%`);
  console.log(`  likeness of two like impacts   ${mean(sameKind).toFixed(3)}  (recordings: 0.90, 0.91)`);

  // The bounds below come from measuring two real dice recordings the user
  // picked out as pleasant (npm run sound:reference), not from theory — and the
  // measurement corrected two of my own assumptions.
  //
  // I had assumed energy in 2.5-5.5kHz was the problem, because the version that
  // was reported as uncomfortable had 44% of its energy there. But one of the
  // references has 39% in that band and sounds fine. What that version actually
  // lacked was anything underneath: 0.6% below 2.5kHz, against 58% and 96% in the
  // two recordings. It was all edge and no object. So the bound is on the
  // balance, not on the bright band alone.
  //
  // I had also required energy above 5.5kHz, on the theory that a hard little
  // object is mostly top end. One of the references has none at all — 0.0% — and
  // is perfectly pleasant, so that requirement was wrong and is gone.
  const body = mean(analysed.map((a) => a.body));
  const mid = mean(analysed.map((a) => a.mid));

  if (below / Math.max(above, 1e-6) < 1) {
    console.error(`\n  FAIL more energy above 2.5kHz than below it — both recordings are the other way round, by 1.3x and 28x`);
    failed = true;
  }
  if (body + mid < 0.25) {
    console.error(`\n  FAIL only ${((body + mid) * 100).toFixed(0)}% sits below 2.5kHz — that is thin`);
    failed = true;
  }
  if (body > 0.5) {
    console.error(`\n  FAIL ${(body * 100).toFixed(0)}% sits in 150-700Hz — the thump has swallowed the strike`);
    failed = true;
  }
  // Both recordings sit between 1.4kHz and 2.5kHz.
  if (centroid < 900 || centroid > 3200) {
    console.error(`\n  FAIL centroid at ${centroid.toFixed(0)}Hz — the recordings sit at 1383 and 2500`);
    failed = true;
  }
  // Bounded from both sides, and the lower bound is the one that mattered.
  //
  // I had assumed variety was the goal and pushed successive impacts apart, down
  // to 0.60 alike. Measuring the recordings says the opposite: two impacts from a
  // real roll are 0.90 and 0.91 alike, because the same object struck again
  // sounds like the same object. Redrawing the resonances every impact gives each
  // hit a different set of pitches, and a sequence of different pitches is an
  // instrument being played — which is what it sounded like.
  const alike = mean(sameKind);
  if (alike > 0.97) {
    console.error(`\n  FAIL two impacts of the same kind are ${alike.toFixed(3)} alike — every contact is identical`);
    failed = true;
  }
  if (alike < 0.7) {
    console.error(`\n  FAIL two impacts of the same kind are only ${alike.toFixed(3)} alike — the recordings are 0.90, and a die that changes pitch every throw is an instrument`);
    failed = true;
  }
  // The recordings fall 20dB in 24ms and 38ms. A die is a click.
  // Nothing physical stops dead. Before the room was added this measured 0.00%,
  // for a sound that was silent from 56ms — while every other number here sat
  // inside the recordings' range.
  const far = mean(analysed.map((a) => a.far));
  if (far < 0.002) {
    console.error(`\n  FAIL only ${(far * 100).toFixed(3)}% of the energy survives to 80ms — the impact cuts to digital silence`);
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
  if (!failed) console.log('\nthe impacts sit where the real recordings do');
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
