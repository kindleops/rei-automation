import type { EntityGraphTab, EntitySearchResult } from '../../domain/entity-graph/entity-graph.types'
import type { SelectedEntity } from '../../domain/entity-graph/selected-entity'
import { resultMatchesSelection } from '../../domain/entity-graph/selected-entity'
import { contactCoverageLabel, formatCell, formatCurrency } from './entity-graph-ui-helpers'

type Props = {
  tab: EntityGraphTab
  results: EntitySearchResult[]
  selectedEntity: SelectedEntity
  compact?: boolean
  onSelect: (result: EntitySearchResult) => void
}

function primaryMetric(tab: EntityGraphTab, result: EntitySearchResult): string {
  const d = result.details ?? {}
  switch (tab) {
    case 'properties':
      return formatCurrency(d.value) !== '—' ? formatCurrency(d.value) : formatCell(d.acquisitionScore ?? result.score)
    case 'master_owners':
      return formatCurrency(d.portfolioValue) !== '—' ? formatCurrency(d.portfolioValue) : `${formatCell(result.linkedCounts.properties)} props`
    case 'people':
      return formatCell(result.linkedCounts.contacts) + ' contacts'
    case 'markets':
    case 'zips':
      return `${formatCell(result.linkedCounts.properties)} properties`
    default:
      return formatCell(result.linkedCounts.properties ?? result.score)
  }
}

export function EntityGraphCardsView({ tab, results, selectedEntity, compact, onSelect }: Props) {
  return (
    <div className={`eg-card-grid${compact ? ' is-compact' : ''}`}>
      {results.map((result) => {
        const d = result.details ?? {}
        const isSelected = resultMatchesSelection(result, selectedEntity)
        return (
          <button
            key={`${result.entityType}:${result.entityId}`}
            type="button"
            className={`eg-card${isSelected ? ' is-selected' : ''}`}
            data-entity-type={result.entityType}
            onClick={() => onSelect(result)}
          >
            <div className="eg-card__top">
              <div className="eg-card__type">{result.entityType.replace(/_/g, ' ')}</div>
              <div className="eg-card__metric">{primaryMetric(tab, result)}</div>
            </div>
            <div className="eg-card__title">{result.title}</div>
            {result.subtitle && <div className="eg-card__sub">{result.subtitle}</div>}
            <div className="eg-card__badges">
              {result.badges.slice(0, 3).map((badge) => (
                <span key={badge} className="eg-chip">{badge}</span>
              ))}
            </div>
            <div className="eg-card__footer">
              {tab === 'properties' && (
                <>
                  <span>{d.marketLabel ?? '—'}</span>
                  <span>{d.assetType ?? '—'}{d.units !== undefined ? ` · ${formatCell(d.units)} units` : ''}</span>
                </>
              )}
              {tab === 'master_owners' && (
                <>
                  <span>{d.priorityTier ?? result.badges[1] ?? '—'}</span>
                  <span>{contactCoverageLabel(result)} coverage</span>
                </>
              )}
              {tab === 'people' && (
                <>
                  <span>{d.occupation ?? result.subtitle ?? '—'}</span>
                  <span>{formatCell(result.linkedCounts.properties)} properties</span>
                </>
              )}
              {(tab === 'markets' || tab === 'zips') && (
                <>
                  <span>{d.marketLabel ?? d.state ?? '—'}</span>
                  <span>{formatCell(result.linkedCounts.reachableContacts ?? result.linkedCounts.contacts)} contacts</span>
                </>
              )}
              {!['properties', 'master_owners', 'people', 'markets', 'zips'].includes(tab) && (
                <>
                  <span>{formatCell(result.linkedCounts.properties)} linked</span>
                  <span>{formatCell(result.linkedCounts.contacts)} contacts</span>
                </>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}