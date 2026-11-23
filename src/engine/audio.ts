import type { MaterialClass, SingularityType } from './constants'

/**
 * "Destruction Orchestra": every sound is synthesised with Web Audio, no samples.
 *
 * Graph:   voice gain(s) ─┐
 *          drone gain  ───┼─► master gain ─► DynamicsCompressor ─► destination
 *
 * - The AudioContext is created on the first user interaction (autoplay policy)
 *   and resumed whenever it is found suspended.
 * - At most MAX_VOICES transient voices play at once; a new sound steals the
 *   least-recently-started voice (LRU) with a 10 ms fade.
 * - Every transient source node binds `onended = () => node.disconnect()`, and
 *   the voice's own gain / filter nodes are disconnected when its last source
 *   ends, so heavy collapses never leave dead nodes in the graph.
 * - Without Web Audio (old WebViews, some CI) the manager runs as a stub: it
 *   still records events, so the game and the tests behave the same.
 */

export const MAX_VOICES = 8
const MASTER_LEVEL = 0.85
/** Major pentatonic degrees (semitones) for collision tones. */
const PENTATONIC = [0, 2, 4, 7, 9]
const BASE_FREQ = 130.81 // C3
const MIN_COLLISION_GAP = 0.028 // s between collision voices
const MIN_SLICE_GAP = 0.04
const MIN_SHATTER_GAP = 0.04 // two fractures in one physics step → one burst

type VoiceKind = 'collision' | 'shatter' | 'slice' | 'explosion' | 'tremor' | 'shutter'

interface Voice {
  id: number
  kind: VoiceKind
  gain: GainNode
  nodes: AudioNode[]
  sources: AudioScheduledSourceNode[]
  start: number
  live: number
}

interface Drone {
  type: SingularityType
  gain: GainNode
  nodes: AudioNode[]
  sources: AudioScheduledSourceNode[]
}

export interface AudioStats {
  voicesStarted: number
  voicesStolen: number
  nodesCreated: number
  nodesDisconnected: number
  activeVoices: number
  droneActive: boolean
}

export interface AudioEvent {
  kind: VoiceKind | 'drone' | 'drone-stop' | 'freeze' | 'mute'
  /** Main parameter of the event (intensity, size, hop, …). */
  value: number
  /** Whether a sound was actually produced (false when muted, frozen, stubbed or suspended). */
  voiced: boolean
  /** Fundamental frequency used, if any. */
  freq?: number
}

type AudioContextCtor = typeof AudioContext

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

export class AudioManager {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  private noise: AudioBuffer | null = null
  private voices: Voice[] = []
  private drone: Drone | null = null
  /** The singularity drone the game wants; restarted after freeze / unmute. */
  private wantedDrone: SingularityType | null = null
  private nextVoiceId = 1
  private lastCollisionAt = -Infinity
  private lastSliceAt = -Infinity
  private lastShatterAt = -Infinity
  private frozen = false
  private _muted: boolean
  private _stub = false
  readonly stats: AudioStats = {
    voicesStarted: 0,
    voicesStolen: 0,
    nodesCreated: 0,
    nodesDisconnected: 0,
    activeVoices: 0,
    droneActive: false,
  }
  /** Recent events (diagnostics and tests). */
  readonly log: AudioEvent[] = []

  constructor(muted = false) {
    this._muted = muted
    this._stub = audioContextCtor() === null
  }

  get muted(): boolean {
    return this._muted
  }

  /** True when Web Audio is unavailable and sounds are only logged. */
  get stub(): boolean {
    return this._stub
  }

  get state(): AudioContextState | 'uncreated' | 'stub' {
    if (this._stub) return 'stub'
    return this.ctx?.state ?? 'uncreated'
  }

  get masterLevel(): number {
    return this.master?.gain.value ?? 0
  }

  /** Whether the master bus runs through the anti-clipping compressor. */
  get hasCompressor(): boolean {
    return this.compressor !== null
  }

