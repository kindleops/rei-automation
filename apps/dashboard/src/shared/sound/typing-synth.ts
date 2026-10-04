/**
 * TYPING SYNTH — keystrokes rendered offline into sample buffers.
 *
 * Every material is built from the same three physical parts, voiced
 * differently: the CONTACT (a filtered noise transient: the cap meeting the
 * switch), the BODY (damped resonances: what the key is made of) and the
 * BOTTOM (a low damped knock: the plate it lands on). Mechanical adds the
 * key-return click; Glass rings inharmonic partials; Press is one crisp
 * premium switch; Bubble is a pitched, soft blip.
 *
 * Pure functions over Float32Array — no Web Audio here, so it is testable and
 * the engine can render the whole pool once and play buffers with zero
 * synthesis work on the keystroke path.
 */

export type TypingMaterial = 'mech' | 'default' | 'press' | 'bubble'
export type TypingKey = 'printable' | 'space' | 'delete' | 'enter'

export const TYPING_MATERIALS: readonly TypingMaterial[] = ['mech', 'default', 'press', 'bubble']
export const TYPING_KEYS: readonly TypingKey[] = ['printable', 'space', 'delete', 'enter']
/** distinct renders per key; playback also jitters pitch and level */
export const TYPING_VARIANTS = 4

/** seeded PRNG (mulberry32) — renders are deterministic per variant */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** RBJ biquad, applied in place */
function biquad(buf: Float32Array, sr: number, type: 'bandpass' | 'highpass' | 'lowpass', freq: number, q: number) {
  const w = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  let b0: number, b1: number, b2: number
  if (type === 'bandpass') { b0 = alpha; b1 = 0; b2 = -alpha }
  else if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2 }
  else { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2 }
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x; y2 = y1; y1 = y
    buf[i] = y
  }
}

interface Contact { at: number; amp: number; dur: number; filter: 'bandpass' | 'highpass'; freq: number; q: number }
interface Mode { at: number; amp: number; freq: number; tau: number; glideTo?: number; attack?: number }

function addContact(out: Float32Array, sr: number, c: Contact, rand: () => number) {
  const n = Math.max(1, Math.floor(c.dur * sr))
  const tmp = new Float32Array(n + Math.floor(0.004 * sr))
  for (let i = 0; i < n; i++) tmp[i] = (2 * rand() - 1) * Math.exp((-5 * i) / n)
  biquad(tmp, sr, c.filter, c.freq, c.q)
  const start = Math.floor(c.at * sr)
  for (let i = 0; i < tmp.length && start + i < out.length; i++) out[start + i] += tmp[i] * c.amp
}

function addMode(out: Float32Array, sr: number, m: Mode) {
  const start = Math.floor(m.at * sr)
  const attack = Math.max(1, Math.floor((m.attack ?? 0.0006) * sr))
  let phase = 0
  for (let i = 0; start + i < out.length; i++) {
    const t = i / sr
    const env = Math.exp(-t / m.tau) * Math.min(1, i / attack)
    if (env < 1e-4 && i > attack) break
    const f = m.glideTo ? m.freq * Math.pow(m.glideTo / m.freq, Math.min(1, t / (m.tau * 2))) : m.freq
    phase += (2 * Math.PI * f) / sr
    out[start + i] += Math.sin(phase) * env * m.amp
  }
}

interface Voice { length: number; contacts: Contact[]; modes: Mode[]; peak: number }

/** jitter a value by ±spread (fraction) */
const j = (rand: () => number, v: number, spread: number) => v * (1 + (rand() * 2 - 1) * spread)

