/**
 * LEADCOMMAND COLOUR INTELLIGENCE — one colour in, a whole system out.
 *
 * The operator controls mood (accent, environment palette, material, motion).
 * LeadCommand controls usability: every derived token is checked against the
 * theme it will sit on, and corrected in lightness (hue kept) until it reads.
 *
 *   deriveAccent       accent → base / hover / pressed / text / soft / border
 *                      / focus / underlight / glow / on-ink, contrast-safe
 *   deriveChart        accent → chart primary + a muted comparison, and a
 *                      STABLE categorical palette that never becomes ten cyans
 *   harmonyPalette     accent → 4 environment anchors (subtle by default)
 *   deriveEnvironment  anchors + composer → the field behind the glass
 *   deriveMaterial     glass preset + advanced values → bounded, readable glass
 *
 * Semantic colours (ok / attn / crit / exec / flow) are product constants per
 * theme and are only READ here — to keep the accent from impersonating them.
 */
import {
  clamp, contrast, deltaE, hue, hueDistance, lerp, maxChroma, oklchToRgb, over, rgbToOklab, rgbToOklch, rotateToward,
  solveLightness, type OKLCH, type RGB,
} from './oklch'

/* ══ foundations: the four luminance models ═════════════════════════════ */

export type FoundationId = 'dark' | 'light' | 'true_black' | 'red_ops'
export const FOUNDATION_IDS: readonly FoundationId[] = ['dark', 'light', 'true_black', 'red_ops']

export interface Semantics { exec: RGB; ok: RGB; attn: RGB; crit: RGB; flow: RGB; neutral: RGB }

export interface Foundation {
  id: FoundationId
  scheme: 'dark' | 'light'
  /** the room behind everything (desktop --dsk-bg) */
  bg: RGB
  /** the theme's own glass fill (desktop --dsk-fill default) */
  fill: RGB
  /** inks (desktop --dsk-ink / -2 / -3) */
  ink: RGB
  ink2: RGB
  ink3: RGB
  /** ink drawn ON a solid accent fill (LC primary buttons use this) */
  inverse: RGB
  /** selection when the accent is reserved (a red accent never paints selection) */
  neutralSelect: RGB
  /** the pane body's own fill opacity before the material multiplier */
  paneAlpha: number
  semantic: Semantics
}

const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b })

const DARK_SEMANTICS: Semantics = {
  exec: rgb(76, 201, 240), ok: rgb(61, 220, 151), attn: rgb(240, 182, 74),
  crit: rgb(255, 91, 108), flow: rgb(167, 139, 250), neutral: rgb(148, 160, 180),
}

export const FOUNDATIONS: Record<FoundationId, Foundation> = {
  dark: {
    id: 'dark', scheme: 'dark', bg: rgb(11, 12, 14), fill: rgb(20, 21, 24),
    ink: rgb(236, 236, 238), ink2: rgb(163, 164, 171), ink3: rgb(111, 112, 120),
    inverse: rgb(5, 8, 13), neutralSelect: rgb(226, 232, 240), paneAlpha: 0.54, semantic: DARK_SEMANTICS,
  },
  light: {
    id: 'light', scheme: 'light', bg: rgb(244, 244, 245), fill: rgb(255, 255, 255),
    ink: rgb(23, 24, 27), ink2: rgb(91, 93, 100), ink3: rgb(138, 140, 147),
    inverse: rgb(255, 255, 255), neutralSelect: rgb(30, 41, 59), paneAlpha: 0.44,
    semantic: {
      exec: rgb(0, 122, 190), ok: rgb(12, 140, 92), attn: rgb(176, 112, 18),
      crit: rgb(214, 40, 62), flow: rgb(112, 80, 230), neutral: rgb(92, 102, 120),
    },
  },
  true_black: {
    id: 'true_black', scheme: 'dark', bg: rgb(0, 0, 0), fill: rgb(0, 0, 0),
    ink: rgb(236, 236, 238), ink2: rgb(163, 164, 171), ink3: rgb(111, 112, 120),
    inverse: rgb(5, 8, 13), neutralSelect: rgb(226, 232, 240), paneAlpha: 0.54, semantic: DARK_SEMANTICS,
  },
  red_ops: {
    id: 'red_ops', scheme: 'dark', bg: rgb(11, 6, 6), fill: rgb(18, 12, 12),
    ink: rgb(236, 236, 238), ink2: rgb(163, 164, 171), ink3: rgb(111, 112, 120),
    inverse: rgb(5, 8, 13), neutralSelect: rgb(226, 232, 240), paneAlpha: 0.54,
    semantic: { ...DARK_SEMANTICS, exec: rgb(125, 211, 252), crit: rgb(255, 59, 59), ok: rgb(74, 222, 128) },
  },
}

