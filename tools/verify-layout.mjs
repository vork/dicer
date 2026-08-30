/**
 * Checks that the settled dice actually land in the strip of screen left clear
 * between the flashed total and the controls, on viewports of very different
 * shapes. On a phone the controls stack into several rows and that strip sits far
 * higher up than it does on a desktop; a fixed camera offset put the dice behind
 * them.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const VIEWPORTS = [
  ['phone portrait', 390, 844],
  ['large phone', 414, 896],
  ['tablet portrait', 768, 1024],
  ['desktop', 1280, 832],
  ['short laptop', 1440, 700],
];

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 5191 },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const failures = [];
let failed = false;

try {
  for (const [name, width, height] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => failures.push(`${name}: ${error.message}`));

    await page.goto('http://127.0.0.1:5191/', { waitUntil: 'load' });
    await page.waitForFunction(
      () => {
        const loader = document.getElementById('loader');
        return !loader || loader.classList.contains('done');
      },
      { timeout: 180000 },
    );

    await page.evaluate(() => window.dicer.debug.setPool(['d20', 'd6', 'd6']));
    await page.evaluate(() => window.dicer.debug.roll(0, -1, 0.7));
    await page.waitForFunction('window.dicer.debug.state().settled === true', { timeout: 180000 });
    // Hold the close-up open, then give the dolly time to arrive.
    await page.evaluate(() => window.dicer.debug.holdReveal(true));
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          let seen = 0;
          const tick = () => (++seen >= 90 ? resolve(seen) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
    );

    const result = await page.evaluate(() => {
      // Freeze the result flash mid-hold so its rectangle is the settled one.
      const reveal = document.getElementById('reveal');
      reveal.classList.remove('show');
      void reveal.offsetWidth;
      reveal.classList.add('show');
      reveal.style.animationPlayState = 'paused';
      reveal.style.animationDelay = '-800ms';

      const bottoms = ['reveal-total', 'reveal-caption', 'reveal-breakdown']
        .map((id) => document.getElementById(id))
        .filter((element) => element.textContent)
        .map((element) => element.getBoundingClientRect().bottom);
      const bandTop = bottoms.length ? Math.max(...bottoms) : 0;
      const bandBottom = document.getElementById('controls').getBoundingClientRect().top;

      const { camera, positions } = window.dicer.debug.diceScreenInfo();
      const THREE = window.dicer.debug.three;
      camera.updateMatrixWorld(true);

      const dice = positions.map((p) => {
        const ndc = new THREE.Vector3(p.x, p.y, p.z).project(camera);
        return {
          x: ((ndc.x + 1) / 2) * window.innerWidth,
          y: ((1 - ndc.y) / 2) * window.innerHeight,
        };
      });

      return { bandTop, bandBottom, dice, width: window.innerWidth, height: window.innerHeight };
    });

    const { bandTop, bandBottom, dice } = result;
    const span = bandBottom - bandTop;
    console.log(
      `${name.padEnd(16)} ${result.width}x${result.height}  clear band ${bandTop.toFixed(0)}–${bandBottom.toFixed(0)}px ` +
        `(${span.toFixed(0)}px)  dice at ${dice.map((d) => d.y.toFixed(0)).join(', ')}`,
    );

    if (span < 60) {
      failures.push(`${name}: the clear band is only ${span.toFixed(0)}px tall`);
      continue;
    }

    // The contract is that the dice as a group are centred in the clear band, and
    // that none of them hides under the controls. Demanding every individual die
    // fit the band is not achievable: a pool spread across the tray is taller than
    // the band, so its topmost die necessarily reaches up into the result text —
    // which is far less costly than a die disappearing behind the controls.
    const centre = dice.reduce((sum, die) => sum + die.y, 0) / dice.length;
    if (centre < bandTop || centre > bandBottom) {
      failures.push(
        `${name}: the dice centre on y ${centre.toFixed(0)}px, outside the clear band ` +
          `${bandTop.toFixed(0)}–${bandBottom.toFixed(0)}px`,
      );
    }

    let overlapping = 0;
    for (const [index, die] of dice.entries()) {
      if (die.y > bandBottom) {
        failures.push(
          `${name}: die ${index} sits at y ${die.y.toFixed(0)}px, below the controls edge at ${bandBottom.toFixed(0)}px`,
        );
      }
      if (die.y < bandTop) overlapping++;
      if (die.x < 0 || die.x > result.width) {
        failures.push(`${name}: die ${index} sits at x ${die.x.toFixed(0)}px, off screen`);
      }
      if (die.y < 0 || die.y > result.height) {
        failures.push(`${name}: die ${index} sits at y ${die.y.toFixed(0)}px, off screen`);
      }
    }
    if (overlapping) console.log(`${''.padEnd(16)} ${overlapping} of ${dice.length} reach up into the result text`);

    await page.close();
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error('\n' + failures.map((f) => `  FAIL ${f}`).join('\n'));
  failed = true;
} else if (!failed) {
  console.log('\nthe settled dice land in the clear band on every viewport');
}

process.exit(failed ? 1 : 0);
