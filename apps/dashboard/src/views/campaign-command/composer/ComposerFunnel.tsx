import { useState } from 'react'
import { cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import type { ComposerAudience, ComposerSample } from './composer-types'
import { audienceFreshness, audienceFunnel, fmt, type FunnelStage } from './composer-model'
import { reasonWords } from './composer-format'

/**
 * The audience, explained as a funnel (owner rule 2026-10-03): every stage
 * shows the server's count, what it removed and why. A stage the server did
 * not measure says so instead of showing a number. Samples are the rendered
 * build samples only — no other per-stage sample exists yet.
 */
export function ComposerFunnel({ audience, labelOf, nowMs }: { audience: ComposerAudience; labelOf: (key: string) => string; nowMs: number }) {
  const [open, setOpen] = useState<string | null>(null)
  const stages = audienceFunnel(audience, labelOf)
  const fresh = audienceFreshness(audience, nowMs)
  if (!stages.length) return null
  const top = stages[0].count ?? 0
  return (
    <section className="ccz-funnel" aria-label="Audience funnel">
      {fresh ? (
        <p className={cx('ccz-fresh', fresh.stale && 'is-stale')}>
          <Icon name="clock" size={13} />
          <span>{fresh.label}</span>
          {fresh.coverage ? (
            <em>Coverage {fresh.coverage.map((c) => `${c.label} ${c.count}%`).join(' · ')}</em>
          ) : (
            <em>Field coverage not measured yet</em>
          )}
        </p>
      ) : null}
      <ol className="ccz-funnel__list">
        {stages.map((s) => (
          <FunnelRow key={s.key} stage={s} top={top} open={open === s.key} onToggle={() => setOpen(open === s.key ? null : s.key)} samples={s.key === 'routing' ? audience.samples : null} />
        ))}
      </ol>
    </section>
  )
}

function FunnelRow({ stage, top, open, onToggle, samples }: { stage: FunnelStage; top: number; open: boolean; onToggle: () => void; samples: ComposerSample[] | null }) {
  const share = stage.count !== null && top > 0 ? Math.max(0.02, Math.min(1, stage.count / top)) : 0
  const expandable = stage.reasons.length > 0 || Boolean(stage.note) || Boolean(samples?.length)
  return (
    <li className={cx('ccz-funnel__row', open && 'is-open')} data-basis={stage.basis}>
      <button type="button" className="ccz-funnel__head" onClick={onToggle} disabled={!expandable} aria-expanded={expandable ? open : undefined}>
        <span className="ccz-funnel__label">{stage.label}</span>
        <span className="ccz-funnel__bar" aria-hidden="true"><i style={{ inlineSize: `${share * 100}%` }} /></span>
        <b className="ccz-num">{stage.count === null ? 'not measured' : fmt(stage.count)}</b>
        <em className="ccz-funnel__drop">{stage.dropped ? `−${fmt(stage.dropped)}` : ''}</em>
        {stage.basis !== 'graph' ? <span className="ccz-funnel__basis">{stage.basis === 'cohort' ? 'whole cohort' : 'sample'}</span> : <span className="ccz-funnel__basis" />}
      </button>
      {open ? (
        <div className="ccz-funnel__detail">
          {stage.note ? <p className="ccz-dim">{stage.note}</p> : null}
          {stage.reasons.length ? (
            <ul className="ccz-why">
              {stage.reasons.map((r) => <li key={r.label}><span>{r.label}</span>{r.count ? <b>{fmt(r.count)}</b> : null}</li>)}
            </ul>
          ) : null}
          {samples?.length ? (
            <ul className="ccz-funnel__samples">
              {samples.map((x) => (
                <li key={x.id} className={cx(!x.ok && 'is-failed')}>
                  <span>{x.place ?? x.market ?? '—'}</span>
                  <em>{x.ok ? x.text : `Not rendered — ${reasonWords(x.reason)}`}</em>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
