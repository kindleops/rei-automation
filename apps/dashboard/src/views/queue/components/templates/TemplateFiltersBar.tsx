import type { ColumnPreset, TableDensity, TemplateIntelligenceFilters } from '../../../../domain/templates/template-intelligence.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const RANGE_OPTIONS = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All time' },
] as const

interface TemplateFiltersBarProps {
  filters: TemplateIntelligenceFilters
  preset: ColumnPreset
  density: TableDensity
  onFiltersChange: (patch: Partial<TemplateIntelligenceFilters>) => void
  onPresetChange: (preset: ColumnPreset) => void
  onDensityChange: (density: TableDensity) => void
  onReset: () => void
  onExport?: () => void
}

export function TemplateFiltersBar({
  filters,
  preset,
  density,
  onFiltersChange,
  onPresetChange,
  onDensityChange,
  onReset,
  onExport,
}: TemplateFiltersBarProps) {
  return (
    <div className="occ-tpl-filters">
      <div className="occ-tpl-filters__row">
        <select className="occ-filter-select" value={filters.range} onChange={(e) => onFiltersChange({ range: e.target.value as TemplateIntelligenceFilters['range'] })}>
          {RANGE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <select className="occ-filter-select" value={filters.stage ?? 'all'} onChange={(e) => onFiltersChange({ stage: e.target.value === 'all' ? undefined : e.target.value })}>
          <option value="all">All Stages</option>
          <option value="S1">S1 Ownership Confirmation</option>
          <option value="S1F">S1F Ownership Follow-Up</option>
          <option value="S2">S2 Selling Interest</option>
          <option value="S3">S3 Asking Price</option>
          <option value="S4">S4 Condition &amp; Underwriting</option>
          <option value="S5">S5 Offer &amp; Negotiation</option>
          <option value="S6">S6 Contract to Close</option>
        </select>
        <select className="occ-filter-select" value={filters.touch ?? ''} onChange={(e) => onFiltersChange({ touch: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">All Touches</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>Touch {n}</option>)}
        </select>
        <select className="occ-filter-select" value={filters.followUp ?? ''} onChange={(e) => onFiltersChange({ followUp: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">All Follow-ups</option>
          <option value="0">First touch only</option>
          <option value="1">Follow-up 1</option>
          <option value="2">Follow-up 2+</option>
        </select>
        <select className="occ-filter-select" value={filters.useCase ?? 'all'} onChange={(e) => onFiltersChange({ useCase: e.target.value === 'all' ? undefined : e.target.value })}>
          <option value="all">All Use Cases</option>
          <option value="ownership_check">Ownership Check</option>
          <option value="consider_selling">Selling Interest</option>
          <option value="asking_price">Asking Price</option>
          <option value="condition_probe">Condition</option>
          <option value="offer_reveal">Offer</option>
        </select>
        <select className="occ-filter-select" value={filters.language ?? 'all'} onChange={(e) => onFiltersChange({ language: e.target.value === 'all' ? undefined : e.target.value })}>
          <option value="all">All Languages</option>
          <option value="English">English</option>
          <option value="Spanish">Spanish</option>
        </select>
        <input
          type="search"
          className="occ-search occ-tpl-filters__search"
          placeholder="Search templates…"
          value={filters.query ?? ''}
          onChange={(e) => onFiltersChange({ query: e.target.value || undefined })}
        />
        <button type="button" className="occ-action-btn is-secondary" onClick={onReset}>Reset</button>
        {onExport && <button type="button" className="occ-action-btn is-secondary" onClick={onExport}>Export</button>}
      </div>
      <div className="occ-tpl-filters__row occ-tpl-filters__row--secondary">
        <div className="occ-tpl-preset-tabs" role="tablist" aria-label="Column presets">
          {(['performance', 'execution', 'funnel', 'autopilot', 'data_quality'] as ColumnPreset[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={preset === p}
              className={cls('occ-tpl-preset-tab', preset === p && 'is-active')}
              onClick={() => onPresetChange(p)}
            >
              {p.replace('_', ' ')}
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
        <span className="occ-tpl-shadow-badge">Autopilot: Shadow</span>
      </div>
    </div>
  )
}