import { describe, expect, it } from 'vitest'
import {
  FOUNDATIONS, FOUNDATION_IDS, deriveAccent, deriveChart, deriveEnvironment, deriveMaterial, harmonyPalette, isCritLike, readabilityReport,
  resolveFoundation, type FoundationId,
} from './derive'
import { ACCENT_PRESETS } from './accents'
import { contrast, deltaE, hueDistance, parseColor, rgbToOklch } from './oklch'
import { computeAppearance } from './tokens'
import { defaultAppearance, normalizeMaterial } from './appearance'

const rgb = (hex: string) => parseColor(hex)!

/** §147: the QA colours the brief names, plus every preset. */
const QA: Record<string, string> = {
  cyan: '#22D3EE', emerald: '#10B981', gold: '#EAB308', violet: '#7C3AED', pink: '#EC4899', blue: '#2563EB', orange: '#F97316',
  'very dark': '#1E1B4B', 'very pale': '#FEF9C3', 'low saturation gray': '#808080', 'near white': '#F8FAFC', 'pure yellow': '#FFFF00',
  ...Object.fromEntries(ACCENT_PRESETS.map((p) => [`preset ${p.id}`, p.hex])),
}

describe('accent derivation — contrast-safe in every foundation', () => {
  for (const id of FOUNDATION_IDS) {
    const f = FOUNDATIONS[id]
    for (const [name, hex] of Object.entries(QA)) {
      it(`${id} · ${name}`, () => {
        const a = deriveAccent(f, rgb(hex), 50)
        expect(contrast(a.base, f.bg)).toBeGreaterThanOrEqual(3)
        expect(contrast(a.on, a.base)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(a.text, f.bg)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(a.focus, f.bg)).toBeGreaterThanOrEqual(3)
        // the hue survives correction (the operator's colour stays the inspiration)
        const src = rgbToOklch(rgb(hex))
        if (src.c > 0.04) expect(hueDistance(rgbToOklch(a.base).h, src.h)).toBeLessThan(12)
      })
    }
  }

  it('keeps every preset exactly as chosen where it already reads (Dark)', () => {
    // violet, blue and rose need a lighter step for dark ink on their fills
    for (const p of ACCENT_PRESETS.filter((x) => !['violet', 'blue', 'rose'].includes(x.id))) {
      expect(deriveAccent(FOUNDATIONS.dark, rgb(p.hex)).base).toEqual(rgb(p.hex))
    }
    expect(deltaE(deriveAccent(FOUNDATIONS.dark, rgb('#E11D48')).base, rgb('#E11D48'))).toBeLessThan(0.02)
  })

  it('a very pale yellow in Light becomes a deeper, readable yellow — never pale text on white', () => {
    const a = deriveAccent(FOUNDATIONS.light, rgb('#FEF9C3'))
    expect(contrast(a.text, { r: 255, g: 255, b: 255 })).toBeGreaterThanOrEqual(4.5)
    expect(a.adjusted).toBe(true)
  })

  it('intensity changes energy and chroma but never readability', () => {
    for (const i of [0, 25, 50, 75, 100]) {
      const a = deriveAccent(FOUNDATIONS.dark, rgb('#22D3EE'), i)
      expect(contrast(a.base, FOUNDATIONS.dark.bg)).toBeGreaterThanOrEqual(3)
    }
    expect(deriveAccent(FOUNDATIONS.dark, rgb('#22D3EE'), 100).softAlpha).toBeGreaterThan(deriveAccent(FOUNDATIONS.dark, rgb('#22D3EE'), 0).softAlpha)
  })
})

