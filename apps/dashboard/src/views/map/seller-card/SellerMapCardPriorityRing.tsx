import { classifyPriorityScore } from './seller-map-card-formatters'

const ringColor = (score: number | null, tier: string | null): string => {
  if (score == null) return 'rgba(148, 163, 184, 0.55)'
  const { classification } = classifyPriorityScore(score, tier)
  const label = (classification || '').toLowerCase()
  if (label.includes('urgent')) return '#f87171'
  if (label.includes('high')) return '#34d399'
  if (label.includes('moderate')) return '#7dd3fc'
  if (label.includes('watch')) return '#fbbf24'
  return '#94a3b8'
}

export const SellerMapCardPriorityRing = ({
  score,
  tier = null,
  classification = null,
  size = 44,
  showUnscoredLabel = false,
}: {
  score: number | null
  tier?: string | null
  classification?: string | null
  size?: number
  showUnscoredLabel?: boolean
}) => {
  const radius = 18
  const circumference = 2 * Math.PI * radius
  const progress = score != null ? Math.max(0.04, Math.min(1, score / 100)) : 0
  const stroke = ringColor(score, tier)
  const title = classification || (score != null ? `Priority score ${Math.round(score)}` : 'Priority score unavailable')

  return (
    <div
      className="smc-priority-ring"
      style={{ width: size, height: size }}
      title={title}
      aria-label={title}
      role="img"
    >
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke="rgba(255, 255, 255, 0.1)"
          strokeWidth="3"
        />
        {score != null ? (
          <circle
            cx="22"
            cy="22"
            r={radius}
            fill="none"
            stroke={stroke}
            strokeWidth="3"
            strokeDasharray={`${progress * circumference} ${circumference}`}
            strokeLinecap="round"
            transform="rotate(-90 22 22)"
          />
        ) : (
          <circle
            cx="22"
            cy="22"
            r={radius}
            fill="none"
            stroke="rgba(148, 163, 184, 0.55)"
            strokeWidth="2"
            strokeDasharray="5 6"
          />
        )}
      </svg>
      <span className="smc-priority-ring__value">
        {score != null ? Math.round(score) : '—'}
      </span>
      {showUnscoredLabel && score == null ? (
        <span className="smc-priority-ring__tag">UNSCORED</span>
      ) : null}
    </div>
  )
}