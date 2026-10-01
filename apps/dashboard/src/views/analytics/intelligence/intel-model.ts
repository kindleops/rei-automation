/**
 * ANALYTICS 4.0 — pure shaping for the Intelligence Lab.
 *
 * The server owns every number (registry, engine, comparisons, cohorts,
 * money by basis). This file only types what it returns and arranges it for
 * drawing: it never derives a rate the server did not compute, never fills a
 * missing bucket, never turns an estimate into an actual.
 */
import type { FilterFieldDef, LabFilter, LabOverview, LabRegistry, MetricDef, SeriesPoint, WhatChanged } from '../../../domain/analytics/analytics-lab-api'

/* ═══ server result types (views added for 4.0) ═══════════════════════════ */

export type LaneKey = 'system' | 'operator' | 'seller' | 'external' | 'blocked' | 'dormant' | 'complete'
export type Basis = { n: number; sum: number }
export type MoneyStage = {
  code: string; index: number; label: string; deals: number; stalled: number; lanes: Record<LaneKey, number>
  asking: Basis; askingImplausible: number; record: Basis
  authorized: { n: number; offer: number; valuation: number; fee: number }; needsValidation: number; notPriced: number
  presented: Basis; contract: Basis; expected: Basis; actual: Basis
}
export type MoneyDeal = {
  id: string; stage: string; stageIndex: number | null; lane: { key: string; label: string } | null; stall: string | null; daysInStage: number | null
  address: string | null; market: string | null; marketKey: string | null; asking: number | null; askImplausible: boolean; record: number | null
  engine: { state: 'authorized' | 'needs_validation' | 'not_priced'; tier?: string | null; recommended?: number | null; valuation?: number | null; fee?: number | null; compCount?: number | null; reasons: string[] }
  presented: number | null; contract: number | null; actual: number | null; propertyId: string | null; threadKey: string | null
}
export type MoneyTotals = Omit<MoneyStage, 'code' | 'index' | 'label' | 'deals'> & { deals: number; closedWithoutEvidence: number }
export type MoneyMarket = { key: string; label: string; deals: number; asking: Basis; record: Basis; authorized: { n: number; offer: number }; needsValidation: number }
export type MoneyResult = {
  stages: MoneyStage[]; totals: MoneyTotals; markets: MoneyMarket[]; deals: MoneyDeal[]; dealsTruncated: boolean
  asOf: 'now'; notApplicable: string[]; offersTruncated: boolean; ever: { closings: number; confirmedRevenue: number; contracts: number }
  thresholds: { stageMaxDays: Record<string, number>; dormantDays: number }; note: string
}

export type IntelEvent = {
  id: string; at: string; kind: 'campaign' | 'control'; tone: 'exec' | 'attn' | 'crit' | 'flow' | 'neutral'
  title: string; subject: string; detail: string | null; campaignId?: string | null; repeats?: number
  items?: Array<{ key: string; label: string; value: string }>; source: string; note?: string
}
export type EventsResult = { events: IntelEvent[]; sources: string[]; note: string }

export type SeriesByResult = {
  available: boolean; dim: string; reason?: string; grain?: string; total?: number; other?: number; otherGroups?: number
  keys?: Array<{ key: string; label: string; total: number; test?: boolean }>
  buckets?: Array<{ start: number; end: number; values: Record<string, number>; total: number }>
}

export type StageRow = {
  code: string; index: number; label: string; entered: number; enteredBySystem: number; enteredByHuman: number
  exits: number; forward: number; backward: number; forwardShare: number | null; forwardCi: { low: number; high: number } | null
  dwell: { n: number; p25: number | null; p50: number | null; p75: number | null; p90: number | null; min: number | null; max: number | null }
  active: number; live: number; dormant: number; stalled: number; stallThresholdDays: number | null
  liveAge: { n: number; p25: number | null; p50: number | null; p75: number | null; p90: number | null; min: number | null; max: number | null }
  stalledIds: string[]
}
export type StagesResult = { current: StageRow[]; comparison: StageRow[] | null; bottleneck: { code: string; label: string; live: number; stalled: number; thresholdDays: number } | null; dormantDays: number }

