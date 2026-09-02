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

## How the dice are shaded

The dice are cast resin over metallic flake, built the way automotive paint is: a
pigmented base loaded with tiny aluminium flakes, under a clear coat. Each flake
is a mirror lying at its own slight angle, so at any moment only the few whose
tilt happens to line a light up with your eye fire — and which few that is
changes as the die turns. That is why the sparkle crawls across a car as you walk
past it, and it is why this cannot be a texture: a painted-on glitter map slides
with the surface instead of firing and dying.

So the flakes are procedural, from a lattice in the die's own object space. They
are embedded in the resin, so they have to be locked to the die and tumble with
it. Each one reflects the environment map through three's `getIBLRadiance` at
near-mirror roughness, and that is the whole trick: the same little room that
lights everything else is what the flakes glint at, so a flake tilted toward the
key panel goes white-hot, one tilted at the cool rim strip goes blue, and one
facing the black shell stays dark. Nothing has to be told where the lights are.

The first version did have to, and it had a tell. It evaluated glints against a
hand-copied list of the scene's light directions, and on a flat die face the
half-vector is constant across the whole facet — so a face whose half-vector fell
outside the cone the flakes can tilt into had no sparkle at all, while its
neighbour was covered. Reflecting the environment instead makes that impossible
and drops the duplicated list of light positions.

The base stays non-metallic. Turning the whole material metallic would take the
painted numerals down with it, and the numerals are the entire point of the app.

Real flakes are far finer than a pixel, and a flake finer than a pixel cannot be
point-sampled without the sparkle turning into crawling noise. The first answer
was to fade them out as they approached one cell per pixel, and it was the wrong
one twice over: the dice went flat exactly when they were small, and it put a
ceiling on how fine the flakes could ever be, because anything finer than about a
quarter of a millimetre simply faded away before it could be seen. Which is what
made them look too big.

So the lattice is mip-mapped instead. It coarsens by powers of two until a cell is
about `grain` pixels across and cross-fades between the two levels either side.
Two details make that handover invisible, and both were wrong first.

The skew that keeps a level from reading as a cubic grid belongs to the *level*,
not to the slot it happens to occupy. Tied to the slot, every boundary was a hard
cut: just below one, the coarse slot drew level k+1 with one skew; just above it,
the fine slot drew that same level with the other, and the whole field jumped to
new positions in a single frame. Keying the skew off the level's parity makes the
handover exact.

And the levels swap by population, not by brightness. Cross-fading their
brightness takes every flake through half intensity on the way, which drops it
under the bloom threshold and lifts it back out, so the field pulses as you zoom.
Each flake now decides by its own hash whether it belongs to this level or the
next, so the population dissolves one speck at a time and every speck that is
drawn is drawn at full strength — which also turns out to change less per frame
overall, since only a few percent of flakes toggle rather than all of them
dimming at once.
Up close you get the flake size the paint actually has; further away you get the
same speck size on screen drawn from a coarser lattice — a fair sample of the same
distribution rather than a blur of it, so the dice stay sparkly at any distance.
`density` is now a ceiling rather than a promise: at 240 flakes per unit a flake
is about 0.08mm on a 20mm die, the right order for real metallic paint, and how
much of that detail survives is the camera's business rather than the setting's.
`grain` is the knob that decides how big a speck looks, and it does it in pixels.

Getting the footprint right matters more than it sounds, since it now picks the
mip level: `fwidth` sums both derivatives across all three components and reads
about twice the true value, which coarsens the lattice a whole level too early and
doubles the size of every speck. `max(length(dFdx), length(dFdy))` is cells per
pixel along the worse screen axis, which is the thing actually being asked.

What makes them read as flakes rather than as sugar is contrast. The environment's
own range is too gentle to say "this flake caught a light and that one did not",
so each flake is weighted by its own brightness before it is added: the majority
facing the dark shell fall away, and the few that found a panel keep their level,
which is well past 1.0 and straight into the bloom pass. That is the difference
between an even grey speckle and a handful of points that flare and die as the die
turns — which is what the effect is for. The weighting is normalised against the
key panel's radiance so that raising the contrast redistributes brightness instead
of amplifying it, and strength and contrast can be tuned apart.

Two settings matter more than they look. Flake roughness is kept near zero,
because a flake given even a few times that reflects a blur of the whole room and
sits there softly lit whichever way the die turns, which is the opposite of a
glint. And the tilt spread is wider than real paint uses: real paint is lit by a
whole sky, while these flakes have one small room to find, so they have to point
in more directions for any of them to find it.

