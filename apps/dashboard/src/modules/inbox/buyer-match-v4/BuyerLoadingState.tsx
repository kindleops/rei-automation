interface Props {
  variant?: 'inline' | 'panel' | 'skeleton'
  message?: string
  timedOut?: boolean
  onRetry?: () => void
}

export function BuyerLoadingState({
  variant = 'panel',
  message = 'Loading buyer market…',
  timedOut = false,
  onRetry,
}: Props) {
  if (variant === 'skeleton') {
    return (
      <div className="bmv4-skeleton" aria-hidden>
        <div className="bmv4-skeleton__bar" />
        <div className="bmv4-skeleton__bar is-short" />
        <div className="bmv4-skeleton__card" />
        <div className="bmv4-skeleton__card" />
      </div>
    )
  }

  return (
    <div className={`bmv4-loading is-${variant}`}>
      {!timedOut ? (
        <>
          <div className="bmv4-loading__spinner" aria-hidden />
          <p>{message}</p>
        </>
      ) : (
        <>
          <p className="bmv4-state bmv4-state--error">Buyer market is taking longer than expected.</p>
          {onRetry && (
            <button type="button" className="bmv4-btn" onClick={onRetry}>
              Retry projection
            </button>
          )}
        </>
      )}
    </div>
  )
}