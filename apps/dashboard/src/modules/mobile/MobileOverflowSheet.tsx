import { type ReactNode } from 'react'
import { Icon, type IconName } from '../../shared/icons'
import { MobileSheet } from './MobileSheet'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export interface OverflowAction {
  id: string
  label: string
  /** One line of supporting truth. Omit rather than pad it with filler. */
  detail?: string
  icon: IconName
  onSelect: () => void
  /** Rendered right-aligned: a count, a status word, a live value. */
  meta?: ReactNode
  active?: boolean
  tone?: 'default' | 'positive' | 'warning' | 'critical' | 'destructive'
  disabled?: boolean
}

export interface MobileOverflowSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  subtitle?: string
  /**
   * Grouped so globals and the current application's own controls stay
   * distinguishable. A group with no actions is dropped, so a caller can pass
   * the same shape on every route without special-casing.
   */
  groups: Array<{ id: string; label?: string; actions: OverflowAction[] }>
}

/**
 * THE CANONICAL MOBILE OVERFLOW / ACTION SHEET.
 *
 * §1 asked the global header to stop presenting five to seven equally weighted
 * circular buttons. The measurement that settled the design: at 390px those
 * buttons paint 38px and sit close enough that their 44px hit areas OVERLAP --
 * probing 21px either side of a control's centre lands on its NEIGHBOUR. So the
 * bar was not merely dense, it was mis-tappable, and making each target bigger
 * would have made that worse rather than better. The fix is fewer controls.
 *
 * Everything displaced lands here: a full-width row per action, with a real
 * label instead of a 15px glyph the operator has to decode. That is also what
 * §12 asks for -- multiple actions belong in a sheet, not a tiny anchored
 * desktop menu.
 *
 * Rows are full-width and 56px tall, so there is no horizontal crowding to
 * collide with and the whole row is the target.
 */
export const MobileOverflowSheet = ({
  open,
  onClose,
  title = 'More',
  subtitle,
  groups,
}: MobileOverflowSheetProps) => {
  const populated = groups.filter((group) => group.actions.length > 0)

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      height="auto"
      className="nx-mobile-overflow"
    >
      <div className="nx-mobile-overflow__body">
        {populated.map((group) => (
          <section key={group.id} className="nx-mobile-overflow__group">
            {group.label ? (
              <h3 className="nx-mobile-overflow__group-label">{group.label}</h3>
            ) : null}
            <div className="nx-mobile-overflow__rows">
              {group.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={cls(
                    'nx-mobile-overflow__row',
                    action.active && 'is-active',
                    action.tone && action.tone !== 'default' && `is-${action.tone}`,
                  )}
                  disabled={action.disabled}
                  aria-pressed={action.active ? true : undefined}
                  onClick={() => {
                    // Close first: every one of these opens another surface, and
                    // leaving the sheet stacked behind it buries the new one.
                    onClose()
                    action.onSelect()
                  }}
                >
                  <span className="nx-mobile-overflow__icon" aria-hidden>
                    <Icon name={action.icon} size={18} strokeWidth={1.7} />
                  </span>
                  <span className="nx-mobile-overflow__text">
                    <span className="nx-mobile-overflow__label">{action.label}</span>
                    {action.detail ? (
                      <span className="nx-mobile-overflow__detail">{action.detail}</span>
                    ) : null}
                  </span>
                  {action.meta ? (
                    <span className="nx-mobile-overflow__meta">{action.meta}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </MobileSheet>
  )
}
