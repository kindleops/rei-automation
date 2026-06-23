import type { LiveStateKind } from '../shell-types'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const LABELS: Record<LiveStateKind, string> = {
  live: 'Live',
  updating: 'Updating',
  updated: 'Updated just now',
  delayed: 'Delayed',
  degraded: 'Degraded',
  offline: 'Offline',
}

export const LiveStateBadge = ({
  state,
  className,
}: {
  state: LiveStateKind
  className?: string
}) => (
  <span className={cls('nx-shell-live-state', `is-${state}`, className)} role="status" aria-live="polite">
    <i className="nx-shell-live-state__dot" aria-hidden />
    {LABELS[state]}
  </span>
)