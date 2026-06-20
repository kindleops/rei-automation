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
  return (
    <header className="occ-failure-command__header">
      <div className="occ-failure-command__title">
        <span>Exception Command Center</span>
        <span className="occ-failure-command__total">{total} affected rows</span>
      </div>
      <div className="occ-failure-command__split">
        <div className="occ-failure-split is-green">
          <span className="occ-failure-split__val">{retryable}</span>
          <span className="occ-failure-split__lbl">Retryable</span>
        </div>
        <div className="occ-failure-split is-red">
          <span className="occ-failure-split__val">{nonRetryable}</span>
          <span className="occ-failure-split__lbl">Non-retryable</span>
        </div>
      </div>
      <div className="occ-failure-command__categories">
        <span>Compliance {compliance}</span>
        <span>Provider {provider}</span>
        <span>Config {config}</span>
        <span>Webhook {webhook}</span>
        <span>Unknown {unknown}</span>
      </div>
    </header>
  )
}