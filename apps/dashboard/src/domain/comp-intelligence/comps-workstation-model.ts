/**
 * COMPS WORKSTATION — pure evidence logic for the desktop valuation
 * workstation. No fetching, no React, no valuation methodology of its own:
 * the engine's verdicts and rules come from /api/cockpit/comps/workspace and
 * the engine's formula lives in comps-valuation-replay.ts. This module turns
 * those into explanations, filters and facts — every sentence it produces is
 * a statement about recorded data or a stated engine rule.
 */
import type { CompsWorkspace, EngineRules, EvidenceComp } from './comps-evidence-api'
import { SALE_TYPE_LABEL, saleTypeOfComp, type SaleType } from './comp-sale-type'

/* ── formatting (UTC-safe) ─────────────────────────────────────────────── */

export const fmtMoney = (n: number | null | undefined, opts: { exact?: boolean } = {}): string | null => {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (opts.exact) return `${sign}$${Math.round(a).toLocaleString('en-US')}`
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}K`
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`
  return `${sign}$${Math.round(a)}`
}

export const fmtPct = (x: number | null | undefined, digits = 1, signed = false): string | null => {
  if (x === null || x === undefined || !Number.isFinite(x)) return null
  const v = x * 100
  const s = Math.abs(v).toFixed(digits)
  if (!signed) return `${v < 0 ? '−' : ''}${s}%`
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${s}%`
}

export const fmtMiles = (d: number | null | undefined): string | null =>
  d === null || d === undefined || !Number.isFinite(d) ? null : d < 0.095 ? `${Math.round(d * 5280).toLocaleString('en-US')} ft` : `${d < 10 ? d.toFixed(2) : d.toFixed(1)} mi`

/** A sale date like 2026-04-22 is a calendar date: format it in UTC so no time zone moves it a day. */
export function fmtDate(iso: string | null | undefined, style: 'short' | 'long' = 'short'): string | null {
  if (!iso) return null
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleDateString('en-US', style === 'long'
    ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** Local date + time for engine/run timestamps (moments, not calendar dates). */
export function fmtMoment(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const fmtAge = (days: number | null | undefined): string | null => {
  if (days === null || days === undefined || !Number.isFinite(days)) return null
  if (days < 1) return 'today'
  if (days < 45) return `${Math.round(days)}d`
  if (days < 730) return `${Math.round(days / 30.4)} mo`
  return `${(days / 365).toFixed(1)} yr`
}

export const fmtInt = (n: number | null | undefined): string | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n).toLocaleString('en-US')

/* ── asset awareness ──────────────────────────────────────────────────── */

export type AssetKind = 'sfr' | 'multifamily' | 'land' | 'commercial' | 'other'

export function assetKind(family: string | null | undefined): AssetKind {
  const f = String(family ?? '').toLowerCase()
  if (f === 'multifamily' || f === 'apartment') return 'multifamily'
  if (f === 'land') return 'land'
  if (f === 'commercial') return 'commercial'
  if (f === 'residential' || f === 'single_family' || f === 'condo') return 'sfr'
  return 'other'
}

export interface UnitMetric {
  key: 'ppsf' | 'ppu' | 'ppa'
  label: string
  short: string
  /** what one "unit" of the subject is */
  basis: string
}

/** SFR / commercial price per building sq ft; multifamily per unit; land per lot acre (§127–129). */
export function unitMetricFor(kind: AssetKind): UnitMetric {
  if (kind === 'multifamily') return { key: 'ppu', label: '$ / unit', short: '/unit', basis: 'units' }
  if (kind === 'land') return { key: 'ppa', label: '$ / acre', short: '/ac', basis: 'acres' }
  return { key: 'ppsf', label: '$ / sq ft', short: '/sf', basis: 'sq ft' }
}

const ACRE = 43_560

/** The comp's price per subject unit — recorded price ÷ recorded size; never computed from a zero or missing size. */
export function unitValue(c: Pick<EvidenceComp, 'ppsf' | 'ppu' | 'salePrice' | 'lotSqft' | 'units' | 'sqft'>, metric: UnitMetric): number | null {
  if (metric.key === 'ppu') return c.ppu && c.ppu > 0 && (c.units ?? 0) >= 2 ? c.ppu : null
  if (metric.key === 'ppa') return c.salePrice && c.lotSqft && c.lotSqft > 0 ? c.salePrice / (c.lotSqft / ACRE) : null
  if (c.ppsf && c.ppsf > 0 && c.sqft && c.sqft > 0) return c.ppsf
  return null
}

/** A value ÷ the subject's size in the same basis — e.g. engine value ÷ subject sq ft. */
export function subjectImplied(value: number | null | undefined, subject: CompsWorkspace['subject'], metric: UnitMetric): number | null {
  if (!value || !(value > 0)) return null
  if (metric.key === 'ppu') return subject.units && subject.units >= 2 ? value / subject.units : null
  if (metric.key === 'ppa') return subject.lotSqft && subject.lotSqft > 0 ? value / (subject.lotSqft / ACRE) : null
  return subject.sqft && subject.sqft > 0 ? value / subject.sqft : null
}

export const fmtUnitValue = (v: number | null, metric: UnitMetric): string | null =>
  v === null ? null : metric.key === 'ppsf' ? `$${Math.round(v).toLocaleString('en-US')}` : fmtMoney(v)

/* ── time ─────────────────────────────────────────────────────────────── */

/** Days since the sale, from the server's UTC computation when present. */
export function saleAgeDays(c: Pick<EvidenceComp, 'compare' | 'saleDate'>, now = Date.now()): number | null {
  if (c.compare?.days !== null && c.compare?.days !== undefined) return c.compare.days
  if (!c.saleDate) return null
  const t = Date.parse(c.saleDate.length === 10 ? `${c.saleDate}T00:00:00Z` : c.saleDate)
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 86_400_000)) : null
}

/**
 * The engine ages a sale in CALENDAR months (UTC year×12 + month difference —
 * acquisitionDecisionEngine ageMonths), so a sale ages a month at every
 * month boundary, not every 30 days.
 */
export function engineAgeMonths(saleDate: string | null | undefined, now: number): number | null {
  if (!saleDate) return null
  const t = Date.parse(saleDate.length === 10 ? `${saleDate}T00:00:00Z` : saleDate)
  if (!Number.isFinite(t) || !Number.isFinite(now)) return null
  const a = new Date(t)
  const b = new Date(now)
  return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth())
}

export interface RecencyStep { id: string; label: string; minMonths: number; maxMonths: number | null; factor: number }

/** Recency buckets ARE the engine's recency steps — the chart shows the weighting the engine applies. */
export function recencySteps(rules: EngineRules | null | undefined): RecencyStep[] {
  if (!rules?.recency?.length) return []
  let lo = 0
  return rules.recency.map((st, i) => {
    const step: RecencyStep = {
      id: `r${i}`,
      label: st.maxMonths === null ? `${lo}+ mo` : lo === 0 ? `≤ ${st.maxMonths} mo` : `${lo}–${st.maxMonths} mo`,
      minMonths: lo,
      maxMonths: st.maxMonths,
      factor: st.score,
    }
    lo = (st.maxMonths ?? lo) + 1
    return step
  })
}

export function recencyStepOf(steps: RecencyStep[], months: number | null): RecencyStep | null {
  if (months === null) return null
  return steps.find((s) => s.maxMonths === null || months <= s.maxMonths) ?? null
}

/** The engine's recency factor for an age in calendar months (rules.recency). */
export function engineRecencyFor(rules: EngineRules | null | undefined, months: number): number | null {
  if (!rules) return null
  return rules.recency.find((s) => s.maxMonths === null || months <= s.maxMonths)?.score ?? null
}

/* ── explanation ──────────────────────────────────────────────────────── */

export type ReasonTone = 'ok' | 'neutral' | 'attn' | 'crit'
export interface Reason { code: string; text: string; tone: ReasonTone }

const DIM_NAME: Record<string, string> = {
  asset_type: 'asset type', units: 'unit count', sqft: 'size', beds: 'bedrooms', baths: 'bathrooms', year_built: 'year built',
  lot_sqft: 'lot size', distance_miles: 'distance', condition: 'condition', zip: 'ZIP', subdivision: 'subdivision', zoning: 'zoning',
  garage: 'garage', pool: 'pool', stories: 'stories',
}

const signedPct = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p)}%`
const ratioBand = (min: number, max: number) => `${Math.round((min - 1) * 100) === 0 ? '±0' : `−${Math.round((1 - min) * 100)}`}% to +${Math.round((max - 1) * 100)}%`

export interface ExplainContext {
  subject: CompsWorkspace['subject']
  rules: EngineRules | null | undefined
  /** adjusted-price band outside which the engine's MAD rule rejected sales */
  outlierBand?: { low: number; high: number } | null
  /** median distance of the set being judged (for a relative "farther than most") */
  setMedianDistance?: number | null
  now?: number
}

/** Why the engine includes — or would accept — this sale. True facts only. */
export function whyIncluded(c: EvidenceComp, ctx: ExplainContext): Reason[] {
  const out: Reason[] = []
  const dims = new Map((c.engine?.dims ?? []).map((d) => [d.f, d]))
  const s = ctx.subject
  if (c.assetMatch && (dims.get('asset_type')?.st === 'exact_or_near' || !dims.has('asset_type'))) out.push({ code: 'same_asset', text: `Same asset type · ${s.familyLabel ?? s.propertyType ?? 'subject class'}`, tone: 'ok' })
  if (c.distanceMiles !== null) out.push({ code: 'distance', text: `${fmtMiles(c.distanceMiles)} from the subject`, tone: c.distanceMiles <= 1 ? 'ok' : 'neutral' })
  const days = saleAgeDays(c, ctx.now)
  if (days !== null) {
    const rec = c.engine?.recency
    out.push({ code: 'recency', text: `Sold ${fmtAge(days)} ago${rec !== null && rec !== undefined ? ` · engine recency ${Math.round(rec)}%` : ''}`, tone: days <= 182 ? 'ok' : 'neutral' })
  }
  const kind = assetKind(s.family)
  if (kind === 'multifamily' && c.compare.units === 0) out.push({ code: 'units', text: 'Same unit count', tone: 'ok' })
  else if (kind === 'land' && c.compare.lotPct !== null && Math.abs(c.compare.lotPct) <= 15) out.push({ code: 'lot', text: `Lot within ${Math.max(1, Math.abs(c.compare.lotPct))}% of the subject's`, tone: 'ok' })
  else if (c.compare.sqftPct !== null && Math.abs(c.compare.sqftPct) <= 10) out.push({ code: 'size', text: c.compare.sqftPct === 0 ? 'Same size as the subject' : `Size within ${Math.abs(c.compare.sqftPct)}% (${fmtInt(c.sqft)} vs ${fmtInt(s.sqft)} sf)`, tone: 'ok' })
  if (kind === 'sfr' && c.compare.beds === 0) out.push({ code: 'beds', text: 'Same bedroom count', tone: 'ok' })
  if (c.compare.years !== null && Math.abs(c.compare.years) <= 10) out.push({ code: 'year', text: c.compare.years === 0 ? 'Built the same year' : `Built within ${Math.abs(c.compare.years)} yrs`, tone: 'ok' })
  for (const f of ['zip', 'subdivision', 'zoning'] as const) {
    if (dims.get(f)?.st === 'exact_or_near') out.push({ code: f, text: `Same ${DIM_NAME[f]}`, tone: 'ok' })
  }
  if (dims.get('condition')?.st === 'exact_or_near') out.push({ code: 'condition', text: 'Same recorded condition', tone: 'ok' })
  if (c.mls) out.push({ code: 'mls', text: 'MLS-recorded sale', tone: 'ok' })
  return out
}

/** Real weaknesses of an admissible sale — never invented, never a guess about condition. */
export function weaknesses(c: EvidenceComp, ctx: ExplainContext): Reason[] {
  const out: Reason[] = []
  for (const d of c.engine?.dims ?? []) {
    if (d.st !== 'mismatch' || d.f === 'distance_miles') continue
    const subjectValue = d.s ?? null
    const detail = subjectValue !== null && subjectValue !== undefined && d.c !== null && d.c !== undefined ? ` (${String(d.c)} vs ${String(subjectValue)})` : ''
    out.push({ code: `dim_${d.f}`, text: `${(DIM_NAME[d.f] ?? d.f).replace(/^\w/, (x) => x.toUpperCase())} differs${detail}`, tone: 'attn' })
  }
  if (c.compare.sqftPct !== null && Math.abs(c.compare.sqftPct) > 20 && !out.some((r) => r.code === 'dim_sqft')) out.push({ code: 'size_gap', text: `Size ${signedPct(c.compare.sqftPct)} vs subject`, tone: 'attn' })
  const days = saleAgeDays(c, ctx.now)
  if (days !== null && days > 365) out.push({ code: 'old', text: `Sale is ${fmtAge(days)} old${c.engine?.recency ? ` — engine recency ${Math.round(c.engine.recency)}%` : ''}`, tone: 'attn' })
  if (c.distanceMiles !== null && ctx.setMedianDistance && c.distanceMiles > Math.max(1, ctx.setMedianDistance * 2)) out.push({ code: 'far', text: `${fmtMiles(c.distanceMiles)} away — over twice the set's median distance`, tone: 'attn' })
  const completeness = c.engine?.completeness
  if (completeness !== null && completeness !== undefined && completeness < 40) out.push({ code: 'thin_record', text: `Thin record — the engine compared ${Math.round(completeness)}% of its features`, tone: 'attn' })
  const adj = c.engine?.adjustedPrice
  if (adj && ctx.outlierBand && (adj < ctx.outlierBand.low || adj > ctx.outlierBand.high)) out.push({ code: 'outlier_band', text: `Adjusted value ${fmtMoney(adj)} is outside the engine's outlier band (${fmtMoney(ctx.outlierBand.low)}–${fmtMoney(ctx.outlierBand.high)})`, tone: 'attn' })
  if (c.corpus === 'transaction_corpus') out.push({ code: 'deed_only', text: 'Recorded deed — not in the engine’s pricing pool', tone: 'neutral' })
  if (c.outsideSearch) out.push({ code: 'outside_search', text: 'Outside the current search radius / window', tone: 'neutral' })
  if (c.state === 'system' && c.today) {
    if (!c.today.eligible) out.push({ code: 'today_rejects', text: `The engine’s rules reject it today: ${c.today.reasons.map((r) => r.replace(/_/g, ' ')).join(', ')}`, tone: 'crit' })
    else if (c.engine?.weight && c.today.weight !== null && c.today.weight < c.engine.weight - 0.0001) out.push({ code: 'aged', text: `Weight has aged since the engine ran (${c.engine.weight.toFixed(4)} → ${c.today.weight.toFixed(4)})`, tone: 'neutral' })
  }
  if (c.reasons.some((r) => r.code === 'outside_top_comp_limit')) out.push({ code: 'outside_top', text: 'Eligible, but outside the engine’s top 12 by weight', tone: 'neutral' })
  if (c.reasons.some((r) => r.code === 'adjusted_price_outlier')) out.push({ code: 'stored_outlier', text: 'The engine rejected it as a price outlier when it ran', tone: 'attn' })
  return out
}

/** Why the engine (or the recorded deed itself) rules this sale out — concrete, with the engine's own limits. */
export function whyExcluded(c: EvidenceComp, ctx: ExplainContext): Reason[] {
  const r = ctx.rules
  const s = ctx.subject
  const out: Reason[] = []
  const days = saleAgeDays(c, ctx.now)
  for (const { code, label } of c.reasons) {
    let text = label
    switch (code) {
      case 'outside_radius':
        if (c.distanceMiles !== null && r) text = `${fmtMiles(c.distanceMiles)} from the subject — the engine’s limit is ${r.radiusMiles} mi`
        break
      case 'sale_too_old':
        if (days !== null && r) text = `Sold ${fmtAge(days)} ago — the engine’s window is ${r.months} months`
        break
      case 'asset_type_mismatch':
      case 'asset_family_invariant':
        text = `${c.propertyType ?? 'Different asset'}${c.units && c.units > 1 ? ` · ${c.units} units` : ''} — the subject is ${s.familyLabel ?? s.propertyType ?? 'a different class'}`
        break
      case 'square_feet_outside_range':
      case 'building_size_outside_range':
        if (c.sqft && s.sqft && r?.size) text = `${fmtInt(c.sqft)} sf vs the subject’s ${fmtInt(s.sqft)} sf (${signedPct(Math.round(((c.sqft - s.sqft) / s.sqft) * 100))}) — the engine allows ${ratioBand(r.size.min, r.size.max)}`
        break
      case 'unit_count_outside_range':
        if (c.units && s.units && r?.size) text = `${c.units} units vs the subject’s ${s.units} — the engine allows ×${r.size.min} to ×${r.size.max}`
        break
      case 'invalid_sale_price':
        text = c.salePrice ? `${fmtMoney(c.salePrice, { exact: true })} — below the engine’s ${fmtMoney(r?.minSalePrice ?? 10_000, { exact: true })} floor` : 'No usable sale price recorded'
        break
      case 'nominal_non_arms_length_transfer':
      case 'nominal_price':
        text = `${fmtMoney(c.salePrice, { exact: true }) ?? 'Price'} — under ${Math.round((r?.nominalPriceToValue ?? 0.25) * 100)}% of the recorded value: a nominal transfer, not a market sale`
        break
      case 'distress_or_transfer_deed':
        text = `${c.docType ? `${c.docType} — ` : ''}a foreclosure / transfer deed, not a market sale`
        break
      case 'package_consideration_unresolved':
        text = 'Same date and price as other parcels — a package sale whose per-parcel price is unknowable'
        break
      case 'same_property':
        text = 'The subject’s own sale'
        break
      default:
        break
    }
    out.push({ code, text, tone: code === 'outside_top_comp_limit' ? 'neutral' : 'crit' })
  }
  return out
}

/* ── filters ──────────────────────────────────────────────────────────── */

export interface CompFilters {
  /** ≤ miles (client-side, within the loaded search) */
  maxDistance: number | null
  /** sold within N months */
  maxAgeMonths: number | null
  /** size within ±N% (sq ft; units for multifamily; lot for land) */
  sizePct: number | null
  /** bedrooms within ±N */
  bedsDelta: number | null
  /** built within ±N years */
  yearDelta: number | null
  sameZip: boolean
  armsLengthOnly: boolean
  corpus: 'all' | 'engine_pool' | 'transaction_corpus'
  /** how the sale happened (see comp-sale-type.ts) — 'all' keeps every type */
  saleType: 'all' | SaleType
}

export const NO_FILTERS: CompFilters = { maxDistance: null, maxAgeMonths: null, sizePct: null, bedsDelta: null, yearDelta: null, sameZip: false, armsLengthOnly: false, corpus: 'all', saleType: 'all' }

export type PresetId = 'strict' | 'balanced' | 'broad'
/** Presets are visible, deterministic filter definitions — not a scoring opinion. */
export const PRESETS: Record<PresetId, { label: string; filters: CompFilters }> = {
  strict: { label: 'Strict', filters: { ...NO_FILTERS, maxDistance: 1, maxAgeMonths: 12, sizePct: 15, bedsDelta: 1 } },
  balanced: { label: 'Balanced', filters: { ...NO_FILTERS, maxDistance: 2, maxAgeMonths: 24, sizePct: 25, bedsDelta: 1 } },
  broad: { label: 'Broad', filters: { ...NO_FILTERS } },
}

/** The words a preset means, so its definition is never hidden. */
export function describeFilters(f: CompFilters, kind: AssetKind): string[] {
  const out: string[] = []
  if (f.maxDistance !== null) out.push(`≤ ${f.maxDistance} mi`)
  if (f.maxAgeMonths !== null) out.push(`sold ≤ ${f.maxAgeMonths} mo`)
  if (f.sizePct !== null) out.push(`${kind === 'multifamily' ? 'units' : kind === 'land' ? 'lot' : 'sq ft'} ±${f.sizePct}%`)
  if (f.bedsDelta !== null && kind === 'sfr') out.push(`beds ±${f.bedsDelta}`)
  if (f.yearDelta !== null) out.push(`built ±${f.yearDelta} yr`)
  if (f.sameZip) out.push('same ZIP')
  if (f.armsLengthOnly) out.push('arm’s-length only')
  if (f.corpus === 'engine_pool') out.push('engine pool only')
  if (f.corpus === 'transaction_corpus') out.push('recorded deeds only')
  if (f.saleType !== 'all') out.push(`${SALE_TYPE_LABEL[f.saleType].short} sales only`)
  return out
}

/** How many filters differ from none — the count the filter bar shows. */
export function filterCount(f: CompFilters): number {
  return (Object.keys(NO_FILTERS) as Array<keyof CompFilters>).filter((k) => f[k] !== NO_FILTERS[k]).length
}

export function matchesPreset(f: CompFilters): PresetId | null {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const p = PRESETS[id].filters
    if ((Object.keys(p) as Array<keyof CompFilters>).every((k) => p[k] === f[k])) return id
  }
  return null
}

