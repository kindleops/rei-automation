/**
 * APPEARANCE → EXPERIENCE TOKENS.
 *
 * Appearance settings produce tokens; components consume tokens. No component
 * runs colour maths: this module is the only place the engine's output
 * becomes CSS, and it is memoised so the work happens once per change.
 *
 *   --lc-accent-*        identity (never semantics), contrast-safe per theme
 *   --lc-select-rgb      selection: the accent, or neutral when the accent is reserved
 *   --lc-chart-*         primary / comparison / neutral / semantic series + a stable categorical set
 *   --lc-env-*           the field behind the glass (anchors, opacity, composer, motion)
 *   --lg-* · --lc-glass-*  the glass material (one store, bounded and readable)
 *
 * Desktop rules are scoped to `html.is-desktop-modern` so the phone keeps its
 * own (unchanged) look; a custom accent is published everywhere because no
 * stylesheet knows its colour.
 */
import { accentSourceHex, GLASS_PRESET_VALUES, materialFamily, normalizeMaterial, DEFAULT_MATERIAL, type AppearanceState, type MaterialState, type MotionLevel } from './appearance'
import type { AccentId } from './accents'
import {
  FOUNDATIONS, deriveAccent, deriveChart, deriveEnvironment, deriveMaterial, harmonyPalette, readabilityReport, resolveFoundation,
  type AccentTokens, type ChartTokens, type EnvironmentTokens, type Foundation, type MaterialTokens, type ReadabilityCheck,
} from './derive'
import { parseColor, toHex, toRgba, toSpaceTriplet, toTriplet, type RGB } from './oklch'

export interface AppearanceInput {
  nexusTheme: unknown
  accentPalette: AccentId
  appearance: AppearanceState
  liquidGlass?: MaterialState
}

export interface AppearanceComputed {
  key: string
  foundation: Foundation
  accentSource: RGB
  accent: AccentTokens
  chart: ChartTokens
  env: EnvironmentTokens
  material: MaterialTokens
  motion: MotionLevel
  report: ReadabilityCheck[]
  css: string
}

const FALLBACK = { r: 6, g: 182, b: 212 }

/** Motion level → animation tempo (duration multiplier) and amplitude. */
export const MOTION_TEMPO: Record<MotionLevel, { tempo: number; amp: number }> = {
  still: { tempo: 1, amp: 0 },
  calm: { tempo: 1, amp: 1 },
  fluid: { tempo: 0.6, amp: 1.35 },
}

/** Base edge alphas per foundation (desktop-calm's --dsk-edge / -hi), scaled by Edge. */
const EDGE_BASE: Record<string, { rgb: string; lo: number; hi: number }> = {
  dark: { rgb: '255, 255, 255', lo: 0.07, hi: 0.11 },
  true_black: { rgb: '255, 255, 255', lo: 0.09, hi: 0.14 },
  red_ops: { rgb: '255, 120, 120', lo: 0.08, hi: 0.13 },
  light: { rgb: '15, 17, 22', lo: 0.08, hi: 0.13 },
}

/** A tiny LRU: the live appearance, the one being previewed, and a few thumbnails. */
const MEMO_MAX = 12
const memo = new Map<string, AppearanceComputed>()

export function computeAppearance(input: AppearanceInput): AppearanceComputed {
  const m = normalizeMaterial(input.liquidGlass ?? DEFAULT_MATERIAL)
  const key = JSON.stringify([resolveFoundation(input.nexusTheme), input.accentPalette, input.appearance, m])
  const hit = memo.get(key)
  if (hit) {
    memo.delete(key)
    memo.set(key, hit)
    return hit
  }
  const foundation = FOUNDATIONS[resolveFoundation(input.nexusTheme)]
  const ap = input.appearance
  const accentSource = parseColor(accentSourceHex(input.accentPalette, ap.accent.custom)) ?? FALLBACK
  const accent = deriveAccent(foundation, accentSource, ap.accent.intensity)
  const chart = deriveChart(foundation, accent)
  const e = ap.environment
  const anchors = e.autoHarmony ? harmonyPalette(accentSource, e.harmony) : e.palette.map((h) => parseColor(h) ?? FALLBACK)
  const env = deriveEnvironment(foundation, { anchors, intensity: e.intensity, blend: e.blend, spread: e.spread, depth: e.depth, luminosity: e.luminosity, temperature: e.temperature })
  const family = materialFamily(m)
  // "theme" glass is the product's tuned default: Crystal at its canonical values
  const values = m.preset === 'theme' ? GLASS_PRESET_VALUES.crystal : m
  const material = deriveMaterial(foundation, { family, blur: values.blur, transparency: values.transparency, sheen: values.sheen, edge: m.edge ?? 'balanced' }, env, accent)
  const report = readabilityReport(foundation, accent, chart, env, material)
  const computed: AppearanceComputed = { key, foundation, accentSource, accent, chart, env, material, motion: ap.motion, report, css: '' }
  computed.css = appearanceCss(computed, input.accentPalette, ap)
  memo.set(key, computed)
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string)
  return computed
}

const decl = (name: string, value: string | number, important = false) => `  ${name}: ${value}${important ? ' !important' : ''};`

