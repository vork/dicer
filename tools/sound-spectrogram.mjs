/**
 * Prints a coarse spectrogram of a real recording next to one of our own
 * impacts, so the two can be compared as shapes rather than as summary numbers.
 *
 * This is the tool that found what eight per-impact statistics could not. Every
 * one of them — bands, centroid, flatness, decay, likeness, tail, crest factor,
 * stereo correlation — sat inside the reference range while the sound was still
 * obviously synthetic, because they all describe an impact in aggregate. Laid out
 * over time it was plain in a second: the recordings still have content in every
 * band at 96ms, and ours was blank from 56ms. Nothing physical stops dead.
 *
 *   npm run sound:spectrogram -- <recording.mp3> [more.mp3 ...]
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

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
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const BANDS = [[200,400],[400,700],[700,1100],[1100,1700],[1700,2600],[2600,4000],[4000,6000],[6000,9000],[9000,14000]];

function spectrogram(samples, rate) {
  const hop = Math.round(rate * 0.008);
  const n = 1024;
  const rows = [];
  for (let s = 0; s + n < Math.min(samples.length, rate * 0.12); s += hop) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = samples[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    fft(re, im);
    const row = BANDS.map(([lo, hi]) => {
      let sum = 0;
      const a = Math.round(lo / rate * n), b = Math.round(hi / rate * n);
      for (let k = a; k < b && k < n / 2; k++) sum += re[k] * re[k] + im[k] * im[k];
      return sum;
    });
    rows.push(row);
  }
  return rows;
}

/** How many distinct peaks the spectrum has, and how sharp. */
function peakiness(samples, rate) {
  const n = 8192;
  const re = new Float64Array(n), im = new Float64Array(n);
  const take = Math.min(n, samples.length);
  for (let i = 0; i < take; i++) re[i] = samples[i] * 0.5 * (1 + Math.cos(Math.PI * i / (take - 1)));
  fft(re, im);
  const mag = [];
  const a = Math.round(300 / rate * n), b = Math.round(9000 / rate * n);
  for (let k = a; k < b; k++) mag.push(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
  // Smooth, then count local maxima standing 6dB over the local floor.
  const w = 9;
  const smooth = mag.map((_, i) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(mag.length - 1, i + w); k++) { s += mag[k]; c++; }
    return s / c;
  });
  let peaks = 0;
  for (let i = 2; i < mag.length - 2; i++) {
    if (mag[i] > mag[i - 1] && mag[i] > mag[i + 1] && mag[i] > smooth[i] * 2.0) peaks++;
  }
  return { peaks, binHz: rate / n };
}

const render = (rows, label) => {
  const flat = rows.flat();
  const max = Math.max(...flat) || 1e-12;
  const ramp = ' .:-=+*#%@';
  console.log(`\n  ${label}`);
  console.log('    ms   200 400 700 1k1 1k7 2k6 4k  6k  9k');
  rows.forEach((row, i) => {
    const cells = row.map((v) => {
      const db = 10 * Math.log10(v / max + 1e-12);
      const idx = Math.max(0, Math.min(ramp.length - 1, Math.round((db + 60) / 60 * (ramp.length - 1))));
      return ramp[idx].repeat(3) + ' ';
    });
    console.log(`   ${String(i * 8).padStart(3)}   ${cells.join('')}`);
  });
};

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5208 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:5208/', { waitUntil: 'commit' });
  const files = process.argv.slice(2);
  const clips = [];
  for (const f of files) {
    const b64 = fs.readFileSync(f).toString('base64');
    const got = await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const ctx = new OfflineAudioContext(1, 1024, 44100);
      const buf = await ctx.decodeAudioData(bytes.buffer);
      const ch = buf.getChannelData(0);
      const mono = Array.from(ch);
      return { rate: buf.sampleRate, samples: mono };
    }, b64);
    // strongest onset
    const { rate, samples } = got;
    const hop = Math.round(rate * 0.002);
    let best = 0, bestV = 0;
    for (let i = 0; i + hop < samples.length; i += hop) {
      let s = 0;
      for (let k = 0; k < hop; k++) s += samples[i + k] * samples[i + k];
      if (s > bestV) { bestV = s; best = i; }
    }
    const start = Math.max(0, best - Math.round(rate * 0.003));
    clips.push({ label: f.split('/').pop().slice(0, 28), rate, samples: samples.slice(start, start + Math.round(rate * 0.15)) });
  }

  // ours
  const mine = await page.evaluate(async () => {
    const { DiceAudio } = await import('/src/audio.ts');
    const ctx = new OfflineAudioContext(2, 44100 * 0.2, 44100);
    Object.defineProperty(ctx, 'state', { get: () => 'running' });
    const audio = new DiceAudio();
    const O = window.AudioContext;
    window.AudioContext = function () { return ctx; };
    audio.resume();
    window.AudioContext = O;
    audio.impact(0.85, 0, 'floor', 0.5);
    const buf = await ctx.startRendering();
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    const mono = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
    return { rate: 44100, samples: Array.from(mono) };
  });
  clips.push({ label: 'ours (floor, 0.85)', ...mine });

  for (const c of clips) {
    render(spectrogram(c.samples, c.rate), c.label);
    const p = peakiness(c.samples, c.rate);
    console.log(`    spectral peaks 300Hz-9kHz standing 6dB proud: ${p.peaks}`);
  }
} finally {
  await browser.close();
  await server.close();
}