export function passesFilters(c: EvidenceComp, f: CompFilters, subject: CompsWorkspace['subject'], now = Date.now()): boolean {
  const kind = assetKind(subject.family)
  if (f.maxDistance !== null && (c.distanceMiles === null || c.distanceMiles > f.maxDistance)) return false
  if (f.maxAgeMonths !== null) {
    const days = saleAgeDays(c, now)
    if (days === null || days > f.maxAgeMonths * 30.44) return false
  }
  if (f.sizePct !== null) {
    const pct = kind === 'multifamily'
      ? (subject.units && c.units ? Math.round(((c.units - subject.units) / subject.units) * 100) : null)
      : kind === 'land' ? c.compare.lotPct : c.compare.sqftPct
    if (pct === null || Math.abs(pct) > f.sizePct) return false
  }
  if (f.bedsDelta !== null && kind === 'sfr' && (c.compare.beds === null || Math.abs(c.compare.beds) > f.bedsDelta)) return false
  if (f.yearDelta !== null && (c.compare.years === null || Math.abs(c.compare.years) > f.yearDelta)) return false
  if (f.sameZip && !(c.zip && subject.zip && c.zip.slice(0, 5) === subject.zip.slice(0, 5))) return false
  if (f.armsLengthOnly && c.armsLength === false) return false
  if (f.corpus !== 'all' && c.corpus !== f.corpus) return false
  if (f.saleType && f.saleType !== 'all' && saleTypeOfComp(c).type !== f.saleType) return false
  return true
}