export function appearanceCss(c: AppearanceComputed, accentPalette: AccentId, ap: AppearanceState): string {
  const { foundation: f, accent: a, chart, env, material: m } = c
  const motion = MOTION_TEMPO[c.motion]
  const legacy = (imp: boolean) => [
    decl('--nx-accent', toHex(a.base), imp),
    decl('--nx-accent-rgb', toTriplet(a.base), imp),
    decl('--nx-accent-soft', toRgba(a.base, a.softAlpha), imp),
    decl('--nx-accent-border', toRgba(a.base, a.borderAlpha), imp),
    decl('--nx-accent-glow', toRgba(a.base, a.underlightAlpha + 0.06), imp),
  ]
  const custom = accentPalette === 'custom'
    ? [':root[data-nexus-theme][data-nexus-accent="custom"] {', ...legacy(false), '}'].join('\n')
    : ''
  const edge = EDGE_BASE[f.id]
  const desktop = [
    ':root.is-desktop-modern[data-nexus-theme] {',
    '  /* accent — one chain for every legacy and LC consumer (theme and accent are separate) */',
    ...legacy(true),
    decl('--nexus-accent', toHex(a.base), true),
    decl('--nexus-accent-rgb', toTriplet(a.base), true),
    decl('--nexus-accent-soft', toRgba(a.base, a.softAlpha), true),
    decl('--nexus-accent-glow', toRgba(a.base, a.underlightAlpha + 0.06), true),
    decl('--nexus-accent-border', toRgba(a.base, a.borderAlpha), true),
    decl('--dsk-primary-ink', toHex(a.on)),
    decl('--lc-accent-rgb', toTriplet(a.base)),
    decl('--lc-accent', toHex(a.base)),
    decl('--lc-accent-base', toHex(a.base)),
    decl('--lc-accent-hover', toHex(a.hover)),
    decl('--lc-accent-pressed', toHex(a.pressed)),
    decl('--lc-accent-text', toHex(a.text)),
    decl('--lc-accent-text-rgb', toTriplet(a.text)),
    decl('--lc-accent-on', toHex(a.on)),
    decl('--lc-accent-muted', toHex(a.muted)),
    decl('--lc-accent-soft', toRgba(a.base, a.softAlpha)),
    decl('--lc-accent-border', toRgba(a.base, a.borderAlpha)),
    decl('--lc-accent-edge', toRgba(a.base, a.borderAlpha)),
    decl('--lc-accent-focus', toHex(a.focus)),
    decl('--lc-accent-underlight', toRgba(a.base, a.underlightAlpha)),
    decl('--lc-accent-glow-low', toRgba(a.base, a.glowAlpha)),
    decl('--lc-accent-energy', a.energy.toFixed(3)),
    decl('--lc-accent-source', toHex(c.accentSource)),
    decl('--lc-select-rgb', toTriplet(a.select)),
    decl('--lc-focus-rgb', toTriplet(a.focus)),
    '  /* charts — harmonised, never monochrome; semantic series stay semantic */',
    decl('--lc-chart-primary', toHex(chart.primary)),
    decl('--lc-chart-primary-rgb', toTriplet(chart.primary)),
    decl('--lc-chart-secondary', toHex(chart.secondary)),
    decl('--lc-chart-neutral', toHex(chart.neutral)),
    decl('--lc-chart-positive', toHex(chart.positive)),
    decl('--lc-chart-negative', toHex(chart.negative)),
    decl('--lc-chart-attention', toHex(chart.attention)),
    ...chart.categorical.map((col, i) => decl(`--lc-chart-${i + 1}`, toHex(col))),
    '  /* environment — the field behind the glass */',
    decl('--lc-env-base', toSpaceTriplet(env.base)),
    decl('--lc-env-a', toSpaceTriplet(env.anchors[0])),
    decl('--lc-env-b', toSpaceTriplet(env.anchors[1])),
    decl('--lc-env-c', toSpaceTriplet(env.anchors[2])),
    decl('--lc-env-d', toSpaceTriplet(env.anchors[3])),
    decl('--lc-env-o', env.opacity),
    decl('--lc-env-blend', env.blend.toFixed(3)),
    decl('--lc-env-spread', env.spread.toFixed(3)),
    decl('--lc-env-depth', env.depth.toFixed(3)),
    decl('--lc-env-fx', `${Math.round(ap.environment.focalX * 100)}%`),
    decl('--lc-env-fy', `${Math.round(ap.environment.focalY * 100)}%`),
    decl('--lc-env-tempo', motion.tempo),
    decl('--lc-env-amp', motion.amp),
    '  /* glass — bounded, readable, one blur per plane */',
    decl('--lg-blur', `${m.blur}px`, true),
    decl('--lg-sat', m.sat, true),
    decl('--lg-alpha', m.alpha, true),
    decl('--lg-sheen', m.sheen, true),
    decl('--lg-fill', toSpaceTriplet(m.fill), true),
    decl('--lc-glass-edge', m.edge),
    ...(m.edge !== 1
      ? [
          decl('--dsk-edge', `rgba(${edge.rgb}, ${(edge.lo * m.edge).toFixed(3)})`),
          decl('--dsk-edge-hi', `rgba(${edge.rgb}, ${(edge.hi * m.edge).toFixed(3)})`),
        ]
      : []),
    '}',
  ].join('\n')
  return `/* LeadCommand Environment Studio — generated Experience Tokens (${f.id}) */\n${custom}\n${desktop}\n`
}

/** Attributes CSS can key on (environment type, motion, reserved accent, material family). */
export function appearanceAttributes(c: AppearanceComputed, ap: AppearanceState, liquidGlass: MaterialState | undefined): Record<string, string | null> {
  return {
    'data-lc-env': ap.environment.type,
    'data-lc-env-motion': ap.motion,
    'data-lc-accent-reserved': c.accent.reserved,
    'data-lc-material': materialFamily(normalizeMaterial(liquidGlass ?? DEFAULT_MATERIAL)),
  }
}
