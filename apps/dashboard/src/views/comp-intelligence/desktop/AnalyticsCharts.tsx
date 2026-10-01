import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import {
  engineAgeMonths, fmtDate, fmtMiles, fmtMoney, fmtUnitValue, median, recencyStepOf, recencySteps, subjectImplied, unitValue,
} from '../../../domain/comp-intelligence/comps-workstation-model'
import type { Tier, Workstation } from './derive-workstation'
import type { FocusStore } from './focus-store'
import { ChartFrame, LegendKey } from './charts/chart-kit'
import { DistanceScoreScatter } from './charts/DistanceScoreScatter'
import { EvidenceStrip, type StripPoint, type StripTier } from './charts/EvidenceStrip'
import { RecencyBars } from './charts/RecencyBars'

const TIER_WORD: Record<Tier, string> = { set: 'in the set', added: 'added by you', removed: 'removed by you', candidate: 'candidate', excluded: 'excluded' }

function tip(c: EvidenceComp, tier: Tier, value: string) {
  return (
    <>
      <b className="ciw-num-strong">{value}</b>
      <span>{c.address ?? 'Comparable sale'}</span>
      <span className="lc-num">{[fmtDate(c.saleDate, 'long'), fmtMiles(c.distanceMiles), TIER_WORD[tier]].filter(Boolean).join(' · ')}</span>
    </>
  )
}

/**
 * The evidence, charted — each with one job (§189):
 *   adjusted values  where the evidence puts the subject, and which sales pull
 *   unit values      the $/sf (or $/unit, $/acre) the set implies vs the subject
 *   distance × score whether the evidence is close AND comparable
 *   recency          how fresh it is, in the engine's own recency steps
 */
