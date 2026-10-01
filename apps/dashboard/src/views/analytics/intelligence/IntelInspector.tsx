/**
 * THE ANALYTICAL INSPECTOR — contextual, never a permanent sidebar.
 *
 * One spatial surface (LCInspector) whose content follows what was picked:
 *   metric   KPI drilldown — value, change with its test, numerator ÷
 *            denominator (each opens its exact records), trend, the leading
 *            breakdown, and the registry definition (sources, time basis,
 *            exclusions, freshness, what changed from v1)
 *   bucket   one day / hour of the hero: its value, base, the same point of
 *            the previous period, its records — and "focus this day"
 *   event    an operational event (campaign lifecycle, a control change)
 *   group    a market / campaign / sender / template / state: its numbers,
 *            narrowing, and the hand-off to the app that owns it
 *   stage    a pipeline stage: evidence, who has the ball, money by basis,
 *            its deals (each opens in Pipeline)
 *   deal     one deal's money by basis, with its readiness reasons
 *   filters  the filter inspector
 * A stack with a back step, not a new page. Esc closes it (after any menu).
 */
import { useMemo } from 'react'
import type { BreakdownRow, LabQuery, MetricDef, MetricPair, SeriesPoint } from '../../../domain/analytics/analytics-lab-api'
import { fmtChange, fmtMetric, fmtP } from '../../../domain/analytics/analytics-lab-api'
import { LCButton, LCFacts, LCInspector, LCInspectorSection, LCSparkline, LCStatus, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import type { Subject } from './intel-context'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { usePipelineData } from './intel-hooks'
import type { MoneyDeal } from './intel-model'
import { LANES, STAGE_SHORT } from './intel-model'
import { fmtBucket, fmtDays, fmtInt, fmtMoney, fmtPct, fmtRange } from './intel-format'
import { serverContext } from './intel-state'
import { RankedBars } from './IntelCharts'
import { IntelFilters } from './IntelFilters'

type Props = { subject: Subject | null; canBack: boolean; onBack: () => void; onClose: () => void; mode: 'float' | 'dock'; onInspect: (s: Subject) => void }

export function IntelInspector({ subject, canBack, onBack, onClose, mode }: Props) {
  const { defs, dims } = useLab()
  const title = !subject ? '' : subject.kind === 'metric' ? defs[subject.id]?.label || subject.id
    : subject.kind === 'bucket' ? defs[subject.metric]?.label || subject.metric
      : subject.kind === 'event' ? (subject.group && subject.group.length > 1 ? `${subject.group.length} events` : subject.event.title)
        : subject.kind === 'group' ? subject.label
          : subject.kind === 'stage' ? `${STAGE_SHORT[subject.code] || ''} ${subject.code.replace(/_/g, ' ')}`
            : subject.kind === 'deal' ? subject.deal.address || 'Deal'
              : 'Filters'
  const eyebrow = !subject ? '' : subject.kind === 'metric' ? `${defs[subject.id]?.family || 'metric'} · definition and drilldown`
    : subject.kind === 'bucket' ? 'one bucket of the trend'
      : subject.kind === 'event' ? (subject.group && subject.group.length > 1 ? 'events too close on the time axis to tell apart' : `${subject.event.kind === 'campaign' ? 'campaign lifecycle' : 'control setting'} · event`)
        : subject.kind === 'group' ? `${dims[subject.dim]?.label || subject.dim}`
          : subject.kind === 'stage' ? 'pipeline stage · now and this period'
            : subject.kind === 'deal' ? 'deal · money by basis'
              : 'narrow the analytical slice'
  return (
    <LCInspector
      open={Boolean(subject)}
      onClose={onClose}
      id="intel-inspector"
      mode={mode}
      title={title}
      eyebrow={eyebrow}
      contentKey={subject ? JSON.stringify(subject).slice(0, 200) : 'none'}
      back={canBack ? { label: 'Back', onBack } : undefined}
      width={420}
      className="ix-insp"
    >
      {!subject ? null
        : subject.kind === 'metric' ? <MetricBody id={subject.id} />
          : subject.kind === 'bucket' ? <BucketBody metric={subject.metric} start={subject.start} end={subject.end} />
            : subject.kind === 'event' ? <EventBody subject={subject} />
              : subject.kind === 'group' ? <GroupBody dim={subject.dim} k={subject.key} label={subject.label} />
                : subject.kind === 'stage' ? <StageBody code={subject.code} />
                  : subject.kind === 'deal' ? <DealBody deal={subject.deal} />
                    : <IntelFilters />}
    </LCInspector>
  )
}

/* ── metric: the KPI drilldown ──────────────────────────────────────────── */

function MetricBody({ id }: { id: string }) {
  const { ctx, act, defs, dims, registry, overview, records } = useLab()
  const def = defs[id]
  const sCtx = serverContext(ctx, { metric: id, groupBy: null })
  const known = overview?.metrics[id] || null
  const q = useIntel<LabQuery>(known ? null : paths.query(sCtx, 'metric'))
  const pair: MetricPair | null = known || q.data?.metric || null
  const seriesQ = useIntel<LabQuery>(def ? paths.query(sCtx, 'series') : null)
  const firstDim = def?.dimensions.find((d) => d === 'market') || def?.dimensions[0] || null
  const bdQ = useIntel<LabQuery>(def && firstDim ? paths.query(serverContext(ctx, { metric: id, groupBy: firstDim, limit: 6 }), 'breakdown') : null)
  if (!def) return <p className="ix-note">This metric is not in the registry.</p>
  const cur = pair?.cur
  const rate = def.unit === 'rate'
  const tb = registry.timeBases[def.time_basis]
  const values = ((seriesQ.data?.result?.current as SeriesPoint[] | undefined) || []).map((p) => p.value)
  const recordable = cur && ['ok', 'insufficient_sample', 'no_data'].includes(cur.status)
  const numRef = def.numerator.metric ? defs[def.numerator.metric] : null
  const denRef = def.denominator?.metric ? defs[def.denominator.metric] : null
  const cmp = overview?.compare
  return (
    <>
      <div className="ix-insp__value">
        <b>{cur ? (cur.status === 'not_applicable' || cur.status === 'unavailable' ? '—' : fmtMetric(def, cur.value)) : '…'}</b>
        {pair?.change?.comparable ? <span className={cx('ix-delta', `is-${changeToneOf(def, pair)}`)}>{fmtChange(def, pair.change)}<small>{pair.change.significant ? 'significant' : 'within normal variation'}</small></span> : null}
        {values.filter((v) => v !== null).length > 1 ? <LCSparkline values={values} label={`${def.label} over the period`} width={120} height={30} /> : null}
      </div>
      {cur?.reason ? <p className="ix-note">{cur.reason}</p> : null}
      {cur && (rate || def.unit === 'ratio') ? (
        <div className="ix-insp__ops">
          <button type="button" disabled={!recordable} onClick={() => records({ cohort: { metric: id, part: 'numerator' }, title: `${def.label} · numerator` })}>
            <span>Numerator</span><b>{fmtInt(cur.num)}</b><em>{def.numerator.label}</em><small>Records <Icon name="chevron-right" size={11} /></small>
          </button>
          <i aria-hidden="true">÷</i>
          <button type="button" disabled={!recordable} onClick={() => records({ cohort: { metric: id, part: 'denominator' }, title: `${def.label} · denominator` })}>
            <span>Denominator</span><b>{fmtInt(cur.den)}</b><em>{def.denominator?.label}</em><small>Records <Icon name="chevron-right" size={11} /></small>
          </button>
        </div>
      ) : cur ? (
        <div className="ix-insp__ops is-single">
          <button type="button" disabled={!recordable} onClick={() => records({ cohort: { metric: id }, title: def.label })}>
            <span>{def.unit === 'duration_min' ? 'Sample' : 'Records'}</span><b>{fmtInt(def.unit === 'duration_min' ? cur.n : cur.value)}</b><em>{def.numerator.label}</em><small>Records <Icon name="chevron-right" size={11} /></small>
          </button>
        </div>
      ) : null}
      <LCInspectorSection title="Period and comparison">
        <LCFacts rows={[
          { label: 'Period', value: overview ? fmtRange(overview.period.start, overview.period.end, ctx.tz) : null },
          { label: 'Comparison', value: cmp?.available ? `${fmtRange(cmp.start, cmp.end, ctx.tz)} · ${pair?.prev ? fmtMetric(def, pair.prev.value) : '—'}${rate && pair?.prev?.den !== undefined ? ` (${fmtInt(pair.prev.num)} / ${fmtInt(pair.prev.den)})` : ''}` : cmp?.reason || 'none' },
          { label: 'Test', value: pair?.change?.comparable ? `${fmtP(pair.change.p) || 'no test for this unit'}${pair.change.ciPts ? ` · 95% CI of the difference ${pair.change.ciPts[0].toFixed(1)} to ${pair.change.ciPts[1].toFixed(1)} pts` : ''}` : pair?.change?.reason || null },
          ...(rate && cur?.ci ? [{ label: '95% interval', value: `${fmtMetric(def, cur.ci.low)} – ${fmtMetric(def, cur.ci.high)} (Wilson)` }] : []),
          ...(def.unit === 'duration_min' && cur?.dist ? [{ label: 'Distribution', value: `P25 ${fmtMetric(def, cur.dist.p25)} · median ${fmtMetric(def, cur.dist.p50)} · P75 ${fmtMetric(def, cur.dist.p75)} · n ${cur.dist.n}` }] : []),
          ...(def.min_sample ? [{ label: 'Minimum sample', value: `${def.min_sample} — below it, a rate is shown but never called a finding` }] : []),
        ]} />
      </LCInspectorSection>
      {firstDim ? (
        <LCInspectorSection title={`By ${(dims[firstDim]?.label || firstDim).toLowerCase()}`} aside={<button type="button" className="ix-link" onClick={() => act.setMetric(id, { groupBy: firstDim })}>Break down in the hero</button>}>
          {((bdQ.data?.result?.rows || []) as BreakdownRow[]).length
            ? <RankedBars rows={(bdQ.data?.result?.rows || []) as BreakdownRow[]} unit={def.unit} format={(v) => fmtMetric(def, v)} maxRows={6} compact onPick={(r) => act.pushSegment({ dim: firstDim, value: r.key, label: r.label })} />
            : <p className="ix-note">{bdQ.loading ? 'Reading…' : 'No groups in this slice.'}</p>}
        </LCInspectorSection>
      ) : null}
      <LCInspectorSection title={<>Definition <span className="ix-muted">{def.version}</span></>}>
        <p className="ix-insp__def">{def.description}</p>
        <LCFacts rows={[
          { label: 'Numerator', value: numRef ? <button type="button" className="ix-link" onClick={() => act.setMetric(numRef.id)}>{numRef.label}</button> : def.numerator.def || def.numerator.label },
          ...(def.denominator ? [{ label: 'Denominator', value: denRef ? denRef.label : def.denominator.def || def.denominator.label }] : []),
          { label: 'Placed in time by', value: tb ? `${tb.label} — ${tb.column}` : def.time_basis, hint: tb?.why },
          { label: 'Sources', value: def.sources.join(' · ') },
          ...(def.exclusions.length ? [{ label: 'Excluded', value: def.exclusions.join(' ') }] : []),
          ...(def.caveat ? [{ label: 'Caveat', value: def.caveat }] : []),
          { label: 'Missing data', value: def.null_behavior },
          { label: 'Freshness', value: def.freshness.note },
          { label: 'Changed from v1', value: def.v1.note || def.v1.status },
        ]} />
      </LCInspectorSection>
      <LCInspectorSection title="Use it">
        <div className="ix-insp__acts">
          <LCButton size="sm" variant="secondary" icon="trending-up" onClick={() => act.setMetric(id)} disabled={ctx.metric === id}>Trend in the hero</LCButton>
          {def.dimensions.slice(0, 10).map((d) => <button key={d} type="button" className={cx('ix-chip is-small', ctx.metric === id && ctx.groupBy === d && 'is-on')} onClick={() => act.setMetric(id, { groupBy: d })}>{dims[d]?.label || d}</button>)}
        </div>
      </LCInspectorSection>
    </>
  )
}
const changeToneOf = (def: MetricDef, p: MetricPair) => {
  if (!p.change.comparable || def.polarity === 'neutral') return 'neutral'
  const d = p.change.kind === 'rate' ? p.change.pts ?? 0 : p.change.delta ?? 0
  return !d ? 'neutral' : (d > 0) === (def.polarity === 'up') ? 'good' : 'bad'
}

/* ── one bucket ──────────────────────────────────────────────────────────── */

function BucketBody({ metric, start, end }: { metric: string; start: number; end: number }) {
  const { ctx, act, defs, overview, records } = useLab()
  const def = defs[metric]
  const q = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric, groupBy: null }), 'series'))
  const cur = (q.data?.result?.current as SeriesPoint[] | undefined) || []
  const i = cur.findIndex((p) => p.start === start)
  const p = i >= 0 ? cur[i] : null
  const prev = i >= 0 ? ((q.data?.result?.comparison as SeriesPoint[] | null | undefined)?.[i] ?? null) : null
  const grain = String(q.data?.result?.grain || overview?.grain.grain || 'day')
  const rate = def?.unit === 'rate'
  const bucket = { start: new Date(start).toISOString(), end: new Date(end).toISOString() }
  return (
    <>
      <div className="ix-insp__value"><b>{p ? fmtMetric(def, p.value) : '…'}</b><span className="ix-muted">{fmtBucket(start, grain, ctx.tz, true)}</span></div>
      <LCFacts rows={[
        ...(rate ? [{ label: def?.numerator.label || 'Numerator', value: p ? fmtInt(p.num) : null }, { label: def?.denominator?.label || 'Denominator', value: p ? fmtInt(p.den) : null }] : [{ label: 'Count', value: p ? fmtInt(p.value) : null }]),
        ...(rate && p?.ci ? [{ label: '95% interval', value: `${fmtMetric(def, p.ci.low)} – ${fmtMetric(def, p.ci.high)}` }] : []),
        { label: 'Same point, previous period', value: prev ? `${fmtMetric(def, prev.value)} · ${fmtBucket(prev.start, grain, ctx.tz, true)}` : null },
      ]} />
      {rate && p && p.den !== undefined && def?.min_sample && p.den < def.min_sample ? <p className="ix-note">n = {p.den} is below the {def.min_sample} this rate needs; one bucket of it is noise more than signal.</p> : null}
      <div className="ix-insp__acts">
        <LCButton size="sm" variant="secondary" icon="list" onClick={() => records({ cohort: { metric, part: rate ? 'numerator' : undefined, bucket }, title: `${def?.label} · ${fmtBucket(start, grain, ctx.tz, true)}` })}>{rate ? 'Numerator records' : 'Records'}</LCButton>
        {rate ? <LCButton size="sm" variant="quiet" onClick={() => records({ cohort: { metric, part: 'denominator', bucket }, title: `${def?.denominator?.label} · ${fmtBucket(start, grain, ctx.tz, true)}` })}>Denominator records</LCButton> : null}
        <LCButton size="sm" variant="quiet" icon="calendar" onClick={() => act.setRange('custom', bucket)} title="Make this bucket the analysed period (compared with the one before it)">Focus this {grain}</LCButton>
      </div>
    </>
  )
}

