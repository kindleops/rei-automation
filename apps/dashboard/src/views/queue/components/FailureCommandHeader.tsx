const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface FailureCommandHeaderProps {
  total: number
  retryable: number
  nonRetryable: number
  compliance: number
  provider: number
  config: number
  webhook: number
  unknown: number
}

export function FailureCommandHeader({
  total, retryable, nonRetryable, compliance, provider, config, webhook, unknown,
}: FailureCommandHeaderProps) {
  const categories = [
    { label: 'Compliance', val: compliance, tone: 'red' },
    { label: 'Provider', val: provider, tone: 'red' },
    { label: 'Configuration', val: config, tone: 'amber' },
    { label: 'Webhook', val: webhook, tone: 'amber' },
    { label: 'Unknown', val: unknown, tone: 'muted' },
  ]

  return (
    <header className="occ-failure-command__header">
      <div className="occ-metric-strip occ-metric-strip--failure">
        <div className="occ-metric-strip__tiles">
          <div className="occ-metric-strip__tile is-primary">
            <span className="occ-metric-strip__val">{total}</span>
            <span className="occ-metric-strip__lbl">Affected Rows</span>
          </div>
          <div className="occ-metric-strip__tile is-green">
            <span className="occ-metric-strip__val">{retryable}</span>
            <span className="occ-metric-strip__lbl">Retryable</span>
          </div>
          <div className="occ-metric-strip__tile is-red">
            <span className="occ-metric-strip__val">{nonRetryable}</span>
            <span className="occ-metric-strip__lbl">Non-retryable</span>
          </div>
          {categories.map(c => (
            <div key={c.label} className={cls('occ-metric-strip__tile', `is-${c.tone}`)}>
              <span className="occ-metric-strip__val">{c.val}</span>
              <span className="occ-metric-strip__lbl">{c.label}</span>
            </div>
          ))}
        </div>
      </div>
    </header>
  )
}