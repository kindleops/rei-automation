export const ShellErrorState = ({
  title = 'Unable to load',
  detail,
  onRetry,
}: {
  title?: string
  detail?: string
  onRetry?: () => void
}) => (
  <div className="nx-shell-error" role="alert">
    <strong>{title}</strong>
    {detail ? <p>{detail}</p> : null}
    {onRetry ? (
      <button type="button" className="nx-shell-error__retry" onClick={onRetry}>
        Retry
      </button>
    ) : null}
  </div>
)