# Dicer

A physically simulated RPG dice roller. Real dice models drop into a leather tray,
tumble under true-scale gravity, and the app reads the number that landed face up.

```
npm install
npm run assets     # rebuild public/dice/* from the source GLB (only needed once)
npm run dev
```

Tap a die type to add one to the pool — tap again for a second, a third, and so
on, up to twelve; the button carries a running count and each pool chip is a −/+
stepper. Then click or tap anywhere to throw. Swipe instead and the direction and
speed of the flick become the direction and force of the throw.

**Sum / Highest / Lowest** decides how the pool collapses into the one number that
gets flashed. Highest and lowest are advantage and disadvantage: the dice that did
not count stay in the breakdown, dimmed and struck through, and a natural 20 or 1
is judged on the die that actually counted — a 20 you dropped to disadvantage is
not a critical. The mode also decides what the reveal closes in on: every die
under sum, only the dice that won under highest and lowest.

## How the numbers are detected

The dice come from a Sketchfab set (`RPG Dice Set` by ghosted, CC-BY-4.0) with the
numerals painted into a texture. Nothing in the file says which number sits on
which face, so that mapping had to be recovered.

1. **`tools/build-assets.mjs`** pulls the six distinct dice out of the source GLB.
   The seven colourways are the same geometry with different textures, so geometry
   is extracted once. Coplanar triangles are merged back into the polygonal faces a
   player actually reads — 36 triangles become the d12's 12 pentagons — and each
   face's outward normal, centroid and extent are written to `public/dice/faces.json`.
   The die is recentred on its true volume centroid, so it spins about its real
   centre of mass, and scaled so the d20 measures 1.0 world unit (~20mm).

2. **`tools/calibrate.mjs`** renders every face of every die in headless Chromium,
   looking straight down that face's normal, and drops a crosshair on the face
   centre. The glyph under the crosshair is that face's value. Six contact sheets,
   read by eye once.

3. **`src/dice/values.ts`** holds the resulting tables. The d4 is the odd one out:
   it prints no numeral at its face centres, only three per face at the corners, so
   it is read from the apex vertex that points up — the way you read a real one.

4. **`npm run verify`** checks the tables three ways, and all three have caught
   real mistakes:
   - Opposite faces on a real die sum to a constant (21 on a d20, 9 on a 0–9 d10).
     This is what pinned down the dotted 6/9 pairs, which are genuinely ambiguous by
     eye — two of them were initially transposed.
   - Every slot must read back as itself from every yaw, through the same
     `src/dice/read.ts` the app uses, alongside a table of cases for how a pool
     collapses under sum, highest and lowest.
   - 240 simulated rolls per die type must all settle inside the tray, land flat
     on the floor, and cover every face, plus a full twelve-die pool to stress
     contacts. The coverage check only applies once each face is expected ten
     times or more: below that a fair d20 skips a face often enough to fail on
     luck alone.

## Layout

```
src/
  app.ts                 wiring: load, light, roll, reveal
  assets.ts              GLB + face data + colourway textures
  audio.ts               procedural impact clicks, no samples shipped
  camera-director.ts     idle / rolling / reveal camera states
  dice/
    values.ts            face -> printed number, per die type
    read.ts              which slot is pointing up
    outcome.ts           pool -> the one number to flash
  input/throw-input.ts   pointer gesture -> world throw vector
  physics/dice-world.ts  Rapier world, tray colliders, settle detection
  scene/
    environment.ts       procedural studio environment + lights
    tray.ts              tray geometry
    textures.ts          procedural felt and leather maps
    postfx.ts            bloom, vignette, grain, chromatic aberration
  ui/hud.ts              dice pool, result flash, aim indicator
tools/                   asset pipeline and headless verification
```

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push
to the default branch, and can be run by hand from the Actions tab. In the
repository settings, under **Pages → Build and deployment**, set **Source** to
**GitHub Actions**; nothing else needs configuring.

