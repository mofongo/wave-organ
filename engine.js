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
 *   engine.setMode('wavetable');            // switch synthesis mode
 *   engine.setWaveShape(samples, 0.8);      // drive wavetable from any UI source
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

    this._ctx      = null;
    this._oscs     = [];
    this._gains    = [];
    this._master   = null;
    this._ready    = false;
    this._mode     = 'additive'; // 'additive' | 'wavetable'
    this._waveOsc  = null;
    this._waveGain = null;
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

  /** Current synthesis mode: 'additive' or 'wavetable'. */
  get mode()         { return this._mode; }

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

    // ── Wavetable oscillator (single oscillator, shape-driven) ──────────────
    this._waveOsc  = ctx.createOscillator();
    this._waveGain = ctx.createGain();
    this._waveOsc.frequency.value = this._baseHz;
    this._waveGain.gain.value     = 0;
    this._waveOsc.connect(this._waveGain);
    this._waveGain.connect(this._master);
    this._waveOsc.start();

    this._ready = true;
  }

  // ── parameter control ─────────────────────────────────────────────────────

  /**
   * Drive the synthesiser with per-partial activation levels.
   *
   * Each value should be in [0, 1]. The engine applies index-based roll-off:
   *   audioGain[i] = clamp(activations[i], 0, 1) * maxGain / (i + 1)
   *
   * Roll-off is index-based (1, 1/2, 1/3 …) rather than ratio-based, so it
   * stays musically consistent across all tunings — partial 0 is always
   * loudest, partial 8 is always quietest regardless of which frequencies are
   * currently assigned.
   *
   * @param {number[]} activations – one value per partial
   */
  setActivations(activations) {
    if (!this._ready) return;
    const now = this._ctx.currentTime;
    activations.forEach((a, i) => {
      if (i >= this._gains.length) return;
      const g = Math.max(0, Math.min(a, 1)) * this._maxGain / (i + 1);
      this._gains[i].gain.setTargetAtTime(g, now, 0.06);
    });
  }

  /**
   * Retune all oscillators to a new set of frequency ratios.
   * Frequencies ramp smoothly so there are no clicks on tuning switches.
   *
   * @param {number[]} ratios – multipliers relative to baseHz, one per partial
   */
  setRatios(ratios) {
    if (!this._ready) return;
    const now = this._ctx.currentTime;
    ratios.forEach((r, i) => {
      if (i >= this._oscs.length) return;
      this._oscs[i].frequency.setTargetAtTime(this._baseHz * r, now, 0.05);
    });
   * Switch synthesis mode with a short crossfade.
   * Safe to call before start() — the mode preference is stored and honoured
   * once the engine is running.
   *
   * @param {'additive'|'wavetable'} mode
   */
  setMode(mode) {
    if (mode === this._mode) return;
    this._mode = mode;
    if (!this._ready) return;
    const now = this._ctx.currentTime;
    if (mode === 'wavetable') {
      this._gains.forEach(g => g.gain.setTargetAtTime(0, now, 0.12));
    } else {
      this._waveGain.gain.setTargetAtTime(0, now, 0.12);
    }
  }

  /**
   * Update the wavetable oscillator's waveform using DFT coefficients
   * derived from `samples`, and set its output level.
   *
   * The DFT converts time-domain samples to the Fourier series coefficients
   * required by createPeriodicWave:
   *   real[k] =  (2/N) * Σ_n  samples[n] * cos(2πkn/N)
   *   imag[k] = -(2/N) * Σ_n  samples[n] * sin(2πkn/N)
   *
   * @param {Float32Array|number[]} samples   – N values in [-1, 1]
   * @param {number}                amplitude – overall gain scalar in [0, 1]
   */
  setWaveShape(samples, amplitude) {
    if (!this._ready) return;
    const N    = samples.length;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);

    for (let k = 1; k < N; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const phi = (2 * Math.PI * k * n) / N;
        re += samples[n] * Math.cos(phi);
        im += samples[n] * Math.sin(phi);
      }
      real[k] =  (2 / N) * re;
      imag[k] = -(2 / N) * im;
    }
    real[0] = 0; imag[0] = 0; // zero DC offset

    const pw = this._ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    this._waveOsc.setPeriodicWave(pw);

    const g = Math.max(0, Math.min(amplitude, 1)) * this._maxGain;
    this._waveGain.gain.setTargetAtTime(g, this._ctx.currentTime, 0.06);
  }
}
