import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { CampaignListFilter } from '../campaign-health'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type CampaignFilterOption = {
  key: CampaignListFilter
  label: string
  count: number
}

interface CampaignFilterMenuProps {
  statusFilter: CampaignListFilter
  options: CampaignFilterOption[]
  onStatusFilter: (filter: CampaignListFilter) => void
  isMobileLayout?: boolean
}

function activeFilterCount(statusFilter: CampaignListFilter): number {
  return statusFilter === 'all' ? 0 : 1
}

export function CampaignFilterMenu({
  statusFilter,
  options,
  onStatusFilter,
  isMobileLayout = false,
}: CampaignFilterMenuProps) {
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const extras = activeFilterCount(statusFilter)

  const activeLabel = options.find((o) => o.key === statusFilter)?.label ?? 'All'
  const activeCount = options.find((o) => o.key === statusFilter)?.count ?? 0
  const summary = statusFilter === 'all'
    ? `All campaigns · ${activeCount}`
    : `${activeLabel} · ${activeCount}`

  const close = useCallback(() => setOpen(false), [])

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const top = rect.bottom + 6
    const maxHeight = Math.max(200, Math.min(window.innerHeight - top - margin, 420))

    if (isMobileLayout) {
      setPanelStyle({
        position: 'fixed',
        top,
        left: margin,
        right: margin,
        maxHeight,
        zIndex: 1200,
      })
      return
    }

    const panelWidth = 280
    const left = Math.min(
      Math.max(margin, rect.right - panelWidth),
      window.innerWidth - panelWidth - margin,
    )
    setPanelStyle({
      position: 'fixed',
      top,
      left,
      width: panelWidth,
      maxHeight,
      zIndex: 1200,
    })
  }, [isMobileLayout])

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
        aria-label="Campaign filters"
        className="occ-liquid-filter__panel is-portaled ccc-liquid-panel"
        style={panelStyle}
      >
        <div className="occ-liquid-filter__panel-head">
          <strong>Filter campaigns</strong>
          <button type="button" className="occ-liquid-filter__close" onClick={close} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="occ-liquid-filter__body">
          <section className="occ-liquid-filter__section">
            <h3>Lifecycle status</h3>
            <label className="occ-liquid-filter__field">
              <span>Status</span>
              <select
                className="occ-liquid-filter__select"
                value={statusFilter}
                onChange={(e) => {
                  onStatusFilter(e.target.value as CampaignListFilter)
                  close()
                }}
              >
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label} ({o.count})
                  </option>
                ))}
              </select>
            </label>
          </section>
          <div className="occ-liquid-filter__pills occ-liquid-filter__pills--wrap ccc-filter-pills">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                className={cls('ccc-filter-pill', statusFilter === o.key && 'is-active')}
                onClick={() => {
                  onStatusFilter(o.key)
                  close()
                }}
              >
                {o.label}
                <span className="ccc-filter-pill__count">{o.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>,
    document.body,
  ) : null

  return (
    <>
      <div className={cls('occ-liquid-filter', 'ccc-liquid-filter', open && 'is-open')}>
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
            <span className="occ-liquid-filter__trigger-title">Status</span>
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