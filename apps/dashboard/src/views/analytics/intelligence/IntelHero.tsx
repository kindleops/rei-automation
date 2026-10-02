/**
 * THE HERO — one analytical surface that morphs between metrics.
 *
 * The headline follows the crosshair: scrub a day and the number, its
 * denominator, the same day of the previous period and that day's context
 * (reached · replied · interested · leading market · leading campaign)
 * all move to it. At rest it states the period and its change against the
 * comparison window, with the test result rather than a vibe.
 *
 * Every element leads somewhere: the metric name opens its definition, a
 * bucket opens its records, a pin opens its event, a breakdown row narrows
 * the whole Lab.
 */
import { useMemo, useState } from 'react'
import type { BreakdownRow, SeriesPoint } from '../../../domain/analytics/analytics-lab-api'
import { fmtChange, fmtMetric, fmtP } from '../../../domain/analytics/analytics-lab-api'
import { LCCounter, LCSegmented, LCSelect, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import type { EventsResult, SeriesByResult, TrendPoint } from './intel-model'
import { HERO_METRICS, alignTrend, denominatorLine, topOf } from './intel-model'
import { fmtBucket, fmtInt, fmtRange } from './intel-format'
import { serverContext, sliceKey } from './intel-state'
import { metricFormat, metricTick } from './intel-hooks'
import { IntelColumns, IntelTrend, IntelTrendTable } from './IntelTrend'
import { RankedBars } from './IntelCharts'
import type { LabQuery } from '../../../domain/analytics/analytics-lab-api'

const UNIT_SUFFIX: Record<string, string> = { rate: '%', duration_min: ' min' }

type Props = { variant?: 'overview' | 'lens'; metrics?: readonly string[]; height?: number }

export function IntelHero({ variant = 'overview', metrics = HERO_METRICS, height }: Props) {
  const { ctx, act, defs, dims, overview, inspect, records, refreshing } = useLab()
  const options = metrics.filter((id) => defs[id])
  const metric = defs[ctx.metric] ? ctx.metric : 'reply_rate'
  const def = defs[metric]
  const isRate = def?.unit === 'rate'
  const own = overview?.trend.metric === metric

  // the hero's own series when the overview carries another metric
  const sCtx = serverContext(ctx, { metric, groupBy: null })
  const seriesQ = useIntel<LabQuery>(own || !overview ? null : paths.query(sCtx, 'series'))
  const pairQ = useIntel<LabQuery>(overview && !overview.metrics[metric] ? paths.query(sCtx, 'metric') : null)
  const trend = own && overview ? overview.trend : null
  const own2 = seriesQ.data?.result || null
  const series = useMemo(() => (trend
    ? { current: trend.current, comparison: trend.comparison, grain: trend.grain }
    : own2
      ? { current: (own2.current as SeriesPoint[]) || [], comparison: (own2.comparison as SeriesPoint[] | null) ?? null, grain: String(own2.grain || 'day') }
      : null), [trend, own2])
  const pair = overview?.metrics[metric] || pairQ.data?.metric || null
  const points = useMemo<TrendPoint[]>(() => (series ? alignTrend(series.current, series.comparison) : []), [series])

  // operational events in the window (pins)
  const evQ = useIntel<LabQuery>(overview ? paths.query(serverContext(ctx, { metric: 'reply_rate', groupBy: null }), 'events') : null)
  const events = (evQ.data?.result as unknown as EventsResult | null)?.events || []

  // scrubbing: the headline follows the crosshair; context loads on first interaction
  const resetKey = `${metric}|${sliceKey(ctx)}`
  const [scrub, setScrub] = useState<{ key: string; i: number | null; engaged: boolean }>({ key: resetKey, i: null, engaged: false })
  if (scrub.key !== resetKey) setScrub({ key: resetKey, i: null, engaged: scrub.engaged })
  const active = scrub.key === resetKey ? scrub.i : null
  const onActive = (i: number | null) => setScrub({ key: resetKey, i, engaged: true })

  const cxCtx = serverContext(ctx, { groupBy: null })
  const want = scrub.engaged && Boolean(overview)
  const reachedQ = useIntel<LabQuery>(want ? paths.query({ ...cxCtx, metric: 'sellers_reached' }, 'series') : null)
  const repliedQ = useIntel<LabQuery>(want ? paths.query({ ...cxCtx, metric: 'reached_replied' }, 'series') : null)
  const interestedQ = useIntel<LabQuery>(want ? paths.query({ ...cxCtx, metric: 'interested_sellers' }, 'series') : null)
  const byMarketQ = useIntel<LabQuery>(want ? paths.query({ ...cxCtx, metric: 'sellers_reached', groupBy: 'market', limit: 8 }, 'seriesBy') : null)
  const byCampaignQ = useIntel<LabQuery>(want ? paths.query({ ...cxCtx, metric: 'sellers_reached', groupBy: 'campaign', limit: 8 }, 'seriesBy') : null)
  const at = (q: { data: LabQuery | null }, i: number) => ((q.data?.result?.current as SeriesPoint[] | undefined)?.[i]?.value ?? null)

  const point = active !== null ? points[active] ?? null : null
  const headline = point ? point.value : pair?.cur.value ?? null
  const grain = series?.grain || overview?.grain.grain || 'day'
  const compareRange = overview?.compare.available ? fmtRange(overview.compare.start, overview.compare.end, ctx.tz) : null
  const delta = !point && pair ? fmtChange(def, pair.change) : null
  const tone = !point && pair?.change?.comparable && def && def.polarity !== 'neutral'
    ? (((pair.change.kind === 'rate' ? pair.change.pts ?? 0 : pair.change.delta ?? 0) > 0) === (def.polarity === 'up') ? 'good' : 'bad')
    : 'neutral'
  const denom = denominatorLine(def, point || pair?.cur)
  const thin = Boolean(point && def?.min_sample && typeof point.den === 'number' && point.den > 0 && point.den < Math.min(10, def.min_sample))
  const maturingFrom = def?.entity === 'seller' && isRate && overview && overview.period.preset !== 'custom' ? Date.parse(overview.period.end) - 72 * 3_600_000 : null
  const format = metricFormat(def)
  const showBreakdown = Boolean(ctx.groupBy && def?.dimensions.includes(ctx.groupBy))
  const view = ctx.view === 'bars' && !isRate ? 'bars' : ctx.view === 'table' ? 'table' : 'line'

  const decimals = isRate ? 1 : def?.unit === 'duration_min' ? 1 : def?.unit === 'ratio' ? 1 : 0
  const scale = isRate ? 100 : 1
  const topMarket = active !== null ? topOf(byMarketQ.data?.result as unknown as SeriesByResult, active) : null
  const topCampaign = active !== null ? topOf(byCampaignQ.data?.result as unknown as SeriesByResult, active) : null
  const pickBucket = (i: number) => { const p = points[i]; if (p) inspect({ kind: 'bucket', metric, start: p.start, end: p.end }) }

  return (
    <section className={cx('ix-hero lc-plane is-crystal is-d3', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} data-under="exec" aria-label={`${def?.label || metric} over the period`}>
      <header className={cx('ix-hero__head', point && 'is-scrub')}>
        <div className="ix-hero__readout" aria-live="polite">
          <span className="ix-eyebrow">
            {point ? <><b>{fmtBucket(point.start, grain, ctx.tz, true)}</b>{active !== null && maturingFrom && point.start >= maturingFrom ? ' · maturing' : ''}</> : <>{def ? def.family : 'Metric'} · {grain === 'hour' ? 'hourly' : grain === 'week' ? 'weekly' : grain === 'month' ? 'monthly' : 'daily'}</>}
          </span>
          <button type="button" className="ix-hero__name" onClick={() => inspect({ kind: 'metric', id: metric })} title="Definition, denominator, comparison and records">
            {def?.label || metric}<Icon name="hash" size={13} />
          </button>
          <div className="ix-hero__value">
            {headline === null || headline === undefined
              ? <b className="ix-hero__num is-none">—</b>
              : <b className={cx('ix-hero__num', thin && 'is-thin')}><LCCounter value={headline * scale} decimals={decimals} suffix={UNIT_SUFFIX[def?.unit || ''] || (def?.unit === 'ratio' ? '×' : '')} label={def?.label} /></b>}
            {delta ? (
              <span className={cx('ix-delta', `is-${tone}`)} title={[fmtP(pair?.change.p), pair?.change.significant ? 'statistically meaningful (p < 0.05)' : 'within normal variation'].filter(Boolean).join(' · ')}>
                <i aria-hidden="true">{tone === 'good' ? '▲' : tone === 'bad' ? '▼' : '•'}</i>{delta}
                <small>{pair?.change.significant ? 'significant' : 'within normal variation'}</small>
              </span>
            ) : !point && pair?.change && !pair.change.comparable ? <span className="ix-delta is-neutral"><small>{pair.change.reason || 'not compared'}</small></span> : null}
            {point && point.prev ? (
              <span className="ix-delta is-neutral"><b>{format(point.prev.value)}</b><small>{compareRange ? 'same point, previous period' : 'comparison'}</small></span>
            ) : null}
          </div>
          <p className="ix-hero__basis">
            {denom ? <span>{denom}</span> : null}
            {!point && pair?.cur.ci && isRate ? <span>95% interval {format(pair.cur.ci.low)} – {format(pair.cur.ci.high)}</span> : null}
            {!point && compareRange ? <span>vs {compareRange}</span> : null}
            {point && point.value === null && def?.unit !== 'count' ? <em className="ix-thin">{isRate && def?.denominator?.label ? `no ${def.denominator.label} this ${grain} — no rate` : `nothing recorded this ${grain}`}</em> : null}
            {thin ? <em className="ix-thin">small sample — below {Math.min(10, def?.min_sample || 10)}; read it as noise</em> : null}
            {!point && pair?.cur.status === 'insufficient_sample' ? <em className="ix-thin">below the {def?.min_sample} this rate needs to be a finding</em> : null}
            {pair?.cur.status === 'not_applicable' || pair?.cur.status === 'unavailable' ? <em className="ix-thin">{pair.cur.reason}</em> : null}
          </p>
        </div>
        <div className="ix-hero__switch">
          <div className="ix-hero__metrics" role="radiogroup" aria-label="Hero metric">
            {options.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={id === metric} className={cx('ix-chip', id === metric && 'is-on')} onClick={() => act.setMetric(id, { groupBy: ctx.groupBy && defs[id]?.dimensions.includes(ctx.groupBy) ? ctx.groupBy : null })} title={defs[id]?.description}>
                {defs[id]?.short || defs[id]?.label || id}
              </button>
            ))}
            {!options.includes(metric) ? <span className="ix-chip is-on" role="radio" aria-checked="true">{def?.short || def?.label}</span> : null}
          </div>
          <LCSelect
            className="ix-hero__metricselect"
            label="Hero metric"
            value={metric}
            onChange={(id) => act.setMetric(id)}
            options={[...new Set([...options, metric])].map((id) => ({ value: id, label: defs[id]?.label || id }))}
            size="sm"
          />
        </div>
        {point ? (
          <dl className="ix-hero__context">
            <div><dt>Reached</dt><dd>{fmtInt(at(reachedQ, active as number))}</dd></div>
            <div><dt>Replied</dt><dd>{fmtInt(at(repliedQ, active as number))}</dd></div>
            <div><dt>Interested</dt><dd>{fmtInt(at(interestedQ, active as number))}</dd></div>
            <div><dt>Top market</dt><dd title={topMarket ? `${topMarket.value} sellers reached` : undefined}>{topMarket ? topMarket.label : byMarketQ.loading ? '…' : '—'}</dd></div>
            <div className="is-wide"><dt>Top campaign</dt><dd title={topCampaign ? `${topCampaign.value} sellers reached` : undefined}>{topCampaign ? topCampaign.label : byCampaignQ.loading ? '…' : '—'}</dd></div>
          </dl>
        ) : null}
      </header>

      <div className={cx('ix-hero__chart', (seriesQ.loading && !own) && 'is-loading')}>
        {!series ? <div className="ix-hero__skel" aria-busy="true"><i /></div>
          : view === 'table' ? <IntelTrendTable points={points} grain={grain} tz={ctx.tz} format={format} unit={def?.unit || 'count'} />
            : view === 'bars' ? <IntelColumns points={points} grain={grain} tz={ctx.tz} format={format} active={active} onActive={onActive} onPick={pickBucket} label={`${def?.label} per ${grain}`} height={height || (variant === 'lens' ? 320 : 260)} />
              : (
                <IntelTrend
                  points={points}
                  unit={def?.unit || 'count'}
                  grain={grain}
                  tz={ctx.tz}
                  label={`${def?.label || metric}, this period against the previous`}
                  format={format}
                  formatTick={metricTick(def)}
                  height={height || (variant === 'lens' ? 340 : 290)}
                  minSample={def?.min_sample}
                  maturingFrom={maturingFrom}
                  events={events}
                  showCompare={Boolean(overview?.compare.available)}
                  active={active}
                  onActive={onActive}
                  onPick={pickBucket}
                  onEvent={(e, group) => inspect({ kind: 'event', event: e, group })}
                  sampleLabel={def?.denominator?.label}
                  compareLabel={compareRange}
                />
              )}
      </div>

      <footer className="ix-hero__foot">
        <div className="ix-legend" aria-hidden={view === 'table'}>
          <span><i className="ix-key is-cur" />This period</span>
          {overview?.compare.available ? <span><i className="ix-key is-prev" />{compareRange}</span> : null}
          {isRate && view === 'line' ? <span><i className="ix-key is-band" />95% interval</span> : null}
          {isRate && view === 'line' ? <span><i className="ix-key is-thin" />small sample</span> : null}
          {view === 'line' && def?.unit !== 'count' && points.some((p) => p.value === null) ? <span title="Days with no value are connected, never filled in"><i className="ix-key is-bridge" />{isRate && def?.denominator?.label ? `bridged · no ${def.denominator.label} or small sample` : 'bridged · nothing recorded'}</span> : null}
          {isRate && view === 'line' && def?.denominator?.label ? <span><i className="ix-key is-n" />{def.denominator.label} per {grain}</span> : null}
          {events.length && view === 'line' ? <span><i className="ix-key is-pin" />{events.length} event{events.length === 1 ? '' : 's'}</span> : null}
        </div>
        <div className="ix-hero__tools">
          <LCSelect
            label="Break down by"
            prefix="Break down"
            variant="quiet"
            size="sm"
            value={showBreakdown ? (ctx.groupBy as string) : '__none'}
            onChange={(d) => { act.set({ groupBy: d === '__none' ? null : d }) }}
            options={[{ value: '__none', label: 'Nothing' }, ...(def?.dimensions || []).filter((d) => dims[d]).map((d) => ({ value: d, label: dims[d]?.label || d, group: dims[d]?.family?.toLowerCase() }))]}
            menuWidth={240}
          />
          <LCSegmented
            label="Chart view"
            size="sm"
            value={view}
            onChange={(v) => act.set({ view: v })}
            options={isRate ? [{ value: 'line', icon: 'stats', title: 'Line' }, { value: 'table', icon: 'list', title: 'Table' }] : [{ value: 'line', icon: 'stats', title: 'Line' }, { value: 'bars', icon: 'grid', title: 'Columns' }, { value: 'table', icon: 'list', title: 'Table' }]}
          />
        </div>
      </footer>

      {showBreakdown ? <HeroBreakdown metric={metric} dim={ctx.groupBy as string} onRecords={(r) => records({ cohort: { metric, part: isRate ? 'numerator' : undefined, group: { dim: ctx.groupBy as string, key: r.key, label: r.label } }, title: `${def?.label} · ${r.label}` })} /> : null}
    </section>
  )
}

