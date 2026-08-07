import { useEffect, useState } from 'react'

/**
 * The single skeleton primitive — constitution §8.
 *
 * §8.1 three tiers by expected duration:
 *   < 200ms  render nothing (no flash)
 *   200ms–2s skeleton matching the final layout geometry
 *   > 2s     skeleton + a labelled progress line, and after 8s an inline retry
 * §8.2 the caller declares real geometry (`rows`, `rowHeight`, `widths`) so the
 *      skeleton cannot differ in shape from the loaded content.
 * §8.3 no spinner may outlive its request — `onRetry` surfaces at 8s.
 */

export interface SkeletonProps {
  /** Number of placeholder rows. Mirror the real list length where known. */
  rows?: number
  /** Row height in px — mirror the real row height. */
  rowHeight?: number
  /** Per-row widths as CSS lengths; cycles if shorter than `rows`. */
  widths?: string[]
  /** What is loading, e.g. "comps". Shown after 2s per §8.1. */
  label?: string
  /** Shown as an inline retry after 8s per §8.1. */
  onRetry?: () => void
  className?: string
  /** Suppress the <200ms delay (already-known-slow surfaces). */
  immediate?: boolean
}

export const Skeleton = ({
  rows = 3,
  rowHeight = 16,
  widths = ['100%', '82%', '64%'],
  label,
  onRetry,
  className,
  immediate = false,
}: SkeletonProps) => {
  const [phase, setPhase] = useState<'hidden' | 'skeleton' | 'labelled' | 'retry'>(
    immediate ? 'skeleton' : 'hidden',
  )

  useEffect(() => {
    const timers = [
      !immediate ? window.setTimeout(() => setPhase('skeleton'), 200) : null,
      window.setTimeout(() => setPhase('labelled'), 2000),
      window.setTimeout(() => setPhase('retry'), 8000),
    ].filter((t): t is number => t !== null)
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [immediate])

  if (phase === 'hidden') return null

  const showLabel = label && (phase === 'labelled' || phase === 'retry')
  const showRetry = onRetry && phase === 'retry'

  return (
    <div
      className={['lc-ui', 'lc-skeleton', className].filter(Boolean).join(' ')}
      aria-busy="true"
      aria-live="polite"
    >
      {Array.from({ length: rows }, (_, index) => (
        <span
          key={index}
          className="lc-skeleton__line"
          style={{ height: rowHeight, width: widths[index % widths.length] }}
        />
      ))}
      {showLabel || showRetry ? (
        <div className="lc-skeleton__progress">
          {showLabel ? <span>Loading {label}…</span> : null}
          {showRetry ? (
            <button type="button" className="lc-skeleton__retry" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
