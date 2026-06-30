import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { cls } from '../campaign-formatters'

export type ChipFilterOption = {
  key: string
  label: string
}

interface CampaignChipFilterMenuProps {
  label: string
  value: string
  options: ChipFilterOption[]
  onChange: (key: string) => void
}

export function CampaignChipFilterMenu({
  label,
  value,
  options,
  onChange,
}: CampaignChipFilterMenuProps) {
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const activeLabel = options.find((o) => o.key === value)?.label ?? 'All'
  const close = useCallback(() => setOpen(false), [])

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const top = rect.bottom + 6
    const maxHeight = Math.max(180, Math.min(window.innerHeight - top - margin, 320))
    setPanelStyle({
      position: 'fixed',
      top,
      left: margin,
      right: margin,
      maxHeight,
      zIndex: 1200,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updatePanelPosition()
    window.addEventListener('resize', updatePanelPosition)
    window.addEventListener('scroll', updatePanelPosition, true)
    return () => {
      window.removeEventListener('resize', updatePanelPosition)
      window.removeEventListener('scroll', updatePanelPosition, true)
    }
  }, [open, updatePanelPosition])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const panel = open ? createPortal(
    <>
      <button type="button" className="occ-liquid-filter__backdrop" aria-label="Close filter" onClick={close} />
      <div
        id={panelId}
        role="dialog"
        aria-label={`${label} filter`}
        className="occ-liquid-filter__panel is-portaled ccc-liquid-panel"
        style={panelStyle}
      >
        <div className="occ-liquid-filter__panel-head">
          <strong>{label}</strong>
          <button type="button" className="occ-liquid-filter__close" onClick={close} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="occ-liquid-filter__body ccc-detail-tab-picker">
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={cls('ccc-detail-tab-picker__item', value === opt.key && 'is-active')}
              onClick={() => {
                onChange(opt.key)
                close()
              }}
            >
              {opt.label}
              {value === opt.key && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body,
  ) : null

  return (
    <>
      <div className={cls('occ-liquid-filter', 'ccc-liquid-filter', 'ccc-mobile-chip-filter', open && 'is-open')}>
        <button
          ref={triggerRef}
          type="button"
          className="occ-liquid-filter__trigger"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="occ-liquid-filter__trigger-copy">
            <span className="occ-liquid-filter__trigger-title">{label}</span>
            <span className="occ-liquid-filter__trigger-sub">{activeLabel}</span>
          </span>
          <span className={cls('occ-liquid-filter__chev', open && 'is-open')} aria-hidden="true">
            <Icon name="chevron-down" size={14} />
          </span>
        </button>
      </div>
      {panel}
    </>
  )
}