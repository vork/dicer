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
  { root: number; q: number; decay: number; tick: number; ring: number; body: number }
> = {
  floor: { root: 3600, q: 6, decay: 0.038, tick: 0.55, ring: 0.70, body: 0.55 },
  wall: { root: 4200, q: 11, decay: 0.055, tick: 0.70, ring: 0.80, body: 0.40 },
  dice: { root: 5200, q: 20, decay: 0.09, tick: 0.90, ring: 0.95, body: 0.20 },
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

    const master = context.createGain();
    master.gain.value = this.enabled ? 0.8 : 0;
    master.connect(limiter);

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
    const ring = voice.decay * jitter(0.25) * (0.7 + level * 0.5);

    // The strike itself: a few milliseconds of top end, and the reason the old
    // version sounded muffled. A bandpass at 1.5-4kHz with a Q of one has
    // essentially nothing above 8kHz, and a three-millisecond attack smeared
    // what little there was. Real acrylic clacking is mostly this.
    const edge = context.createBiquadFilter();
    edge.type = 'highpass';
    edge.frequency.value = 2600 * jitter(0.4);
    const tick = context.createGain();
    const tickLength = 0.005 * jitter(0.35);
    tick.gain.setValueAtTime(0, now);
    tick.gain.linearRampToValueAtTime(voice.tick * level, now + 0.0006);
    tick.gain.exponentialRampToValueAtTime(0.0001, now + tickLength);
    source.connect(edge).connect(tick).connect(placement);
    // Milliseconds, not the whole ring: this is the contact, not the sound.
    source.start(now, Math.random() * 1.5, tickLength + 0.01);

    // And the body ringing — as decaying sinusoids, not as noise held through a
    // filter. That distinction is what made the old version sound synthetic: a
    // bandpass biquad at 4kHz with a Q of 20 rings for about Q/(pi*f), which is
    // under two milliseconds, so nothing of the forty to ninety it seemed to
    // last came from the resonator. It came from noise being fed through it the
    // whole time, and continuously-driven noise is a hiss, not a strike. Struck
    // solids ring down as sinusoids, so these are sinusoids.
    const root = (voice.root * 0.5) / Math.max(radius, 0.2) * jitter(0.28);
    const modes = Math.random() < 0.35 ? MODES.slice(0, 3) : MODES;
    for (const ratio of modes) {
      const mode = context.createOscillator();
      mode.type = 'sine';
      const hz = Math.min(root * ratio * jitter(0.22), 17000);
      mode.frequency.setValueAtTime(hz * 1.012, now);
      // Real modes sag a little as the contact lets go; dead-steady pitch is one
      // of the things that reads as a synthesiser.
      mode.frequency.exponentialRampToValueAtTime(hz, now + 0.012);
      // Higher modes lose their energy faster, which is why a struck object
      // brightens at the very start and then darkens as it rings out.
      const tau = ring * jitter(0.3) / Math.pow(ratio, 0.7);
      const loudness =
        voice.ring * level * Math.pow(ratio, -1.1) * (0.55 + Math.random() * 0.6);
      const decay = context.createGain();
      decay.gain.setValueAtTime(0, now);
      decay.gain.linearRampToValueAtTime(loudness, now + 0.0006);
      decay.gain.exponentialRampToValueAtTime(0.0001, now + tau);
      mode.connect(decay).connect(placement);
      mode.start(now);
      mode.stop(now + tau + 0.02);
    }

    // Body: a short low sine, only on hits with real force behind them. Kept well
    // under the strike, because a sine at this level carries far more energy than
    // a few milliseconds of top end and will bury it given the chance — measured
    // at zero percent of a floor impact's energy above 6kHz before this came down.
    if (level > 0.3) {
      const thump = context.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime((150 + Math.random() * 40) * voice.body, now);
      thump.frequency.exponentialRampToValueAtTime(58 * voice.body, now + 0.1);
      const thumpGain = context.createGain();
      thumpGain.gain.setValueAtTime(0, now);
      thumpGain.gain.linearRampToValueAtTime(0.38 * level * voice.body, now + 0.006);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.10 * jitter(0.25));
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