export function AnalyticsCharts({ m, store, layout }: { m: Workstation; store: FocusStore; layout: 'column' | 'grid' | 'inline' }) {
  const shown = [...m.lensComps, ...m.removed, ...m.candidates]
  const tierOf = (c: EvidenceComp): StripTier => (m.tiers.get(c.key) as StripTier) ?? 'candidate'

  const adjPoints: StripPoint[] = shown.filter((c) => c.engine?.eligible && c.engine.adjustedPrice).map((c) => ({
    key: c.key, value: c.engine!.adjustedPrice as number, tier: tierOf(c), weight: c.engine?.weight ?? null,
    flagged: tierOf(c) !== 'candidate' && Boolean(m.band && c.engine?.adjustedPrice && (c.engine.adjustedPrice < m.band.low || c.engine.adjustedPrice > m.band.high)),
    tip: tip(c, tierOf(c), `${fmtMoney(c.engine!.adjustedPrice, { exact: true })} adjusted`),
  }))
  const c = m.w.conclusion
  const op = m.operatorReplay?.result ?? null
  const adjRefs = [
    ...(m.comparableValuation && c?.valueMid ? [{ id: 'engine', label: 'Engine', value: c.valueMid, tone: 'engine' as const }] : []),
    ...(op && m.operatorKeys ? [{ id: 'operator', label: 'Your set', value: op.mid, tone: 'operator' as const }] : []),
  ]
  const adjBands = [
    ...(m.comparableValuation && c?.valueLow && c.valueHigh ? [{ id: 'engine', label: 'engine range', low: c.valueLow, high: c.valueHigh, tone: 'engine' as const }] : []),
    ...(m.band ? [{ id: 'mad', label: 'outlier band', low: m.band.low, high: m.band.high, tone: 'attn' as const }] : []),
  ]

  const unitPoints: StripPoint[] = shown.map((x) => ({ x, u: unitValue(x, m.metric) })).filter((p) => p.u !== null).map(({ x, u }) => ({
    key: x.key, value: u as number, tier: tierOf(x), tip: tip(x, tierOf(x), `${fmtUnitValue(u, m.metric)}${m.metric.short}`),
  }))
  const setUnits = m.lensComps.map((x) => unitValue(x, m.metric)).filter((v): v is number => v !== null)
  const setMedian = median(setUnits)
  const implied = m.comparableValuation ? subjectImplied(c?.valueMid ?? null, m.w.subject, m.metric) : null
  const unitRefs = [
    ...(setMedian !== null ? [{ id: 'median', label: 'Set median', value: setMedian, tone: 'engine' as const }] : []),
    ...(implied !== null ? [{ id: 'implied', label: 'Subject implied', value: implied, tone: 'subject' as const }] : []),
  ]

  const scatter = shown.filter((x) => x.engine?.eligible && x.engine.score !== null && x.engine.score !== undefined && x.distanceMiles !== null).map((x) => ({
    key: x.key, distance: x.distanceMiles as number, score: x.engine!.score as number, weight: x.engine?.weight ?? null, tier: tierOf(x),
    tip: tip(x, tierOf(x), `score ${Math.round(x.engine!.score as number)} · ${fmtMiles(x.distanceMiles)}`),
  }))

  const steps = recencySteps(m.rules)
  const columns = steps.map((step) => ({ step, set: 0, candidates: 0 }))
  for (const x of [...m.lensComps, ...m.candidates]) {
    const st = recencyStepOf(steps, engineAgeMonths(x.saleDate, m.now))
    const col = st ? columns.find((k) => k.step.id === st.id) : null
    if (!col) continue
    if (m.lensKeys.has(x.key)) col.set += 1
    else col.candidates += 1
  }

  const legend = (
    <span className="ciw-legend-inline">
      <LegendKey tone="set">shown set</LegendKey>
      {m.added.size ? <LegendKey tone="added" shape="ring">added</LegendKey> : null}
      {m.removed.length ? <LegendKey tone="set" shape="ring">removed</LegendKey> : null}
      <LegendKey tone="cand">candidates</LegendKey>
    </span>
  )

  return (
    <div className={`ciw-analytics is-${layout}`}>
      <ChartFrame title="Adjusted to the subject" aside={legend} note={m.band ? <>Each sale re-priced to the subject by the engine. Amber ring: a comp in the shown set outside the engine’s outlier band ({fmtMoney(m.band.low)}–{fmtMoney(m.band.high)}) from its stored run.</> : 'Each sale re-priced to the subject by the engine’s adjustment blend.'}>
        {adjPoints.length ? <EvidenceStrip points={adjPoints} refs={adjRefs} bands={adjBands} store={store} format={(v) => fmtMoney(v) ?? ''} ariaLabel={`Adjusted values of ${adjPoints.length} sales`} /> : <p className="ciw-muted">No sale here could be adjusted to the subject.</p>}
      </ChartFrame>
      <ChartFrame title={`${m.metric.label} as sold`} note={implied !== null ? `Subject implied = engine central ÷ the subject’s ${m.metric.basis}. Recorded price ÷ recorded size; sales without a size are left out, sales beyond the axis are pinned at its edge (dashed).` : 'Recorded price ÷ recorded size; sales without a size are left out, sales beyond the axis are pinned at its edge (dashed).'}>
        {unitPoints.length ? <EvidenceStrip points={unitPoints} refs={unitRefs} bands={[]} store={store} format={(v) => fmtUnitValue(v, m.metric) ?? ''} ariaLabel={`${m.metric.label} of ${unitPoints.length} sales`} /> : <p className="ciw-muted">No sale in view records a size to divide by.</p>}
      </ChartFrame>
      <ChartFrame title="Distance × comparability" aside={<span className="ciw-chart__aside">marker size = engine weight</span>} note="Comparability is the engine’s own feature-match score (0–100). The vertical rule is the search radius.">
        {scatter.length ? <DistanceScoreScatter points={scatter} radius={m.w.query.radiusMiles} minScore={m.rules?.minCompScore ?? 30} store={store} /> : <p className="ciw-muted">No scored sales to plot.</p>}
      </ChartFrame>
      {columns.length ? (
        <ChartFrame title="Sale age · engine recency steps" aside={<span className="ciw-legend-inline"><LegendKey tone="set" shape="band">shown set</LegendKey><LegendKey tone="cand" shape="band">other admissible</LegendKey></span>}>
          <RecencyBars columns={columns} />
        </ChartFrame>
      ) : null}
    </div>
  )
}