/** Every stored theme id resolves to one of the four foundations. */
export function resolveFoundation(themeId: unknown): FoundationId {
  if (themeId === 'light') return 'light'
  if (themeId === 'true_black' || themeId === 'operator-black') return 'true_black'
  if (themeId === 'red_ops' || themeId === 'infrared') return 'red_ops'
  return 'dark'
}

/* ══ accent ═════════════════════════════════════════════════════════════ */

export interface AccentTokens {
  /** the operator's colour, untouched (what the swatch shows) */
  source: RGB
  /** UI accent: fills, indicators, boundaries (≥3:1 on the room, ≥4.5:1 with its on-ink) */
  base: RGB
  hover: RGB
  pressed: RGB
  /** accent as text on the room and on glass (≥4.5:1) */
  text: RGB
  /** ink on a solid `base` fill */
  on: RGB
  /** desaturated accent for quiet emphasis */
  muted: RGB
  /** selection colour — the accent, or a neutral when the accent is reserved */
  select: RGB
  /** focus ring colour (≥3:1 on the room) */
  focus: RGB
  /** alpha levels (already scaled by intensity) */
  softAlpha: number
  borderAlpha: number
  underlightAlpha: number
  glowAlpha: number
  /** 0.45–1.65: intensity as a multiplier other tokens can scale by */
  energy: number
  /** the accent is close enough to failure-red that it may not mean selection */
  reserved: 'crit' | null
  /** lightness had to move noticeably to stay readable */
  adjusted: boolean
}

export const INTENSITY_DEFAULT = 50

/** intensity 0–100 → [chroma multiplier, energy] (50 = the colour exactly as chosen) */
export function intensityFactors(intensity: number): { chroma: number; energy: number } {
  const i = clamp(Number.isFinite(intensity) ? intensity : INTENSITY_DEFAULT, 0, 100)
  return {
    chroma: i < 50 ? lerp(0.42, 1, i / 50) : 1,
    energy: i <= 50 ? lerp(0.45, 1, i / 50) : lerp(1, 1.65, (i - 50) / 50),
  }
}

/** Is this hue + chroma close enough to the theme's failure red to be mistaken for it? */
export function isCritLike(color: RGB, f: Foundation): boolean {
  const a = rgbToOklch(color)
  const crit = rgbToOklch(f.semantic.crit)
  return a.c > 0.085 && hueDistance(a.h, crit.h) < 22
}

export function deriveAccent(f: Foundation, source: RGB, intensity = INTENSITY_DEFAULT): AccentTokens {
  const { chroma, energy } = intensityFactors(intensity)
  const src = rgbToOklch(source)
  const start: OKLCH = { l: src.l, c: src.c * chroma, h: src.h }
  const dir: 1 | -1 = f.scheme === 'dark' ? 1 : -1
  // The room and a pane at its own fill: an accent must read on both.
  const pane = over(f.fill, f.paneAlpha + 0.3, f.bg)

  const baseSolve = solveLightness(start, (c) => contrast(c, f.bg) >= 3 && contrast(c, pane) >= 3 && contrast(c, f.inverse) >= 4.5, dir)
  const base = baseSolve.rgb
  const textSolve = solveLightness(baseSolve.lch, (c) => contrast(c, f.bg) >= 4.6 && contrast(c, pane) >= 4.6, dir)
  const at = (dl: number, cMul = 1) => oklchToRgb({ l: clamp(baseSolve.lch.l + dl, 0.02, 0.99), c: baseSolve.lch.c * cMul, h: start.h })
  const hover = at(0.045 * dir)
  const pressed = at(-0.05 * dir)
  const inkL = rgbToOklch(f.ink2).l
  const muted = oklchToRgb({ l: lerp(baseSolve.lch.l, inkL, 0.35), c: baseSolve.lch.c * 0.38, h: start.h })

  const reserved: 'crit' | null = isCritLike(base, f) ? 'crit' : null
  const select = reserved ? f.neutralSelect : base
  const focus = reserved ? f.neutralSelect : base

  return {
    source,
    base,
    hover,
    pressed,
    text: textSolve.rgb,
    on: f.inverse,
    muted,
    select,
    focus,
    softAlpha: clamp((f.scheme === 'dark' ? 0.14 : 0.12) * energy, 0.05, 0.26),
    borderAlpha: clamp(0.42 * Math.sqrt(energy), 0.26, 0.6),
    underlightAlpha: clamp(0.2 * energy, 0.06, 0.34),
    glowAlpha: clamp(0.1 * energy, 0.04, 0.18),
    energy,
    reserved,
    adjusted: baseSolve.moved > ADJUSTED_THRESHOLD,
  }
}