`npm run verify:flakes` is what caught the jumping. It simulates a dolly without
moving the camera: the mip level comes from `log2(footprint * grain)`, so sweeping
`grain` walks the same range as closing in, with the camera, the dice and the
lights all held still — and then anything that changes between two frames is the
lattice and nothing else. Getting there took two goes at removing what was *not*
the lattice. The grade reseeds its film grain every frame, a flat noise floor four
times the size of the signal. Then the camera turned out never to stop drifting;
normalising each step by a locally measured drift blew up wherever that drift
passed through zero at a turning point of its own sine, and reported a confident
100x "pop" at the same grain every run. Silencing the grain and freezing the
camera puts the floor at exactly zero.

Even then, sweeping and hunting for an outlier step was too blunt — every step
toggles a few percent of the flakes at random, so the worst step sits three to
five times the median whether anything is wrong or not. It straddles instead. A
level boundary is crossed by a grain step of a fifth of a percent, over which a
working dissolve changes almost nothing while a broken handover swaps the whole
field, so the question becomes "is this anywhere near as large as replacing every
flake" rather than a judgement about scatter. Away from a boundary a 0.4% change
of zoom disturbs 0.4% of the field. Crossing one used to disturb 35%; it now
disturbs 9-17%, varying with where the dice happen to lie.

That residual is real and I have not explained it. The spikes are not periodic —
they are scattered, one per facet, each worth roughly that facet's share of the
die, which is what you would expect if each facet hands over at its own depth. But
a clean handover should cost about 0.4%, not ten. Making both mip levels share one
skew, so they nest exactly, changes nothing (15%), which rules out the skew as the
remaining cause. The check's limit is set at 25%, which sits between the old
behaviour and the current one — enough to catch a regression to the old, not
enough to call the current state finished.

`npm run flakes` is the tuning rig: one roll, then every entry in
`tools/flake-variants.json` rendered as a magnified crop of the same settled die
and composited into a contact sheet. A variant can name a colourway too, so one
sweep covers all seven. It asserts first that the flake uniform reached a
compiled program, because a string replace that quietly matched nothing in
`onBeforeCompile` looks exactly like a shader that is merely too subtle, and
knowing which of the two you have is the difference between tuning numbers and
debugging plumbing.

Bloom used to start at 0.95, which in linear HDR is below what a clearcoat
highlight on a die reaches, so whole corners of a die bloomed into a soft white
blob and took the numerals with them. It now starts above 1.0 at roughly half the
strength and a shorter radius, which confines it to genuinely blown highlights
and leaves the flakes as the thing catching the light.

Every flake parameter is a uniform, exposed through `window.dicer.debug.setFlakes`
along with `setBloom`, which is how the contact sheets are swept without a rebuild.

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

The reveal also has to get the tray wall out of the way. The rim is 2.3 units
tall, so at the reveal's usual 58 degrees a die within about 1.2 units of the near
wall is simply hidden behind it — and dice come to rest against walls constantly.

The fix that suggests itself is to stand the camera up until the sight line clears
the rim, and it is not enough. A die touching the wall needs about 80 degrees of
elevation before its centre appears and close to 90 before its base does, and at
90 the camera has no horizontal component left, so its roll is undefined and the
picture spins. So the camera swings its heading instead, until it is looking in
from over the middle of the tray. Both the camera and the die are then inside the
tray's inner rectangle, and that rectangle is convex, so the sight line between
them cannot pass through a wall at all — at any elevation. The wall is not seen
over, it is simply no longer in the way, and the shot keeps the lower, more
three-dimensional angle instead of flattening to a plan view. Elevation is still
there as a second line of defence, for the cases the swing only partly solves.

How much it swings is how much it needs to: zero when the usual heading already
sees the dice, full when nothing else would. That measurement is deliberately
taken at the heading the camera would otherwise drift to rather than the one it is
currently at, or swinging inward would relieve the very pressure that caused it
and the camera would wander back out again. The same quantity picks the rate, so a
shot that needs rescuing is reframed briskly while everything else keeps the slow
drift.

That last part is what the first attempt got wrong, and the test hid it. The
reveal is held for a few seconds and then eases back out, but `verify:camera` ran
the camera for twelve seconds before looking — long enough for a slow orbit to
reach an angle the player never sees. Every assertion in it was a statement about
a camera that does not exist. It now runs for exactly `REVEAL_HOLD_SECONDS`,
imported from the app so the two cannot drift apart, and it checks that the die's
near-bottom is visible rather than only its centre, which is the difference
between seeing a die and seeing the top half of one.