  /** Call from a user gesture: creates the context on first use, resumes it if suspended. */
  unlock(): void {
    if (this._stub) return
    if (!this.ctx) {
      const Ctor = audioContextCtor()
      if (!Ctor) {
        this._stub = true
        return
      }
      try {
        const ctx = new Ctor({ latencyHint: 'interactive' })
        const compressor = ctx.createDynamicsCompressor()
        compressor.threshold.value = -16
        compressor.knee.value = 10
        compressor.ratio.value = 6
        compressor.attack.value = 0.003
        compressor.release.value = 0.18
        const master = ctx.createGain()
        master.gain.value = this._muted ? 0 : MASTER_LEVEL
        master.connect(compressor)
        compressor.connect(ctx.destination)
        // One second of white noise, reused by every noise burst.
        const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
        const data = noise.getChannelData(0)
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
        this.ctx = ctx
        this.master = master
        this.compressor = compressor
        this.noise = noise
        ctx.addEventListener('statechange', () => {
          if (ctx.state === 'running') this.syncDrone()
        })
      } catch {
        this._stub = true
        return
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined)
  }

  setMuted(muted: boolean): void {
    this._muted = muted
    this.record({ kind: 'mute', value: muted ? 1 : 0, voiced: false })
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const now = ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    if (muted) {
      this.master.gain.setValueAtTime(0, now)
      this.silenceVoices()
      this.stopDrone(true)
    } else {
      this.master.gain.setValueAtTime(0, now)
      this.master.gain.linearRampToValueAtTime(MASTER_LEVEL, now + 0.08)
      this.syncDrone()
    }
  }

  /** Physics freeze: cut collision / singularity voices immediately; restart the drone on thaw. */
  freeze(frozen: boolean): void {
    this.frozen = frozen
    this.record({ kind: 'freeze', value: frozen ? 1 : 0, voiced: false })
    if (frozen) {
      this.silenceVoices()
      this.stopDrone(true)
    } else {
      this.syncDrone()
    }
  }

  // -------------------------------------------------------------------------
  // Sounds
  // -------------------------------------------------------------------------

  /**
   * An impact. `momentum` = mass × relative velocity (N·s) drives loudness,
   * pitch and brightness: heavy hits are low resonant thuds, light hits crisp
   * ticks, all tuned to a pentatonic scale so piles sound musical, not noisy.
   */
  collision(momentum: number, mass: number, material: MaterialClass): void {
    if (momentum < 0.5) return
    const ctx = this.ctx
    const now = ctx?.currentTime ?? performance.now() / 1000
    if (now - this.lastCollisionAt < MIN_COLLISION_GAP) return
    this.lastCollisionAt = now

    const k = Math.min(1, Math.log1p(momentum) / Math.log1p(40))
    const heaviness = Math.min(1, mass / 1.2)
    const octave = heaviness > 0.7 ? 0 : heaviness > 0.35 ? 1 : 2
    const degree = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)]
    const materialShift = material === 'sphere' ? 4 : material === 'cylinder' ? 7 : material === 'nitro' ? -5 : 0
    const freq = BASE_FREQ * Math.pow(2, octave + (degree + materialShift) / 12)
    const v = this.voice('collision')
    this.record({ kind: 'collision', value: momentum, voiced: !!v, freq })
    if (!v || !ctx) return

    const t = ctx.currentTime
    const vol = 0.05 + 0.5 * k
    const heavy = heaviness > 0.5 && k > 0.45
    const decay = heavy ? 0.32 + 0.25 * k : 0.07 + 0.08 * k

    // Tone: triangle for ticks, sine with a pitch drop for thuds.
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 500 + 4200 * k * (1 - heaviness * 0.6)
    filter.Q.value = heavy ? 4 : 1
    filter.connect(v.gain)
    v.nodes.push(filter)
    const osc = ctx.createOscillator()
    osc.type = heavy ? 'sine' : 'triangle'
    osc.frequency.setValueAtTime(heavy ? freq * 0.5 * 1.6 : freq, t)
    osc.frequency.exponentialRampToValueAtTime(heavy ? freq * 0.5 : freq * 0.98, t + 0.06)
    osc.connect(filter)
    this.source(v, osc, t, t + decay + 0.05)

    // Contact transient: a short noise click (light) or thump (heavy).
    const ng = ctx.createGain()
    const nf = ctx.createBiquadFilter()
    nf.type = heavy ? 'lowpass' : 'highpass'
    nf.frequency.value = heavy ? 260 : 2800
    ng.gain.setValueAtTime(vol * (heavy ? 0.9 : 0.5), t)
    ng.gain.exponentialRampToValueAtTime(0.0008, t + (heavy ? 0.12 : 0.025))
    nf.connect(ng)
    ng.connect(v.gain)
    v.nodes.push(nf, ng)
    this.source(v, this.noiseSource(nf), t, t + (heavy ? 0.14 : 0.04))

