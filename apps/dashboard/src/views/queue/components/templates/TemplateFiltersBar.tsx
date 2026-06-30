import { useState } from 'react'
import type { ColumnPreset, TableDensity, TemplateIntelligenceFilters } from '../../../../domain/templates/template-intelligence.types'
import { COLUMN_PRESET_LABELS } from '../../../../domain/templates/template-operator-labels'
import { ALL_PERFORMANCE_COLUMNS } from '../../../../lib/data/templateIntelligenceData'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const PRESETS: ColumnPreset[] = ['performance', 'execution', 'funnel', 'optimization', 'template_health']

const PERF_COL_LABELS: Record<string, string> = {
  sends: 'Sends',
  delivered: 'Delivered',
  delivery_rate: 'Delivery Rate',
  failed: 'Failed',
  replies: 'Replies',
  reply_rate: 'Reply Rate',
  avg_reply_time: 'Avg Reply Time',
  positive_replies: 'Positive Replies',
  positive_rate: 'Positive Rate',
  negative_replies: 'Negative Replies',
  negative_rate: 'Negative Rate',
  ownership_confirmed: 'Ownership Confirmed',
  stage_advanced: 'Stage Advanced',
  opt_outs: 'Opt-Outs',
  wrong_numbers: 'Wrong Numbers',
  confidence: 'Confidence',
  trend: 'Trend',
}

interface TemplateFiltersBarProps {
  filters: TemplateIntelligenceFilters
  preset: ColumnPreset
  density: TableDensity
  visibleColumns: string[]
  isMobileLayout?: boolean
  onFiltersChange: (patch: Partial<TemplateIntelligenceFilters>) => void
  onPresetChange: (preset: ColumnPreset) => void
  onDensityChange: (density: TableDensity) => void
  onVisibleColumnsChange: (cols: string[]) => void
  onReset: () => void
  onExport?: () => void
}

export function TemplateFiltersBar({
  filters,
  preset,
  density,
  visibleColumns,
  isMobileLayout = false,
  onFiltersChange,
  onPresetChange,
  onDensityChange,
  onVisibleColumnsChange,
  onReset,
  onExport,
}: TemplateFiltersBarProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const [colsOpen, setColsOpen] = useState(false)

  if (isMobileLayout) return null

  const toggleCol = (col: string) => {
    if (visibleColumns.includes(col)) {
      if (visibleColumns.length <= 3) return
      onVisibleColumnsChange(visibleColumns.filter((c) => c !== col))
    } else {
      onVisibleColumnsChange([...visibleColumns, col])
    }
  }

  return (
    <div className="occ-tpl-filters">
      <div className="occ-tpl-filters__row">
        <input
          type="search"
          className="occ-search occ-tpl-filters__search"
          placeholder="Search templates…"
          value={filters.query ?? ''}
          onChange={(e) => onFiltersChange({ query: e.target.value || undefined })}
        />
        <button type="button" className="occ-action-btn is-secondary" onClick={() => setMoreOpen((o) => !o)}>
          {moreOpen ? 'Fewer filters' : 'More filters'}
        </button>
        {preset === 'performance' && (
          <button type="button" className="occ-action-btn is-secondary" onClick={() => setColsOpen((o) => !o)}>
            Columns
          </button>
        )}
        <button type="button" className="occ-action-btn is-secondary" onClick={onReset}>Reset</button>
        {onExport && <button type="button" className="occ-action-btn is-secondary" onClick={onExport}>Export</button>}
        <span className="occ-tpl-shadow-badge">Optimization: Recommendations only</span>
      </div>

      {moreOpen && (
        <div className="occ-tpl-filters__row occ-tpl-filters__row--more">
          <select className="occ-filter-select" value={filters.touch ?? ''} onChange={(e) => onFiltersChange({ touch: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">All touches</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>Touch {n}</option>)}
          </select>
          <select className="occ-filter-select" value={filters.followUp ?? ''} onChange={(e) => onFiltersChange({ followUp: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">All follow-ups</option>
            <option value="0">First touch only</option>
            <option value="1">Follow-up 1</option>
            <option value="2">Follow-up 2+</option>
          </select>
          <select className="occ-filter-select" value={filters.useCase ?? 'all'} onChange={(e) => onFiltersChange({ useCase: e.target.value === 'all' ? undefined : e.target.value })}>
            <option value="all">All use cases</option>
            <option value="ownership_check">Ownership check</option>
            <option value="consider_selling">Selling interest</option>
            <option value="asking_price">Asking price</option>
            <option value="condition_probe">Condition</option>
            <option value="offer_reveal">Offer</option>
          </select>
          <select className="occ-filter-select" value={filters.language ?? 'all'} onChange={(e) => onFiltersChange({ language: e.target.value === 'all' ? undefined : e.target.value })}>
            <option value="all">All languages</option>
            <option value="English">English</option>
            <option value="Spanish">Spanish</option>
          </select>
          <select className="occ-filter-select" value={filters.activeState ?? ''} onChange={(e) => onFiltersChange({ activeState: e.target.value || undefined })}>
            <option value="">All states</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
        </div>
      )}

      {colsOpen && preset === 'performance' && (
        <div className="occ-tpl-filters__cols">
          {ALL_PERFORMANCE_COLUMNS.map((col) => (
            <label key={col} className="occ-tpl-col-toggle">
              <input type="checkbox" checked={visibleColumns.includes(col)} onChange={() => toggleCol(col)} />
              {PERF_COL_LABELS[col] ?? col}
            </label>
          ))}
        </div>
      )}

      <div className="occ-tpl-filters__row occ-tpl-filters__row--secondary">
        <div className="occ-tpl-preset-tabs" role="tablist" aria-label="View presets">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={preset === p}
              className={cls('occ-tpl-preset-tab', preset === p && 'is-active')}
              onClick={() => onPresetChange(p)}
            >
              {COLUMN_PRESET_LABELS[p] ?? p}
            </button>
          ))}
        </div>
        <div className="occ-density-select" role="group" aria-label="Table density">
          {(['comfortable', 'compact'] as TableDensity[]).map((d) => (
            <button key={d} type="button" className={cls('occ-density-btn', density === d && 'is-active')} onClick={() => onDensityChange(d)}>
              {d}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}