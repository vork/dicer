import type { ContactSurface } from './physics/dice-world';

/**
 * Procedural dice audio. No samples to ship: each impact is one burst of noise
 * struck through a set of resonators — the sharp top end of the contact itself,
 * then three high-Q modes ringing where the body of the die would — layered with
 * a low sine for its mass. Everything is synthesised per impact, so timbre can
 * follow how hard the hit was, how big the die is, and what it landed on.
 */

/** Inharmonic, the way a small solid object rings. Not a harmonic series. */
const MODES = [1, 1.63, 2.41, 3.32];

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
  floor: { root: 950, decay: 0.016, tick: 0.18, ring: 0.85, body: 0.55 },
  wall: { root: 1150, decay: 0.019, tick: 0.25, ring: 0.90, body: 0.40 },
  dice: { root: 1550, decay: 0.024, tick: 0.35, ring: 1.00, body: 0.22 },
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

    // Dice make a lot of small taps and a few hard cracks. Pushing the quiet end
    // up far enough to hear leaves the loud end clipping when several land at
    // once, so the bus runs through a limiter and the levels can sit high.
    // Deliberately not a fast limiter. At a 3ms attack it was closing over the
    // strike itself — the two or three milliseconds of top end that make a die
    // sound hard — and levelling exactly what should stand out. Opening more
    // slowly lets the transient through and still catches the sustain behind it.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 10;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.006;
    limiter.release.value = 0.12;
    limiter.connect(context.destination);

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
    presence.connect(limiter);

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
  impact(strength: number, pan = 0, surface: ContactSurface = 'floor', radius = 0.5) {
    if (!this.enabled) return;
    if (!this.context) this.init();
    const context = this.context;
    const master = this.master;
    const noise = this.noise;
    if (!context || !master || !noise || context.state !== 'running') return;

    // Rate-limit: a scattering handful of dice can fire dozens of contacts a frame.
    const now = context.currentTime;
    if (now - this.lastPlayed > 0.09) this.playedInWindow = 0;
    if (this.playedInWindow >= 4) return;
    this.lastPlayed = now;
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

    // One strike, one burst of energy, several paths out of it. The burst is a
    // few milliseconds — the contact and nothing more — and what happens after
    // it is the resonators ringing, not the noise continuing.
    const excite = context.createGain();
    const burst = 0.006 * jitter(0.35);
    excite.gain.setValueAtTime(0, now);
    excite.gain.linearRampToValueAtTime(1, now + 0.0005);
    excite.gain.exponentialRampToValueAtTime(0.0001, now + burst);
    source.connect(excite);
    source.start(now, Math.random() * 1.5, burst + 0.02);

    // The top end of the contact itself, which is most of what makes a die sound
    // hard rather than soft.
    const edge = context.createBiquadFilter();
    edge.type = 'highpass';
    edge.frequency.value = 1100 * jitter(0.4);
    const tick = context.createGain();
    tick.gain.value = voice.tick * level;
    excite.connect(edge).connect(tick).connect(placement);

    // And the body ringing. Resonators, struck by that burst and left to ring on
    // their own — not sine oscillators, and not noise held through a filter.
    //
    // Both of those were tried and both were wrong in the same place. Sines are
    // pure tones and read as digital beeps; noise held through a filter for the
    // whole ring is a hiss. What sits between them is a filter with enough Q to
    // ring on its own after a short strike, which keeps the pitch of a mode and
    // the grain of a real object.
    //
    // Whether that is possible depends entirely on frequency, which is what I got
    // wrong first: a resonator's ring is T20 = 2.303 * Q / (pi * f), so at the
    // 4kHz the modes used to sit at, even Q 20 rings for 3.5ms and there is
    // nothing to hear. Down at 950-1550Hz the same arithmetic gives 25-38ms,
    // which is exactly what the reference recordings do.
    const root = (voice.root * 0.5) / Math.max(radius, 0.2) * jitter(0.28);
    const modes = Math.random() < 0.35 ? MODES.slice(0, 3) : MODES;
    for (const ratio of modes) {
      const hz = Math.min(root * ratio * jitter(0.22), 15000);
      // Higher modes lose their energy faster, which is why a struck object
      // brightens for an instant and then darkens as it rings out.
      const t20 = (ring / Math.pow(ratio, 0.7)) * jitter(0.3);
      const q = Math.min(Math.max((Math.PI * hz * t20) / 2.303, 4), 150);
      const mode = context.createBiquadFilter();
      mode.type = 'bandpass';
      mode.frequency.value = hz;
      mode.Q.value = q;
      const gain = context.createGain();
      // A narrower resonator takes a far smaller bite out of a broadband strike,
      // and the bite is proportional to its bandwidth f/Q — so putting the level
      // back means scaling by sqrt(Q/f), not by sqrt(Q). Getting that wrong left
      // the modes about fifty times too quiet against the wideband contact
      // noise, and the whole sound collapsed into the tick.
      gain.gain.value =
        voice.ring * level * Math.pow(ratio, -0.75) * (0.55 + Math.random() * 0.6) *
        Math.sqrt(q / hz) * 300;
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