export type BuyersResult = {
  dataThrough: string | null; coverage: 'full' | 'partial' | 'none' | 'unknown'
  purchases: number | null; entities: number | null; repeat: number | null; prevPurchases: number | null
  markets: Array<{ key: string; label: string; state?: string; cur: number; prev: number; entities: number; centroid?: { lat: number; lng: number } | null }>
  zips: Array<{ zip: string; market: string; lat: number; lng: number; purchases: number }>
  unresolved: number | null; note: string
}
export type OrchestratorResult = { total: number; workflows: Array<{ key: string; workflow: string; version: number; runs: number; states: Record<string, number> }>; runs: Array<{ id: string; workflow_key: string; state: string; outcome: string | null; started_at: string }>; note: string }

export type ExternalSource = {
  id: string; family: string; label: string; status: 'connected' | 'not_connected'; reason: string | null; requires: string[]
  metrics: Array<{ id: string; label: string; unit: string; definition: string }>; dimensions: string[]; freshness: string
}
export type MoneyBasisDef = { id: string; label: string; kind: string; source: string; note: string }
/** The overview's cohort line, with the seller cohort the 4.0 read model adds. */
export type PeriodCohort = LabOverview['thePeriod']['cohort'] & {
  sellerCohort?: { key: string; label: string; current: number | null; comparison: number | null } | null
}
export type IntelRegistry = LabRegistry & {
  cohorts?: Record<string, { label: string; metric: string }>
  money?: MoneyBasisDef[]
  external?: ExternalSource[]
  classDisposition?: Record<string, string>
  classLabels?: Record<string, string>
  dispositionLabels?: Record<string, string>
  runClassLabels?: Record<string, string>
}

/* ═══ canonical vocabularies (labels + semantic tones; meaning never moves) ═ */

export const STAGE_SHORT: Record<string, string> = {
  ownership_confirmation: 'S1', offer_interest: 'S2', asking_price: 'S3', property_condition: 'S4', offer: 'S5',
  formal_contract: 'S6', disposition: 'S7', under_contract: 'S8', prepared_to_close: 'S9', closed: 'S10',
}
export const STAGE_ORDER = Object.keys(STAGE_SHORT)

/** Pipeline Command's waiting-on lanes — who has the ball now. */
export const LANES: ReadonlyArray<{ key: LaneKey; label: string; tone: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral' | 'cobalt'; hint: string }> = [
  { key: 'system', label: 'System handling', tone: 'exec', hint: 'The autopilot has the next step (scheduled or gated by the send gate).' },
  { key: 'seller', label: 'Waiting on seller', tone: 'cobalt', hint: 'We spoke last; the seller has the ball.' },
  { key: 'operator', label: 'Needs operator', tone: 'attn', hint: 'Review requested, an autopilot hold, or a reply nobody answered.' },
  { key: 'external', label: 'External wait', tone: 'flow', hint: 'Contract, buyer or title work outstanding (S6–S9).' },
  { key: 'blocked', label: 'Blocked', tone: 'crit', hint: 'Suppressed or blocked contact, a blocker, or automation overdue.' },
  { key: 'dormant', label: 'Dormant', tone: 'neutral', hint: 'Active on paper, untouched for 30+ days, nothing scheduled.' },
  { key: 'complete', label: 'Closed', tone: 'ok', hint: 'Closing evidence recorded.' },
]

/** Autopilot run outcomes (one class per run; held is not failed). */
export const RUN_CLASSES: ReadonlyArray<{ key: string; label: string; tone: 'exec' | 'neutral' | 'attn' | 'flow' | 'crit' | 'ok'; owner: string }> = [
  { key: 'executed', label: 'Executed by the system', tone: 'exec', owner: 'System' },
  { key: 'human_review', label: 'Routed to a person', tone: 'flow', owner: 'Operator' },
  { key: 'auto_reply_off', label: 'Auto-reply off — waits for operator', tone: 'attn', owner: 'Operator' },
  { key: 'send_gate', label: 'Held by the send gate', tone: 'neutral', owner: 'Brake' },
  { key: 'policy', label: 'Stopped by policy', tone: 'neutral', owner: 'Policy' },
  { key: 'failed', label: 'Failed', tone: 'crit', owner: 'Failure' },
  { key: 'other', label: 'Other', tone: 'neutral', owner: 'Other' },
]

/**
 * Delivery health, never merged: each class says what stopped the message.
 * `stage` places it in the flow (before the carrier, at the provider, at the
 * carrier) so unrelated failures never share a bar.
 */
