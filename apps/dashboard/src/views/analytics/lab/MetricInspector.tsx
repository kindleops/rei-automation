/**
 * METRIC INSPECTOR — the right-hand Level-2 plane. For any metric: the value,
 * its numerator and denominator (each opens its exact records), the interval,
 * the period and comparison, the active slice, and the registry definition
 * (time basis, sources, exclusions, null behaviour, freshness, version, and
 * how it differs from the v1 contract). Never a rate without its denominator.
 */
import { Icon } from '../../../shared/icons'
import type { LabContext, LabEnvelope, LabRegistry, MetricPair } from '../../../domain/analytics/analytics-lab-api'
import { fetchLabQuery, fmtCount, fmtMetric, fmtP } from '../../../domain/analytics/analytics-lab-api'
import type { LabActions } from './lab-state'
import { useLabData } from './lab-state'
import { Delta, StatusMark, cls } from './LabUi'
import { fmtRangeShort } from './charts/chart-kit'
import { filterChipText } from './LabContextBar'
import type { OpenRecords } from './LabOverview'

type Props = {
  id: string
  ctx: LabContext
  act: LabActions
  registry: LabRegistry
  envelope: LabEnvelope | null
  known?: MetricPair | null
  onClose: () => void
  onRecords: OpenRecords
  onInspect: (id: string) => void
}

