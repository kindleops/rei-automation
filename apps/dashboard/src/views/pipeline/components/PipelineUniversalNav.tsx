import { routeEntityGraphAction } from '../../../domain/entity-graph/entity-graph-route-actions'
import { universalContextFromOpportunity } from '../../../domain/pipeline/pipeline-universal-context'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import { pushRoutePath } from '../../../app/router'

const DESTINATIONS = [
  { key: 'inbox', label: 'Inbox', action: 'open_inbox_thread' as const },
  { key: 'conversation', label: 'Conversation', action: 'open_inbox_thread' as const },
  { key: 'deal_intelligence', label: 'Deal Intelligence', action: 'open_deal_intelligence' as const },
  { key: 'comp_intelligence', label: 'Comp Intelligence', action: 'open_comp_intelligence' as const },
  { key: 'buyer_match', label: 'Buyer Match', action: 'open_buyer_match' as const },
  { key: 'map', label: 'Map', action: 'show_on_map' as const },
  { key: 'queue', label: 'Queue', action: 'open_queue' as const },
  { key: 'calendar', label: 'Calendar', action: 'open_calendar' as const },
  { key: 'list', label: 'List', action: 'open_property' as const },
  { key: 'entity_graph', label: 'Entity Graph', action: 'open_entity_graph' as const },
  { key: 'workflow_studio', label: 'Workflow Studio', action: 'open_workflow_run' as const },
  { key: 'campaigns', label: 'Campaign Command', action: 'open_campaigns' as const },
] as const

interface PipelineUniversalNavProps {
  opportunity: PipelineOpportunity
  onAction: (id: string, action: string) => void | Promise<void>
  compact?: boolean
}

export function PipelineUniversalNav({ opportunity, onAction, compact }: PipelineUniversalNavProps) {
  const universal = universalContextFromOpportunity(opportunity)

  const handleNavigate = (dest: typeof DESTINATIONS[number]) => {
    if (dest.action === 'open_inbox_thread' && opportunity.primary_thread_key) {
      void onAction(opportunity.id, 'open_inbox_thread')
      return
    }
    if (dest.action === 'open_property' && opportunity.primary_property_id) {
      pushRoutePath(`/list?property=${encodeURIComponent(opportunity.primary_property_id)}`)
      return
    }
    if (dest.action === 'show_on_map') {
      routeEntityGraphAction('show_on_map', universal)
      pushRoutePath('/map')
      return
    }
    if (dest.action === 'open_comp_intelligence') {
      routeEntityGraphAction('open_comp_intelligence', universal)
      return
    }
    if (dest.action === 'open_deal_intelligence') {
      routeEntityGraphAction('open_deal_intelligence', universal)
      return
    }
    if (dest.action === 'open_buyer_match') {
      routeEntityGraphAction('open_buyer_match', universal)
      return
    }
    if (dest.action === 'open_workflow_run') {
      void onAction(opportunity.id, 'open_workflow_run')
      return
    }
    void onAction(opportunity.id, dest.action)
  }

  return (
    <div className={`plv-universal-nav${compact ? ' plv-universal-nav--compact' : ''}`}>
      <span className="plv-universal-nav__label">Open in</span>
      <div className="plv-universal-nav__menu">
        {DESTINATIONS.map((dest) => (
          <button
            key={dest.key}
            type="button"
            className="plv-universal-nav__item"
            onClick={() => handleNavigate(dest)}
          >
            {dest.label}
          </button>
        ))}
      </div>
    </div>
  )
}