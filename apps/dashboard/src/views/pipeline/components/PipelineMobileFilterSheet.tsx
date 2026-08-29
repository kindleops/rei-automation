import { Icon } from '../../../shared/icons'
import {
  EMPTY_FILTERS,
  SORT_OPTIONS,
  activeFilterCount,
  type PipelineMobileFilters,
  type PipelineMobileSortId,
} from './pipeline-mobile-filters'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface FacetOption {
  id: string
  label: string
  count: number
}

/**
 * The compact mobile Filters sheet.
 *
 * Deliberately NOT the desktop FILTERS panel: no rule builder, no field picker,
 * no boolean groups. Four primary dimensions, every option carrying its own
 * count so the operator can see what a tap will cost before making it. Options
 * with zero matches in the current scope are not offered at all — a filter that
 * can only produce an empty list is a dead control.
 *
 * Sort lives here too rather than in its own menu; on a phone a second overlay
 * for three choices is not worth the chrome.
 */
export function PipelineMobileFilterSheet({
  filters, onChange, sort, onSortChange,
  stageOptions, statusOptions, temperatureOptions,
  needsResponseCount, followUpDueCount, resultCount,
  onClose,
}: {
  filters: PipelineMobileFilters
  onChange: (next: PipelineMobileFilters) => void
  sort: PipelineMobileSortId
  onSortChange: (id: PipelineMobileSortId) => void
  stageOptions: FacetOption[]
  statusOptions: FacetOption[]
  temperatureOptions: FacetOption[]
  needsResponseCount: number
  followUpDueCount: number
  resultCount: number
  onClose: () => void
}) {
  const toggle = (key: 'stages' | 'statuses' | 'temperatures', id: string) => {
    const current = filters[key]
    onChange({
      ...filters,
      [key]: current.includes(id) ? current.filter((v) => v !== id) : [...current, id],
    })
  }

  const count = activeFilterCount(filters)

  const facet = (
    title: string,
    key: 'stages' | 'statuses' | 'temperatures',
    options: FacetOption[],
  ) => {
    if (!options.length) return null
    return (
      <section className="plmf-facet">
        <h3>{title}</h3>
        <div className="plmf-chips">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={cls('plmf-chip', filters[key].includes(o.id) && 'is-on')}
              aria-pressed={filters[key].includes(o.id)}
              onClick={() => toggle(key, o.id)}
            >
              {o.label}<em>{o.count}</em>
            </button>
          ))}
        </div>
      </section>
    )
  }

  return (
    <div className="plmf-root" role="dialog" aria-modal="true" aria-label="Filter pipeline">
      <button type="button" className="plmf-scrim" aria-label="Close filters" onClick={onClose} />
      <div className="plmf-sheet">
        <div className="plmf-grip" aria-hidden="true" />

        <header className="plmf-head">
          <h2>Filters</h2>
          {count > 0 ? (
            <button type="button" className="plmf-clear" onClick={() => onChange(EMPTY_FILTERS)}>
              Clear all
            </button>
          ) : null}
        </header>

        <div className="plmf-scroll">
          <section className="plmf-facet">
            <h3>Attention</h3>
            <div className="plmf-chips">
              <button
                type="button"
                className={cls('plmf-chip', filters.needsResponse && 'is-on')}
                aria-pressed={filters.needsResponse}
                onClick={() => onChange({ ...filters, needsResponse: !filters.needsResponse })}
              >
                Needs response<em>{needsResponseCount}</em>
              </button>
              <button
                type="button"
                className={cls('plmf-chip', filters.followUpDue && 'is-on')}
                aria-pressed={filters.followUpDue}
                onClick={() => onChange({ ...filters, followUpDue: !filters.followUpDue })}
              >
                Follow-up due<em>{followUpDueCount}</em>
              </button>
            </div>
          </section>

          {facet('Stage', 'stages', stageOptions)}
          {facet('Status', 'statuses', statusOptions)}
          {facet('Temperature', 'temperatures', temperatureOptions)}

          <section className="plmf-facet">
            <h3>Sort</h3>
            <div className="plmf-sorts">
              {SORT_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={cls('plmf-sort', sort === o.id && 'is-on')}
                  aria-pressed={sort === o.id}
                  onClick={() => onSortChange(o.id)}
                >
                  <span>{o.label}</span>
                  <em>{o.hint}</em>
                  {sort === o.id ? <Icon name="check" /> : null}
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="plmf-foot">
          <button type="button" className="plmf-apply" onClick={onClose}>
            Show {resultCount.toLocaleString()} lead{resultCount === 1 ? '' : 's'}
          </button>
        </footer>
      </div>
    </div>
  )
}
