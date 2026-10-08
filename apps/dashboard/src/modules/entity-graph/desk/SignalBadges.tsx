/**
 * Signal badges — one colored chip per signal (property-signals.ts):
 * distress (red) · opportunity (green) · risk (amber) · neutral (grey).
 * `max` folds the tail into "+N" (the title lists them all).
 */
import { cx } from '../../../shared/lc'
import type { PropertySignal } from '../mobile/property-signals'

export function SignalBadges({ signals, max = 4, size = 'sm' }: { signals: PropertySignal[]; max?: number; size?: 'sm' | 'md' }) {
  if (!signals.length) return <span className="egdk-cell-none">—</span>
  const shown = signals.slice(0, max)
  const rest = signals.length - shown.length
  return (
    <span className={cx('egdk-sigs', size === 'md' && 'is-md')} title={signals.map((s) => s.label).join(' · ')}>
      {shown.map((s) => <span key={s.key} className={cx('egdk-sig', `is-${s.tone}`)}>{s.label}</span>)}
      {rest > 0 ? <span className="egdk-sig is-more">+{rest}</span> : null}
    </span>
  )
}