/** Lightness travel (OKLCH L) beyond which the UI quietly says "Adjusted for contrast". */
export const ADJUSTED_THRESHOLD = 0.1

/**
 * A whisper of the accent in the glass fill ("surface tint"), scaled by the
 * accent's energy. Only the neutral foundations take it: True Black stays
 * black (OLED surfaces never pick up a cast) and Red Ops keeps its own red
 * glass — the accent never repaints a foundation.
 */
export function surfaceTint(f: Foundation, glassFill: RGB, accent: AccentTokens): RGB {
  if (f.id === 'true_black' || f.id === 'red_ops') return glassFill
  const a = rgbToOklch(accent.source)
  if (a.c < 0.02) return glassFill
  const [L, A, B] = rgbToOklab(glassFill)
  const c = Math.min(f.scheme === 'light' ? 0.005 : 0.01, a.c * 0.06 * accent.energy)
  const rad = (a.h * Math.PI) / 180
  const lab: [number, number, number] = [L, A + c * Math.cos(rad), B + c * Math.sin(rad)]
  const chroma = Math.hypot(lab[1], lab[2])
  return oklchToRgb({ l: lab[0], c: chroma, h: chroma < 1e-4 ? 0 : (Math.atan2(lab[2], lab[1]) * 180) / Math.PI })
}

/* ══ charts ═════════════════════════════════════════════════════════════ */

export interface ChartTokens {
  primary: RGB
  secondary: RGB
  neutral: RGB
  positive: RGB
  negative: RGB
  attention: RGB
  /** stable categorical palette, accent first, near-duplicates of the accent removed */
  categorical: RGB[]
}

/** Categorical hues chosen to stay apart (no reds — red means failure). */
const CATEGORICAL_HUES = [215, 285, 345, 252, 182, 55, 315, 120, 150, 78]

const categoricalFor = (f: Foundation): RGB[] =>
  CATEGORICAL_HUES.map((h) => {
    const l = f.scheme === 'dark' ? 0.76 : 0.56
    return oklchToRgb({ l, c: Math.min(0.14, maxChroma(l, h) * 0.92), h })
  })

export function deriveChart(f: Foundation, accent: AccentTokens): ChartTokens {
  const dir: 1 | -1 = f.scheme === 'dark' ? 1 : -1
  const primary = accent.reserved ? f.neutralSelect : accent.base
  const p = rgbToOklch(primary)
  // comparison: the muted complement — present, never louder than the primary
  const compStart: OKLCH = { l: p.l, c: clamp(p.c * 0.45, 0.03, 0.09), h: hue(p.h + 180) }
  const secondary = solveLightness(compStart, (c) => contrast(c, f.bg) >= 3, dir).rgb
  const stable = categoricalFor(f)
  const rest = stable.filter((c) => deltaE(c, primary) > 0.09 && !isCritLike(c, f))
  return {
    primary,
    secondary,
    neutral: f.semantic.neutral,
    positive: f.semantic.ok,
    negative: f.semantic.crit,
    attention: f.semantic.attn,
    categorical: [primary, ...rest].slice(0, 8),
  }
}

/* ══ environment palette ════════════════════════════════════════════════ */

export type HarmonyId = 'analogous' | 'monochrome' | 'complement' | 'deep-aurora' | 'cool-glass'
export const HARMONY_IDS: readonly HarmonyId[] = ['analogous', 'monochrome', 'complement', 'deep-aurora', 'cool-glass']

/**
 * Four anchors around one accent. Chroma is held below the accent's own so
 * the field supports the product instead of competing with it; complements
 * are muted on purpose (no bright cyan + bright orange unless chosen).
 */
