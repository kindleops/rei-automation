import { Icon } from '../../shared/icons'
import type { EntityGraphTab, EntityGraphTabCounts, EntityGraphVisualMode } from '../../domain/entity-graph/entity-graph.types'
import { TAB_OPTIONS } from './entity-graph-ui-helpers'

type Props = {
  activeTab: EntityGraphTab
  visualMode: EntityGraphVisualMode
  query: string
  tabCounts: EntityGraphTabCounts | null
  resultCount: number
  activeFilterCount: number
  onTabChange: (tab: EntityGraphTab) => void
  onQueryChange: (query: string) => void
  onVisualModeChange: (mode: EntityGraphVisualMode) => void
  onOpenFilters: () => void
}

function formatCount(value?: number): string {
  if (value === undefined || value === null) return '…'
  return value.toLocaleString()
}

export function EntityGraphHeader({
  activeTab,
  visualMode,
  query,
  tabCounts,
  resultCount,
  activeFilterCount,
  onTabChange,
  onQueryChange,
  onVisualModeChange,
  onOpenFilters,
}: Props) {
  const tabTotal = tabCounts?.[TAB_OPTIONS.find((t) => t.key === activeTab)?.countKey as keyof EntityGraphTabCounts] as number | undefined

  return (
    <header className="eg-header">
      <div className="eg-header__gradient" aria-hidden />
      <div className="eg-header__top">
        <div className="eg-header__brand">
          <span className="eg-header__icon"><Icon name="grid" /></span>
          <div>
            <h1>Entity Graph</h1>
            <p>{formatCount(tabTotal)} records · {visualMode} view · {formatCount(resultCount)} shown</p>
          </div>
        </div>

        <div className="eg-header__search nx-liquid-surface">
          <Icon name="radar" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search address, owner, person, phone, email…"
            aria-label="Entity Graph search"
          />
        </div>

        <div className="eg-header__actions">
          <button type="button" className="eg-glass-btn" onClick={onOpenFilters}>
            Filters
            {activeFilterCount > 0 && <span className="eg-badge-count">{activeFilterCount}</span>}
          </button>
          <div className="eg-mode-switch nx-liquid-tabs" role="group" aria-label="View mode">
            {(['table', 'cards', 'graph'] as EntityGraphVisualMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={visualMode === mode ? 'is-active' : ''}
                onClick={() => onVisualModeChange(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="eg-entity-switch" role="tablist" aria-label="Entity types">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`eg-entity-switch__item${activeTab === tab.key ? ' is-active' : ''}`}
            onClick={() => onTabChange(tab.key)}
          >
            <span>{tab.label}</span>
            <span className="eg-entity-switch__count">
              {formatCount(tabCounts?.[tab.countKey as keyof EntityGraphTabCounts] as number | undefined)}
            </span>
          </button>
        ))}
      </div>
    </header>
  )
}