`base` is `'./'` in `vite.config.js` and every asset is fetched through
`import.meta.env.BASE_URL`, so the same build works whether it is served from
`user.github.io/dicer/` or from a domain root. `npm run verify:build` proves that:
it serves `dist/` from a sub-path, loads it, rolls once, and fails on any 404 —
the failure mode where an absolute asset path works on the dev server and breaks
in production.

## Installing it

The build ships a web app manifest and a service worker, so the site can be
installed to a home screen and then runs with no network at all — which is the
point for a dice roller, since the moment you want one you are usually sitting at
a table rather than near good reception. Pages serves over HTTPS, which is what
service workers require; on the dev server the app is a plain page, as the plugin
leaves the worker out of `npm run dev`.

Everything is precached, not fetched on demand: the dice mesh, the face table,
Rapier's wasm chunk, and all seven colourways. A colourway pulled from the network
when you tapped it would fail exactly when the app was supposed to be working
offline, and the whole payload is only ~5.8MB. Updates install silently and take
effect on the next launch — there is no state worth interrupting a roll for.

`npm run verify:pwa` is the check that this is real rather than declared. It
serves the build from a sub-path, waits for the worker to install and claim the
page, validates the manifest and that every icon resolves, then cuts the network
at the browser and reloads. The app has to boot, complete a three-die roll, prove
the display face is genuinely local, and serve all 21 dice assets from cache —
including the six colourways that were never displayed while the network was up,
which is what catches a precache covering only the paths a first visit happened to
touch. Stripping the colourways out of the precache manifest by hand is enough to
make it fail, which is how I know it is looking.

The two typefaces are vendored rather than linked, by `npm run fonts`. Cormorant
Garamond is what the flashed number is set in, and a stylesheet fetched from
Google would have failed offline and dropped the reveal into Georgia — the app
would still work, but it would not look like itself. Both families are variable
fonts, so all six weights are two files and 84KB in total; only the latin subset
is kept, since nothing here renders text the user supplies. Self-hosting also
takes a render-blocking third-party request out of the first load.

`npm run icons` regenerates the launcher icons from `public/favicon.svg`. The
maskable one drops the background plate and insets the mark, because launchers
crop that icon to their own shape and a mark sitting at the edge loses its
corners.

## Notes on the simulation

One world unit is about 20mm, so gravity runs at its true scaled value of ~490
units/s². That is what makes the dice feel dense — they accelerate hard and land
dead rather than floating.

Settling time scales as `sqrt(size / gravity)`, so a real 20mm die comes to rest in
roughly six tenths of a second: accurate, but over before the camera has finished
moving. `TIME_SCALE` in `dice-world.ts` feeds the solver less simulated time per
real second, which stretches the timeline without touching the dynamics — the
trajectories are the ones true gravity produces, just watched a little slower.
Scaling gravity down instead would have made the dice look light.

A die that comes to rest leaning on a wall or on a neighbour is detected — its
upward face is more than a few degrees off vertical — and settled before it is
read. A kick in place frees a die propped on a neighbour, but not one wedged into
a corner, where the wall being pushed against is the wall it rebounds off. So
after two attempts the die is picked up and dropped again near the middle of the
tray, into a spot sampled clear of the other dice — dropping it onto a neighbour
resolves the overlap with an impulse large enough to fire a die through the wall.
That is what a player does with a cocked die and, given a fresh uniform
orientation, is a fair re-roll. Before that, four kicks and then acceptance meant
a wedged d4 could be read at 44 degrees off vertical — a wrong number about once
in fifteen hundred rolls, which `verify:physics` now catches by checking that a
settled die rests at exactly its inradius above the floor.

The reveal also stands the camera up as far as it needs to in order to see over
the tray wall. The rim is 2.3 units tall, so at the reveal's usual 58 degrees a
die within about 1.2 units of the near wall is simply hidden behind it — and dice
come to rest against walls constantly. The elevation that clears the rim is
computed from where the dice actually are, so a die by the wall is viewed from
close to overhead, which is also the best angle for reading the face that landed
up, while a die in the open keeps the lower, more three-dimensional angle.