export function harmonyPalette(accent: RGB, harmony: HarmonyId): RGB[] {
  const a = rgbToOklch(accent)
  const C = clamp(a.c, 0.02, 0.2)
  const L = clamp(a.l, 0.45, 0.78)
  const mk = (l: number, c: number, h: number) => oklchToRgb({ l: clamp(l, 0.2, 0.92), c: Math.max(0, c), h: hue(h) })
  switch (harmony) {
    case 'monochrome':
      return [mk(L, C, a.h), mk(L - 0.12, C * 0.8, a.h - 6), mk(L + 0.05, C * 0.55, a.h + 8), mk(L - 0.24, C * 0.7, a.h)]
    case 'complement':
      return [mk(L, C, a.h), mk(L - 0.04, C * 0.5, a.h + 180), mk(L - 0.08, C * 0.72, a.h + 28), mk(L - 0.2, C * 0.42, a.h + 200)]
    case 'deep-aurora':
      return [mk(L - 0.04, C, a.h), mk(L - 0.1, C * 0.85, a.h - 58), mk(L - 0.08, C * 0.8, a.h + 72), mk(L - 0.24, C * 0.55, a.h + 150)]
    case 'cool-glass':
      return [mk(L, C * 0.7, a.h), mk(0.6, 0.09, 248), mk(0.66, 0.075, 212), mk(0.42, 0.035, 262)]
    case 'analogous':
    default:
      // close to the legacy "accent" backdrop: a cooler and a warmer
      // companion and a deep anchor, one family
      return [mk(L, C, a.h), mk(L - 0.03, C * 0.9, a.h - 36), mk(L + 0.03, C * 0.85, a.h + 30), mk(L - 0.2, C * 0.7, a.h - 68)]
  }
}

/** Fill a 2–4 anchor palette out to four layers without inventing new hues. */
export function expandAnchors(anchors: RGB[]): RGB[] {
  const list = anchors.length ? anchors : [rgb(6, 182, 212)]
  const out = [...list]
  let i = 0
  while (out.length < 4) {
    const src = rgbToOklch(list[i % list.length])
    // a deeper echo of an existing anchor — never a new colour
    out.push(oklchToRgb({ l: clamp(src.l - 0.16 - 0.04 * i, 0.22, 0.9), c: src.c * 0.75, h: src.h }))
    i += 1
  }
  return out.slice(0, 4)
}

/* ══ environment field ══════════════════════════════════════════════════ */

export interface EnvironmentInput {
  anchors: RGB[]
  /** 0–100 */ intensity: number
  /** 0–100 soft → deep */ blend: number
  /** 0–100 focused → ambient */ spread: number
  /** 0–100 */ depth: number
  /** 0–100, 50 balanced */ luminosity: number
  /** 0–100, 50 neutral; < 50 cool, > 50 warm */ temperature: number
}

export interface EnvironmentTokens {
  base: RGB
  anchors: [RGB, RGB, RGB, RGB]
  /** colour layer opacity, after auto-contrast */
  opacity: number
  /** 0–1 normalised composer values */
  blend: number
  spread: number
  depth: number
  /** the environment was dimmed to keep text readable */
  dimmed: boolean
}

const WARM_HUE = 68
const COOL_HUE = 245

function tuneAnchor(f: Foundation, c: RGB, lum: number, temp: number, index: number): RGB {
  const a = rgbToOklch(c)
  let { l, c: ch, h } = a
  if (index > 0 && Math.abs(temp) > 0.01) {
    // temperature bends the supporting anchors, never the primary
    h = rotateToward(h, temp > 0 ? WARM_HUE : COOL_HUE, Math.abs(temp) * 30)
  }
  if (f.scheme === 'light') {
    // light: mist and crystal, never pastel candy
    l = clamp(lerp(0.86, l, 0.18) + lum * 0.035, 0.76, 0.94)
    ch = clamp(ch * 0.62, 0.02, 0.11)
  } else {
    l = clamp(l + lum * 0.1, 0.36, 0.8)
    ch = clamp(ch, 0, 0.22)
    if (f.id === 'red_ops' && index > 0) { ch *= 0.6; l *= 0.92 }
  }
  return oklchToRgb({ l, c: ch, h })
}

const SIGNAL_RED_FIELD: OKLCH = { l: 0.48, c: 0.17, h: 25 }

