import type { ClosingHealthBand } from '../../../domain/closing-desk/closing-desk.types'

const BAND_COLORS: Record<ClosingHealthBand, string> = {
  on_track: 'var(--cd-semantic-healthy, #34d399)',
  watch: 'var(--cd-semantic-watch, #fbbf24)',
  at_risk: 'var(--cd-semantic-warning, #fb923c)',
  critical: 'var(--cd-semantic-critical, #f87171)',
  unknown: 'var(--cd-semantic-unknown, #94a3b8)',
}

export interface ClosingReadinessRingProps {
  score: number
  band: ClosingHealthBand
  size?: number
  label?: string
}

export function ClosingReadinessRing({ score, band, size = 56, label }: ClosingReadinessRingProps) {
  const stroke = 5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score)) / 100
  const offset = c * (1 - pct)

  return (
    <div className="cd-ring" style={{ width: size, height: size }} aria-label={label ?? `Health ${score}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--cd-ring-track, rgba(255,255,255,0.08))"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={BAND_COLORS[band]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="cd-ring__arc"
        />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="cd-ring__score">
          {score}
        </text>
      </svg>
    </div>
  )
}