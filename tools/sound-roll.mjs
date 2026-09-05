/**
 * Renders a whole roll — a real physics throw, every contact it produced, in the
 * order and at the times a player hears them — and lays it beside a recording of
 * a real one.
 *
 * Every other sound check renders one impact into its own context. That is the
 * wrong unit: a roll is thirty contacts in two seconds, and the things that make
 * it sound synthetic live in the sequence, not in any single hit. Both reference
 * recordings are rolls, so this is the like-for-like comparison.
 *
 *   npm run sound:roll -- <recording.mp3> [more.mp3 ...]
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

/** Magnitude spectrum of one window, in dB, over 200Hz-12kHz. */
function spectrum(samples, at, n, rate) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[at + i] || 0;
    re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fft(re, im);
  const lo = Math.round((200 / rate) * n), hi = Math.round((12000 / rate) * n);
  const out = [];
  for (let k = lo; k < hi; k++) out.push(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
  return out;
}

/** Onsets, by a rise in short-window energy over the local floor. */
function onsets(samples, rate) {
  const win = Math.round(rate * 0.003);
  const env = [];
  for (let i = 0; i + win < samples.length; i += win) {
    let s = 0;
    for (let k = 0; k < win; k++) s += samples[i + k] * samples[i + k];
    env.push(Math.sqrt(s / win));
  }
  const peak = Math.max(...env);
  const found = [];
  for (let i = 2; i < env.length - 1; i++) {
    if (env[i] > peak * 0.12 && env[i] > env[i - 1] * 1.7 && env[i] > env[i - 2] * 1.7) {
      const at = (i * win) / rate;
      if (!found.length || at - found[found.length - 1] > 0.02) found.push(at);
    }
  }
  return found;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/**
 * How alike successive contacts in one roll are, spectrum to spectrum. Real dice
 * are the same object struck repeatedly, so this is high — but every strike lands
 * somewhere different on the body and excites a different set of modes, so it is
 * not 1.0 either. A synth that stamps out one fixed chord sits far too close to it.
 */
function selfLikeness(samples, rate, hits) {
  const n = 4096;
  const specs = hits
    .filter((t) => t * rate + n < samples.length)
    .map((t) => spectrum(samples, Math.round(t * rate), n, rate).map((v) => Math.log(v + 1e-9)));
  const scores = [];
  for (let i = 0; i + 1 < specs.length; i++) {
    const a = specs[i], b = specs[i + 1];
    const ma = mean(a), mb = mean(b);
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < a.length; k++) {
      const x = a[k] - ma, y = b[k] - mb;
      dot += x * y; na += x * x; nb += y * y;
    }
    scores.push(dot / Math.sqrt(na * nb || 1e-12));
  }
  scores.sort((x, y) => x - y);
  return { median: scores[Math.floor(scores.length / 2)] ?? 0, count: specs.length };
}

/**
 * Where the spectral peak of each contact sits. A real roll scatters these,
 * because which modes a strike excites depends on where it lands; a fixed set of
 * ratios on a fixed root puts every contact on the same note.
 */
function peakScatter(samples, rate, hits) {
  const n = 4096;
  const lo = 200;
  const centres = [];
  for (const t of hits) {
    const at = Math.round(t * rate);
    if (at + n >= samples.length) continue;
    const s = spectrum(samples, at, n, rate);
    let best = 0, bestV = 0;
    for (let k = 0; k < s.length; k++) if (s[k] > bestV) { bestV = s[k]; best = k; }
    centres.push(lo + (best * rate) / n);
  }
  if (centres.length < 3) return { spread: 0, centres };
  const m = mean(centres);
  const sd = Math.sqrt(mean(centres.map((c) => (c - m) ** 2)));
  return { spread: sd / m, median: m, centres };
}

const BANDS = [[200, 400], [400, 700], [700, 1100], [1100, 1700], [1700, 2600], [2600, 4000], [4000, 6000], [6000, 9000], [9000, 14000]];