export function deriveEnvironment(f: Foundation, input: EnvironmentInput): EnvironmentTokens {
  const lum = (clamp(input.luminosity, 0, 100) - 50) / 50
  const temp = (clamp(input.temperature, 0, 100) - 50) / 50
  let anchors = expandAnchors(input.anchors).map((c, i) => tuneAnchor(f, c, lum, temp, i))
  // Red Ops keeps its red foundation whatever the palette (never "just Dark")
  if (f.id === 'red_ops') anchors = [oklchToRgb({ ...SIGNAL_RED_FIELD, l: SIGNAL_RED_FIELD.l + lum * 0.06 }), ...anchors.slice(0, 3)]
  const i = clamp(input.intensity, 0, 100) / 100
  let opacity = f.id === 'light' ? 0.24 + 0.5 * i : f.id === 'true_black' ? 0.12 + 0.52 * i : 0.16 + 0.56 * i
  // auto-contrast: the brightest point of the field, seen through a pane,
  // must leave primary text comfortably readable — dim the field, not the type
  const blend = clamp(input.blend, 0, 100) / 100
  const peak = 0.55 + 0.35 * blend
  let dimmed = false
  for (let k = 0; k < 12; k++) {
    if (fieldReadable(f, anchors, opacity * peak)) break
    opacity *= 0.88
    dimmed = true
  }
  return {
    base: f.bg,
    anchors: anchors.slice(0, 4) as [RGB, RGB, RGB, RGB],
    opacity: Number(opacity.toFixed(3)),
    blend,
    spread: clamp(input.spread, 0, 100) / 100,
    depth: clamp(input.depth, 0, 100) / 100,
    dimmed,
  }
}

/**
 * Muted text may lose a little contrast to colour behind the glass, never
 * much: at most a quarter of what it has over the theme's plain glass.
 */
export function mutedFloor(f: Foundation): number {
  const plain = over(f.fill, f.paneAlpha, f.bg)
  const muted = f.scheme === 'dark' ? f.ink3 : f.ink2
  return Math.max(2.5, contrast(muted, plain) * 0.75)
}

function fieldReadable(f: Foundation, anchors: RGB[], alpha: number): boolean {
  const muted = f.scheme === 'dark' ? f.ink3 : f.ink2
  const floor = mutedFloor(f)
  return anchors.every((a) => {
    const surface = over(f.fill, f.paneAlpha, over(a, alpha, f.bg))
    return contrast(f.ink, surface) >= 9 && contrast(muted, surface) >= floor
  })
}

/* ══ material ═══════════════════════════════════════════════════════════ */

export type GlassFamily = 'clear' | 'crystal' | 'frosted' | 'smoke'
export const GLASS_FAMILIES: readonly GlassFamily[] = ['clear', 'crystal', 'frosted', 'smoke']
export type EdgeLevel = 'soft' | 'balanced' | 'crisp'

export interface MaterialInput {
  family: GlassFamily
  blur: number
  transparency: number
  sheen: number
  edge: EdgeLevel
}

export interface MaterialTokens {
  blur: number
  sat: number
  /** multiplier on every glass fill's opacity (1 = the product's tuned default) */
  alpha: number
  sheen: number
  fill: RGB
  edge: number
  /** transparency was clamped to keep text readable */
  clamped: boolean
}

/** Safe product limits: blur that renders well and stays cheap. */
export const BLUR_MIN = 6
export const BLUR_MAX = 48
/** Crystal at its canonical transparency is the product's default glass (alpha 1). */
export const CRYSTAL_TRANSPARENCY = 45

const FILLS: Record<FoundationId, Record<GlassFamily, RGB>> = {
  // frost is a lifted, milky fill — lifted only as far as muted text allows
  dark: { clear: rgb(14, 15, 18), crystal: rgb(20, 21, 24), frosted: rgb(26, 28, 32), smoke: rgb(6, 7, 9) },
  true_black: { clear: rgb(0, 0, 0), crystal: rgb(0, 0, 0), frosted: rgb(16, 16, 18), smoke: rgb(0, 0, 0) },
  red_ops: { clear: rgb(14, 9, 9), crystal: rgb(18, 12, 12), frosted: rgb(25, 17, 18), smoke: rgb(8, 5, 5) },
  light: { clear: rgb(255, 255, 255), crystal: rgb(255, 255, 255), frosted: rgb(247, 248, 250), smoke: rgb(228, 231, 237) },
}
export const glassFill = (f: FoundationId, family: GlassFamily) => FILLS[f][family]
const SATURATION: Record<GlassFamily, number> = { clear: 1.55, crystal: 1.45, frosted: 1.2, smoke: 1.0 }
export const EDGE_FACTOR: Record<EdgeLevel, number> = { soft: 0.6, balanced: 1, crisp: 1.65 }