The tray a die is allowed to touch is not the tray in `tray.ts`. `ExtrudeGeometry`'s
bevel rounds the wall's top and bottom edges, but it also pulls the whole inner
face inward by `bevelSize` along its full height, and the opening's corners are
filleted while four flat collider planes meet at a point. So the leather you can
see stood 0.16 units inside the wall the physics used, and 0.28 at a corner —
every die that came to rest against a wall was buried a third of its width into
it, worst exactly where dice pile up.

`PLAY` in `tray.ts` is the boundary that actually exists: the nominal opening less
the bevel, with the fillet shrunk to match. The colliders are built from it, three
chord planes per corner standing in for each fillet — cutting at most 0.02 units
inside the true arc, a fortieth of a die — and the camera measures the rim from it
too, since the rim that blocks a sight line is the one you can see.

`npm run verify:tray` keeps the two honest by measuring both rather than trusting
either: it raycasts the built wall geometry and, along the same headings, the
physics world itself. Asking the colliders instead of recomputing the boundary
from the constants they were built from is the point — the arithmetic agreeing
with itself would prove nothing, and would sit there passing if the walls were
wired back to the nominal dimensions. Doing exactly that is how I know it works:
78 sight lines all overhang, worst 0.226 at the corner diagonal, against 0.000 as
it stands.

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

## The sound

Every impact is synthesised: one burst of noise struck through a set of
resonators, layered with a low sine for the die's mass. Nothing is sampled.

It used to be one bandpass filter at 1.5-4kHz with a Q of about one, and that is
audible as two separate faults. A Q-1 bandpass has essentially nothing above 8kHz,
so 0.4% of the energy sat above 6kHz — the sound was all body and no strike, which
is what "muffled" means. And because the filter shape was the same every time, two
impacts of the same kind measured 0.99 alike: the only things that varied were the
centre frequency by a few hundred hertz and where the noise buffer was read from,
neither of which changes the timbre.

Now the noise excites a sharp top-end tick — the contact itself, under a
millisecond of attack, which is most of what makes a die sound hard — and two or
three high-Q modes on inharmonic ratios, ringing where the body of the die would.
Each impact picks its own root, ratios, Q values, mode count and decay, so no two
are alike, and a big die rings lower than a small one.

Contacts are also told apart. Acrylic on felt, on leather and on acrylic sound
nothing alike, so the physics guesses which happened — neighbours first, since a
die knocking another die is the rarest and most distinctive of the three — and
each gets its own voice. Felt swallows the ring; a die struck by another die is
the brightest thing in the tray. Measured, that is 16% of the energy above 6kHz on
the floor against 42% between dice, where before all three sat at 0.3%.

Two smaller things were burying the strike. The low sine carries far more energy
than a few milliseconds of top end and will swamp it given the chance — floor
impacts measured *zero* percent above 6kHz until it came down. And the bus limiter
attacked in 3ms, which is to say it closed over the transient and levelled the one
part that was supposed to stand out; it opens more slowly now and catches the
sustain behind it instead.

`npm run verify:sound` measures all of this rather than describing it: it renders
impacts through the real class into an `OfflineAudioContext` and reports the share
of energy above 6kHz and how alike two impacts of the same kind are. Its own first
version was wrong in a way worth recording — plain cosine similarity between two
log-magnitude spectra sits above 0.99 no matter how different the sounds, because
it is measuring the offset they share rather than their shape. Centring each
spectrum first is what makes the number mean anything.

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
| `npm run verify:tray` | no die can sink into the wall you can see |
| `npm run verify:layout` | settled dice land clear of the result and the controls |
| `npm run verify:physics` | settle, containment and distribution over many rolls |
| `npm run verify:pairs` | two dice in one throw land independently of each other |
| `npm run verify:audio` | impacts make sound, and the toggle silences and restores it |
| `npm run verify:sound` | the impacts are bright, and no two are alike |
| `npm run verify:flakes` | the sparkle does not jump as the camera closes in |
| `npm run verify:build` | the built site runs from a sub-path, with no 404s |
| `npm run verify:pwa` | the installed app boots and rolls with the network cut |
| `npm run calibrate` | regenerate the face contact sheets |
| `npm run flakes` | contact sheet of flake settings on one settled die |
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
