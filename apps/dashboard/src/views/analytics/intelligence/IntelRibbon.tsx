/**
 * PERIOD INTELLIGENCE — a thin instrument beside the hero, not a row of cards.
 *
 *   telemetry   the period's headline metrics, each with its change against
 *               the comparison window and its base said in numbers
 *   signals     what improved and what degraded (only changes the server's
 *               test calls meaningful), and where attention is needed
 *   context     the strongest market (rate leader among markets with enough
 *               sample), the acquisition bottleneck (stage-age evidence) and
 *               the value in motion (by basis — never one number)
 *   brief       the narrative, demoted: it explains the data, it does not
 *               replace it
 */
import type { MetricPair } from '../../../domain/analytics/analytics-lab-api'
import { fmtChange, fmtMetric } from '../../../domain/analytics/analytics-lab-api'
import { cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import type { MoneyResult, StagesResult } from './intel-model'
import { HERO_METRICS, STAGE_SHORT, changeText, changeTone, splitChanges } from './intel-model'
import { fmtAge, fmtInt, fmtMoney, fmtPct, fmtRange } from './intel-format'
import { serverContext } from './intel-state'
import type { LabQuery } from '../../../domain/analytics/analytics-lab-api'

const TELEMETRY = ['sellers_reached', 'reply_rate', 'interested_sellers', 'opportunities_created', 'delivery_rate', 'content_filter_rate', 'human_intervention_rate'] as const

export function IntelRibbon() {
  const { ctx, act, defs, overview, inspect } = useLab()
  const sCtx = serverContext(ctx, { metric: 'stage_advancements', groupBy: null })
  const stagesQ = useIntel<LabQuery>(overview ? paths.query(sCtx, 'stages') : null)
  const moneyQ = useIntel<LabQuery>(overview ? paths.query(serverContext(ctx, { metric: 'reply_rate', groupBy: null }), 'money') : null)
  if (!overview) return <aside className="ix-ribbon lc-plane is-smoke is-d2" aria-busy="true"><div className="ix-skel-rows"><i /><i /><i /><i /><i /></div></aside>
  const stages = stagesQ.data?.result as unknown as StagesResult | null
  const money = moneyQ.data?.result as unknown as MoneyResult | null
  const cmp = overview.compare
  const heroable = new Set<string>([...overview.trend.options, ...HERO_METRICS])
  const { improved, degraded } = splitChanges(overview.changes)
  const rr = defs.reply_rate
  const leader = [...overview.geo.rows].filter((r) => !r.insufficient && r.value !== null && (r.den ?? 0) >= (rr?.min_sample || 30)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0] || null
  const bottleneck = stages?.bottleneck || null
  const bStage = bottleneck ? stages?.current.find((s) => s.code === bottleneck.code) : null
  const pick = (id: string) => (heroable.has(id) ? act.setMetric(id) : inspect({ kind: 'metric', id }))
  const pair = (id: string): MetricPair | undefined => overview.metrics[id]

  return (
    <aside className="ix-ribbon lc-plane is-smoke is-d2" aria-label="Period intelligence">
      <header className="ix-ribbon__head">
        <span className="ix-eyebrow">This period</span>
        <p><b>{fmtRange(overview.period.start, overview.period.end, ctx.tz)}</b>{cmp.available && cmp.start && cmp.end ? <span> vs {fmtRange(cmp.start, cmp.end, ctx.tz)}</span> : <span className="ix-muted"> · {cmp.reason || 'no comparison'}</span>}</p>
      </header>

      <ol className="ix-tele">
        {TELEMETRY.map((id) => {
          const p = pair(id)
          const def = defs[id]
          if (!p || !def) return null
          const v = p.cur
          const change = fmtChange(def, p.change)
          const tone = p.change.comparable && def.polarity !== 'neutral' ? changeTone({ kind: p.change.kind as string, pts: p.change.pts ?? null, delta: p.change.delta ?? null, polarity: def.polarity }) : 'neutral'
          const base = def.unit === 'rate' && typeof v.num === 'number' && typeof v.den === 'number' ? `${fmtInt(v.num)} of ${fmtInt(v.den)}` : null
          return (
            <li key={id}>
              <button type="button" className={cx('ix-tele__row', ctx.metric === id && 'is-on')} onClick={() => pick(id)} title={def.description}>
                <span className="ix-tele__label">{def.short || def.label}</span>
                <b className="ix-tele__value">{v.status === 'not_applicable' || v.status === 'unavailable' ? '—' : fmtMetric(def, v.value)}</b>
                <span className={cx('ix-tele__delta', `is-${tone}`, p.change.comparable && p.change.significant && 'is-sig')} title={p.change.comparable ? (p.change.significant ? 'statistically meaningful' : 'within normal variation') : p.change.reason || 'not compared'}>
                  {change || (p.change.reason ? '—' : '')}
                </span>
                <small className="ix-tele__base">{base || (v.status !== 'ok' ? v.status.replace(/_/g, ' ') : def.unit === 'duration_min' ? `n = ${fmtInt(v.n)}` : ' ')}</small>
              </button>
            </li>
          )
        })}
      </ol>

      <section className="ix-signals" aria-label="What moved">
        {degraded.length ? (
          <div className="ix-signal is-bad">
            <span className="ix-eyebrow"><Icon name="alert" size={11} />Degraded</span>
            <ul>{degraded.slice(0, 3).map((c) => <li key={c.id}><button type="button" onClick={() => pick(c.id)}><span>{c.label}</span><b>{changeText(c)}</b></button></li>)}</ul>
          </div>
        ) : null}
        {improved.length ? (
          <div className="ix-signal is-good">
            <span className="ix-eyebrow"><Icon name="trending-up" size={11} />Improved</span>
            <ul>{improved.slice(0, 3).map((c) => <li key={c.id}><button type="button" onClick={() => pick(c.id)}><span>{c.label}</span><b>{changeText(c)}</b></button></li>)}</ul>
          </div>
        ) : null}
        {!degraded.length && !improved.length ? <p className="ix-note">{cmp.available ? 'Nothing moved beyond normal variation against the comparison window.' : 'Choose a comparison window to see what moved.'}</p> : null}
      </section>

      <dl className="ix-facts">
        <div>
          <dt>Strongest market</dt>
          <dd>
            {leader ? (
              <button type="button" className="ix-link" onClick={() => act.pushSegment({ dim: 'market', value: leader.key, label: leader.label })} title="Narrow the Lab to this market">
                {leader.label} <span className="ix-muted">{fmtPct(leader.value)} of {fmtInt(leader.den)}</span>
              </button>
            ) : <span className="ix-muted">no market has {rr?.min_sample || 30}+ sellers reached</span>}
          </dd>
        </div>
        <div>
          <dt>Bottleneck</dt>
          <dd>
            {bottleneck && bStage ? (
              <button type="button" className="ix-link" onClick={() => inspect({ kind: 'stage', code: bottleneck.code })} title="Stage-age evidence, not a score">
                {STAGE_SHORT[bottleneck.code]} {bottleneck.label} <span className="ix-muted">{bottleneck.stalled} of {bottleneck.live} live &gt; {bottleneck.thresholdDays}d{bStage.liveAge.p50 !== null ? ` · median ${(bStage.liveAge.p50 / 1440).toFixed(1)}d` : ''}</span>
              </button>
            ) : stagesQ.loading ? <span className="ix-muted">reading stages…</span> : <span className="ix-muted">no stage holds 3+ live deals with 2+ past its clock</span>}
          </dd>
        </div>
        <div>
          <dt>Value in motion</dt>
          <dd>
            {money ? (
              <button type="button" className="ix-link" onClick={() => act.setLens('financial')} title="Each basis is its own figure">
                {fmtMoney(money.totals.authorized.offer, { zero: '$0' })} <span className="ix-muted">authorized offers ({money.totals.authorized.n})</span>
                <span className="ix-facts__sub">{fmtMoney(money.totals.record.sum)} county estimate · {money.totals.record.n} deals · {fmtMoney(money.totals.actual.sum, { zero: '$0' })} actual settled</span>
              </button>
            ) : moneyQ.loading ? <span className="ix-muted">reading the pipeline…</span> : <span className="ix-muted">unavailable</span>}
          </dd>
        </div>
      </dl>

      {overview.narrative.length ? (
        <div className="ix-brief">
          <span className="ix-eyebrow">Intelligence brief</span>
          <ul>
            {overview.narrative.slice(0, 5).map((line, i) => (
              <li key={i}>
                {line.parts?.length
                  ? line.parts.map((part, k) => (part.metric
                    ? <button key={k} type="button" className="ix-brief__ref" onClick={() => inspect({ kind: 'metric', id: part.metric as string })}>{part.text}</button>
                    : <span key={k}>{part.text}</span>))
                  : line.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="ix-ribbon__foot">
        <span title={overview.thePeriod.freshness.note}>Data {fmtAge(overview.thePeriod.freshness.dataAsOf)}</span>
        <span title={Object.entries(overview.thePeriod.exclusions).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(' · ')}>canary &amp; test excluded</span>
        {overview.thePeriod.caveats.length ? <span title={overview.thePeriod.caveats.join(' · ')}>{overview.thePeriod.caveats.length} caveat{overview.thePeriod.caveats.length === 1 ? '' : 's'}</span> : null}
        <span>defs {overview.version.replace('lab-', '')}</span>
      </footer>
    </aside>
  )
}