/* ── sets ─────────────────────────────────────────────────────────────── */

export function setDiff(system: ReadonlySet<string>, operator: ReadonlySet<string>): { added: string[]; removed: string[] } {
  return {
    added: [...operator].filter((k) => !system.has(k)),
    removed: [...system].filter((k) => !operator.has(k)),
  }
}

export const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k))

const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
export { median }

export interface EvidenceDepth {
  count: number
  within1mi: number
  within90d: number
  within12mo: number
  mlsCount: number
  medianDistance: number | null
  medianAgeDays: number | null
  /** interquartile spread of the unit metric, relative to its median */
  unitSpread: number | null
}

/** Evidence depth as facts (§51): counts, not a badge. */
export function evidenceDepth(set: EvidenceComp[], metric: UnitMetric, now = Date.now()): EvidenceDepth {
  const ages = set.map((c) => saleAgeDays(c, now)).filter((d): d is number => d !== null)
  const units = set.map((c) => unitValue(c, metric)).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const q = (p: number) => (units.length ? units[Math.min(units.length - 1, Math.max(0, Math.round(p * (units.length - 1))))] : null)
  const mid = median(units)
  const p25 = q(0.25)
  const p75 = q(0.75)
  return {
    count: set.length,
    within1mi: set.filter((c) => c.distanceMiles !== null && c.distanceMiles <= 1).length,
    within90d: ages.filter((d) => d <= 90).length,
    within12mo: ages.filter((d) => d <= 365).length,
    mlsCount: set.filter((c) => c.mls).length,
    medianDistance: median(set.map((c) => c.distanceMiles).filter((d): d is number => d !== null)),
    medianAgeDays: median(ages),
    unitSpread: units.length >= 3 && mid && p25 !== null && p75 !== null ? (p75 - p25) / mid : null,
  }
}

/** The most recent recorded sale in each corpus — what "evidence through" can truthfully say. */
export function latestSales(comps: EvidenceComp[]): { enginePool: string | null; recordedDeeds: string | null } {
  let pool: string | null = null
  let deeds: string | null = null
  for (const c of comps) {
    if (!c.saleDate) continue
    if (c.corpus === 'engine_pool') { if (!pool || c.saleDate > pool) pool = c.saleDate }
    else if (!deeds || c.saleDate > deeds) deeds = c.saleDate
  }
  return { enginePool: pool, recordedDeeds: deeds }
}

/** Other recorded sales of the same property inside the loaded search — a timeline, not the full history. */
export function transactionsOfProperty(comps: EvidenceComp[], c: EvidenceComp): EvidenceComp[] {
  if (!c.propertyId) return [c]
  return comps.filter((x) => x.propertyId === c.propertyId && x.saleDate).sort((a, b) => String(b.saleDate).localeCompare(String(a.saleDate)))
}