    v.gain.gain.setValueAtTime(vol, t)
    v.gain.gain.exponentialRampToValueAtTime(0.0008, t + decay)
  }

  /** Crystalline burst at the moment of fracture: inharmonic high partials + sparkle noise. */
  shatter(size: number): void {
    const ctx = this.ctx
    const now = ctx?.currentTime ?? performance.now() / 1000
    if (now - this.lastShatterAt < MIN_SHATTER_GAP) return
    this.lastShatterAt = now
    const v = this.voice('shatter')
    this.record({ kind: 'shatter', value: size, voiced: !!v, freq: 2400 })
    if (!v || !ctx) return
    const t = ctx.currentTime
    const vol = 0.25 + 0.25 * Math.min(1, size)
    v.gain.gain.setValueAtTime(vol, t)
    v.gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.6)
    const partials = [2350, 3130, 4170, 5480]
    partials.forEach((f, i) => {
      const g = ctx.createGain()
      const start = t + i * 0.012 + Math.random() * 0.02
      g.gain.setValueAtTime(0.5 / (i + 1), start)
      g.gain.exponentialRampToValueAtTime(0.0008, start + 0.18 + Math.random() * 0.25)
      g.connect(v.gain)
      v.nodes.push(g)
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f * (0.92 + Math.random() * 0.16)
      osc.connect(g)
      this.source(v, osc, start, start + 0.5)
    })
    const hf = ctx.createBiquadFilter()
    hf.type = 'highpass'
    hf.frequency.value = 3800
    const hg = ctx.createGain()
    hg.gain.setValueAtTime(0.35, t)
    hg.gain.exponentialRampToValueAtTime(0.0008, t + 0.09)
    hf.connect(hg)
    hg.connect(v.gain)
    v.nodes.push(hf, hg)
    this.source(v, this.noiseSource(hf), t, t + 0.1)
  }

  /** Laser cut: a fast downward sine sweep plus a short knife hiss. */
  slice(): void {
    const ctx = this.ctx
    const now = ctx?.currentTime ?? performance.now() / 1000
    if (now - this.lastSliceAt < MIN_SLICE_GAP) return
    this.lastSliceAt = now
    const v = this.voice('slice')
    this.record({ kind: 'slice', value: 1, voiced: !!v, freq: 1500 })
    if (!v || !ctx) return
    const t = ctx.currentTime
    v.gain.gain.setValueAtTime(0.32, t)
    v.gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.22)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1500, t)
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.18)
    osc.connect(v.gain)
    this.source(v, osc, t, t + 0.22)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.setValueAtTime(6500, t)
    bp.frequency.exponentialRampToValueAtTime(3000, t + 0.12)
    bp.Q.value = 1.2
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.6, t)
    ng.gain.exponentialRampToValueAtTime(0.0008, t + 0.12)
    bp.connect(ng)
    ng.connect(v.gain)
    v.nodes.push(bp, ng)
    this.source(v, this.noiseSource(bp), t, t + 0.13)
  }

  /** Nitro: sub-bass boom + filtered noise burst. Each chain hop is pitched a little higher. */
  explosion(hop: number): void {
    const ctx = this.ctx
    const pitch = Math.pow(1.07, Math.min(hop, 12))
    const v = this.voice('explosion')
    this.record({ kind: 'explosion', value: hop, voiced: !!v, freq: 78 * pitch })
    if (!v || !ctx) return
    const t = ctx.currentTime
    v.gain.gain.setValueAtTime(1, t)
    v.gain.gain.exponentialRampToValueAtTime(0.0008, t + 1.1)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(78 * pitch, t)
    osc.frequency.exponentialRampToValueAtTime(28 * pitch, t + 0.8)
    const og = ctx.createGain()
    og.gain.setValueAtTime(1, t)
    og.gain.exponentialRampToValueAtTime(0.0008, t + 0.9)
    osc.connect(og)
    og.connect(v.gain)
    v.nodes.push(og)
    this.source(v, osc, t, t + 0.95)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(2400 * pitch, t)
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.7)
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.9, t)
    ng.gain.exponentialRampToValueAtTime(0.0008, t + 0.8)
    lp.connect(ng)
    ng.connect(v.gain)
    v.nodes.push(lp, ng)
    this.source(v, this.noiseSource(lp), t, t + 0.85)
  }

  /** Earthquake: a low rumble that escalates, then settles. */
  tremor(duration: number): void {
    const ctx = this.ctx
    const v = this.voice('tremor')
    this.record({ kind: 'tremor', value: duration, voiced: !!v, freq: 38 })
    if (!v || !ctx) return
    const t = ctx.currentTime
    const end = t + duration + 0.35
    v.gain.gain.setValueAtTime(0.0008, t)
    v.gain.gain.exponentialRampToValueAtTime(0.9, t + duration * 0.8)
    v.gain.gain.exponentialRampToValueAtTime(0.0008, end)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(90, t)
    lp.frequency.linearRampToValueAtTime(240, t + duration * 0.8)
    lp.Q.value = 3
    lp.connect(v.gain)
    v.nodes.push(lp)
    this.source(v, this.noiseSource(lp, true), t, end)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(34, t)
    osc.frequency.linearRampToValueAtTime(48, t + duration)
    const og = ctx.createGain()
    og.gain.value = 0.7
    osc.connect(og)
    og.connect(v.gain)
    v.nodes.push(og)
    this.source(v, osc, t, end)
  }

  /** Camera shutter click for photo mode. */
  shutter(): void {
    const ctx = this.ctx
    const v = this.voice('shutter')
    this.record({ kind: 'shutter', value: 1, voiced: !!v })
    if (!v || !ctx) return
    const t = ctx.currentTime
    v.gain.gain.setValueAtTime(0.4, t)
    v.gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.09)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 2000
    hp.connect(v.gain)
    v.nodes.push(hp)
    this.source(v, this.noiseSource(hp), t, t + 0.03)
    this.source(v, this.noiseSource(hp), t + 0.055, t + 0.08)
  }

  /** Continuous singularity drone (or null to fade it out). */
  singularity(type: SingularityType | null): void {
    this.wantedDrone = type
    this.syncDrone()
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private record(e: AudioEvent): void {
    this.log.push(e)
    if (this.log.length > 80) this.log.shift()
  }

  private canPlay(): boolean {
    return !!this.ctx && !!this.master && this.ctx.state === 'running' && !this._muted
  }

  /** Allocate a voice, stealing the least-recently-started one when all 8 are busy. */
  private voice(kind: VoiceKind): Voice | null {
    if (!this.canPlay()) return null
    if (this.frozen && kind !== 'shutter') return null
    const ctx = this.ctx!
    while (this.voices.length >= MAX_VOICES) {
      let oldest = this.voices[0]
      for (const v of this.voices) if (v.start < oldest.start) oldest = v
      this.kill(oldest, 0.01)
      this.stats.voicesStolen++
    }
    const gain = ctx.createGain()
    gain.connect(this.master!)
    const v: Voice = { id: this.nextVoiceId++, kind, gain, nodes: [gain], sources: [], start: ctx.currentTime, live: 0 }
    this.voices.push(v)
    this.stats.voicesStarted++
    this.stats.activeVoices = this.voices.length
    return v
  }

  private source<T extends AudioScheduledSourceNode>(v: Voice, node: T, start: number, stop: number): T {
    v.sources.push(node)
    v.live++
    this.stats.nodesCreated++
    node.onended = () => {
      node.disconnect()
      this.stats.nodesDisconnected++
      v.live--
      if (v.live <= 0) this.release(v)
    }
    node.start(start)
    node.stop(stop)
    return node
  }

  private noiseSource(dest: AudioNode, loop = false): AudioBufferSourceNode {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = loop
    src.connect(dest)
    return src
  }

  /** Voice finished: detach its remaining nodes from the graph. */
  private release(v: Voice): void {
    const i = this.voices.indexOf(v)
    if (i >= 0) this.voices.splice(i, 1)
    for (const n of v.nodes) n.disconnect()
    v.nodes.length = 0
    this.stats.activeVoices = this.voices.length
  }

  /** Fade a voice out over `fade` seconds and stop its sources (onended cleans up). */
  private kill(v: Voice, fade: number): void {
    const ctx = this.ctx
    const i = this.voices.indexOf(v)
    if (i >= 0) this.voices.splice(i, 1)
    this.stats.activeVoices = this.voices.length
    if (!ctx) return
    const now = ctx.currentTime
    v.gain.gain.cancelScheduledValues(now)
    if (fade <= 0) v.gain.gain.setValueAtTime(0, now)
    else v.gain.gain.setTargetAtTime(0, now, fade / 3)
    for (const s of v.sources) {
      try {
        s.stop(now + Math.max(0.02, fade))
      } catch {
        /* already stopped */
      }
    }
  }

  private silenceVoices(): void {
    for (const v of [...this.voices]) this.kill(v, 0)
  }

  private syncDrone(): void {
    const want = this.frozen || this._muted ? null : this.wantedDrone
    if (this.drone && this.drone.type === want) return
    if (this.drone) this.stopDrone(false)
    if (!want) return
    if (!this.canPlay()) return
    this.startDrone(want)
  }

  private startDrone(type: SingularityType): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(type === 'blackhole' ? 0.55 : 0.3, t + 0.5)
    gain.connect(this.master!)
    const drone: Drone = { type, gain, nodes: [gain], sources: [] }
    const add = <T extends AudioScheduledSourceNode>(node: T): T => {
      drone.sources.push(node)
      this.stats.nodesCreated++
      node.onended = () => {
        node.disconnect()
        this.stats.nodesDisconnected++
      }
      node.start(t)
      return node
    }

    if (type === 'blackhole') {
      // Filtered low rumble: detuned saws + noise under a slowly breathing lowpass.
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 150
      lp.Q.value = 5
      lp.connect(gain)
      drone.nodes.push(lp)
      for (const f of [41, 43.6]) {
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        o.frequency.value = f
        o.connect(lp)
        add(o)
      }
      const ng = ctx.createGain()
      ng.gain.value = 0.6
      ng.connect(lp)
      drone.nodes.push(ng)
      add(this.noiseSource(ng, true))
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 0.3
      const depth = ctx.createGain()
      depth.gain.value = 70
      lfo.connect(depth)
      depth.connect(lp.frequency)
      drone.nodes.push(depth)
      add(lfo)
    } else {
      // Pulsating high-harmonic hum, throbbing with the repulsor's shockwaves.
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 280
      const amp = ctx.createGain()
      amp.gain.value = 0.5
      hp.connect(amp)
      amp.connect(gain)
      drone.nodes.push(hp, amp)
      ;[220, 330, 440, 660, 990].forEach((f, i) => {
        const o = ctx.createOscillator()
        o.type = i % 2 ? 'triangle' : 'sine'
        o.frequency.value = f
        const g = ctx.createGain()
        g.gain.value = 0.35 / (i + 1)
        o.connect(g)
        g.connect(hp)
        drone.nodes.push(g)
        add(o)
      })
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 1 / 1.3
      const depth = ctx.createGain()
      depth.gain.value = 0.45
      lfo.connect(depth)
      depth.connect(amp.gain)
      drone.nodes.push(depth)
      add(lfo)
    }
    this.drone = drone
    this.stats.droneActive = true
    this.record({ kind: 'drone', value: type === 'blackhole' ? 1 : 2, voiced: true })
  }

  /** Fade the drone out (or cut it instantly) and tear it down. */
  private stopDrone(immediate: boolean): void {
    const drone = this.drone
    if (!drone) return
    this.drone = null
    this.stats.droneActive = false
    this.record({ kind: 'drone-stop', value: immediate ? 1 : 0, voiced: false })
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    drone.gain.gain.cancelScheduledValues(now)
    if (immediate) drone.gain.gain.setValueAtTime(0, now)
    else drone.gain.gain.setTargetAtTime(0, now, 0.08)
    const stopAt = now + (immediate ? 0.02 : 0.45)
    for (const s of drone.sources) {
      try {
        s.stop(stopAt)
      } catch {
        /* already stopped */
      }
    }
    // Detach the filters / gains once the sources have finished.
    window.setTimeout(() => {
      for (const n of drone.nodes) n.disconnect()
    }, (stopAt - now) * 1000 + 120)
  }
}