export const DELIVERY_CLASSES: ReadonlyArray<{ key: string; label: string; stage: 'guard' | 'gate' | 'provider' | 'carrier'; tone: 'crit' | 'attn' | 'neutral' }> = [
  { key: 'carrier_spam_filter', label: 'Carrier content filter', stage: 'carrier', tone: 'crit' },
  { key: 'carrier_hard_bounce', label: 'Invalid destination (hard bounce)', stage: 'carrier', tone: 'crit' },
  { key: 'carrier_soft_bounce', label: 'Soft bounce', stage: 'carrier', tone: 'attn' },
  { key: 'carrier_dnc', label: 'Carrier DNC', stage: 'carrier', tone: 'crit' },
  { key: 'carrier_undelivered', label: 'Undelivered — carrier gave no reason', stage: 'carrier', tone: 'attn' },
  { key: 'provider_blacklist', label: 'Recipient blocked the sender (prior STOP)', stage: 'provider', tone: 'attn' },
  { key: 'provider_no_sid', label: 'Provider returned no message id', stage: 'provider', tone: 'crit' },
  { key: 'provider_timeout', label: 'Provider timeout', stage: 'provider', tone: 'crit' },
  { key: 'send_error', label: 'Internal send error', stage: 'provider', tone: 'crit' },
  { key: 'sender_health', label: 'Sender-health block', stage: 'guard', tone: 'attn' },
  { key: 'template_health', label: 'Template-health block', stage: 'guard', tone: 'attn' },
  { key: 'content_guard', label: 'Pre-send content guard', stage: 'guard', tone: 'neutral' },
  { key: 'duplicate_guard', label: 'Duplicate guard', stage: 'guard', tone: 'neutral' },
  { key: 'send_gate', label: 'Held by the send gate', stage: 'gate', tone: 'neutral' },
  { key: 'operator_review', label: 'Held for operator review', stage: 'gate', tone: 'neutral' },
]

/* ═══ funnel ══════════════════════════════════════════════════════════════ */

export interface FunnelStage {
  id: string
  label: string
  value: number | null
  /** share of the first stage */
  ofFirst: number | null
  /** the server's conversion from this stage's own base */
  retained: number | null
  /** the base the conversion is measured on (the previous stage when nested) */
  base: number | null
  /** people lost between the previous stage and this one, when the previous stage IS the base */
  dropped: number | null
  note?: string
  /** the seller cohort this stage selects when used as a filter */
  cohort: string | null
}
const COHORT_OF: Record<string, string> = { sellers_reached: 'reached', reached_replied: 'replied', interested_sellers: 'interested', opportunity_rate: 'opportunity', opted_out_sellers: 'opted_out' }

/** The server's funnel with share-of-first and drop-off from its own counts. */
export function funnelStages(steps: LabOverview['funnel']['steps']): FunnelStage[] {
  const first = steps[0]?.value ?? null
  return steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1].value : null
    return {
      id: s.id,
      label: s.label,
      value: s.value,
      ofFirst: first && s.value !== null ? s.value / first : null,
      retained: i === 0 ? null : s.conversion,
      base: s.base,
      dropped: i > 0 && prev !== null && s.value !== null && s.base === prev ? Math.max(0, prev - s.value) : null,
      note: s.note,
      cohort: COHORT_OF[s.id] || null,
    }
  })
}

/* ═══ trend ═══════════════════════════════════════════════════════════════ */

export type TrendPoint = SeriesPoint & { prev: SeriesPoint | null }
/** Current buckets with the comparison aligned by bucket index (the server sizes both alike). */
export function alignTrend(current: SeriesPoint[], comparison: SeriesPoint[] | null): TrendPoint[] {
  return current.map((p, i) => ({ ...p, prev: comparison?.[i] ?? null }))
}

/** "18 of 121 sellers reached" — the denominator, said, for a rate. */
export function denominatorLine(def: MetricDef | undefined, point: { num?: number; den?: number; n?: number } | null | undefined): string | null {
  if (!def || !point) return null
  if (def.unit === 'rate' && typeof point.num === 'number' && typeof point.den === 'number') {
    return `${point.num.toLocaleString('en-US')} of ${point.den.toLocaleString('en-US')} ${def.denominator?.label?.toLowerCase() || 'in the base'}`
  }
  if (def.unit === 'ratio' && typeof point.num === 'number' && typeof point.den === 'number') return `${point.num.toLocaleString('en-US')} ÷ ${point.den.toLocaleString('en-US')}`
  if (typeof point.n === 'number' && def.unit === 'duration_min') return `n = ${point.n.toLocaleString('en-US')}`
  return null
}

