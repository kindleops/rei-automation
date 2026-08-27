import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import { MobileBottomSheet } from '../../../../modules/mobile/MobileBottomSheet'
import type { ColumnPreset, TemplateIntelligenceFilters } from '../../../../domain/templates/template-intelligence.types'
import { COLUMN_PRESET_LABELS } from '../../../../domain/templates/template-operator-labels'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All' },
] as const

const STAGES = [
  { key: 'S1', label: 'S1' },
  { key: 'S1F', label: 'S1F' },
  { key: 'S2', label: 'S2' },
  { key: 'S3', label: 'S3' },
  { key: 'S4', label: 'S4' },
  { key: 'S5', label: 'S5' },
  { key: 'S6', label: 'S6' },
] as const

const VIEWS: ColumnPreset[] = ['performance', 'execution', 'funnel', 'optimization', 'template_health']

interface TemplateMobileFiltersProps {
  open: boolean
  filters: TemplateIntelligenceFilters
  preset: ColumnPreset
  matchingCount: number
  onClose: () => void
  onFiltersChange: (patch: Partial<TemplateIntelligenceFilters>) => void
  onPresetChange: (preset: ColumnPreset) => void
  onReset: () => void
}

/** Range / Stage / View / Search stay open; touch, language and state collapse. */
export function TemplateMobileFilters({
  open,
  filters,
  preset,
  matchingCount,
  onClose,
  onFiltersChange,
  onPresetChange,
  onReset,
}: TemplateMobileFiltersProps) {
  const [moreOpen, setMoreOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <MobileBottomSheet open snap="expanded" onClose={onClose} className="qm-filter-sheet">
      <header className="qm-filter__head">
        <strong>Template filters</strong>
        <button type="button" className="qms-chrome__btn is-close" onClick={onClose} aria-label="Close filters">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="qm-filter__body">
        <section className="qm-filter__section">
          <h3>Range</h3>
          <div className="qm-filter__rail">
            {RANGES.map(r => (
              <button
                key={r.key}
                type="button"
                className={cls('qm-chip', filters.range === r.key && 'is-active')}
                onClick={() => onFiltersChange({ range: r.key as TemplateIntelligenceFilters['range'] })}
              >
                {r.label}
              </button>
            ))}
          </div>
        </section>

        <section className="qm-filter__section">
          <h3>Stage</h3>
          <div className="qm-filter__rail">
            <button
              type="button"
              className={cls('qm-chip', !filters.stage && 'is-active')}
              onClick={() => onFiltersChange({ stage: undefined })}
            >
              All
            </button>
            {STAGES.map(s => (
              <button
                key={s.key}
                type="button"
                className={cls('qm-chip', filters.stage === s.key && 'is-active')}
                onClick={() => onFiltersChange({ stage: filters.stage === s.key ? undefined : s.key })}
              >
                {s.label}
              </button>
            ))}
          </div>
        </section>

        <section className="qm-filter__section">
          <h3>View</h3>
          <div className="qm-filter__rail">
            {VIEWS.map(v => (
              <button
                key={v}
                type="button"
                className={cls('qm-chip', preset === v && 'is-active')}
                onClick={() => onPresetChange(v)}
              >
                {COLUMN_PRESET_LABELS[v] ?? v}
              </button>
            ))}
          </div>
        </section>

        <section className="qm-filter__section">
          <h3>Search</h3>
          <input
            type="search"
            className="qm-filter__search"
            placeholder="Template name or message…"
            value={filters.query ?? ''}
            onChange={e => onFiltersChange({ query: e.target.value || undefined })}
          />
        </section>

        <section className="qm-tpl-collapse">
          <button
            type="button"
            className="qm-tpl-collapse__toggle"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(v => !v)}
          >
            <span>More</span>
            <Icon name={moreOpen ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
          {moreOpen && (
            <div className="qm-tpl-collapse__body">
              <label className="qm-filter__field">
                <span>Touch</span>
                <select
                  className="qm-filter__select"
                  value={filters.touch ?? 'all'}
                  onChange={e => onFiltersChange({ touch: e.target.value === 'all' ? undefined : Number(e.target.value) })}
                >
                  <option value="all">Any touch</option>
                  {[1, 2, 3, 4, 5].map(t => <option key={t} value={t}>Touch {t}</option>)}
                </select>
              </label>
              <label className="qm-filter__field">
                <span>Language</span>
                <select
                  className="qm-filter__select"
                  value={filters.language ?? 'all'}
                  onChange={e => onFiltersChange({ language: e.target.value === 'all' ? undefined : e.target.value })}
                >
                  <option value="all">Any language</option>
                  <option value="en">English</option>
                  <option value="es">Spanish</option>
                </select>
              </label>
              <label className="qm-filter__field">
                <span>State</span>
                <select
                  className="qm-filter__select"
                  value={filters.activeState ?? 'all'}
                  onChange={e => onFiltersChange({ activeState: e.target.value === 'all' ? undefined : e.target.value })}
                >
                  <option value="all">Any state</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
              <button type="button" className="qm-filter__reset" onClick={onReset}>Reset all filters</button>
            </div>
          )}
        </section>
      </div>

      <footer className="qm-filter__foot">
        <button type="button" className="qms-action is-primary" onClick={onClose}>
          Show {matchingCount.toLocaleString()} template{matchingCount === 1 ? '' : 's'}
        </button>
      </footer>
    </MobileBottomSheet>,
    document.body,
  )
}
