/**
 * Procedural dice audio. No samples to ship: each impact is a short filtered
 * noise burst (the acrylic "clack") layered with a low sine thump (the mass),
 * which lets the timbre track impact strength continuously.
 */
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
      this.master.gain.setTargetAtTime(enabled ? 0.9 : 0, this.context.currentTime, 0.02);
    }
  }

  get isEnabled() {
    return this.enabled;
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
    const master = context.createGain();
    master.gain.value = this.enabled ? 0.9 : 0;
    master.connect(context.destination);

    // Two seconds of white noise, reused for every click.
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.context = context;
    this.master = master;
    this.noise = buffer;
  }

  /** @param strength 0..1 */
  impact(strength: number) {
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

    const level = Math.max(0.06, Math.min(1, strength));

    // Click: band-passed noise, brighter and longer the harder the hit.
    const source = context.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = 0.85 + Math.random() * 0.3;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1500 + level * 2600 + Math.random() * 500;
    band.Q.value = 1.1;
    const clickGain = context.createGain();
    const clickDuration = 0.035 + level * 0.05;
    clickGain.gain.setValueAtTime(0, now);
    clickGain.gain.linearRampToValueAtTime(0.42 * level, now + 0.003);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + clickDuration);
    source.connect(band).connect(clickGain).connect(master);
    source.start(now, Math.random() * 1.5, clickDuration + 0.02);

    // Body: a short low sine, only on hits with real force behind them.
    if (level > 0.22) {
      const thump = context.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(150 + Math.random() * 40, now);
      thump.frequency.exponentialRampToValueAtTime(58, now + 0.1);
      const thumpGain = context.createGain();
      thumpGain.gain.setValueAtTime(0, now);
      thumpGain.gain.linearRampToValueAtTime(0.3 * level, now + 0.006);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
      thump.connect(thumpGain).connect(master);
      thump.start(now);
      thump.stop(now + 0.15);
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
      gain.gain.linearRampToValueAtTime(0.09 / (index + 1), start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + 1.2);
    });
  }
}