/* ── an operational event ────────────────────────────────────────────────── */

function EventBody({ subject }: { subject: Extract<Subject, { kind: 'event' }> }) {
  const { ctx, act, inspect } = useLab()
  const e = subject.event
  if (subject.group && subject.group.length > 1) {
    return (
      <ol className="ix-insp__events">
        {subject.group.map((g) => (
          <li key={g.id}>
            <button type="button" onClick={() => inspect({ kind: 'event', event: g })}>
              <LCStatus tone={g.tone === 'neutral' ? 'neutral' : g.tone} label={g.kind === 'campaign' ? 'Campaign' : 'Control'} />
              <span><b>{g.title}</b><small>{g.subject}</small></span>
              <time dateTime={g.at}>{new Date(g.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: ctx.tz })}</time>
            </button>
          </li>
        ))}
      </ol>
    )
  }
  return (
    <>
      <div className="ix-insp__value"><LCStatus tone={e.tone === 'neutral' ? 'neutral' : e.tone} label={e.kind === 'campaign' ? 'Campaign' : 'Control'} /><span className="ix-muted">{new Date(e.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: ctx.tz })}</span></div>
      <p className="ix-insp__def"><b>{e.subject}</b></p>
      {e.detail ? <p className="ix-note">{e.detail}</p> : null}
      {e.items?.length ? <LCFacts rows={e.items.map((i) => ({ label: i.label, value: i.value }))} /> : null}
      {e.repeats ? <p className="ix-note">Repeated {e.repeats} more time{e.repeats === 1 ? '' : 's'} within the hour (folded into one event).</p> : null}
      {e.note ? <p className="ix-note">{e.note}</p> : null}
      <p className="ix-muted ix-insp__src">Source: {e.source}</p>
      {e.campaignId ? (
        <div className="ix-insp__acts">
          <LCButton size="sm" variant="secondary" icon="arrow-up-right" onClick={() => pushRoutePath(`/campaign-command?campaign=${encodeURIComponent(e.campaignId as string)}`)}>Open in Campaign Command</LCButton>
          <LCButton size="sm" variant="quiet" icon="filter" onClick={() => act.pushSegment({ dim: 'campaign', value: e.campaignId as string, label: e.subject })}>Narrow the Lab to it</LCButton>
        </div>
      ) : null}
    </>
  )
}

