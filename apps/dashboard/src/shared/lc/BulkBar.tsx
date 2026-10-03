/**
 * LCBulkBar — the action bar a list shows while rows are selected.
 *
 *   [☑ 12 selected · of 340 in view]  [Select all 340]  [Clear Esc]      [actions…]
 *   while running:  Archiving 50 of 120  ━━━━━━━━━━━━━━━
 *   after a partial run: 10 archived · 2 blocked  [Why?] → per-item reasons
 *
 * It renders in flow (sticky inside the list's own scroll root), never fixed
 * to the viewport, so it works in any Shell pane. Actions come from the
 * surface; the bar decides nothing about eligibility.
 */
import type { ReactNode } from 'react'
import { LCButton } from './Button'
import { cx } from './cx'
import { LCPopover } from './Popover'
import { LCProgress } from './Rail'
import { LCKbd } from './States'
import type { AllState } from './selection'
import type { IconName } from '../icons'
import './lc-bulk.css'

export interface LCBulkAction {
  id: string
  label: string
  icon?: IconName
  onRun: () => void
  disabled?: boolean
  /** why it is disabled (shown as the title) */
  disabledReason?: string
}

export interface LCBulkIssue { id: string; label: string; outcome: 'blocked' | 'failed'; message: string }

export interface LCBulkBarProps {
  count: number
  inView: number
  all: AllState
  noun: { one: string; many: string }
  onSelectAll: () => void
  onClear: () => void
  actions: LCBulkAction[]
  progress?: { verb: string; done: number; total: number } | null
  /** the last run's outcome line + its per-item issues */
  outcome?: { text: string; issues: LCBulkIssue[] } | null
  onDismissOutcome?: () => void
  className?: string
  children?: ReactNode
}

export function LCBulkBar({ count, inView, all, noun, onSelectAll, onClear, actions, progress, outcome, onDismissOutcome, className }: LCBulkBarProps) {
  if (count === 0 && !progress && !outcome) return null
  const word = count === 1 ? noun.one : noun.many
  return (
    <div className={cx('lc-bulkbar', progress && 'is-running', className)} role="toolbar" aria-label={`Bulk actions for ${count} selected ${word}`}>
      {progress ? (
        <div className="lc-bulkbar__progress" aria-live="polite">
          <span className="lc-bulkbar__count">{progress.verb} {progress.done.toLocaleString('en-US')} of {progress.total.toLocaleString('en-US')}</span>
          <LCProgress value={progress.done} max={Math.max(1, progress.total)} label={`${progress.verb} ${noun.many}`} />
        </div>
      ) : count > 0 ? (
        <>
          <div className="lc-bulkbar__sel">
            <span className={cx('lc-check', all === 'all' ? 'is-on' : 'is-mixed')} aria-hidden="true" />
            <span className="lc-bulkbar__count">{count.toLocaleString('en-US')} {word} selected</span>
            <span className="lc-bulkbar__of">of {inView.toLocaleString('en-US')} in view</span>
          </div>
          <div className="lc-bulkbar__sel-actions">
            {all !== 'all' && inView > count ? (
              <LCButton variant="quiet" size="sm" onClick={onSelectAll}>Select all {inView.toLocaleString('en-US')}</LCButton>
            ) : null}
            <LCButton variant="quiet" size="sm" onClick={onClear} aria-keyshortcuts="Escape">
              Clear <LCKbd keys={['Esc']} />
            </LCButton>
          </div>
          <div className="lc-bulkbar__actions">
            {actions.map((a) => (
              <LCButton key={a.id} variant="secondary" size="sm" icon={a.icon} onClick={a.onRun} disabled={a.disabled} title={a.disabled ? a.disabledReason : undefined}>
                {a.label}
              </LCButton>
            ))}
          </div>
        </>
      ) : null}
      {!progress && outcome ? (
        <div className="lc-bulkbar__outcome" aria-live="polite">
          <span>{outcome.text}</span>
          {outcome.issues.length ? (
            <LCPopover
              label="Items that were not changed"
              width={380}
              side="top"
              align="end"
              trigger={<LCButton variant="quiet" size="sm">Why?</LCButton>}
            >
              <ul className="lc-bulkbar__issues">
                {outcome.issues.slice(0, 40).map((issue) => (
                  <li key={issue.id} className={cx('lc-bulkbar__issue', `is-${issue.outcome}`)}>
                    <span className="lc-bulkbar__issue-who">{issue.label}</span>
                    <span className="lc-bulkbar__issue-why">{issue.message}</span>
                  </li>
                ))}
                {outcome.issues.length > 40 ? <li className="lc-bulkbar__issue is-more">and {outcome.issues.length - 40} more</li> : null}
              </ul>
            </LCPopover>
          ) : null}
          {onDismissOutcome ? <LCButton variant="quiet" size="sm" onClick={onDismissOutcome} aria-label="Dismiss result">Dismiss</LCButton> : null}
        </div>
      ) : null}
    </div>
  )
}
