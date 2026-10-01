/**
 * THE ACQUISITION FUNNEL — the period's reached cohort, stage by stage.
 * Implemented natively (Arc's Funnel Chart is a Pro component this project
 * does not license).
 *
 * Production is not one straight line: interested sellers and sellers who
 * became opportunities are BOTH subsets of the sellers who replied — not of
 * each other — so they are drawn as two branches of "Replied", each stating
 * its own base. Drop-off is shown only where the previous stage IS the base.
 * Bars are linear (a 2.4% stage looks like 2.4%); the numbers carry the rest.
 *
 * Every stage is a cohort: clicking it narrows the WHOLE Lab to those sellers
 * (the chip says so); "sellers" opens the exact records.
 */
import type { CSSProperties } from 'react'
import { cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { useLab } from './intel-context'
import type { FunnelStage } from './intel-model'
import { funnelStages } from './intel-model'
import { fmtInt, fmtPct } from './intel-format'

export function IntelFunnel({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { ctx, act, defs, overview, inspect, records, registry, refreshing } = useLab()
  if (!overview) return <section className="ix-funnel lc-plane is-crystal is-d2" aria-busy="true"><div className="ix-skel-rows"><i /><i /><i /><i /></div></section>
  const stages = funnelStages(overview.funnel.steps)
  const first = stages[0]?.value ?? 0
  const active = ctx.segment.find((s) => s.dim === 'cohort')?.value ?? null
  const cohortLabel = (key: string | null) => (key ? registry.cohorts?.[key]?.label || key : '')
  const reached = stages[0]
  const replied = stages[1]
  const branches = stages.slice(2)
  const events = overview.funnel.events

  const row = (s: FunnelStage, depth: number, base: string | null) => {
    const on = Boolean(s.cohort && active === s.cohort)
    const w = first && s.value !== null ? Math.max(0.35, (s.value / first) * 100) : 0
    return (
      <li key={s.id} className={cx('ix-funnel__stage', `is-d${depth}`, on && 'is-on')} style={{ '--w': `${w}%` } as CSSProperties}>
        <button
          type="button"
          className="ix-funnel__body"
          onClick={() => (s.cohort ? act.setCohort(on ? null : s.cohort, cohortLabel(s.cohort)) : inspect({ kind: 'metric', id: s.id }))}
          aria-pressed={s.cohort ? on : undefined}
          title={s.cohort ? (on ? 'Clear this cohort' : `Narrow the whole Lab to these ${fmtInt(s.value)} sellers`) : undefined}
        >
          <span className="ix-funnel__name">{depth > 0 ? <i className="ix-funnel__elbow" aria-hidden="true" /> : null}{s.label}</span>
          <span className="ix-funnel__bar" aria-hidden="true"><i /></span>
          <b className="ix-funnel__value">{fmtInt(s.value)}</b>
          <span className="ix-funnel__rates">
            {base === null ? <em>the cohort</em> : (
              <>
                {s.retained !== null ? <em><b>{fmtPct(s.retained)}</b> of {base}</em> : null}
                {s.ofFirst !== null && depth > 0 ? <em className="ix-muted">{fmtPct(s.ofFirst)} of reached</em> : null}
              </>
            )}
          </span>
        </button>
        <div className="ix-funnel__acts">
          <button type="button" className="ix-mini" onClick={() => records({ cohort: { metric: s.id, part: 'numerator', window: 'current' }, title: `${s.label} · this period` })} title={`Open the ${fmtInt(s.value)} sellers`}>
            <Icon name="list" size={12} />sellers
          </button>
          <button type="button" className="ix-mini is-icon" onClick={() => inspect({ kind: 'metric', id: s.id })} aria-label={`Definition of ${s.label}`}><Icon name="hash" size={12} /></button>
        </div>
        {s.note ? <small className="ix-funnel__note">{s.note}</small> : null}
      </li>
    )
  }

  return (
    <section className={cx('ix-funnel lc-plane is-crystal is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} aria-label="Acquisition funnel">
      <header className="ix-plane__head">
        <div>
          <span className="ix-eyebrow">Acquisition</span>
          <h2>From reached to opportunity</h2>
        </div>
        <p className="ix-muted">{active ? <>Cohort · <b>{cohortLabel(active)}</b> — the Lab is narrowed to it</> : 'Click a stage to narrow the whole Lab to those sellers'}</p>
      </header>
      {reached && replied ? (
        <ol className="ix-funnel__flow">
          {row(reached, 0, null)}
          <li className="ix-funnel__drop" aria-hidden={replied.dropped === null}>
            {replied.dropped !== null ? <span><Icon name="chevron-down" size={11} />{fmtInt(replied.dropped)} reached sellers did not reply</span> : null}
          </li>
          {row(replied, 0, defs[replied.id]?.denominator?.label?.toLowerCase() || 'reached')}
          {branches.map((b) => row(b, 1, 'replied'))}
        </ol>
      ) : null}
      <footer className="ix-funnel__events">
        <span className="ix-eyebrow">Down-funnel</span>
        {events.map((e) => (
          <button key={e.id} type="button" className={cx('ix-funnel__event', !e.value && 'is-zero')} onClick={() => inspect({ kind: 'metric', id: e.id })} title={e.caveat || undefined}>
            <b>{e.status === 'ok' ? fmtInt(e.value) : '—'}</b> {e.label.toLowerCase()}
          </button>
        ))}
        <span className="ix-muted ix-funnel__eventsnote">{events.every((e) => !e.value) ? 'None recorded in this period — shown as zero, not hidden. ' : ''}Events in the period, not yet linked to this cohort.</span>
      </footer>
      {variant === 'lens' ? <p className="ix-note">{overview.funnel.note}</p> : null}
    </section>
  )
}
