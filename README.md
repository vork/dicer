# Dicer

A physically simulated RPG dice roller. Real dice models drop into a leather tray,
tumble under true-scale gravity, and the app reads the number that landed face up.

```
npm install
npm run assets     # rebuild public/dice/* from the source GLB (only needed once)
npm run dev
```

Click or tap to throw. Swipe and the direction and speed of the flick become the
direction and force of the throw.

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
     `src/dice/read.ts` the app uses.
   - 150 simulated rolls per die type must all settle inside the tray, land flat on
     the floor, and cover every face.

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

## Tooling

| command | what it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` | typecheck + production build |
| `npm run assets` | regenerate `public/dice/*` from the source GLB |
| `npm run verify` | all three checks below |
| `npm run verify:values` | opposite-face-sum invariant on the tables |
| `npm run verify:reading` | every slot reads back from every yaw |
| `npm run verify:physics` | settle, containment and distribution over many rolls |
| `npm run calibrate` | regenerate the face contact sheets |
| `npm run shoot` | screenshot the running app at each stage |

The headless tools need a Chromium; set `PLAYWRIGHT_CHROMIUM` if Playwright's own
download is not present.

## Credits

Dice models: [RPG Dice Set](https://sketchfab.com/3d-models/rpg-dice-set-2498c370c56842f89fa3d7096c72ed56)
by [ghosted](https://sketchfab.com/dianaavlis2002), CC-BY-4.0.
