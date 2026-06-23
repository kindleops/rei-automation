import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CALENDAR_LAYER_CATEGORIES,
  CALENDAR_LAYER_OPTIONS,
  CALENDAR_LAYER_PRESETS,
  type CalendarLayerId,
} from '../../../lib/calendar/calendar-layers'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarLayersPopoverProps = {
  layers: CalendarLayerId[]
  visibleCount: number
  onChange: (layers: CalendarLayerId[]) => void
}

export function CalendarLayersPopover({ layers, visibleCount, onChange }: CalendarLayersPopoverProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const toggle = (id: CalendarLayerId) => {
    const next = layers.includes(id) ? layers.filter((layer) => layer !== id) : [...layers, id]
    onChange(next.length ? next : CALENDAR_LAYER_OPTIONS.map((l) => l.id))
  }

  const allIds = CALENDAR_LAYER_OPTIONS.map((l) => l.id)
  const activeCount = layers.length

  const rect = triggerRef.current?.getBoundingClientRect()
  const popoverStyle = rect
    ? { top: rect.bottom + 8, right: Math.max(12, window.innerWidth - rect.right) }
    : undefined

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cls('nx-cal__cmd-btn', open && 'is-active')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Icon name="layers" />
        <span>Layers</span>
        <span className="nx-cal__cmd-badge" title={`${activeCount} active layers`}>{activeCount} active</span>
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              className="nx-cal__layers-popover"
              role="dialog"
              aria-label="Calendar layers"
              style={popoverStyle}
            >
              <div className="nx-cal__layers-popover-head">
                <div>
                  <strong>Layers</strong>
                  <span>{visibleCount} visible events</span>
                </div>
                <button type="button" className="nx-cal__icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                  <Icon name="close" />
                </button>
              </div>

              <div className="nx-cal__layers-presets">
                {CALENDAR_LAYER_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="nx-cal__layers-preset"
                    onClick={() => onChange(preset.layers())}
                  >
                    {preset.label}
                  </button>
                ))}
                <button type="button" className="nx-cal__layers-preset" onClick={() => onChange(allIds)}>Select All</button>
                <button type="button" className="nx-cal__layers-preset" onClick={() => onChange([])}>Clear</button>
              </div>

              <div className="nx-cal__layers-categories">
                {CALENDAR_LAYER_CATEGORIES.map((category) => (
                  <section key={category.id} className="nx-cal__layers-category">
                    <span className="nx-cal__layers-category-label">{category.label}</span>
                    <div className="nx-cal__layers-category-grid">
                      {CALENDAR_LAYER_OPTIONS.filter((l) => category.layers.includes(l.id)).map((layer) => (
                        <button
                          key={layer.id}
                          type="button"
                          className={cls('nx-cal__layer-toggle', layers.includes(layer.id) && 'is-active')}
                          onClick={() => toggle(layer.id)}
                        >
                          {layer.label}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}