/**
 * LEADCOMMAND COLOUR CORE — perceptual colour math, no DOM, no React.
 *
 * Every appearance decision (accent derivation, contrast correction, palette
 * harmony, chart colours) runs here in OKLCH: lightness moves the way the eye
 * reads it, chroma is "how much colour", hue stays put when lightness moves.
 * Operators never see these values; they pick a colour, LeadCommand does the
 * maths. Hex stays the stored / user-facing representation.
 *
 * Gamut: OKLCH can describe colours a screen cannot show. `oklchToRgb`
 * reduces chroma (never lightness, never hue) until the colour fits sRGB,
 * so a corrected accent keeps its identity.
 */

export interface RGB { r: number; g: number; b: number }
export interface OKLCH { l: number; c: number; h: number }
export interface HSV { h: number; s: number; v: number }
export interface HSL { h: number; s: number; l: number }

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const round = (v: number) => Math.round(clamp(v, 0, 255))
const normHue = (h: number) => ((h % 360) + 360) % 360

/* ── sRGB transfer ─────────────────────────────────────────────────────── */

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/* ── OKLab (Björn Ottosson) ────────────────────────────────────────────── */

export function rgbToOklab({ r, g, b }: RGB): [number, number, number] {
  const lr = toLinear(r / 255), lg = toLinear(g / 255), lb = toLinear(b / 255)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

export function rgbToOklch(rgb: RGB): OKLCH {
  const [l, a, b] = rgbToOklab(rgb)
  const c = Math.hypot(a, b)
  // Achromatic colours have no meaningful hue; 0 keeps them deterministic.
  const h = c < 1e-4 ? 0 : normHue((Math.atan2(b, a) * 180) / Math.PI)
  return { l, c, h }
}

const EPS = 1e-5
const inGamut = (lin: [number, number, number]) => lin.every((v) => v >= -EPS && v <= 1 + EPS)

function lchToLinear({ l, c, h }: OKLCH): [number, number, number] {
  const rad = (h * Math.PI) / 180
  return oklabToLinear(l, c * Math.cos(rad), c * Math.sin(rad))
}

/** The most chroma this lightness + hue can carry on an sRGB screen. */
export function maxChroma(l: number, h: number): number {
  let lo = 0, hi = 0.4
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(lchToLinear({ l, c: mid, h }))) lo = mid
    else hi = mid
  }
  return lo
}

/** OKLCH → sRGB, reducing chroma (not lightness or hue) to fit the gamut. */
export function oklchToRgb(lch: OKLCH): RGB {
  const l = clamp(lch.l, 0, 1)
  let lin = lchToLinear({ l, c: Math.max(0, lch.c), h: lch.h })
  if (!inGamut(lin)) lin = lchToLinear({ l, c: maxChroma(l, lch.h), h: lch.h })
  return {
    r: round(toGamma(clamp(lin[0], 0, 1)) * 255),
    g: round(toGamma(clamp(lin[1], 0, 1)) * 255),
    b: round(toGamma(clamp(lin[2], 0, 1)) * 255),
  }
}

/* ── formats ───────────────────────────────────────────────────────────── */

const hex2 = (v: number) => round(v).toString(16).padStart(2, '0')
export const toHex = ({ r, g, b }: RGB) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase()
/** "r, g, b" — the comma triplet the existing --*-rgb tokens use. */
export const toTriplet = ({ r, g, b }: RGB) => `${round(r)}, ${round(g)}, ${round(b)}`
/** "r g b" — the space triplet --lg-fill / --dsk-fill use. */
export const toSpaceTriplet = ({ r, g, b }: RGB) => `${round(r)} ${round(g)} ${round(b)}`
export const toRgba = ({ r, g, b }: RGB, a: number) => `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${Number(clamp(a, 0, 1).toFixed(3))})`
export const toRgbCss = ({ r, g, b }: RGB) => `rgb(${round(r)}, ${round(g)}, ${round(b)})`
export const sameRgb = (a: RGB, b: RGB) => round(a.r) === round(b.r) && round(a.g) === round(b.g) && round(a.b) === round(b.b)

/* ── parsing: what an operator might paste ─────────────────────────────── */

const num = (s: string, scale: number) => (s.endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s))

/**
 * Accepts #22D3EE · 22D3EE · #2de · rgb(34, 211, 238) · rgb(34 211 238 / 50%)
 * · rgba(…) · hsl(188 86% 53%) · oklch(0.82 0.13 210) · "34, 211, 238".
 * Alpha is ignored (an accent is opaque). Anything else is null — never a guess.
 */
