import type { ClosingHealth } from '../../../domain/closing-desk/closing-desk.types'

const BAND_LABEL: Record<string, string> = {
  on_track: 'On Track',
  watch: 'Watch',
  at_risk: 'At Risk',
  critical: 'Critical',
  unknown: 'Unknown',
}

export function ClosingHealthBadge({ health }: { health: ClosingHealth }) {
  return (
    <span className="cd-health" data-band={health.band} title={`${health.factors.length} scoring factor(s)`}>
      <span className="cd-health__dot" aria-hidden />
      {health.band === 'unknown' ? 'Health —' : `${health.score} · ${BAND_LABEL[health.band] ?? health.band}`}
    </span>
  )
}
