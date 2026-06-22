const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export const MetricTile = ({
  label,
  value,
  meta,
  tone = 'neutral',
}: {
  label: string
  value: React.ReactNode
  meta?: React.ReactNode
  tone?: 'neutral' | 'good' | 'warning' | 'critical' | 'info'
}) => (
  <div className={cls('nx-shell-metric', `is-${tone}`)}>
    <span className="nx-shell-metric__label">{label}</span>
    <strong className="nx-shell-metric__value">{value}</strong>
    {meta ? <small className="nx-shell-metric__meta">{meta}</small> : null}
  </div>
)