/* ── a group: market / campaign / sender / template / state … ──────────── */

const GROUP_METRICS = ['sellers_reached', 'reply_rate', 'interest_rate', 'opt_out_rate', 'opportunity_rate', 'messages_sent', 'delivery_rate', 'content_filter_rate']
function GroupBody({ dim, k, label }: { dim: string; k: string; label: string }) {
  const { ctx, act, defs, dims, records } = useLab()
  const valid = GROUP_METRICS.filter((id) => defs[id]?.dimensions.includes(dim))
  const q = useIntel<LabQuery>(valid.length ? paths.query(serverContext(ctx, { metric: valid[0], groupBy: dim, limit: 500, metrics: valid }), 'table') : null)
  type Row = { key: string; label: string; values: Record<string, { value: number | null; num: number | null; den: number | null; n: number; insufficient?: boolean }>; prev?: Record<string, { value: number | null }> | null }
  const row = ((q.data?.result?.rows || []) as unknown as Row[]).find((r) => String(r.key) === String(k)) || null
  const { money } = usePipelineData()
  const market = dim === 'market' ? money?.markets.find((m) => m.key === k) : null
  return (
    <>
      <LCFacts rows={valid.map((id) => {
        const v = row?.values[id]
        const d = defs[id]
        return { label: d.label, value: v ? `${fmtMetric(d, v.value)}${d.unit === 'rate' ? ` · ${fmtInt(v.num)} / ${fmtInt(v.den)}${v.insufficient ? ' · small sample' : ''}` : ''}${row?.prev?.[id] ? ` (prev ${fmtMetric(d, row.prev[id].value)})` : ''}` : q.loading ? '…' : null }
      })} />
      {market ? (
        <LCInspectorSection title="Pipeline here · now">
          <LCFacts rows={[
            { label: 'Active deals', value: fmtInt(market.deals) },
            { label: 'County / AVM estimate', value: market.record.n ? `${fmtMoney(market.record.sum)} · ${market.record.n} deals` : null },
            { label: 'Authorized engine offers', value: market.authorized.n ? `${fmtMoney(market.authorized.offer)} · ${market.authorized.n} deals` : '$0' },
            { label: 'Needs validation', value: fmtInt(market.needsValidation) },
          ]} />
        </LCInspectorSection>
      ) : null}
      <div className="ix-insp__acts">
        <LCButton size="sm" variant="primary" icon="filter" onClick={() => act.pushSegment({ dim, value: k, label })}>Narrow the Lab to {label}</LCButton>
        <LCButton size="sm" variant="secondary" icon="list" onClick={() => records({ cohort: { metric: 'sellers_reached', group: { dim, key: k, label } }, title: `Sellers reached · ${label}` })}>Sellers reached</LCButton>
        {dim === 'campaign' ? <LCButton size="sm" variant="quiet" icon="arrow-up-right" onClick={() => pushRoutePath(`/campaign-command?campaign=${encodeURIComponent(k)}`)}>Open in Campaign Command</LCButton> : null}
      </div>
      <p className="ix-muted ix-insp__src">{dims[dim]?.source}</p>
    </>
  )
}

