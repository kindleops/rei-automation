import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'

type PiGlassSelectProps = {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
  searchable?: boolean
}

export function PiGlassSelect({ label, value, options, onChange, searchable = false }: PiGlassSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  const filtered = searchable && query.trim()
    ? options.filter((option) => option.toLowerCase().includes(query.trim().toLowerCase()))
    : options

  return (
    <div className="pi-glass-select" ref={rootRef}>
      <span className="pi-glass-select__label">{label}</span>
      <button
        type="button"
        className={`pi-glass-select__trigger${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{value}</span>
        <Icon name="chevron-down" />
      </button>
      {open && (
        <div className="pi-glass-select__menu nx-liquid-popover" role="listbox" id={listId}>
          {searchable && (
            <div className="pi-glass-select__search">
              <Icon name="search" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${label.toLowerCase()}`}
                aria-label={`Search ${label}`}
              />
            </div>
          )}
          <div className="pi-glass-select__options">
            {filtered.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === value}
                className={option === value ? 'is-active' : ''}
                onClick={() => {
                  onChange(option)
                  setOpen(false)
                  setQuery('')
                }}
              >
                {option}
              </button>
            ))}
            {filtered.length === 0 && <div className="pi-glass-select__empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  )
}