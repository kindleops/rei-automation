import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import type { ColumnPreset, TableDensity, TemplateIntelligenceFilters } from '../../../../domain/templates/template-intelligence.types'
import { COLUMN_PRESET_LABELS } from '../../../../domain/templates/template-operator-labels'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const RANGE_OPTIONS = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All' },
] as const

const PRESETS: ColumnPreset[] = ['performance', 'execution', 'funnel', 'optimization', 'template_health']

interface OccTemplateFilterMenuProps {
  filters: TemplateIntelligenceFilters
  preset: ColumnPreset
  density: TableDensity
  matchingCount: number
  onFiltersChange: (patch: Partial<TemplateIntelligenceFilters>) => void
  onPresetChange: (preset: ColumnPreset) => void
  onDensityChange: (density: TableDensity) => void
  onReset: () => void
  onExport?: () => void
}

function activeFilterCount(filters: TemplateIntelligenceFilters, preset: ColumnPreset): number {
  let n = 0
  if (filters.range !== '7d') n++
  if (filters.stage) n++
  if (filters.query?.trim()) n++
  if (filters.touch != null) n++
  if (filters.followUp != null) n++
  if (filters.useCase) n++
  if (filters.language) n++
  if (filters.activeState) n++
  if (preset !== 'performance') n++
  return n
}