export function parseColor(input: unknown): RGB | null {
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase()
  if (!s || s.length > 64) return null

  const hex = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = h.slice(0, 3).split('').map((c) => c + c).join('')
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }

  const fn = s.match(/^(rgba?|hsla?|oklch)\((.*)\)$/)
  const body = fn ? fn[2] : /^[\d.\s,%]+$/.test(s) ? s : null
  if (body === null) return null
  const parts = body.split('/')[0].trim().split(/[\s,]+/).filter(Boolean)
  if (parts.length < 3) return null
  const kind = fn ? fn[1] : 'rgb'
  const valid = (v: number) => Number.isFinite(v)

  if (kind.startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255))
    if (![r, g, b].every(valid) || [r, g, b].some((v) => v < 0 || v > 255)) return null
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b) }
  }
  if (kind.startsWith('hsl')) {
    const h = parseFloat(parts[0])
    const sat = parseFloat(parts[1]) / (parts[1].endsWith('%') || parseFloat(parts[1]) > 1 ? 100 : 1)
    const lig = parseFloat(parts[2]) / (parts[2].endsWith('%') || parseFloat(parts[2]) > 1 ? 100 : 1)
    if (![h, sat, lig].every(valid) || sat < 0 || sat > 1 || lig < 0 || lig > 1) return null
    return hslToRgb({ h, s: sat, l: lig })
  }
  // oklch(L C H): L as 0–1 or a percentage
  const l = parts[0].endsWith('%') ? parseFloat(parts[0]) / 100 : parseFloat(parts[0])
  const c = parseFloat(parts[1])
  const h = parseFloat(parts[2])
  if (![l, c, h].every(valid) || l < 0 || l > 1 || c < 0 || c > 0.5) return null
  return oklchToRgb({ l, c, h })
}

/** Canonical stored form: #RRGGBB, or null when the input is not a colour. */
export function normalizeHex(input: unknown): string | null {
  const rgb = parseColor(input)
  return rgb ? toHex(rgb) : null
}

/* ── HSV / HSL for the picker surface and the Advanced readout ─────────── */

export function rgbToHsv({ r, g, b }: RGB): HSV {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min
  let h = 0
  if (d > 0) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return { h: normHue(h * 60), s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const H = normHue(h) / 60, C = v * s, X = C * (1 - Math.abs((H % 2) - 1)), m = v - C
  const [r, g, b] = H < 1 ? [C, X, 0] : H < 2 ? [X, C, 0] : H < 3 ? [0, C, X] : H < 4 ? [0, X, C] : H < 5 ? [X, 0, C] : [C, 0, X]
  return { r: round((r + m) * 255), g: round((g + m) * 255), b: round((b + m) * 255) }
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return { h: normHue(h * 60), s, l }
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const C = (1 - Math.abs(2 * l - 1)) * s
  const H = normHue(h) / 60, X = C * (1 - Math.abs((H % 2) - 1)), m = l - C / 2
  const [r, g, b] = H < 1 ? [C, X, 0] : H < 2 ? [X, C, 0] : H < 3 ? [0, C, X] : H < 4 ? [0, X, C] : H < 5 ? [X, 0, C] : [C, 0, X]
  return { r: round((r + m) * 255), g: round((g + m) * 255), b: round((b + m) * 255) }
}

/* ── contrast (WCAG 2.x relative luminance) ────────────────────────────── */

export function luminance({ r, g, b }: RGB): number {
  return 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255)
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** A colour at `alpha` composited over an opaque background (as the browser does, in sRGB). */
export function over(fg: RGB, alpha: number, bg: RGB): RGB {
  const a = clamp(alpha, 0, 1)
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) }
}

/** Perceptual distance (ΔE in OKLab, ~0.02 = just noticeable). */
export function deltaE(a: RGB, b: RGB): number {
  const [l1, a1, b1] = rgbToOklab(a)
  const [l2, a2, b2] = rgbToOklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/** Shortest angular distance between two hues, 0–180. */
export const hueDistance = (a: number, b: number) => {
  const d = Math.abs(normHue(a) - normHue(b))
  return d > 180 ? 360 - d : d
}

/** Rotate hue `from` toward `to` by `amount` degrees along the short way (never past it). */
export function rotateToward(from: number, to: number, amount: number): number {
  const diff = ((normHue(to) - normHue(from) + 540) % 360) - 180
  const step = Math.sign(diff) * Math.min(Math.abs(diff), Math.abs(amount))
  return normHue(from + step)
}

export const hue = normHue

/**
 * Move lightness (only) until `ok` holds, searching toward `dir` (+1 lighter,
 * −1 darker). Contrast against a fixed colour is monotonic along one
 * direction, so a bisection finds the smallest change that satisfies it —
 * the corrected colour stays as close to the operator's choice as possible.
 */
export function solveLightness(start: OKLCH, ok: (rgb: RGB) => boolean, dir: 1 | -1): { lch: OKLCH; rgb: RGB; moved: number } {
  const at = (l: number) => oklchToRgb({ ...start, l })
  const first = at(start.l)
  if (ok(first)) return { lch: start, rgb: first, moved: 0 }
  const bound = dir > 0 ? 0.995 : 0.02
  if (!ok(at(bound))) return { lch: { ...start, l: bound }, rgb: at(bound), moved: Math.abs(bound - start.l) }
  let bad = start.l, good = bound
  for (let i = 0; i < 24; i++) {
    const mid = (bad + good) / 2
    if (ok(at(mid))) good = mid
    else bad = mid
  }
  return { lch: { ...start, l: good }, rgb: at(good), moved: Math.abs(good - start.l) }
}
