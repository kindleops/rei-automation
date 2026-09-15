import type { PipelineGroupByMode } from '../../../domain/pipeline/pipeline-opportunity.types'
import { PipelineFilterMenu } from './PipelineFilterMenu'

interface PipelineMobileToolbarProps {
  query: string
  onQueryChange: (value: string) => void
  groupBy: PipelineGroupByMode
  onGroupByChange: (mode: PipelineGroupByMode) => void
  hotOnly: boolean
  followUpOnly: boolean
  hideSuppressed: boolean
  suppressionFilterAvailable?: boolean
  onHotOnly: (value: boolean) => void
  onFollowUpOnly: (value: boolean) => void
  onHideSuppressed: (value: boolean) => void
  resultCount: number
}

export function PipelineMobileToolbar({
  query,
  onQueryChange,
  groupBy,
  onGroupByChange,
  hotOnly,
  followUpOnly,
  hideSuppressed,
  suppressionFilterAvailable = true,
  onHotOnly,
  onFollowUpOnly,
  onHideSuppressed,
  resultCount,
}: PipelineMobileToolbarProps) {
  return (
    <div className="plv-mobile-toolbar">
      <div className="plv-mobile-toolbar__search">
        <span className="plv-mobile-toolbar__search-icon" aria-hidden>⌕</span>
        <input
          type="search"
          className="plv-mobile-toolbar__input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Seller, address, intent…"
          aria-label="Search pipeline"
        />
        {query && (
          <button
            type="button"
            className="plv-mobile-toolbar__clear"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <div className="plv-mobile-toolbar__row">
        <PipelineFilterMenu
          layout="mobile"
          groupBy={groupBy}
          onGroupByChange={onGroupByChange}
          hotOnly={hotOnly}
          followUpOnly={followUpOnly}
          hideSuppressed={hideSuppressed}
          suppressionFilterAvailable={suppressionFilterAvailable}
          onHotOnly={onHotOnly}
          onFollowUpOnly={onFollowUpOnly}
          onHideSuppressed={onHideSuppressed}
        />
      </div>

      <div className="plv-mobile-toolbar__meta">
        <span>{resultCount} deal{resultCount !== 1 ? 's' : ''} matching filters</span>
      </div>
    </div>
  )
}