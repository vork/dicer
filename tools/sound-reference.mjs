/**
 * Measures real dice recordings the same way verify-sound measures the synthesis,
 * so the two are directly comparable and the synthesis has something to aim at.
 *
 * Decoding is done in Chromium, which already ships an mp3 decoder; onsets are
 * picked off the energy envelope so each impact is measured on its own rather
 * than smeared into the roll around it.
 *
 *   node tools/sound-reference.mjs <file.mp3> [more.mp3 ...]
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node tools/sound-reference.mjs <file> [file ...]');
  process.exit(1);
}

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

/** Band energies, and the shares verify-sound reports. */
function analyse(samples, rate) {
  const n = 8192;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const take = Math.min(n, samples.length);
  // Half a Hann: an impact starts at sample zero, so the window must not.
  for (let i = 0; i < take; i++) {
    re[i] = samples[i] * 0.5 * (1 + Math.cos((Math.PI * i) / (take - 1)));
  }
  fft(re, im);
  const power = (lo, hi) => {
    const a = Math.max(1, Math.round((lo / rate) * n));
    const b = Math.min(n / 2, Math.round((hi / rate) * n));
    let sum = 0;
    for (let k = a; k < b; k++) sum += re[k] * re[k] + im[k] * im[k];
    return sum;
  };
  const total = power(120, rate / 2) || 1e-12;
  // Spectral centroid, the single number for "how high does this sit".
  let num = 0;
  let den = 0;
  for (let k = Math.round((120 / rate) * n); k < n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    num += p * ((k * rate) / n);
    den += p;
  }
  // Spectral flatness over raw bins: the geometric mean of bin power over the
  // arithmetic mean. Near zero means the energy stands in a few narrow places,
  // which is what a pitch is; near one means it is spread, which is a clatter.
  // Raw bins rather than bands, because a resonator is far narrower than a
  // third-octave band and banding averages the peaks away.
  const fa = Math.max(1, Math.round((150 / rate) * n));
  const fb = Math.min(n / 2, Math.round((12000 / rate) * n));
  let logSum = 0;
  let linSum = 0;
  for (let k = fa; k < fb; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    logSum += Math.log(p + 1e-20);
    linSum += p;
  }
  const flatness = Math.exp(logSum / (fb - fa)) / (linSum / (fb - fa));

  // Third-octave log-magnitude shape, for comparing one impact against another.
  const shapeEdges = [];
  for (let f = 150; f <= 12000; f *= Math.pow(2, 1 / 3)) shapeEdges.push(f);
  const shape = [];
  for (let b = 0; b < shapeEdges.length - 1; b++) {
    shape.push(Math.log10(power(shapeEdges[b], shapeEdges[b + 1]) / total + 1e-9));
  }

  return {
    shape,
    flatness,
    body: power(150, 700) / total,
    mid: power(700, 2500) / total,
    harsh: power(2500, 5500) / total,
    air: power(5500, rate / 2) / total,
    centroid: den > 0 ? num / den : 0,
  };
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

try {
  for (const file of files) {
    const b64 = fs.readFileSync(file).toString('base64');
    const decoded = await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const ctx = new OfflineAudioContext(1, 1024, 44100);
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      const ch = buffer.getChannelData(0);
      const other = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
      const mono = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) mono[i] = other ? (ch[i] + other[i]) / 2 : ch[i];
      return { rate: buffer.sampleRate, samples: Array.from(mono) };
    }, b64);

    const { rate, samples } = decoded;

    // Onsets off the energy envelope: a local maximum that stands well clear of
    // the running floor, and at least 40ms clear of the last one.
    const hop = Math.round(rate * 0.002);
    const env = [];
    for (let i = 0; i + hop < samples.length; i += hop) {
      let sum = 0;
      for (let k = 0; k < hop; k++) sum += samples[i + k] * samples[i + k];
      env.push(Math.sqrt(sum / hop));
    }
    const loudest = Math.max(...env);
    const gap = Math.round(0.04 / 0.002);
    const onsets = [];
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] < loudest * 0.12) continue;
      if (env[i] <= env[i - 1] || env[i] < env[i + 1]) continue;
      if (onsets.length && i - onsets[onsets.length - 1] < gap) continue;
      onsets.push(i);
    }

    const rows = [];
    for (const o of onsets) {
      const start = Math.max(0, o * hop - Math.round(rate * 0.002));
      const slice = samples.slice(start, start + Math.round(rate * 0.25));
      if (slice.length < 2048) continue;
      const bands = analyse(slice, rate);
      // -20dB decay, measured on the same envelope.
      const peakIndex = o;
      let decay = Infinity;
      for (let i = peakIndex; i < env.length; i++) {
        if (env[i] < env[peakIndex] * 0.1) { decay = (i - peakIndex) * 2; break; }
      }
      rows.push({ ...bands, decay });
    }

    // How alike two impacts from the same recording are, by the same centred
    // correlation verify-sound uses on the synthesis. This is the number for
    // "does every hit sound like the same instrument being played again".
    const centred = (a, b) => {
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
    const pairs = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) pairs.push(centred(rows[i].shape, rows[j].shape));
    }

    const median = (xs) => {
      const s = xs.slice().sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const decays = rows.map((r) => r.decay).filter(Number.isFinite);
    console.log(`\n${file.split('/').pop()}  (${rate}Hz, ${(samples.length / rate).toFixed(1)}s, ${rows.length} impacts)`);
    console.log(`    150-700Hz  body    ${(median(rows.map((r) => r.body)) * 100).toFixed(1)}%`);
    console.log(`    0.7-2.5kHz mid     ${(median(rows.map((r) => r.mid)) * 100).toFixed(1)}%`);
    console.log(`    2.5-5.5kHz harsh   ${(median(rows.map((r) => r.harsh)) * 100).toFixed(1)}%`);
    console.log(`    5.5kHz+    air     ${(median(rows.map((r) => r.air)) * 100).toFixed(1)}%`);
    console.log(`    spectral centroid  ${median(rows.map((r) => r.centroid)).toFixed(0)}Hz`);
    console.log(`    spectral flatness  ${median(rows.map((r) => r.flatness)).toFixed(3)}`);
    console.log(`    -20dB in           ${decays.length ? median(decays).toFixed(0) : '?'}ms`);
    console.log(`    likeness of two    ${pairs.length ? median(pairs).toFixed(3) : '?'}`);
  }
} finally {
  await browser.close();
}
