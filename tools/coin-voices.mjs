/**
 * Renders one coin impact per metal offline and measures how they differ:
 * the spectral centroid of the strike, the time for the envelope to fall 30dB,
 * and how much energy the tail carries against the strike. Six impacts each,
 * averaged, since every impact is jittered.
 *
 *   npm run coin:voices
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({ root: process.cwd(), server: { host: '127.0.0.1', port: 5236 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:5236/tools/sound-roll.html', { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', null, { timeout: 120000 });
  for (const metal of ['gold', 'silver', 'bronze', 'copper', 'iron', 'electrum', 'roseGold']) {
   const acc = { centroid: 0, t30: 0, late: 0, n: 0 };
   for (let trial = 0; trial < 6; trial++) {
    const { rate, samples } = await page.evaluate((m) => window.__renderCoin(m), metal);
    // Peak, spectral centroid over the first 60ms after the peak, and the time
    // for the envelope to fall 20dB below the peak.
    let peak = 0, peakAt = 0;
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) { peak = a; peakAt = i; } }
    const N = 4096; const start = peakAt;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); re[i] = (samples[start + i] || 0) * w; }
    // naive DFT on 4096 bins up to 12kHz would be slow; use a coarse DFT at 200 bins
    let num = 0, den = 0;
    for (let b = 1; b < 240; b++) { const f = b * 50; let sr = 0, si = 0; for (let i = 0; i < N; i += 2) { const ph = (2 * Math.PI * f * i) / rate; sr += re[i] * Math.cos(ph); si -= re[i] * Math.sin(ph); } const mag = Math.hypot(sr, si); num += f * mag; den += mag; }
    const centroid = num / den;
    // envelope: RMS in 2ms windows
    const win = Math.round(rate * 0.002); let t30 = 0.5; let early = 0, late = 0;
    for (let i = peakAt; i + win < samples.length; i += win) { let e = 0; for (let j = 0; j < win; j++) e += samples[i + j] * samples[i + j]; const rms = Math.sqrt(e / win); const t = (i - peakAt) / rate; if (t < 0.02) early += e; else if (t < 0.12) late += e; if (t30 === 0.5 && rms < peak * 0.0316 / Math.SQRT2) t30 = t; }
    acc.centroid += centroid; acc.t30 += t30; acc.late += 10 * Math.log10((late + 1e-12) / (early + 1e-12)); acc.n++;
   }
   console.log(`${metal.padEnd(9)} centroid ${(acc.centroid / acc.n).toFixed(0)} Hz  ring to -30dB ${(acc.t30 / acc.n * 1000).toFixed(0)} ms  tail 20-120ms vs strike ${(acc.late / acc.n).toFixed(1)} dB`);
  }
} finally { await browser.close(); await server.close(); }
