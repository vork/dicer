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

A die that comes to rest leaning on a wall or on a neighbour is detected (its
upward face is more than a few degrees off vertical) and nudged until it lies flat,
so a reading is never taken off a cocked die.

Where the close-up puts the dice is measured, not assumed. The app reads the gap
between the bottom of the flashed total and the top of the controls and asks the
camera to land the dice in the middle of it. That gap is a very different shape on
a phone — where the controls stack into several rows — than on a desktop, and a
fixed camera offset parked the dice behind them. The camera honours the request
only as far as the framing allows: tilting to place the subject costs vertical
frame, so a pool spread across the tray gets almost none and stays centred rather
than being cropped.

Every throw randomises the starting orientation with Shoemake's method, which is
uniform over the space of rotations — random Euler angles would have clustered
around the poles. Spawn position, heading, speed, lift and spin on all three axes
are randomised per die as well. Over 3000 simulated d20 rolls the face
distribution gives a chi-square of 13.9 against 19 degrees of freedom, which is
where a fair die belongs.

Dice in one throw are independent of each other, and `npm run verify:pairs`
measures it rather than assuming it: over 2500 throws of 2d20 the pair matched
5.1% of the time against the 5.0% chance predicts, the correlation between the two
values was +0.03 against a standard error of 0.02, and neither slot was biased. So
doubles are simply as common as they should be — one roll in twenty for 2d20, and
one in six for 2d6.

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
| `npm run verify:build` | the built site runs from a sub-path, with no 404s |
| `npm run calibrate` | regenerate the face contact sheets |
| `npm run shoot` | screenshot the running app at each stage |

The headless tools need a Chromium; set `PLAYWRIGHT_CHROMIUM` if Playwright's own
download is not present.

## Credits

Dice models: [RPG Dice Set](https://sketchfab.com/3d-models/rpg-dice-set-2498c370c56842f89fa3d7096c72ed56)
by [ghosted](https://sketchfab.com/dianaavlis2002), CC-BY-4.0.