Where the close-up puts the dice is measured, not assumed. The app reads the gap
between the bottom of the flashed total and the top of the controls and hands the
camera that band; the camera frames the dice to fit inside it. That gap is a very
different shape on a phone — where the controls stack into several rows — than on
a desktop, and a fixed camera offset parked the dice behind them.

Fitting the band rather than the whole frame is what makes the placement possible
at all: a subject framed to fill the screen has nowhere left to move, so asking
for it to sit clear of the controls achieves nothing. The pull-back that buys the
room is capped, because dice in opposite corners of a shallow window would
otherwise retreat to several times the tray's width and become specks. Past that
cap the subject cannot fit, and the overflow goes upward on purpose: a die reaching
behind the flashed total is still visible, while one under the controls is gone.

Every throw randomises the starting orientation with Shoemake's method, which is
uniform over the space of rotations — random Euler angles would have clustered
around the poles. Spawn position, heading, speed, lift and spin on all three axes
are randomised per die as well. Over 3000 simulated d20 rolls the face
distribution gives a chi-square of 13.9 against 19 degrees of freedom, which is
where a fair die belongs.

Dice in one throw are independent of each other, and `npm run verify:pairs`
measures it rather than assuming it. It checks the match rate against chance, the
correlation between the two values, whether either slot in the pair is biased on
its own, and a chi-square for independence over the whole joint table — which
catches structure the match rate alone would miss.

It runs two paths, because they are not the same code. Rebuilding the dice each
throw is what a test naturally does; the app builds the pool once and then throws
the same bodies over and over, so anything carried between throws only shows up on
that second path. Over 6000 throws of 2d6 on the app's path the pair matched
**16.7% against the 16.7% chance predicts**, correlation -0.000, joint chi-square
19.0 against 25 degrees of freedom, and no roll failed to settle. 2d20 matches 5%.

Doubles are simply that common: one roll in six for 2d6, one in twenty for 2d20.
In twenty throws of 2d6 you should expect three or four matching pairs.

Each die is launched from its own point on a ring, staggered in height so they do
not spawn inside one another. Which die takes which slot is shuffled every throw:
without that the first die in the pool would always leave from the same place
relative to the heading, so the pool's slots could not be independent by
construction, only by measurement.

## Tooling

| command | what it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` | typecheck + production build |
| `npm run assets` | regenerate `public/dice/*` from the source GLB |
| `npm run verify` | all four checks below |
| `npm run verify:values` | opposite-face-sum invariant on the tables |
| `npm run verify:reading` | every slot reads back from every yaw, and pool resolution |
| `npm run verify:camera` | the reveal frames dice anywhere in the tray, uncropped |
| `npm run verify:layout` | settled dice land clear of the result and the controls |
| `npm run verify:physics` | settle, containment and distribution over many rolls |
| `npm run verify:pairs` | two dice in one throw land independently of each other |
| `npm run verify:audio` | impacts make sound, and the toggle silences and restores it |
| `npm run verify:build` | the built site runs from a sub-path, with no 404s |
| `npm run verify:pwa` | the installed app boots and rolls with the network cut |
| `npm run calibrate` | regenerate the face contact sheets |
| `npm run shoot` | screenshot the running app at each stage |
| `npm run icons` | regenerate the launcher icons from the favicon |
| `npm run fonts` | re-vendor the web fonts into `public/fonts/` |

The headless tools need a Chromium; set `PLAYWRIGHT_CHROMIUM` if Playwright's own
download is not present.

## Credits

Dice models: [RPG Dice Set](https://sketchfab.com/3d-models/rpg-dice-set-2498c370c56842f89fa3d7096c72ed56)
by [ghosted](https://sketchfab.com/dianaavlis2002), CC-BY-4.0.

Typefaces: Cormorant Garamond by Christian Thalmann and Inter by Rasmus Andersson,
both under the SIL Open Font License 1.1.