/** The largest named group in one stacked bucket (never "other" or unresolved). */
export function topOf(result: SeriesByResult | null | undefined, index: number): { key: string; label: string; value: number } | null {
  const b = result?.buckets?.[index]
  if (!b || !result?.keys) return null
  let best: { key: string; label: string; value: number } | null = null
  for (const k of result.keys) {
    if (k.key === '__other' || k.key === '__unresolved' || k.key === '__none' || k.test) continue
    const v = b.values[k.key] || 0
    if (v > 0 && (!best || v > best.value)) best = { key: k.key, label: k.label, value: v }
  }
  return best
}

/* ═══ change ══════════════════════════════════════════════════════════════ */

export const changeMagnitude = (c: WhatChanged) => (c.kind === 'rate' ? Math.abs(c.pts ?? 0) : Math.abs(c.delta ?? 0))
export function changeTone(c: Pick<WhatChanged, 'kind' | 'pts' | 'delta' | 'polarity'>): 'good' | 'bad' | 'neutral' {
  const d = c.kind === 'rate' ? c.pts ?? 0 : c.delta ?? 0
  if (!d || c.polarity === 'neutral') return 'neutral'
  return (d > 0) === (c.polarity === 'up') ? 'good' : 'bad'
}
export function changeText(c: Pick<WhatChanged, 'kind' | 'pts' | 'delta' | 'pct'>): string {
  if (c.kind === 'rate' && typeof c.pts === 'number') return `${c.pts > 0 ? '+' : '−'}${Math.abs(c.pts).toFixed(1)} pts`
  if (typeof c.delta === 'number') return `${c.delta > 0 ? '+' : '−'}${Math.abs(Math.round(c.delta)).toLocaleString('en-US')}`
  return '—'
}
/** The period's tested changes split by whether they help or hurt (neutral polarity listed apart). */
export function splitChanges(changes: WhatChanged[]) {
  const improved = changes.filter((c) => changeTone(c) === 'good')
  const degraded = changes.filter((c) => changeTone(c) === 'bad')
  const moved = changes.filter((c) => changeTone(c) === 'neutral')
  return { improved, degraded, moved }
}

/* ═══ misc ════════════════════════════════════════════════════════════════ */

export const isNamedKey = (k: string) => k !== '__unresolved' && k !== '__none' && k !== '__other'

/** Hero metrics in the brief's order — each a registry metric with an honest series. */
export const HERO_METRICS = ['sellers_reached', 'reached_replied', 'reply_rate', 'interested_sellers', 'opportunities_created', 'stage_advancements', 'transport_failures', 'opted_out_sellers', 'offers_issued'] as const

/** Metric families of the explorer, in reading order. */
export const FAMILY_ORDER = ['communication', 'delivery', 'pipeline', 'automation', 'buyers']
export const FAMILY_LABEL: Record<string, string> = { communication: 'Acquisition · seller response', delivery: 'Communications · delivery', pipeline: 'Pipeline', automation: 'Automation', buyers: 'Buyers' }

/* ═══ flow layout (pure) ═══════════════════════════════════════════════════ */

export type FlowNode = { id: string; column: number; label: string; value: number; tone: string; hint?: string }
export type FlowLink = { from: string; to: string; value: number }

export type Laid = FlowNode & { x: number; y: number; h: number }