/* ── a pipeline stage ────────────────────────────────────────────────────── */

function StageBody({ code }: { code: string }) {
  const { inspect, records } = useLab()
  const { stages, money } = usePipelineData()
  const s = stages?.current.find((x) => x.code === code) || null
  const m = money?.stages.find((x) => x.code === code) || null
  const deals = useMemo(() => (money?.deals || []).filter((d) => d.stage === code), [money, code])
  return (
    <>
      <div className="ix-insp__value"><b>{m ? fmtInt(m.deals) : '…'}</b><span className="ix-muted">active deals now</span></div>
      {m ? (
        <div className="ix-lanes" aria-label="Who has the ball">
          {LANES.filter((l) => m.lanes[l.key]).map((l) => <span key={l.key} data-tone={l.tone} title={l.hint}><i />{l.label}<b>{m.lanes[l.key]}</b></span>)}
        </div>
      ) : null}
      <LCInspectorSection title="Evidence">
        <LCFacts rows={[
          { label: 'Entered this period', value: s ? `${fmtInt(s.entered)} (${s.enteredBySystem} by the autopilot · ${s.enteredByHuman} by an operator)` : null },
          { label: 'Exited this period', value: s ? `${fmtInt(s.exits)}${s.backward ? ` · ${s.backward} moved back` : ''}` : null },
          { label: 'Forward share of exits', value: s && s.forwardShare !== null ? `${fmtPct(s.forwardShare, 0)} (${s.forward} of ${s.exits})` : null },
          { label: 'Dwell (median · P75)', value: s?.dwell.n ? `${fmtDays(s.dwell.p50)} · ${fmtDays(s.dwell.p75)} · n ${s.dwell.n}` : null },
          { label: 'Live deal age (median · P75)', value: s?.liveAge.n ? `${fmtDays(s.liveAge.p50)} · ${fmtDays(s.liveAge.p75)} · n ${s.liveAge.n}` : null },
          { label: 'Past the stage clock', value: s?.stallThresholdDays ? `${fmtInt(s.stalled)} of ${fmtInt(s.live)} live > ${s.stallThresholdDays} days` : null },
        ]} />
      </LCInspectorSection>
      {m ? (
        <LCInspectorSection title="Money here · by basis">
          <LCFacts rows={[
            { label: 'County / AVM estimate', value: m.record.n ? `${fmtMoney(m.record.sum)} · ${m.record.n} of ${m.deals}` : null },
            { label: 'Seller asking (stated)', value: m.asking.n ? `${fmtMoney(m.asking.sum)} · ${m.asking.n}${m.askingImplausible ? ` · ${m.askingImplausible} implausible excluded` : ''}` : null },
            { label: 'Authorized engine offers', value: m.authorized.n ? `${fmtMoney(m.authorized.offer)} · ${m.authorized.n} deals` : '$0' },
            { label: 'Needs validation', value: `${fmtInt(m.needsValidation)} deals (not summed)` },
            { label: 'Presented · contract · actual', value: `${fmtMoney(m.presented.sum, { zero: '$0' })} · ${fmtMoney(m.contract.sum, { zero: '$0' })} · ${fmtMoney(m.actual.sum, { zero: '$0' })}` },
          ]} />
        </LCInspectorSection>
      ) : null}
      <LCInspectorSection title={`Deals · ${fmtInt(deals.length)}`}>
        <ul className="ix-insp__deals">
          {deals.slice(0, 14).map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => inspect({ kind: 'deal', deal: d })}>
                <span>{d.address || 'Address not recorded'}</span>
                <em>{d.market || 'unresolved'} · {fmtInt(d.daysInStage)}d{d.stall ? ` · ${d.stall}` : ''}</em>
                <b>{d.engine.state === 'authorized' ? fmtMoney(d.engine.recommended) : d.record ? fmtMoney(d.record) : '—'}</b>
              </button>
            </li>
          ))}
        </ul>
        {deals.length > 14 ? <p className="ix-note">{deals.length - 14} more in the Financial lens.</p> : null}
      </LCInspectorSection>
      <div className="ix-insp__acts">
        <LCButton size="sm" variant="secondary" icon="list" onClick={() => records({ cohort: { metric: 'stage_advancements', group: { dim: 'stage', key: code, label: s?.label || code } }, title: `Forward moves into ${s?.label || code}` })}>Moves into this stage</LCButton>
        <LCButton size="sm" variant="quiet" icon="arrow-up-right" onClick={() => pushRoutePath('/pipeline')}>Open Pipeline</LCButton>
      </div>
    </>
  )
}

