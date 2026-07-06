import { useEffect, useId, useRef, useState } from 'react'

import { cls } from '../utils'

export interface GlassSelectOption {
  label: string
  value: string
}

export interface GlassSelectProps {
  value: string
  options: GlassSelectOption[]
  placeholder?: string
  disabled?: boolean
  onChange: (value: string) => void
  'aria-label'?: string
}

export function GlassSelect({
  value,
  options,
  placeholder = 'Select…',
  disabled = false,
  onChange,
  'aria-label': ariaLabel,
}: GlassSelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selected = options.find((option) => option.value === value) ?? null

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className={cls('mf-glass-select', open && 'is-open', disabled && 'is-disabled')} ref={rootRef}>
      <button
        type="button"
        className="mf-glass-select__trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={cls('mf-glass-select__value', !selected && 'is-placeholder')}>
          {selected?.label ?? placeholder}
        </span>
        <span className="mf-glass-select__chevron" aria-hidden>▾</span>
      </button>
      {open ? (
        <ul id={listId} className="mf-glass-select__menu" role="listbox">
          {options.map((option) => (
            <li key={option.value} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={cls('mf-glass-select__option', option.value === value && 'is-active')}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}