/** The voicing table: what each material sounds like for each key. */
function voice(material: TypingMaterial, key: TypingKey, rand: () => number): Voice {
  const r = (v: number, s = 0.06) => j(rand, v, s)
  switch (material) {
    case 'mech': {
      // dry, precise: a bright contact, a short plastic body, a felt plate, then the key-return click
      const body = { printable: 1900, space: 1150, delete: 1600, enter: 1350 }[key]
      const bottom = { printable: 190, space: 125, delete: 170, enter: 105 }[key]
      const contacts: Contact[] = [
        { at: 0, amp: 1, dur: 0.0025, filter: 'bandpass', freq: r(4600, 0.1), q: 1.6 },
        { at: r(key === 'enter' ? 0.075 : 0.05, 0.15), amp: 0.32, dur: 0.0016, filter: 'bandpass', freq: r(5200, 0.1), q: 2 },
      ]
      if (key === 'space' || key === 'enter') contacts.push({ at: r(0.004, 0.2), amp: 0.45, dur: 0.002, filter: 'bandpass', freq: r(3200), q: 1.4 }) // stabiliser rattle
      return {
        length: key === 'enter' ? 0.14 : 0.1,
        contacts,
        modes: [
          { at: 0.0008, amp: 0.42, freq: r(body), tau: r(0.006, 0.15) },
          { at: 0.0015, amp: key === 'space' || key === 'enter' ? 0.7 : 0.45, freq: r(bottom), tau: r(key === 'enter' ? 0.02 : 0.012, 0.15) },
        ],
        peak: { printable: 0.5, space: 0.58, delete: 0.44, enter: 0.66 }[key],
      }
    }
    case 'default': {
      // glass: a soft tick, then inharmonic partials that ring briefly
      const f = { printable: 2650, space: 1720, delete: 2150, enter: 1320 }[key]
      const tau = { printable: 0.018, space: 0.026, delete: 0.014, enter: 0.06 }[key]
      const modes: Mode[] = [
        { at: 0.0005, amp: 0.55, freq: r(f, 0.04), tau: r(tau, 0.12), glideTo: key === 'delete' ? f * 0.94 : undefined },
        { at: 0.0005, amp: 0.22, freq: r(f * 2.76, 0.03), tau: r(tau * 0.5, 0.12) },
        { at: 0.0005, amp: 0.08, freq: r(f * 5.4, 0.03), tau: r(tau * 0.28, 0.12) },
      ]
      if (key === 'enter') modes.push({ at: 0.0005, amp: 0.3, freq: r(f * 1.5, 0.01), tau: r(0.05, 0.1) })
      return {
        length: key === 'enter' ? 0.22 : 0.12,
        contacts: [{ at: 0, amp: 0.5, dur: 0.0012, filter: 'highpass', freq: r(6500), q: 0.7 }],
        modes,
        peak: { printable: 0.42, space: 0.48, delete: 0.38, enter: 0.55 }[key],
      }
    }
    case 'press': {
      // one premium switch: a very crisp click over the knock of what it moves
      const knock = { printable: 460, space: 300, delete: 380, enter: 230 }[key]
      const contacts: Contact[] = [{ at: 0, amp: 1, dur: 0.0009, filter: 'highpass', freq: r(5800, 0.08), q: 0.8 }]
      if (key === 'enter') contacts.push({ at: r(0.018, 0.1), amp: 0.6, dur: 0.0009, filter: 'highpass', freq: r(5200), q: 0.8 })
      return {
        length: key === 'enter' ? 0.11 : 0.07,
        contacts,
        modes: [
          { at: 0.0004, amp: 0.65, freq: r(knock), tau: r(key === 'space' ? 0.011 : 0.008, 0.12) },
          { at: 0.0004, amp: 0.15, freq: r(knock * 3.1), tau: r(0.003, 0.12) },
        ],
        peak: { printable: 0.5, space: 0.56, delete: 0.46, enter: 0.62 }[key],
      }
    }
    case 'bubble': {
      // soft, pitched blips — rising for keys, falling for delete, two notes for return
      const [from, to] = { printable: [620, 900], space: [430, 610], delete: [760, 500], enter: [520, 780] }[key]
      const modes: Mode[] = [{ at: 0, amp: 0.7, freq: r(from, 0.05), glideTo: r(to, 0.05), tau: r(0.014, 0.12), attack: 0.002 }]
      if (key === 'enter') modes.push({ at: 0.045, amp: 0.55, freq: r(to, 0.03), glideTo: r(to * 1.33, 0.03), tau: 0.02, attack: 0.002 })
      return {
        length: key === 'enter' ? 0.14 : 0.08,
        contacts: [{ at: 0, amp: 0.12, dur: 0.001, filter: 'bandpass', freq: 2400, q: 1 }],
        modes,
        peak: { printable: 0.4, space: 0.45, delete: 0.38, enter: 0.5 }[key],
      }
    }
  }
}

/** Render one keystroke variant. Level-matched: every buffer peaks at its key's target. */
export function renderKeystroke(material: TypingMaterial, key: TypingKey, variant: number, sampleRate: number): Float32Array {
  const seed = (TYPING_MATERIALS.indexOf(material) + 1) * 7919 + (TYPING_KEYS.indexOf(key) + 1) * 104729 + variant * 15485863
  const rand = rng(seed)
  const v = voice(material, key, rand)
  const out = new Float32Array(Math.ceil(v.length * sampleRate))
  for (const c of v.contacts) addContact(out, sampleRate, c, rand)
  for (const m of v.modes) addMode(out, sampleRate, m)
  let max = 0
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]))
  const scale = max > 0 ? v.peak / max : 0
  // short fade so a buffer never ends on a click
  const fade = Math.floor(0.004 * sampleRate)
  for (let i = 0; i < out.length; i++) {
    const tail = out.length - i
    out[i] *= scale * (tail < fade ? tail / fade : 1)
  }
  return out
}
