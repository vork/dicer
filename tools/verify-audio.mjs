/**
 * Does the sound actually play, and does the toggle actually silence it?
 *
 * Web Audio makes no noise a headless run can hear, so this counts the nodes the
 * app builds instead: every impact creates a buffer source, so a roll that made
 * sound is a roll that created some. The rolls are driven with real mouse input,
 * because an AudioContext only starts on a trusted gesture — calling the debug
 * hook would test a path no user takes.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5190 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });

// Count sound-producing nodes, and remember every context the app opens.
await page.addInitScript(() => {
  window.__audio = { sources: 0, contexts: [] };
  const Ctor = window.AudioContext;
  window.AudioContext = function (...args) {
    const context = new Ctor(...args);
    window.__audio.contexts.push(context);
    const create = context.createBufferSource.bind(context);
    context.createBufferSource = (...inner) => {
      window.__audio.sources++;
      return create(...inner);
    };
    return context;
  };
  window.AudioContext.prototype = Ctor.prototype;
});

const failures = [];

const rollWithMouse = async () => {
  const before = await page.evaluate(() => window.__audio.sources);
  // A short drag across the canvas: the throw gesture a player actually makes.
  await page.mouse.move(500, 300);
  await page.mouse.down();
  await page.mouse.move(500, 220, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction('window.dicer.debug.state().settled === true', { timeout: 180000 });
  const after = await page.evaluate(() => window.__audio.sources);
  return after - before;
};

try {
  await page.goto('http://127.0.0.1:5190/', { waitUntil: 'load' });
  await page.waitForFunction(
    () => {
      const loader = document.getElementById('loader');
      return !loader || loader.classList.contains('done');
    },
    { timeout: 180000 },
  );
  await page.evaluate(() => window.dicer.debug.setPool(['d20', 'd6', 'd6']));

  const withSound = await rollWithMouse();
  const state = await page.evaluate(() => window.__audio.contexts.map((c) => c.state));
  console.log(`sound on : ${withSound} impact sounds, audio context ${JSON.stringify(state)}`);

  if (state.length === 0) failures.push('the app never opened an AudioContext');
  else if (state[0] !== 'running') failures.push(`the AudioContext is "${state[0]}", so nothing can play`);
  if (withSound === 0) failures.push('a roll with sound enabled produced no sound at all');

  // Mute, and confirm the next roll is silent.
  await page.click('#sound-toggle');
  const pressed = await page.getAttribute('#sound-toggle', 'aria-pressed');
  const muted = await rollWithMouse();
  console.log(`sound off: ${muted} impact sounds, button aria-pressed=${pressed}`);
  if (pressed !== 'false') failures.push(`muting left aria-pressed at "${pressed}"`);
  if (muted !== 0) failures.push(`a roll with sound muted still produced ${muted} sounds`);

  // Unmute, and confirm it comes back.
  await page.click('#sound-toggle');
  const restored = await rollWithMouse();
  const pressedAgain = await page.getAttribute('#sound-toggle', 'aria-pressed');
  console.log(`sound on : ${restored} impact sounds, button aria-pressed=${pressedAgain}`);
  if (pressedAgain !== 'true') failures.push(`unmuting left aria-pressed at "${pressedAgain}"`);
  if (restored === 0) failures.push('unmuting did not bring the sound back');
} catch (error) {
  console.error(error);
  failures.push(error.message);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error('\n' + failures.map((f) => `  FAIL ${f}`).join('\n'));
  process.exit(1);
}
console.log('\nthe sound plays, and the toggle silences and restores it');