function HeroBreakdown({ metric, dim, onRecords }: { metric: string; dim: string; onRecords: (r: BreakdownRow) => void }) {
  const { ctx, act, defs, dims } = useLab()
  const def = defs[metric]
  const q = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric, groupBy: dim, limit: 60 }), 'breakdown'))
  const rows = (q.data?.result?.rows || []) as BreakdownRow[]
  return (
    <div className={cx('ix-hero__breakdown', q.stale && 'is-stale')}>
      <header>
        <span className="ix-eyebrow">{def?.label} by {(dims[dim]?.label || dim).toLowerCase()}</span>
        <small>{def?.unit === 'rate' ? 'dot = rate · bar = 95% interval · tick = previous period · faded = small sample' : 'tick = previous period'} · click a row to narrow the Lab</small>
      </header>
      {q.error && !q.data ? <p className="ix-note is-bad">Breakdown didn’t load · {q.error}</p> : null}
      {rows.length ? (
        <RankedBars
          rows={rows}
          unit={def?.unit || 'count'}
          format={(v) => fmtMetric(def, v)}
          maxRows={12}
          onPick={(r) => act.pushSegment({ dim, value: r.key, label: r.label })}
          onRecords={onRecords}
        />
      ) : q.data && !q.loading ? <p className="ix-note">No {(dims[dim]?.label || dim).toLowerCase()} with activity in this slice.</p> : <div className="ix-skel-rows"><i /><i /><i /></div>}
      {q.data?.result?.truncated ? <p className="ix-note">Showing the top {rows.length} of {q.data.result.total}.</p> : null}
    </div>
  )
}