export function MetricInspector({ id, ctx, act, registry, envelope, known, onClose, onRecords, onInspect }: Props) {
  const def = registry.metrics.find((m) => m.id === id)
  const q = useLabData(known ? null : `insp|${id}|${JSON.stringify([ctx.range, ctx.compare, ctx.filters, ctx.segment, ctx.tz])}`, (signal) => fetchLabQuery({ ...ctx, metric: id, groupBy: null }, 'metric', signal))
  const pair = known || q.data?.metric || null
  const env = envelope || q.data || null
  if (!def) return null
  const tz = ctx.tz
  const rate = def.unit === 'rate'
  const cur = pair?.cur
  const tb = registry.timeBases[def.time_basis]
  const numRef = def.numerator.metric ? registry.metrics.find((m) => m.id === def.numerator.metric) : null
  const denRef = def.denominator?.metric ? registry.metrics.find((m) => m.id === def.denominator?.metric) : null
  const recordable = cur && (cur.status === 'ok' || cur.status === 'insufficient_sample' || cur.status === 'no_data')
  return (
    <aside className="lab-insp" aria-label={`${def.label} — metric inspector`}>
      <header className="lab-insp__head">
        <div>
          <span className="lab-eyebrow">{def.family} · {registry.entities[def.entity]?.label || def.entity}</span>
          <h3>{def.label}</h3>
        </div>
        <button type="button" className="lab-ctl is-quiet" onClick={onClose} aria-label="Close inspector"><Icon name="close" /></button>
      </header>

      <div className={cls('lab-insp__value', q.loading && 'is-refreshing')}>
        <b>{cur ? (cur.status === 'not_applicable' || cur.status === 'unavailable' ? '—' : fmtMetric(def, cur.value)) : '…'}</b>
        {cur ? <StatusMark status={cur.status} reason={cur.reason} n={cur.n} /> : null}
        {pair ? <Delta def={def} change={pair.change} /> : null}
      </div>
      {cur?.reason ? <p className="lab-note">{cur.reason}</p> : null}

      {cur && rate ? (
        <div className="lab-insp__ops">
          <button type="button" disabled={!recordable} onClick={() => onRecords({ metric: id, part: 'numerator' }, `${def.label} · numerator`)}>
            <span>Numerator</span><b>{fmtCount(cur.num)}</b><em>{def.numerator.label}</em><small>View records <Icon name="chevron-right" /></small>
          </button>
          <i className="lab-insp__div" aria-hidden="true">÷</i>
          <button type="button" disabled={!recordable} onClick={() => onRecords({ metric: id, part: 'denominator' }, `${def.label} · denominator`)}>
            <span>Denominator</span><b>{fmtCount(cur.den)}</b><em>{def.denominator?.label}</em><small>View records <Icon name="chevron-right" /></small>
          </button>
        </div>
      ) : cur && def.unit === 'ratio' ? (
        <div className="lab-insp__ops">
          <button type="button" onClick={() => onRecords({ metric: id, part: 'numerator' }, `${def.label} · numerator cohort`)}><span>Numerator</span><b>{fmtCount(cur.num)}</b><em>{def.numerator.label}</em><small>View cohort <Icon name="chevron-right" /></small></button>
          <i className="lab-insp__div" aria-hidden="true">÷</i>
          <button type="button" onClick={() => onRecords({ metric: id, part: 'denominator' }, `${def.label} · denominator`)}><span>Denominator</span><b>{fmtCount(cur.den)}</b><em>{def.denominator?.label}</em><small>View records <Icon name="chevron-right" /></small></button>
        </div>
      ) : cur ? (
        <div className="lab-insp__ops is-single">
          <button type="button" disabled={!recordable} onClick={() => onRecords({ metric: id }, def.label)}>
            <span>{def.unit === 'duration_min' ? 'Sample' : 'Records'}</span><b>{fmtCount(def.unit === 'duration_min' ? cur.n : cur.value)}</b><em>{def.numerator.label}</em><small>View records <Icon name="chevron-right" /></small>
          </button>
        </div>
      ) : null}

      <dl className="lab-spec">
        {rate && cur?.ci ? <div><dt>95% interval</dt><dd>{fmtMetric(def, cur.ci.low)} – {fmtMetric(def, cur.ci.high)} (Wilson){cur.minSample ? ` · min sample ${cur.minSample}` : ''}</dd></div> : null}
        {def.unit === 'duration_min' && cur?.dist ? <div><dt>Distribution</dt><dd>P25 {fmtMetric(def, cur.dist.p25)} · median {fmtMetric(def, cur.dist.p50)} · P75 {fmtMetric(def, cur.dist.p75)} · P90 {fmtMetric(def, cur.dist.p90)} · n {cur.dist.n}</dd></div> : null}
        <div><dt>Period</dt><dd>{env ? fmtRangeShort(env.period.start, env.period.end, tz) : '—'}</dd></div>
        <div><dt>Comparison</dt><dd>
          {env?.compare.available ? <>{fmtRangeShort(env.compare.start, env.compare.end, tz)} · {pair?.prev ? fmtMetric(def, pair.prev.value) : '—'}{rate && pair?.prev?.den !== undefined ? ` (${fmtCount(pair.prev.num)}/${fmtCount(pair.prev.den)})` : ''}</> : env?.compare.reason || 'none'}
          {pair?.change?.comparable ? <small>{fmtP(pair.change.p) || 'no test for this unit'}{pair.change.significant ? ' · statistically meaningful' : ' · within normal variation'}{pair.change.ciPts ? ` · 95% CI of the difference ${pair.change.ciPts[0].toFixed(1)} to ${pair.change.ciPts[1].toFixed(1)} pts` : ''}</small> : pair?.change?.reason ? <small>not compared: {pair.change.reason}</small> : null}
        </dd></div>
        <div><dt>Slice</dt><dd>{ctx.filters.length || ctx.segment.length ? [...ctx.segment.map((s) => `${registry.dimensions[s.dim]?.label || s.dim} = ${s.label || s.value}`), ...ctx.filters.map((f) => filterChipText(f, registry))].join(' · ') : 'All activity (canary and test campaigns excluded)'}</dd></div>
      </dl>

      <section className="lab-insp__def">
        <h4>Definition <em>{def.version}</em></h4>
        <p>{def.description}</p>
        <dl className="lab-spec">
          <div><dt>Numerator</dt><dd>{numRef ? <button type="button" className="lab-link" onClick={() => onInspect(numRef.id)}>{numRef.label}</button> : def.numerator.label}{def.numerator.def ? <code>{def.numerator.def}</code> : null}</dd></div>
          {def.denominator ? <div><dt>Denominator</dt><dd>{denRef ? <button type="button" className="lab-link" onClick={() => onInspect(denRef.id)}>{denRef.label}</button> : def.denominator.label}{def.denominator.def ? <code>{def.denominator.def}</code> : null}</dd></div> : null}
          <div><dt>Time basis</dt><dd>{tb?.label}<code>{tb?.column}</code>{tb?.why ? <small>{tb.why}</small> : null}</dd></div>
          <div><dt>Sources</dt><dd>{def.sources.join(' · ')}</dd></div>
          {def.exclusions.length ? <div><dt>Excluded</dt><dd>{def.exclusions.join(' ')}</dd></div> : null}
          {def.caveat ? <div><dt>Caveat</dt><dd>{def.caveat}</dd></div> : null}
          <div><dt>Missing data</dt><dd>{def.null_behavior}</dd></div>
          <div><dt>Freshness</dt><dd>{def.freshness.note}</dd></div>
          <div><dt>vs v1</dt><dd><span className={cls('lab-v1', `is-${def.v1.status}`)}>{def.v1.status}</span>{def.v1.note ? ` ${def.v1.note}` : ''}</dd></div>
        </dl>
      </section>

      <section className="lab-insp__actions">
        <button type="button" className="lab-ctl" onClick={() => act.set({ metric: id, groupBy: ctx.groupBy && def.dimensions.includes(ctx.groupBy) ? ctx.groupBy : null })} disabled={ctx.metric === id || cur?.status === 'unavailable' || cur?.status === 'not_applicable'}><Icon name="trending-up" />Trend this metric</button>
        <div className="lab-insp__dims">
          <span>Break down by</span>
          {def.dimensions.slice(0, 12).map((d) => <button key={d} type="button" className={cls('lab-chiplet', ctx.metric === id && ctx.groupBy === d && 'is-on')} onClick={() => act.set({ metric: id, groupBy: d })}>{registry.dimensions[d]?.label || d}</button>)}
        </div>
      </section>
    </aside>
  )
}
