/**
 * The Intelligence Lab's product rules, checked against the source:
 * desktop only, phones untouched; the server owns every number; pane-safe
 * layout; money never collapsed; no fabricated external data.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = __dirname
const read = (p: string) => readFileSync(join(here, p), 'utf8')
const sources = readdirSync(here).filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f))

describe('Intelligence Lab (desktop)', () => {
  it('only the modern desktop renders it; phones keep their own Analytics surface', () => {
    const surface = read('../performance/AnalyticsSurface.tsx')
    expect(surface).toMatch(/if \(!isModernDesktop\) return <AnalyticsPhoneSurface \/>/)
    expect(surface).toMatch(/import\('\.\.\/intelligence\/IntelligenceLab'\)/)
    expect(surface).toMatch(/fetchAnalyticsPerformance/) // the phone still reads its own model
  })

  it('never reads a table or derives a headline rate in the browser', () => {
    for (const f of sources) {
      const src = read(f)
      expect(src, f).not.toMatch(/from\(['"](send_queue|message_events|acquisition_opportunit|closing_cases|seller_offers)/)
      expect(src, f).not.toMatch(/\b(replyRate|deliveryRate|interestRate)\s*=\s*[^=]/)
      expect(src, f).not.toMatch(/supabase/i)
    }
  })

  it('stays inside its pane: container queries, no viewport units, nothing fixed', () => {
    const css = read('intelligence.css')
    expect(css).toMatch(/container:\s*ix \/ inline-size/)
    expect(css).not.toMatch(/\d+(vw|vh|dvh|lvh|svh)\b/)
    expect(css).not.toMatch(/position:\s*fixed/)
    expect(css).not.toMatch(/@media\s*\((min|max)-width/)
  })

  it('money is never one number: every basis is its own figure, needs-validation is never summed', () => {
    const money = read('IntelMoney.tsx')
    for (const label of ['County / AVM estimate', 'Seller asking', 'Authorized engine offers', 'Needs validation', 'Actual settled']) expect(money).toContain(label)
    expect(money).toMatch(/never summed/)
    expect(money).not.toMatch(/needsValidation\s*\*|\+\s*t\.needsValidation/)
  })

  it('Growth never fabricates Search Console data: it renders the registry declaration and its status', () => {
    const buyers = read('IntelBuyers.tsx')
    expect(buyers).toMatch(/registry\.external/)
    expect(buyers).not.toMatch(/clicks:\s*\d|impressions:\s*\d|ctr:\s*0\.\d/i)
  })

  it('no dead controls: no Export / Share / Customize / AI buttons', () => {
    for (const f of sources.filter((x) => x.endsWith('.tsx'))) {
      const src = read(f)
      expect(src, f).not.toMatch(/>\s*(Export|Share|Customize|AI Assist|Download)\s*</)
    }
  })

  it('every chart that can be keyboard-inspected says so (slider semantics on the trend)', () => {
    const trend = read('IntelTrend.tsx')
    expect(trend).toMatch(/role="slider"/)
    expect(trend).toMatch(/aria-valuetext/)
    expect(trend).toMatch(/useLcReducedMotion/)
  })
})
