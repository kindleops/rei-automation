import type { CompValuationUniverse } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  universes: CompValuationUniverse[]
}

const fmt = (n: number | null) =>
  n != null
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
    : 'Unavailable'

const toneFor = (classification: string) => {
  if (classification === 'QUALIFIED') return 'qualified'
  if (/scenario|provisional/i.test(classification)) return 'review'
  return 'unavailable'
}

export function ValuationUniverseGrid({ universes }: Props) {
  if (!universes.length) {
    return <p className="ci-empty">No valuation universes projected.</p>
  }

  return (
    <div className="ci-universe-grid" role="list">
      {universes.map((u) => (
        <article key={u.universe} className={`ci-universe-card ci-universe-card--${toneFor(u.classification)}`} role="listitem">
          <header className="ci-universe-card__head">
            <h3>{u.universe.replace(/_/g, ' ')}</h3>
            <span className="ci-chip">{u.classification}</span>
          </header>
          <div className="ci-universe-card__range tabular-nums">
            <span>{fmt(u.low)}</span>
            <span className="ci-universe-card__mid">{fmt(u.mid)}</span>
            <span>{fmt(u.high)}</span>
          </div>
          <dl className="ci-universe-card__meta">
            <div><dt>Independent txns</dt><dd>{u.independent_transaction_count ?? '—'}</dd></div>
            <div><dt>ESS</dt><dd>{u.effective_sample_size ?? '—'}</dd></div>
            <div><dt>Confidence</dt><dd>{u.confidence != null ? `${Math.round(u.confidence)}%` : '—'}</dd></div>
            <div><dt>Dispersion</dt><dd>{u.dispersion != null ? `${Math.round(u.dispersion)}%` : '—'}</dd></div>
            <div><dt>Rejections</dt><dd>{u.rejection_count ?? 0}</dd></div>
          </dl>
          {!u.available && u.unavailable_reason && (
            <p className="ci-universe-card__reason">{u.unavailable_reason}</p>
          )}
        </article>
      ))}
    </div>
  )
}