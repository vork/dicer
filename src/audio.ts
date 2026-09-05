import type { ContactSurface } from './physics/dice-world';

/**
 * Where the body resonates, as ratios of the root. Inharmonic and dense — a solid
 * object rings on ratios like these, not on a harmonic series — and fixed, so
 * that the same die struck twice sounds like the same die.
 */
const MODES = [1, 1.42, 1.93, 2.51, 3.14, 3.87, 4.6];

/**
 * Procedural dice audio. No samples to ship: each impact is one burst of noise
 * struck through a set of resonators — the sharp top end of the contact itself,
 * then three high-Q modes ringing where the body of the die would — layered with
 * a low sine for its mass. Everything is synthesised per impact, so timbre can
 * follow how hard the hit was, how big the die is, and what it landed on.
 */

/**
 * Acrylic on felt, on leather and on acrylic sound nothing alike, and having
 * every contact sound the same was most of why the old version was monotonous.
 * Felt swallows the ring almost entirely; a die struck by another die is the
 * brightest thing in the tray.
 */
const SURFACES: Record<
  ContactSurface,
  { root: number; decay: number; tick: number; ring: number; body: number }
> = {
  floor: { root: 880, decay: 0.016, tick: 0.18, ring: 0.85, body: 0.55 },
  wall: { root: 1050, decay: 0.022, tick: 0.25, ring: 0.90, body: 0.40 },
  dice: { root: 1400, decay: 0.027, tick: 0.35, ring: 1.00, body: 0.22 },
};
export class DiceAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastPlayed = 0;
  private playedInWindow = 0;
  private enabled = true;

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(enabled ? 0.8 : 0, this.context.currentTime, 0.02);
    }
  }

  /** Must be called from a user gesture; browsers block audio otherwise. */
  resume() {
    if (!this.context) this.init();
    if (this.context?.state === 'suspended') void this.context.resume();
  }

  private init() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();

    // A soft saturator, not a compressor.
    //
    // This was a DynamicsCompressor at a -14dB threshold with a 10dB knee, and
    // impacts peak at about -14dB — so every single one landed five decibels
    // inside the knee. With a 6ms attack and a 120ms release, and contacts
    // arriving every twenty to ninety milliseconds, it engaged on every impact
    // and never let go: it pumped continuously and chewed the very transients it
    // was there to protect, which is what made the dice sound crunched and
    // quantised.
    //
    // tanh has unity slope at the origin, so it is a straight wire at the levels
    // the dice actually reach — 0.1dB at a single impact's peak — and bends only
    // when several land at once. Oversampling matters: a waveshaper folds
    // whatever it distorts back down the spectrum, and that aliasing is itself
    // exactly the digital grit being avoided here.
    const saturator = context.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      // Plain tanh: slope one at the origin, so it is a straight wire for
      // anything small, bending only as the sum approaches full scale. A single
      // impact peaks near 0.2, where this costs 0.1dB.
      curve[i] = Math.tanh((i / (curve.length - 1)) * 2 - 1);
    }
    saturator.curve = curve;
    saturator.oversample = '4x';
    saturator.connect(context.destination);

    // A gentle dip where the ear is sharpest. 2.5-5.5kHz is the band that turns a
    // click from present into piercing, and dice put a lot of energy there — half
    // of it, before the modes were moved down. Taking a few dB out here is what
    // separates a sound you can listen to for an hour from one you cannot.
    const presence = context.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 3800;
    presence.Q.value = 1.1;
    // Only a couple of dB. This was cut much harder when the modes themselves sat
    // in this band; with them moved down, the same cut on top took the
    // articulation out as well as the edge.
    presence.gain.value = -2.5;
    presence.connect(saturator);

    const master = context.createGain();
    master.gain.value = this.enabled ? 0.8 : 0;
    master.connect(presence);

    // Two seconds of white noise, reused for every click.
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.context = context;
    this.master = master;
    this.noise = buffer;
  }

  /**
   * @param strength 0..1
   * @param pan -1..1, where the die hit across the tray
   * @param surface what it hit
   * @param radius the die's bounding radius, in world units
   */
  impact(strength: number, pan = 0, surface: ContactSurface = 'floor', radius = 0.5, when = 0) {
    if (!this.enabled) return;
    if (!this.context) this.init();
    const context = this.context;
    const master = this.master;
    const noise = this.noise;
    if (!context || !master || !noise || context.state !== 'running') return;

    // Placed where the solver says it happened, not at the frame boundary. The
    // solver takes up to eight steps a frame, so contacts within one frame are
    // as much as seventy milliseconds apart; playing them together stacked them
    // at an identical sample, where they summed into one blip rather than
    // sounding like the separate taps they are.
    // Two dice landing in the same solver step are not landing at the same
    // microsecond, and identical timestamps sum coherently into one loud click
    // rather than two taps. A couple of milliseconds of scatter is below the
    // threshold where it reads as a delay and above the one where it stacks.
    const now = context.currentTime + Math.max(0, when) + Math.random() * 0.004;

    // Rate-limit: a scattering handful of dice can fire dozens of contacts a
    // frame. Measured against the frame boundary rather than the placed time, so
    // that spreading contacts out does not spend the budget faster.
    const arrived = context.currentTime;
    if (arrived - this.lastPlayed > 0.09) this.playedInWindow = 0;
    if (this.playedInWindow >= 7) return;
    this.lastPlayed = arrived;
    this.playedInWindow++;

    // Most contacts in a roll are gentle settling taps rather than the opening
    // crack, so a linear mapping left the median impact near inaudible. The
    // curve lifts the quiet end without flattening the loud end.
    const level = Math.pow(Math.max(0.06, Math.min(1, strength)), 0.55);
    const voice = SURFACES[surface];
    const jitter = (amount: number) => 1 + (Math.random() * 2 - 1) * amount;

    const placement = context.createStereoPanner();
    placement.pan.value = Math.max(-1, Math.min(1, pan)) * 0.6;
    placement.connect(master);

    // One burst of noise excites the whole thing, the way one strike does.
    const source = context.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = 0.85 + Math.random() * 0.3;
    // Target -20dB ring for the fundamental; the resonator Q is derived from it.
    const ring = voice.decay * jitter(0.25) * (0.7 + level * 0.5);

    // A die does not land once. It comes down on an edge, tips, and drops onto a
    // face, and those contacts are milliseconds apart — that clatter is most of
    // what separates dice on a table from something being struck. So the
    // excitation is two or three spikes a few milliseconds apart, each quieter
    // than the last, re-striking the same resonators.
    const excite = context.createGain();
    const burst = 0.005 * jitter(0.35);
    const strikes = 1 + (Math.random() < 0.65 ? 1 : 0) + (Math.random() < 0.35 ? 1 : 0);
    let at = now;
    let force = 1;
    for (let i = 0; i < strikes; i++) {
      excite.gain.setValueAtTime(0.0001, at);
      excite.gain.linearRampToValueAtTime(force, at + 0.0004);
      excite.gain.exponentialRampToValueAtTime(0.0001, at + burst);
      at += burst + 0.004 + Math.random() * 0.016;
      force *= 0.4 + Math.random() * 0.3;
    }
    source.connect(excite);
    source.start(now, Math.random() * 1.5, at - now + 0.02);

    // The top end of the contact itself, which is most of what makes a die sound
    // hard rather than soft.
    const edge = context.createBiquadFilter();
    edge.type = 'highpass';
    edge.frequency.value = 1100 * jitter(0.4);
    const tick = context.createGain();
    tick.gain.value = voice.tick * level;
    excite.connect(edge).connect(tick).connect(placement);

    // And the body ringing. Resonators, struck by that clatter and left to ring
    // on their own — not sine oscillators, and not noise held through a filter.
    //
    // Both of those were tried and both were wrong. Sines are pure tones and read
    // as digital beeps; noise held through a filter for the whole ring is a hiss.
    // A filter with enough Q to ring after a short strike sits between them,
    // keeping the pitch of a mode and the grain of a real object. Whether that is
    // possible depends entirely on frequency: the ring is T20 = 2.303*Q/(pi*f),
    // so at the 4kHz the modes once sat at even Q 20 rings for 3.5ms and there is
    // nothing to hear, while down here at 950-1550Hz the same arithmetic gives
    // tens of milliseconds.
    //
    // The ratios are drawn fresh for every impact rather than taken from a fixed
    // set. A fixed set is a chord, and a chord struck over and over is a tuned
    // instrument — which is exactly what it sounded like. Dice have no tuning:
    // the modes a contact happens to excite depend on where it was struck, so
    // they should differ every time and never resolve into a pitch.
    const root = (voice.root * 0.5) / Math.max(radius, 0.2) * jitter(0.06);
    for (const nominal of MODES) {
      // A fixed set of ratios, barely jittered, and a root that hardly moves.
      //
      // This was drawing fresh random ratios for every impact, on the theory that
      // variety reads as realism. It does not. Measured, two impacts from a real
      // dice recording are 0.90 alike — the same object struck again sounds like
      // the same object. Redrawing the modes each time gave every hit a different
      // set of pitches, and a sequence of different pitches is a marimba being
      // played, which is exactly what it sounded like.
      const ratio = nominal * jitter(0.05);
      const hz = Math.min(root * ratio, 15000);
      // Deliberately short and broad. A narrow resonator holds a pitch; a
      // handful of broad ones overlapping read as a body with a colour.
      const t20 = ((ring * 0.75) / Math.pow(ratio, 0.5)) * jitter(0.12);
      const q = Math.min(Math.max((Math.PI * hz * t20) / 2.303, 3), 90);
      const mode = context.createBiquadFilter();
      mode.type = 'bandpass';
      mode.frequency.value = hz;
      mode.Q.value = q;
      const gain = context.createGain();
      // A narrow resonator takes a bite out of a broadband strike proportional to
      // its bandwidth f/Q, so restoring the level scales by sqrt(Q/f) — not
      // sqrt(Q), which left the modes fifty times too quiet against the contact
      // noise and collapsed the whole sound into the tick.
      gain.gain.value =
        voice.ring * level * Math.pow(ratio, -0.35) * (0.85 + Math.random() * 0.3) *
        Math.sqrt(q / hz) * 150;
      excite.connect(mode).connect(gain).connect(placement);
    }

    // Body: a short low sine, only on hits with real force behind them. Kept well
    // under the strike, because a sine at this level carries far more energy than
    // a few milliseconds of top end and will bury it given the chance — measured
    // at zero percent of a floor impact's energy above 6kHz before this came down.
    if (level > 0.3) {
      const thump = context.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(320 + Math.random() * 80, now);
      thump.frequency.exponentialRampToValueAtTime(150, now + 0.1);
      const thumpGain = context.createGain();
      thumpGain.gain.setValueAtTime(0, now);
      thumpGain.gain.linearRampToValueAtTime(0.28 * level * voice.body, now + 0.006);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04 * jitter(0.25));
      thump.connect(thumpGain).connect(master);
      thump.start(now);
      thump.stop(now + 0.16);
    }
  }

  /** A soft chime under the result flash. */
  reveal(critical: boolean) {
    if (!this.enabled) return;
    const context = this.context;
    const master = this.master;
    if (!context || !master || context.state !== 'running') return;

    const now = context.currentTime;
    const root = critical ? 523.25 : 392.0;
    [1, 1.5, 2].forEach((ratio, index) => {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = root * ratio;
      const gain = context.createGain();
      const start = now + index * 0.035;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.17 / (index + 1), start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + 1.2);
    });
  }
}