describe('semantic protection', () => {
  it('a red-family accent never paints selection or focus (failure stays red-only)', () => {
    for (const id of FOUNDATION_IDS) {
      for (const hex of ['#FF1212', '#E11D48', '#EF4444']) {
        const a = deriveAccent(FOUNDATIONS[id], rgb(hex))
        expect(a.reserved).toBe('crit')
        expect(a.select).toEqual(FOUNDATIONS[id].neutralSelect)
        expect(a.focus).toEqual(FOUNDATIONS[id].neutralSelect)
      }
    }
  })
  it('cyan, violet, pink and gold accents keep their own selection colour', () => {
    for (const hex of ['#22D3EE', '#7C3AED', '#EC4899', '#EAB308']) expect(deriveAccent(FOUNDATIONS.dark, rgb(hex)).reserved).toBeNull()
  })
  it('semantic colours are product constants — no accent changes them', () => {
    const before = JSON.stringify(FOUNDATIONS.red_ops.semantic)
    deriveAccent(FOUNDATIONS.red_ops, rgb('#22D3EE'), 100)
    expect(JSON.stringify(FOUNDATIONS.red_ops.semantic)).toBe(before)
  })
})

describe('charts harmonise without becoming monochrome', () => {
  it('a cyan accent does not produce a palette of cyans', () => {
    const f = FOUNDATIONS.dark
    const chart = deriveChart(f, deriveAccent(f, rgb('#06B6D4')))
    expect(chart.categorical[0]).toEqual(chart.primary)
    for (let i = 1; i < chart.categorical.length; i++) expect(deltaE(chart.categorical[i], chart.primary)).toBeGreaterThan(0.09)
    expect(chart.categorical.some((c) => isCritLike(c, f))).toBe(false)
    expect(chart.positive).toEqual(f.semantic.ok)
    expect(chart.negative).toEqual(f.semantic.crit)
    expect(chart.attention).toEqual(f.semantic.attn)
  })
  it('chart lines read on the room in every theme', () => {
    for (const id of FOUNDATION_IDS) {
      const f = FOUNDATIONS[id]
      const chart = deriveChart(f, deriveAccent(f, rgb('#22D3EE')))
      expect(contrast(chart.primary, f.bg)).toBeGreaterThanOrEqual(3)
      expect(contrast(chart.secondary, f.bg)).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('environment palettes', () => {
  it('auto harmony stays subtle — no bright complement unless chosen', () => {
    const accent = rgbToOklch(rgb('#22D3EE'))
    for (const h of ['analogous', 'monochrome', 'complement', 'deep-aurora', 'cool-glass'] as const) {
      const p = harmonyPalette(rgb('#22D3EE'), h)
      expect(p).toHaveLength(4)
      for (const c of p.slice(1)) expect(rgbToOklch(c).c).toBeLessThanOrEqual(accent.c + 0.01)
    }
  })
  it('is deterministic (no colours randomised per load)', () => {
    expect(harmonyPalette(rgb('#7C3AED'), 'deep-aurora')).toEqual(harmonyPalette(rgb('#7C3AED'), 'deep-aurora'))
  })
  it('dims a too-bright field instead of letting it wash out the text (auto-contrast)', () => {
    const f = FOUNDATIONS.dark
    const env = deriveEnvironment(f, { anchors: [rgb('#FFFFFF'), rgb('#FEF9C3')], intensity: 100, blend: 100, spread: 100, depth: 0, luminosity: 100, temperature: 50 })
    expect(env.dimmed).toBe(true)
  })
  it('Red Ops keeps a red foundation whatever the palette', () => {
    const env = deriveEnvironment(FOUNDATIONS.red_ops, { anchors: [rgb('#22D3EE'), rgb('#10B981')], intensity: 55, blend: 50, spread: 50, depth: 50, luminosity: 50, temperature: 50 })
    expect(hueDistance(rgbToOklch(env.anchors[0]).h, 25)).toBeLessThan(10)
  })
  it('Light keeps environmental colour as mist, not candy', () => {
    const env = deriveEnvironment(FOUNDATIONS.light, { anchors: [rgb('#7C3AED'), rgb('#F97316')], intensity: 60, blend: 50, spread: 50, depth: 50, luminosity: 50, temperature: 50 })
    for (const a of env.anchors) {
      const lch = rgbToOklch(a)
      expect(lch.l).toBeGreaterThanOrEqual(0.75)
      expect(lch.c).toBeLessThanOrEqual(0.115)
    }
  })
  it('temperature bends supporting anchors, never the primary', () => {
    const base = { anchors: [rgb('#22D3EE'), rgb('#7C3AED')], intensity: 55, blend: 50, spread: 50, depth: 50, luminosity: 50 }
    const warm = deriveEnvironment(FOUNDATIONS.dark, { ...base, temperature: 100 })
    const cool = deriveEnvironment(FOUNDATIONS.dark, { ...base, temperature: 0 })
    expect(warm.anchors[0]).toEqual(cool.anchors[0])
    expect(warm.anchors[1]).not.toEqual(cool.anchors[1])
  })
})

describe('material safety', () => {
  const env = (id: FoundationId, bright = false) => deriveEnvironment(FOUNDATIONS[id], {
    anchors: bright ? [rgb('#F8FAFC'), rgb('#FEF9C3')] : [rgb('#22D3EE'), rgb('#7C3AED')],
    intensity: bright ? 100 : 40, blend: 60, spread: 60, depth: 50, luminosity: bright ? 100 : 50, temperature: 50,
  })
  it('blur is bounded to safe product limits', () => {
    const m = deriveMaterial(FOUNDATIONS.dark, { family: 'clear', blur: 500, transparency: 50, sheen: 50, edge: 'balanced' }, env('dark'))
    expect(m.blur).toBeLessThanOrEqual(48)
    const n = deriveMaterial(FOUNDATIONS.dark, { family: 'clear', blur: 0, transparency: 50, sheen: 50, edge: 'balanced' }, env('dark'))
    expect(n.blur).toBeGreaterThanOrEqual(6)
  })
  it('clamps transparency that would make text unreadable over a bright field', () => {
    const m = deriveMaterial(FOUNDATIONS.dark, { family: 'clear', blur: 12, transparency: 100, sheen: 50, edge: 'balanced' }, env('dark', true))
    expect(m.clamped).toBe(true)
  })
  it('Crystal at its canonical values is exactly the product default glass', () => {
    const m = deriveMaterial(FOUNDATIONS.dark, { family: 'crystal', blur: 24, transparency: 45, sheen: 50, edge: 'balanced' }, env('dark'))
    expect(m.alpha).toBe(1)
    expect(m.sheen).toBe(1)
  })
  it('True Black glass stays black', () => {
    const m = deriveMaterial(FOUNDATIONS.true_black, { family: 'crystal', blur: 24, transparency: 45, sheen: 50, edge: 'balanced' }, env('true_black'))
    expect(m.fill).toEqual({ r: 0, g: 0, b: 0 })
  })
})

describe('the contrast engine passes every material over every theme (QA §149–151)', () => {
  for (const id of FOUNDATION_IDS) {
    for (const preset of ['theme', 'clear', 'frosted', 'smoke'] as const) {
      for (const [envName, palette] of [['low', ['#22D3EE', '#7C3AED']], ['bright', ['#F8FAFC', '#FEF9C3', '#FFFF00']], ['aurora', ['#14B8A6', '#10B981', '#7C3AED', '#22D3EE']]] as const) {
        it(`${id} · ${preset} · ${envName}`, () => {
          const ap = defaultAppearance()
          ap.environment = { ...ap.environment, autoHarmony: false, palette: [...palette], intensity: envName === 'bright' ? 100 : 60, luminosity: envName === 'bright' ? 100 : 50 }
          const c = computeAppearance({ nexusTheme: id, accentPalette: 'custom', appearance: { ...ap, accent: { custom: '#22D3EE', intensity: 60 } }, liquidGlass: normalizeMaterial({ preset, blur: 20, transparency: preset === 'clear' ? 90 : 40, sheen: 50 }) })
          const failed = readabilityReport(c.foundation, c.accent, c.chart, c.env, c.material).filter((r) => !r.pass)
          expect(failed).toEqual([])
        })
      }
    }
  }
})

describe('every stored theme resolves to a foundation', () => {
  it('maps legacy ids', () => {
    expect(resolveFoundation('infrared')).toBe('red_ops')
    expect(resolveFoundation('operator-black')).toBe('true_black')
    expect(resolveFoundation('executive')).toBe('dark')
    expect(resolveFoundation(undefined)).toBe('dark')
  })
})