export function layoutFlow(nodes: FlowNode[], links: FlowLink[], { width, height, nodeW = 10, gap = 10, columns, colX }: { width: number; height: number; nodeW?: number; gap?: number; columns: number; colX?: number[] }) {
  const cols = Array.from({ length: columns }, (_, c) => nodes.filter((n) => n.column === c && n.value > 0))
  const scale = Math.min(...cols.filter((c) => c.length).map((c) => (height - gap * (c.length - 1)) / Math.max(1, c.reduce((a, n) => a + n.value, 0))))
  // column positions: evenly spaced, or at the given fractions of the width (a label lane after a middle column)
  const xs = (c: number) => (columns <= 1 ? 0 : (colX && colX[c] !== undefined ? colX[c] : c / (columns - 1)) * (width - nodeW))
  const laid = new Map<string, Laid>()
  cols.forEach((col, c) => {
    const total = col.reduce((a, n) => a + n.value, 0) * scale + gap * Math.max(0, col.length - 1)
    let y = (height - total) / 2
    for (const n of col) {
      const h = Math.max(1.5, n.value * scale)
      laid.set(n.id, { ...n, x: xs(c), y, h })
      y += h + gap
    }
  })
  // ribbons stack in node order on both ends
  const outAt = new Map<string, number>()
  const inAt = new Map<string, number>()
  const ribbons = links.filter((l) => l.value > 0 && laid.has(l.from) && laid.has(l.to)).map((l) => {
    const a = laid.get(l.from) as Laid
    const b = laid.get(l.to) as Laid
    const w = l.value * scale
    const ya = a.y + (outAt.get(a.id) || 0)
    const yb = b.y + (inAt.get(b.id) || 0)
    outAt.set(a.id, (outAt.get(a.id) || 0) + w)
    inAt.set(b.id, (inAt.get(b.id) || 0) + w)
    const x0 = a.x + nodeW
    const x1 = b.x
    const mx = (x0 + x1) / 2
    const d = `M${x0},${ya}C${mx},${ya} ${mx},${yb} ${x1},${yb}L${x1},${yb + w}C${mx},${yb + w} ${mx},${ya + w} ${x0},${ya + w}Z`
    return { ...l, d, tone: b.tone }
  })
  return { nodes: [...laid.values()], ribbons, nodeW, xs }
}

/**
 * Label positions for a flow: each label sits at its node's centre unless that
 * would collide with the label above; a column that runs out of room pushes
 * back up from the bottom. Returns the label's centre y per node id.
 */
export function placeFlowLabels(nodes: Array<{ id: string; column: number; y: number; h: number }>, height: number, gap = 16): Map<string, number> {
  const out = new Map<string, number>()
  const byCol = new Map<number, Array<{ id: string; c: number }>>()
  for (const n of nodes) byCol.set(n.column, [...(byCol.get(n.column) || []), { id: n.id, c: n.y + n.h / 2 }])
  for (const list of byCol.values()) {
    list.sort((a, b) => a.c - b.c)
    const ys = list.map((n) => n.c)
    for (let i = 1; i < ys.length; i += 1) ys[i] = Math.max(ys[i], ys[i - 1] + gap)
    const bottom = height - gap / 2
    if (ys.length && ys[ys.length - 1] > bottom) {
      ys[ys.length - 1] = bottom
      for (let i = ys.length - 2; i >= 0; i -= 1) ys[i] = Math.min(ys[i], ys[i + 1] - gap)
    }
    list.forEach((n, i) => out.set(n.id, ys[i]))
  }
  return out
}

/* ═══ filters ═════════════════════════════════════════════════════════════ */

export type FilterDraft = LabFilter & { labels?: string[] }
export const OP_LABEL: Record<string, string> = {
  eq: 'is', neq: 'is not', in: 'is any of', not_in: 'is none of', gt: '>', lt: '<', between: 'between', exists: 'has a value', missing: 'is missing', before: 'before', after: 'after', is_true: 'is true', is_false: 'is false',
}

export function filterText(f: FilterDraft, fields: FilterFieldDef[]) {
  const def = fields.find((x) => x.id === f.field)
  const op = OP_LABEL[f.op] || f.op
  if (['exists', 'missing', 'is_true', 'is_false'].includes(f.op)) return { field: def?.label || f.field, value: op }
  const labels = f.labels?.length ? f.labels : Array.isArray(f.value) ? (f.value as unknown[]).map(String) : [String(f.value)]
  const v = f.op === 'between' && Array.isArray(f.value) ? `${(f.value as number[])[0]} – ${(f.value as number[])[1]}` : labels.length > 2 ? `${labels.slice(0, 2).join(', ')} +${labels.length - 2}` : labels.join(', ')
  return { field: def?.label || f.field, value: `${op === 'is' || op === 'is any of' ? '' : `${op} `}${v}${def?.unit === '%' && !Array.isArray(f.value) ? '%' : ''}` }
}

/* ═══ hand-off paths (the URL contracts other apps read) ═══════════════════ */

/** Workflow Studio's seller-autopilot view of one run (workflow-studio-routing: seller_automation, thread_key, execution_id). */
export const sellerAutomationPath = (r: Readonly<Record<string, unknown>>) =>
  `/workflow-studio?seller_automation=1&workflow=seller-inbound-v1${r.thread ? `&thread_key=${encodeURIComponent(String(r.thread))}` : ''}${r.id ? `&execution_id=${encodeURIComponent(String(r.id))}` : ''}`