export function OccTemplateFilterMenu({
  filters,
  preset,
  density,
  matchingCount,
  onFiltersChange,
  onPresetChange,
  onDensityChange,
  onReset,
  onExport,
}: OccTemplateFilterMenuProps) {
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const extras = activeFilterCount(filters, preset)

  const close = useCallback(() => setOpen(false), [])

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const top = rect.bottom + 6
    const maxHeight = Math.max(180, Math.min(window.innerHeight - top - margin, 560))
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
    const onLayout = () => updatePanelPosition()
    window.addEventListener('resize', onLayout)
    window.addEventListener('scroll', onLayout, true)
    return () => {
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('scroll', onLayout, true)
    }
  }, [open, updatePanelPosition])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const rangeLabel = RANGE_OPTIONS.find(o => o.key === filters.range)?.label ?? filters.range
  const stageLabel = filters.stage ?? 'All stages'
  const summary = [rangeLabel, stageLabel !== 'All stages' ? stageLabel : null].filter(Boolean).join(' · ')

  const panel = open && typeof document !== 'undefined' ? createPortal(
    <>
      <button type="button" className="occ-liquid-filter__backdrop" aria-label="Close filters" onClick={close} />
      <div
        id={panelId}
        className="occ-liquid-filter__panel is-portaled"
        role="dialog"
        aria-label="Template filters"
        aria-modal="true"
        style={panelStyle}
        onClick={e => e.stopPropagation()}
      >
        <div className="occ-liquid-filter__panel-head">
          <strong>Template filters</strong>
          <button type="button" className="occ-liquid-filter__close" onClick={close} aria-label="Close filters">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="occ-liquid-filter__body">
          <section className="occ-liquid-filter__section">
            <h3>Template range</h3>
            <div className="occ-liquid-filter__pills">
              {RANGE_OPTIONS.map(o => (
                <button
                  key={o.key}
                  type="button"
                  className={cls('occ-mpill', 'occ-mpill--date', filters.range === o.key && 'is-active')}
                  onClick={() => onFiltersChange({ range: o.key })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </section>

          <section className="occ-liquid-filter__section">
            <h3>Stage</h3>
            <select
              className="occ-liquid-filter__select occ-liquid-filter__select--block"
              value={filters.stage ?? 'all'}
              onChange={e => onFiltersChange({ stage: e.target.value === 'all' ? undefined : e.target.value })}
            >
              <option value="all">All stages</option>
              <option value="S1">S1 Ownership</option>
              <option value="S1F">S1F Follow-up</option>
              <option value="S2">S2 Selling interest</option>
              <option value="S3">S3 Asking price</option>
              <option value="S4">S4 Condition</option>
              <option value="S5">S5 Offer</option>
              <option value="S6">S6 Contract</option>
            </select>
          </section>

          <section className="occ-liquid-filter__section">
            <h3>View</h3>
            <div className="occ-liquid-filter__pills occ-liquid-filter__pills--wrap">
              {PRESETS.map(p => (
                <button
                  key={p}
                  type="button"
                  className={cls('occ-mpill', preset === p && 'is-active')}
                  onClick={() => onPresetChange(p)}
                >
                  {COLUMN_PRESET_LABELS[p] ?? p}
                </button>
              ))}
            </div>
          </section>

          <section className="occ-liquid-filter__section">
            <h3>Search</h3>
            <input
              type="search"
              className="occ-liquid-filter__search"
              placeholder="Template name or body…"
              value={filters.query ?? ''}
              onChange={e => onFiltersChange({ query: e.target.value || undefined })}
            />
          </section>

          <section className="occ-liquid-filter__section">
            <h3>More filters</h3>
            <div className="occ-liquid-filter__fields">
              <label className="occ-liquid-filter__field">
                <span>Touch</span>
                <select
                  className="occ-liquid-filter__select"
                  value={filters.touch ?? ''}
                  onChange={e => onFiltersChange({ touch: e.target.value ? Number(e.target.value) : undefined })}
                >
                  <option value="">All touches</option>
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>Touch {n}</option>)}
                </select>
              </label>
              <label className="occ-liquid-filter__field">
                <span>Follow-up</span>
                <select
                  className="occ-liquid-filter__select"
                  value={filters.followUp ?? ''}
                  onChange={e => onFiltersChange({ followUp: e.target.value ? Number(e.target.value) : undefined })}
                >
                  <option value="">All</option>
                  <option value="0">First touch only</option>
                  <option value="1">Follow-up 1</option>
                  <option value="2">Follow-up 2+</option>
                </select>
              </label>
              <label className="occ-liquid-filter__field">
                <span>Language</span>
                <select
                  className="occ-liquid-filter__select"
                  value={filters.language ?? 'all'}
                  onChange={e => onFiltersChange({ language: e.target.value === 'all' ? undefined : e.target.value })}
                >
                  <option value="all">All languages</option>
                  <option value="English">English</option>
                  <option value="Spanish">Spanish</option>
                </select>
              </label>
              <label className="occ-liquid-filter__field">
                <span>Status</span>
                <select
                  className="occ-liquid-filter__select"
                  value={filters.activeState ?? ''}
                  onChange={e => onFiltersChange({ activeState: e.target.value || undefined })}
                >
                  <option value="">All</option>
                  <option value="active">Active only</option>
                  <option value="inactive">Inactive only</option>
                </select>
              </label>
            </div>
          </section>

          <section className="occ-liquid-filter__section">
            <h3>Card density</h3>
            <div className="occ-liquid-filter__density" role="group" aria-label="Card density">
              {(['comfortable', 'compact'] as TableDensity[]).map(d => (
                <button
                  key={d}
                  type="button"
                  className={cls('occ-liquid-filter__density-btn', density === d && 'is-active')}
                  onClick={() => onDensityChange(d)}
                >
                  {d === 'comfortable' ? 'Comfortable' : 'Compact'}
                </button>
              ))}
            </div>
          </section>

          <div className="occ-tpl-filter-actions">
            <button type="button" className="occ-action-btn is-secondary" onClick={onReset}>Reset</button>
            {onExport && <button type="button" className="occ-action-btn is-secondary" onClick={onExport}>Export</button>}
          </div>
        </div>
      </div>
    </>,
    document.body,
  ) : null

  return (
    <div className={cls('occ-liquid-filter', 'occ-tpl-mobile-filter', open && 'is-open')}>
      <button
        ref={triggerRef}
        type="button"
        className="occ-liquid-filter__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => {
          if (open) close()
          else {
            updatePanelPosition()
            setOpen(true)
          }
        }}
      >
        <span className="occ-liquid-filter__trigger-icon" aria-hidden="true">
          <Icon name="filter" size={14} />
        </span>
        <span className="occ-liquid-filter__trigger-copy">
          <span className="occ-liquid-filter__trigger-title">Filters</span>
          <span className="occ-liquid-filter__trigger-sub">{summary || 'All templates'}</span>
        </span>
        {extras > 0 && <span className="occ-liquid-filter__badge">{extras}</span>}
        <span className={cls('occ-liquid-filter__chev', open && 'is-open')} aria-hidden="true">
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      <span className="occ-tpl-mobile-filter__count">{matchingCount.toLocaleString()} templates</span>
      {panel}
    </div>
  )
}