/* ── one deal ────────────────────────────────────────────────────────────── */

function DealBody({ deal }: { deal: MoneyDeal }) {
  const lane = LANES.find((l) => l.key === deal.lane?.key)
  return (
    <>
      <div className="ix-insp__value"><span className="ix-stage">{STAGE_SHORT[deal.stage]}</span><span className="ix-muted">{deal.market || 'market unresolved'} · {fmtInt(deal.daysInStage)} days in stage</span></div>
      {lane ? <LCStatus tone={lane.tone === 'cobalt' ? 'exec' : lane.tone} label={lane.label} /> : null}
      <LCInspectorSection title="Money · each basis apart">
        <LCFacts rows={[
          { label: 'Seller asking · stated', value: deal.asking ? `${fmtMoney(deal.asking)}${deal.askImplausible ? ' · implausible capture (excluded from totals)' : ''}` : null },
          { label: 'County / AVM estimate', value: deal.record ? fmtMoney(deal.record) : null },
          { label: 'Engine valuation · modeled', value: deal.engine.valuation ? fmtMoney(deal.engine.valuation) : null },
          { label: 'Engine offer', value: deal.engine.state === 'not_priced' ? 'not priced' : `${fmtMoney(deal.engine.recommended)} · ${deal.engine.state === 'authorized' ? 'authorized' : 'needs validation'}` },
          { label: 'Modeled assignment fee', value: deal.engine.fee ? fmtMoney(deal.engine.fee) : null },
          { label: 'Presented offer', value: deal.presented ? fmtMoney(deal.presented) : null },
          { label: 'Contract', value: deal.contract ? fmtMoney(deal.contract) : null },
          { label: 'Actual settled', value: deal.actual ? fmtMoney(deal.actual) : null },
        ]} />
        {deal.engine.reasons.length ? <ul className="ix-insp__reasons">{deal.engine.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
      </LCInspectorSection>
      <div className="ix-insp__acts">
        <LCButton size="sm" variant="primary" icon="arrow-up-right" onClick={() => pushRoutePath(`/pipeline?opp=${encodeURIComponent(deal.id)}`)}>Open in Pipeline</LCButton>
        {deal.threadKey ? <LCButton size="sm" variant="secondary" icon="message" onClick={() => pushRoutePath(`/inbox?thread=${encodeURIComponent(deal.threadKey as string)}`)}>Conversation</LCButton> : null}
        {deal.propertyId ? <LCButton size="sm" variant="quiet" icon="users" onClick={() => pushRoutePath(`/buyer-match?property_id=${encodeURIComponent(deal.propertyId as string)}`)}>Buyer Match</LCButton> : null}
      </div>
    </>
  )
}
