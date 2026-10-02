import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'
import './lc-feedback.css'

/**
 * LCSwitch — an on/off preference that takes effect immediately.
 * (A choice that needs Save/Apply is a checkbox in a form, not a switch.)
 * Native `role="switch"` button: Space/Enter toggle, focus ring from the kit.
 */
export interface LCSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** visible label; omit only when an outer <label>/aria-label names it */
  label?: ReactNode
  /** one line under the label */
  hint?: ReactNode
  size?: 'sm' | 'md'
}

export const LCSwitch = forwardRef<HTMLButtonElement, LCSwitchProps>(function LCSwitch(
  { checked, onCheckedChange, label, hint, size = 'md', disabled, className, onClick, ...rest },
  ref,
) {
  const control = (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx('lc-switch', size === 'sm' && 'is-sm', checked && 'is-on', !label && className)}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onCheckedChange(!checked)
      }}
      {...rest}
    >
      <span className="lc-switch__thumb" aria-hidden="true" />
    </button>
  )
  if (!label) return control
  return (
    <label className={cx('lc-switch-row', disabled && 'is-disabled', className)}>
      <span className="lc-switch-row__text">
        <span className="lc-switch-row__label">{label}</span>
        {hint ? <span className="lc-switch-row__hint">{hint}</span> : null}
      </span>
      {control}
    </label>
  )
})
