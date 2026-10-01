import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { LCTooltip } from './Tooltip'
import { cx } from './cx'
import './lc-controls.css'

/**
 * LCButton — hierarchy, not a filled rectangle for every action.
 *
 *   primary   the one action a surface is for (accent)
 *   secondary a real action, quieter (glass)
 *   quiet     inline / toolbar text action
 *   ghost     tertiary, appears on hover context
 *   danger    destructive; red is reserved for this
 *
 * Press compresses a hair; loading morphs the icon into a spinner while the
 * label stays put (no layout jump). Copy is product language: "Retry send",
 * "Open campaign", "Apply filters" — never "Submit" or "OK".
 */

export type LCButtonVariant = 'primary' | 'secondary' | 'quiet' | 'ghost' | 'danger'

export interface LCButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: LCButtonVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: IconName
  trailingIcon?: IconName
  loading?: boolean
  /** stretch to the container's width */
  block?: boolean
  children?: ReactNode
}

export const LCButton = forwardRef<HTMLButtonElement, LCButtonProps>(function LCButton(
  { variant = 'secondary', size = 'md', icon, trailingIcon, loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('lc-btn', `is-${variant}`, `is-${size}`, block && 'is-block', loading && 'is-loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="lc-btn__spin" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} className="lc-btn__icon" /> : null}
      {children !== undefined && children !== null ? <span className="lc-btn__label">{children}</span> : null}
      {trailingIcon && !loading ? <Icon name={trailingIcon} size={size === 'sm' ? 12 : 14} className="lc-btn__trail" /> : null}
    </button>
  )
})

export interface LCIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName
  /** required: the tooltip and the accessible name */
  label: string
  size?: 'sm' | 'md' | 'lg'
  /** pressed / selected tool */
  selected?: boolean
  /** a meaningful state dot (new activity, needs attention) */
  dot?: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | null
  /** a small count instead of a dot */
  count?: number | null
  variant?: 'plain' | 'glass'
  shortcut?: string[]
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
  /** suppress the tooltip (e.g. when a visible label sits beside it) */
  noTooltip?: boolean
}

/** Dense visual, sufficient target: the hit area extends past the glyph. */
export const LCIconButton = forwardRef<HTMLButtonElement, LCIconButtonProps>(function LCIconButton(
  { icon, label, size = 'md', selected, dot, count, variant = 'plain', shortcut, tooltipSide = 'bottom', noTooltip, className, type = 'button', ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={selected === undefined ? undefined : selected}
      className={cx('lc-ibtn', 'lc-hit', `is-${size}`, `is-${variant}`, selected && 'is-selected', className)}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} />
      {typeof count === 'number' && count > 0 ? (
        <span className="lc-ibtn__count" aria-hidden="true">{count > 99 ? '99+' : count}</span>
      ) : dot ? (
        <span className="lc-ibtn__dot" data-tone={dot} aria-hidden="true" />
      ) : null}
    </button>
  )
  return noTooltip ? btn : <LCTooltip content={label} side={tooltipSide} shortcut={shortcut}>{btn}</LCTooltip>
})

/** A quiet inline link-button for secondary actions inside text. */
export const LCLink = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName }>(function LCLink(
  { className, children, icon, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx('lc-link', className)} {...rest}>
      {children}
      {icon ? <Icon name={icon} size={12} /> : null}
    </button>
  )
})
