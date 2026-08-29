import type { ReactNode } from 'react'

/**
 * The single empty-state primitive — constitution §9.
 *
 * §9.2 four kinds, visually distinct:
 *   first-run       never had data — explain the feature, offer setup
 *   filtered-empty  data exists, filters exclude it — offer Clear filters + count
 *   genuinely-empty a real zero and that is good news — rendered positively
 *   unavailable     cannot be shown (permission/backend) — routes to §10
 * §9.1 every empty state states a cause and offers an action, or says
 *      explicitly that nothing is needed.
 * §9.3 it never occupies a large canvas with a centred icon and nothing else.
 */

export type EmptyStateKind = 'first-run' | 'filtered-empty' | 'genuinely-empty' | 'unavailable'

const EYEBROW: Record<EmptyStateKind, string> = {
  'first-run': 'Not set up yet',
  'filtered-empty': 'Filtered out',
  'genuinely-empty': 'All clear',
  unavailable: 'Unavailable',
}

const TONE: Record<EmptyStateKind, string> = {
  'first-run': 'lc-state--neutral',
  'filtered-empty': 'lc-state--neutral',
  'genuinely-empty': 'lc-state--positive',
  unavailable: 'lc-state--caution',
}

export interface EmptyStateProps {
  kind: EmptyStateKind
  /** What the operator is looking at. */
  title: string
  /** Why it is empty — required by §9.1. */
  cause: string
  /** Number of active filters, for `filtered-empty`. */
  activeFilterCount?: number
  onClearFilters?: () => void
  /** The next useful action. Omit only when nothing is needed. */
  action?: { label: string; onClick: () => void }
  /** Explicit "nothing needed" copy when there is genuinely no action. */
  nothingNeeded?: string
  children?: ReactNode
  className?: string
}

export const EmptyState = ({
  kind,
  title,
  cause,
  activeFilterCount,
  onClearFilters,
  action,
  nothingNeeded,
  children,
  className,
}: EmptyStateProps) => (
  <div
    className={['lc-ui', 'lc-state', TONE[kind], className].filter(Boolean).join(' ')}
    data-lc-empty-kind={kind}
  >
    <span className="lc-state__eyebrow">{EYEBROW[kind]}</span>
    <h3 className="lc-state__title">{title}</h3>
    <div className="lc-state__body">
      <p style={{ margin: 0 }}>{cause}</p>
      {kind === 'filtered-empty' && typeof activeFilterCount === 'number' ? (
        <span className="lc-state__meta">
          {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active
        </span>
      ) : null}
      {nothingNeeded ? <span className="lc-state__meta">{nothingNeeded}</span> : null}
    </div>
    {children}
    {action || onClearFilters ? (
      <div className="lc-state__actions">
        {onClearFilters ? (
          <button type="button" className="lc-ui-btn" onClick={onClearFilters}>
            Clear filters
          </button>
        ) : null}
        {action ? (
          <button type="button" className="lc-ui-btn lc-ui-btn--primary" onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </div>
    ) : null}
  </div>
)
