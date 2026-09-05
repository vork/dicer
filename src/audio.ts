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
 *
 * The roots are close together on purpose, though they did not start that way.
 * Most of the pitch you hear when a die lands is the tray, and the tray is the
 * same object whichever face hit it — only the die-on-die contact is genuinely a
 * different resonator. Spread over 880-1400Hz, the root jumped by more than half
 * an octave depending on what each contact happened to touch, and since die-on-die
 * is the commonest contact of all the sound lurched between two pitches all the
 * way through a roll.
 */
const SURFACES: Record<
  ContactSurface,
  { root: number; decay: number; tick: number; ring: number; body: number }
> = {
  floor: { root: 900, decay: 0.016, tick: 0.21, ring: 0.85, body: 0.50 },
  wall: { root: 1010, decay: 0.019, tick: 0.26, ring: 0.90, body: 0.42 },
  dice: { root: 1190, decay: 0.021, tick: 0.32, ring: 1.00, body: 0.33 },
};
export class DiceAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private floor: GainNode | null = null;
  private bed: AudioBufferSourceNode | null = null;
  private floorStarted = false;
  private lastPlayed = 0;
  private playedInWindow = 0;
  private enabled = true;

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(enabled ? 0.8 : 0, this.context.currentTime, 0.02);
    }
  }

  /**
   * A small, soft room with a table in it, generated rather than sampled.
   *
   * Dense scattered reflections over a decaying noise tail. Both halves of that
   * are corrections. The reflections were four single samples at 6, 11, 19 and
   * 31ms — and one sample at 0.45 is a full-bandwidth impulse, about the most
   * synthetic object that can exist in a buffer. A table scatters dozens of
   * overlapping arrivals, each one filtered by the surface it came off, so that
   * is what these are: short bursts at irregular times, never a lone spike.
   *
   * The tail's low pass used to close from 2.1kHz down to 380Hz across the decay,
   * which is a wah pedal shutting on every impact, and reads exactly as hearing
   * the dice through water. Rooms do get darker as they decay, but nowhere near
   * that far or that fast: this closes to 1.4kHz and stops.
   */
  private static tabletop(context: BaseAudioContext): AudioBuffer {
    const rate = context.sampleRate;
    const length = Math.floor(rate * 0.34);
    const buffer = context.createBuffer(2, length, rate);
    // Deterministic, so the room is the same room on every impact and between
    // reloads — it is one table, not a new one per hit.
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let low = 0;
      for (let i = 0; i < length; i++) {
        const t = i / rate;
        // Darkens with the decay, but only over the top half of its range.
        const coefficient = 0.34 - 0.12 * Math.min(1, t / 0.34);
        low += coefficient * (rand() * 2 - 1 - low);
        data[i] = low * Math.exp(-t * 15);
      }
      // Early reflections: irregular arrivals through the first 50ms, each a
      // short burst rather than an impulse, thinning out as the tail takes over.
      let at = 0.0035 + rand() * 0.002;
      let gain = 0.5;
      while (at < 0.05) {
        const start = Math.floor(at * rate);
        const span = Math.floor(rate * (0.0004 + rand() * 0.0009));
        const sign = rand() < 0.5 ? -1 : 1;
        for (let i = 0; i < span && start + i < length; i++) {
          // A raised cosine, so the burst has no edge of its own to click on.
          const shape = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / span);
          data[start + i] += sign * gain * shape * (rand() * 2 - 1);
        }
        at += 0.0012 + rand() * 0.004;
        gain *= 0.88;
      }
    }
    // Normalise to a fixed energy so the wet level means the same thing whatever
    // the shape of the room, and changing the room does not change the loudness.
    let energy = 0;
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) energy += data[i] * data[i];
    }
    const scale = 0.55 / Math.sqrt(energy / length);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] *= scale;
    }
    return buffer;
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

    // The room the dice are in.
    //
    // Without this an impact stops dead: measured against the recordings, both of
    // them still have content across every band at 96ms, while ours was blank
    // from 56ms — not quiet, empty. Nothing in the physical world decays into
    // absolute silence, and that abrupt cut to nothing is most of what was left
    // of sounding synthetic. A short tail also fills the gaps between contacts,
    // which is what makes a roll sound like it is happening somewhere.
    //
    // I nearly built this two rounds ago and talked myself out of it because the
    // recordings measured 1.000 stereo correlation. That was the wrong inference:
    // it says they are mono, not that they are dry.
    const room = context.createConvolver();
    room.buffer = DiceAudio.tabletop(context);
    const wet = context.createGain();
    wet.gain.value = 0.85;
    room.connect(wet).connect(presence);

    // The tray itself: a fixed set of gentle formants every contact passes
    // through, wired in series ahead of everything else.
    //
    // Most of what you hear when a die lands is not the die, it is the tray, and
    // the tray is one object — so its colour belongs here, stamped identically on
    // every contact, rather than being re-synthesised per impact as part of each
    // voice. Measured over whole rolls this is what moved consecutive contacts
    // closer together; five attempts at reducing the per-contact randomisation
    // moved it by nothing at all, because the variation was never there.
    //
    // Gentle on purpose. At nearly twice these figures both the likeness and the
    // pitch scatter got worse, not better: a strong resonance is a box, and a box
    // rings at its own pitch instead of colouring what happens inside it.
    const BODY = [
      { hz: 420, q: 1.9, db: 4.0 },
      { hz: 780, q: 2.4, db: -3.0 },
      { hz: 1350, q: 2.0, db: 3.5 },
      { hz: 3200, q: 2.0, db: -2.5 },
    ];
    let bodyIn = presence;
    for (const f of [...BODY].reverse()) {
      const filter = context.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = f.hz;
      filter.Q.value = f.q;
      filter.gain.value = f.db;
      filter.connect(bodyIn);
      bodyIn = filter;
    }

    const master = context.createGain();
    master.gain.value = this.enabled ? 0.8 : 0;
    master.connect(bodyIn);
    master.connect(room);

    // Two seconds of white noise, reused for every click.
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Room tone.
    //
    // Measured in ten-millisecond windows, both reference recordings sit on a
    // floor 48 and 65dB under their loudest moment. Ours sat 223dB under it,
    // which is not a quiet room — it is mathematically nothing. A sequence of
    // events separated by absolute silence is the most recognisable synthetic
    // tell there is, and no recording of anything has ever had one.
    //
    // So: a bed of filtered noise, far too quiet to hear on its own, present
    // while the dice are. It is raised by each contact and decays away a couple
    // of seconds after the last one, because the room is only there to be heard
    // when something else is making a sound in it — and a page sitting idle
    // should be properly silent rather than hissing.
    const bed = context.createBufferSource();
    const bedBuffer = context.createBuffer(2, context.sampleRate * 3, context.sampleRate);
    for (let c = 0; c < 2; c++) {
      const channel = bedBuffer.getChannelData(c);
      let low = 0;
      for (let i = 0; i < channel.length; i++) {
        low += 0.12 * (Math.random() * 2 - 1 - low);
        channel[i] = low;
      }
    }
    bed.buffer = bedBuffer;
    bed.loop = true;
    const bedShape = context.createBiquadFilter();
    bedShape.type = 'highpass';
    bedShape.frequency.value = 90;
    const floor = context.createGain();
    floor.gain.value = 0;
    bed.connect(bedShape).connect(floor).connect(master);

    this.context = context;
    this.master = master;
    this.noise = buffer;
    this.floor = floor;
    this.bed = bed;
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

    // Bring the room tone up, and leave it decaying. Every contact re-raises it,
    // so it is continuous through a roll and gone a few seconds after the last
    // die stops. The bed only starts on the first contact of the session.
    if (this.floor && this.bed) {
      if (!this.floorStarted) {
        this.bed.start(context.currentTime);
        this.floorStarted = true;
      }
      const gain = this.floor.gain;
      gain.cancelScheduledValues(context.currentTime);
      gain.setTargetAtTime(0.0016, context.currentTime, 0.03);
      gain.setTargetAtTime(0, context.currentTime + 0.4, 0.8);
    }
    const jitter = (amount: number) => 1 + (Math.random() * 2 - 1) * amount;

    const placement = context.createStereoPanner();
    placement.pan.value = Math.max(-1, Math.min(1, pan)) * 0.6;
    placement.connect(master);

    // One burst of noise excites the whole thing, the way one strike does.
    const source = context.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = 0.92 + Math.random() * 0.16;
    // Target -20dB ring for the fundamental; the resonator Q is derived from it.
    const ring = voice.decay * jitter(0.12) * (0.7 + level * 0.5);

    // A die does not land once. It comes down on an edge, tips, and drops onto a
    // face, and those contacts are milliseconds apart — that clatter is most of
    // what separates dice on a table from something being struck. So the
    // excitation is two or three spikes a few milliseconds apart, each quieter
    // than the last, re-striking the same resonators.
    const excite = context.createGain();
    const burst = 0.005 * jitter(0.2);
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
    edge.frequency.value = 1100 * jitter(0.15);
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
    const root = (voice.root * 0.5) / Math.max(radius, 0.2) * jitter(0.04);
    for (const nominal of MODES) {
      // A fixed set of ratios, barely jittered, and a root that hardly moves.
      //
      // This was drawing fresh random ratios for every impact, on the theory that
      // variety reads as realism. It does not. Measured, two impacts from a real
      // dice recording are 0.90 alike — the same object struck again sounds like
      // the same object. Redrawing the modes each time gave every hit a different
      // set of pitches, and a sequence of different pitches is a marimba being
      // played, which is exactly what it sounded like.
      const ratio = nominal * jitter(0.03);
      const hz = Math.min(root * ratio, 15000);
      // Deliberately short and broad. A narrow resonator holds a pitch; a
      // handful of broad ones overlapping read as a body with a colour.
      const t20 = ((ring * 0.75) / Math.pow(ratio, 0.5)) * jitter(0.12);
      // Capped hard. The ceiling used to be 90, and die-on-die contacts — the
      // commonest kind in a roll by a wide margin — were reaching Q 85 at 5.7kHz.
      // That is a tuning fork. Acrylic has a loss factor around 0.05, which puts
      // its modes near Q 20 before the tray damps them further, and nothing in a
      // felt-lined leather box rings narrower than that.
      const q = Math.min(Math.max((Math.PI * hz * t20) / 2.303, 3), 26);
      const mode = context.createBiquadFilter();
      mode.type = 'bandpass';
      mode.frequency.value = hz;
      mode.Q.value = q;
      const gain = context.createGain();
      // A narrow resonator takes a bite out of a broadband strike proportional to
      // its bandwidth f/Q, so restoring the level scales by sqrt(Q/f) — not
      // sqrt(Q), which left the modes fifty times too quiet against the contact
      // noise and collapsed the whole sound into the tick.
      // The rolloff across the modes, and how much it is allowed to wander.
      //
      // At -0.35 the second mode sat 1.83dB under the first while this random
      // factor spanned +-1.2dB, so which partial carried the pitch flipped from
      // one contact to the next. Measured over a whole roll, the strongest peak
      // scattered 66.6% about its mean where real dice scatter 21-27%: a set of
      // inharmonic partials with a different winner every strike is a bell being
      // struck in different places. Steeper here, and tighter there, keeps the
      // fundamental in front where a real body keeps it.
      gain.gain.value =
        voice.ring * level * Math.pow(ratio, -0.85) * (0.92 + Math.random() * 0.16) *
        Math.sqrt(q / hz) * 150;
      excite.connect(mode).connect(gain).connect(placement);
    }

    // Body: a short low sine, only on hits with real force behind them. Kept well
    // under the strike, because a sine at this level carries far more energy than
    // a few milliseconds of top end and will bury it given the chance — measured
    // at zero percent of a floor impact's energy above 6kHz before this came down.
    // Faded in rather than switched on at a threshold. `level > 0.3` meant one
    // contact carried a whole extra oscillator and the next did not, so
    // neighbouring taps in the same roll differed by more than a hard hit differs
    // from a soft one.
    const weight = Math.min(1, Math.max(0, (level - 0.24) / 0.3));
    if (weight > 0.02) {
      const thump = context.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(320 + Math.random() * 50, now);
      thump.frequency.exponentialRampToValueAtTime(150, now + 0.1);
      const thumpGain = context.createGain();
      thumpGain.gain.setValueAtTime(0, now);
      thumpGain.gain.linearRampToValueAtTime(0.28 * weight * level * voice.body, now + 0.006);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04 * jitter(0.15));
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