/** transparency 0 → fills at 1.5× their theme opacity; 100 → 0.12× (the shared mapping). */
export const alphaForTransparency = (t: number) => Math.max(0.12, 1.5 - (clamp(t, 0, 100) / 100) * 1.38)
/** Desktop: the same curve, normalised so Crystal's canonical value is exactly the tuned default. */
export const desktopAlpha = (t: number) => alphaForTransparency(t) / alphaForTransparency(CRYSTAL_TRANSPARENCY)

export function deriveMaterial(f: Foundation, m: MaterialInput, env: EnvironmentTokens, accent?: AccentTokens): MaterialTokens {
  // the fill as it will actually render (with the accent's surface tint),
  // then the readability floor: the clearest glass that still keeps primary
  // text ≥ 7:1 (and muted text legible) over the brightest point of the field
  const fill = accent ? surfaceTint(f, FILLS[f.id][m.family], accent) : FILLS[f.id][m.family]
  const floor = alphaFloor(f, env, fill)
  const wanted = desktopAlpha(m.transparency)
  const alpha = Math.max(wanted, floor)
  return {
    blur: Math.round(clamp(m.blur, BLUR_MIN, BLUR_MAX)),
    sat: SATURATION[m.family],
    alpha: Number(alpha.toFixed(3)),
    sheen: Number((clamp(m.sheen, 0, 100) / 50).toFixed(3)),
    fill,
    edge: EDGE_FACTOR[m.edge] ?? 1,
    clamped: alpha > wanted + 1e-6,
  }
}

/** The point of the field that is hardest to read primary text over. */
export function worstField(f: Foundation, env: EnvironmentTokens): RGB {
  const peak = env.opacity * (0.55 + 0.35 * env.blend)
  return env.anchors.reduce((worst, a) => {
    const c = over(a, peak, f.bg)
    return contrast(c, f.ink) < contrast(worst, f.ink) ? c : worst
  }, f.bg)
}

function alphaFloor(f: Foundation, env: EnvironmentTokens, fill: RGB): number {
  const worst = worstField(f, env)
  const muted = f.scheme === 'dark' ? f.ink3 : f.ink2
  const floor = mutedFloor(f)
  for (let alpha = 0.12; alpha <= 1.6; alpha += 0.02) {
    const surface = over(fill, clamp(f.paneAlpha * alpha, 0, 1), worst)
    if (contrast(f.ink, surface) >= 7 && contrast(muted, surface) >= floor) return Number(alpha.toFixed(2))
  }
  return 1.6
}

/* ══ readability report (the contrast engine's own checklist) ═══════════ */

export interface ReadabilityCheck { id: string; ratio: number; min: number; pass: boolean }

/**
 * The surfaces an environment must keep usable: text levels, interactive
 * and selected controls, focus, semantic badges, chart primary, glass.
 */
export function readabilityReport(f: Foundation, accent: AccentTokens, chart: ChartTokens, env: EnvironmentTokens, mat: MaterialTokens): ReadabilityCheck[] {
  const glass = over(mat.fill ?? f.fill, clamp(f.paneAlpha * mat.alpha, 0, 1), worstField(f, env))
  const selected = over(accent.select, accent.softAlpha, glass)
  const checks: Array<[string, number, number]> = [
    ['primary text on glass', contrast(f.ink, glass), 7],
    ['secondary text on glass', contrast(f.ink2, glass), 4.5],
    ['muted text on glass', contrast(f.scheme === 'dark' ? f.ink3 : f.ink2, glass), mutedFloor(f)],
    ['accent text on room', contrast(accent.text, f.bg), 4.5],
    ['accent control on room', contrast(accent.base, f.bg), 3],
    ['ink on accent fill', contrast(accent.on, accent.base), 4.5],
    ['text on selected row', contrast(f.ink, selected), 7],
    ['focus ring on room', contrast(accent.focus, f.bg), 3],
    ['chart primary on room', contrast(chart.primary, f.bg), 3],
    ['success badge on glass', contrast(f.semantic.ok, glass), 3],
    ['attention badge on glass', contrast(f.semantic.attn, glass), 3],
    ['failure badge on glass', contrast(f.semantic.crit, glass), 3],
  ]
  return checks.map(([id, ratio, min]) => ({ id, ratio: Number(ratio.toFixed(2)), min, pass: ratio >= min - 1e-6 }))
}
