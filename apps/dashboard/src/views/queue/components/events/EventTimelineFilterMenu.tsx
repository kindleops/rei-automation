import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import { TIMELINE_TYPE_FILTERS, type TimelineGroupBy, type TimelineTypeFilter } from '../../event-timeline-stats'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const GROUP_OPTIONS: Array<{ key: TimelineGroupBy; label: string }> = [
  { key: 'time', label: 'Time' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'seller', label: 'Seller' },
  { key: 'sender', label: 'Sender' },
  { key: 'market', label: 'Market' },
]

interface EventTimelineFilterMenuProps {
  typeFilter: TimelineTypeFilter
  groupBy: TimelineGroupBy
  onTypeFilter: (filter: TimelineTypeFilter) => void
  onGroupBy: (group: TimelineGroupBy) => void
}

function activeFilterCount(typeFilter: TimelineTypeFilter, groupBy: TimelineGroupBy): number {
  let n = 0
  if (typeFilter !== 'all') n++
  if (groupBy !== 'time') n++
  return n
}

export function EventTimelineFilterMenu({
  typeFilter,
  groupBy,
  onTypeFilter,
  onGroupBy,
}: EventTimelineFilterMenuProps) {
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const extras = activeFilterCount(typeFilter, groupBy)

  const typeLabel = TIMELINE_TYPE_FILTERS.find((f) => f.key === typeFilter)?.label ?? 'All'
  const groupLabel = GROUP_OPTIONS.find((g) => g.key === groupBy)?.label ?? 'Time'
  const summary = `${typeLabel} · ${groupLabel}`

  const close = useCallback(() => setOpen(false), [])

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const top = rect.bottom + 6
    const maxHeight = Math.max(160, Math.min(window.innerHeight - top - margin, 320))
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
      <button
        type="button"
        className="occ-liquid-filter__backdrop"
        aria-label="Close filters"
        onClick={close}
      />
      <div
        id={panelId}
        role="dialog"
        aria-label="Event timeline filters"
        className="occ-liquid-filter__panel is-portaled occ-evt-liquid-panel"
        style={panelStyle}
      >
        <div className="occ-liquid-filter__panel-head">
          <strong>Event filters</strong>
          <button type="button" className="occ-liquid-filter__close" onClick={close} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="occ-liquid-filter__body">
          <section className="occ-liquid-filter__section">
            <h3>Event type</h3>
            <label className="occ-liquid-filter__field">
              <span>Type</span>
              <select
                className="occ-liquid-filter__select"
                value={typeFilter}
                onChange={(e) => onTypeFilter(e.target.value as TimelineTypeFilter)}
              >
                {TIMELINE_TYPE_FILTERS.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </select>
            </label>
          </section>
          <section className="occ-liquid-filter__section">
            <h3>Grouping</h3>
            <label className="occ-liquid-filter__field">
              <span>Group by</span>
              <select
                className="occ-liquid-filter__select"
                value={groupBy}
                onChange={(e) => onGroupBy(e.target.value as TimelineGroupBy)}
              >
                {GROUP_OPTIONS.map((g) => (
                  <option key={g.key} value={g.key}>{g.label}</option>
                ))}
              </select>
            </label>
          </section>
        </div>
      </div>
    </>,
    document.body,
  ) : null

  return (
    <>
      <div className={cls('occ-liquid-filter', 'occ-evt-liquid-filter', open && 'is-open')}>
        <button
          ref={triggerRef}
          type="button"
          className="occ-liquid-filter__trigger"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="occ-liquid-filter__trigger-icon" aria-hidden="true">
            <Icon name="filter" size={15} />
          </span>
          <span className="occ-liquid-filter__trigger-copy">
            <span className="occ-liquid-filter__trigger-title">Filters</span>
            <span className="occ-liquid-filter__trigger-sub">{summary}</span>
          </span>
          {extras > 0 && <span className="occ-liquid-filter__badge">{extras}</span>}
          <span className={cls('occ-liquid-filter__chev', open && 'is-open')} aria-hidden="true">
            <Icon name="chevron-down" size={14} />
          </span>
        </button>
      </div>
      {panel}
    </>
  )
}