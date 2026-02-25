/**
 * WaveOrganEngine — Web Audio synthesis engine for Wave Organ.
 *
 * Encapsulates the entire audio graph: oscillators, per-partial gain nodes,
 * master bus, limiter, and delay reverb tail. Decoupled from any UI; accepts
 * per-partial activation values (0–1) and translates them into audio gain with
 * harmonic roll-off applied automatically.
 *
 * Usage:
 *   const engine = new WaveOrganEngine();   // configure with options if needed
 *   engine.start();                         // call from a user gesture
 *   engine.setActivations([0, 0.5, 1, ...]); // drive from any UI source
 */
class WaveOrganEngine {
  /**
   * @param {object}   options
   * @param {number}   options.baseHz      – fundamental frequency in Hz  (default 110)
   * @param {number[]} options.partials    – harmonic multipliers          (default [1..9])
   * @param {number}   options.maxGain     – per-oscillator gain ceiling   (default 0.18)
   * @param {number}   options.masterGain  – master bus level              (default 0.65)
   * @param {number}   options.delayTime   – reverb delay in seconds       (default 0.36)
   * @param {number}   options.feedback    – delay feedback amount 0–1     (default 0.35)
   * @param {number}   options.wetGain     – delay wet level 0–1           (default 0.18)
   */
  constructor(options = {}) {
    this._baseHz     = options.baseHz     ?? 110;
    this._partials   = options.partials   ?? [1, 2, 3, 4, 5, 6, 7, 8, 9];
    this._maxGain    = options.maxGain    ?? 0.18;
    this._masterGain = options.masterGain ?? 0.65;
    this._delayTime  = options.delayTime  ?? 0.36;
    this._feedback   = options.feedback   ?? 0.35;
    this._wetGain    = options.wetGain    ?? 0.18;

    this._ctx    = null;
    this._oscs   = [];
    this._gains  = [];
    this._master = null;
    this._ready  = false;
  }

  // ── read-only properties ──────────────────────────────────────────────────

  /** True after start() has been called successfully. */
  get isReady()      { return this._ready; }

  /** Harmonic multiplier array (copy). */
  get partials()     { return this._partials.slice(); }

  /** Fundamental frequency in Hz. */
  get baseHz()       { return this._baseHz; }

  /** Number of harmonic partials / oscillators. */
  get partialCount() { return this._partials.length; }

  /** Per-oscillator gain ceiling (before 1/h roll-off). */
  get maxGain()      { return this._maxGain; }

  /** Web Audio current time in seconds, or 0 before start(). */
  get currentTime()  { return this._ctx ? this._ctx.currentTime : 0; }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialise the Web Audio graph and start all oscillators.
   * Must be called from a user-gesture (click / keydown).
   */
  start() {
    if (this._ready) return;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._ctx = ctx;

    // ── Limiter — prevents clipping when many partials are active ───────────
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value      =  3;
    limiter.ratio.value     = 20;
    limiter.attack.value    =  0.001;
    limiter.release.value   =  0.08;
    limiter.connect(ctx.destination);

    // ── Delay reverb tail ───────────────────────────────────────────────────
    const delay    = ctx.createDelay(1.0);
    const feedback = ctx.createGain();
    const wetGain  = ctx.createGain();
    delay.delayTime.value = this._delayTime;
    feedback.gain.value   = this._feedback;
    wetGain.gain.value    = this._wetGain;
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wetGain);
    wetGain.connect(limiter);

    // ── Master gain bus ─────────────────────────────────────────────────────
    this._master = ctx.createGain();
    this._master.gain.value = this._masterGain;
    this._master.connect(limiter);
    this._master.connect(delay); // feed delay pre-limiter

    // ── One sine oscillator per harmonic partial ────────────────────────────
    this._partials.forEach(h => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type            = 'sine';
      osc.frequency.value = this._baseHz * h;
      gain.gain.value     = 0;
      osc.connect(gain);
      gain.connect(this._master);
      osc.start();
      this._oscs.push(osc);
      this._gains.push(gain);
    });

    this._ready = true;
  }

  // ── parameter control ─────────────────────────────────────────────────────

  /**
   * Drive the synthesiser with per-partial activation levels.
   *
   * Each value should be in [0, 1]. The engine applies:
   *   audioGain[i] = clamp(activations[i], 0, 1) * maxGain / partials[i]
   *
   * The 1/h roll-off gives a natural additive timbre — louder lower partials,
   * quieter upper ones — so callers can treat all values uniformly as a simple
   * "how active is this partial?" signal.
   *
   * @param {number[]} activations – one value per partial
   */
  setActivations(activations) {
    if (!this._ready) return;
    const now = this._ctx.currentTime;
    activations.forEach((a, i) => {
      if (i >= this._gains.length) return;
      const g = Math.max(0, Math.min(a, 1)) * this._maxGain / this._partials[i];
      this._gains[i].gain.setTargetAtTime(g, now, 0.06);
    });
  }
}