/** A whole-roll spectrogram, one row per 40ms. */
function rollGram(samples, rate, seconds) {
  const hop = Math.round(rate * 0.04);
  const n = 2048;
  const rows = [];
  for (let s = 0; s + n < Math.min(samples.length, rate * seconds); s += hop) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = samples[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    fft(re, im);
    rows.push(BANDS.map(([a, b]) => {
      let sum = 0;
      const k0 = Math.round((a / rate) * n), k1 = Math.round((b / rate) * n);
      for (let k = k0; k < k1 && k < n / 2; k++) sum += re[k] * re[k] + im[k] * im[k];
      return sum;
    }));
  }
  return rows;
}

function draw(rows, label) {
  const max = Math.max(...rows.flat()) || 1e-12;
  const ramp = ' .:-=+*#%@';
  console.log(`\n  ${label}`);
  console.log('     ms   200 400 700 1k1 1k7 2k6 4k  6k  9k');
  rows.forEach((row, i) => {
    const cells = row.map((v) => {
      const db = 10 * Math.log10(v / max + 1e-12);
      const idx = Math.max(0, Math.min(ramp.length - 1, Math.round(((db + 60) / 60) * (ramp.length - 1))));
      return ramp[idx].repeat(3) + ' ';
    });
    console.log(`   ${String(i * 40).padStart(4)}   ${cells.join('')}`);
  });
}

const server = await createServer({ root: process.cwd(), server: { host: '127.0.0.1', port: 5213 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
try {
  await page.goto('http://127.0.0.1:5213/tools/sound-roll.html', { waitUntil: 'commit' });
  await page.waitForFunction('window.__ready === true', { timeout: 120000 });

  const clips = [];
  for (const f of process.argv.slice(2)) {
    const b64 = fs.readFileSync(f).toString('base64');
    const got = await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const ctx = new OfflineAudioContext(1, 1024, 44100);
      const buf = await ctx.decodeAudioData(bytes.buffer);
      return { rate: buf.sampleRate, samples: Array.from(buf.getChannelData(0)) };
    }, b64);
    // Start at the first contact so the two line up.
    const first = onsets(got.samples, got.rate)[0] ?? 0;
    const from = Math.max(0, Math.round((first - 0.01) * got.rate));
    clips.push({
      label: f.split('/').pop().slice(0, 30),
      rate: got.rate,
      samples: got.samples.slice(from, from + Math.round(got.rate * 1.6)),
      contacts: null,
    });
  }

  const ours = await page.evaluate(async () => {
    const r = await window.__renderRoll(['d6', 'd6', 'd20', 'd8'], 1.6);
    return r;
  });
  clips.push({ label: `ours (a real four-die throw)`, ...ours });

  for (const c of clips) {
    draw(rollGram(c.samples, c.rate, 1.0), c.label);
    const hits = onsets(c.samples, c.rate);
    const like = selfLikeness(c.samples, c.rate, hits);
    const scatter = peakScatter(c.samples, c.rate, hits);
    const gaps = hits.slice(1).map((t, i) => (t - hits[i]) * 1000);
    // Not the same thing as the number of contacts: anything within 20ms of the
    // last one is counted with it, on both sides of the comparison, because two
    // taps that close are one event to the ear.
    console.log(`     onsets 20ms apart       ${hits.length}${c.contacts ? ` (from ${c.contacts} solver contacts)` : ''}`);
    console.log(`     gaps between them       ${gaps.length ? `${Math.min(...gaps).toFixed(0)}-${Math.max(...gaps).toFixed(0)}ms, median ${gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)].toFixed(0)}ms` : '-'}`);
    console.log(`     one contact to the next ${like.median.toFixed(3)} alike  (over ${like.count})`);
    console.log(`     spectral peak scatter   ${(scatter.spread * 100).toFixed(1)}% around ${(scatter.median || 0).toFixed(0)}Hz`);
  }
} finally {
  await browser.close();
  await server.close();
}
