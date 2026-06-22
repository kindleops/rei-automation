import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CalendarScopeMode } from '../../../lib/data/calendarData'
import type { CalendarTimezoneMode } from '../../../lib/calendar/calendar-timezone'
import type { CalendarLayerId } from '../../../lib/calendar/calendar-layers'
import { Icon } from '../../../shared/icons'
import { CalendarLayersPopover } from './CalendarLayersPopover'

type CalendarCommandOverflowProps = {
  scopeMode: CalendarScopeMode
  selectedEnabled: boolean
  timezoneMode: CalendarTimezoneMode
  layers: CalendarLayerId[]
  visibleEventCount: number
  railOpen: boolean
  showRailToggle: boolean
  onScopeChange: (value: CalendarScopeMode) => void
  onTimezoneModeChange: (value: CalendarTimezoneMode) => void
  onLayersChange: (layers: CalendarLayerId[]) => void
  onToggleRail: () => void
}

export function CalendarCommandOverflow({
  scopeMode,
  selectedEnabled,
  timezoneMode,
  layers,
  visibleEventCount,
  railOpen,
  showRailToggle,
  onScopeChange,
  onTimezoneModeChange,
  onLayersChange,
  onToggleRail,
}: CalendarCommandOverflowProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="nx-cal__cmd-overflow">
      <button
        ref={triggerRef}
        type="button"
        className="nx-cal__icon-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="More calendar controls"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" />
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div className="nx-cal__cmd-overflow-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div className="nx-cal__cmd-overflow-panel" role="dialog" aria-label="Calendar controls" onClick={(e) => e.stopPropagation()}>
            <div className="nx-cal__cmd-overflow-row">
              <span>Timezone</span>
              <select value={timezoneMode} onChange={(e) => onTimezoneModeChange(e.target.value as CalendarTimezoneMode)}>
                <option value="operator">Operator</option>
                <option value="property">Property</option>
                <option value="recipient">Recipient</option>
              </select>
            </div>
            <div className="nx-cal__cmd-overflow-row nx-cal__scope-toggle">
              <button type="button" className={scopeMode === 'global' ? 'is-active' : ''} onClick={() => onScopeChange('global')}>Global</button>
              <button
                type="button"
                className={scopeMode === 'selected' ? 'is-active' : ''}
                onClick={() => onScopeChange('selected')}
                disabled={!selectedEnabled}
                title={!selectedEnabled ? 'Select an entity first' : 'Selected Entity scope'}
              >
                Selected Entity
              </button>
            </div>
            <div className="nx-cal__cmd-overflow-row">
              <CalendarLayersPopover layers={layers} visibleCount={visibleEventCount} onChange={onLayersChange} />
            </div>
            {showRailToggle ? (
              <button type="button" className="nx-cal__cmd-btn" onClick={() => { onToggleRail(); setOpen(false) }}>
                {railOpen ? 'Hide rail' : 'Show rail'}
              </button>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}