import { useState } from 'react'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import { displayCurrency, stageLabel } from '../../../domain/pipeline/pipeline-display-helpers'
import { formatRelativeTime } from '../../../shared/formatters'

type PanelTab = 'overview' | 'conversation' | 'intelligence' | 'underwriting' | 'workflow' | 'activity'

interface PipelineCommandPanelProps {
  opportunity: PipelineOpportunity
  collapsed?: boolean
  onToggleCollapse?: () => void
  onOpenCommandView: (threadId?: string | null) => void
  onOpenConversation: (threadId?: string | null) => void
  onOpenDealIntelligence: (threadId?: string | null) => void
  onAction: (id: string, action: string, payload?: Record<string, unknown>) => void | Promise<void>
  onRefreshEngine?: (id: string) => void | Promise<void>
}

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'underwriting', label: 'Underwriting' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'activity', label: 'Activity' },
]

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="plv-detail-row">
      <span className="plv-detail-row__label">{label}</span>
      <span className="plv-detail-row__value">{value}</span>
    </div>
  )
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`plv-metric-block is-${tone}`}>
      <span className="plv-metric-block__label">{label}</span>
      <strong className="plv-metric-block__value">{value}</strong>
    </div>
  )
}

export function PipelineCommandPanel({
  opportunity: opp,
  collapsed,
  onToggleCollapse,
  onOpenCommandView,
  onOpenConversation,
  onOpenDealIntelligence,
  onAction,
  onRefreshEngine,
}: PipelineCommandPanelProps) {
  const [tab, setTab] = useState<PanelTab>('overview')
  const threadId = opp.primary_thread_key

  if (collapsed) {
    return (
      <div className="plv-command-panel plv-command-panel--collapsed">
        <button type="button" className="plv-command-panel__expand" onClick={onToggleCollapse} title="Expand panel">
          ◀
        </button>
      </div>
    )
  }

  return (
    <div className="plv-command-panel">
      <header className="plv-command-panel__header">
        <div>
          <strong>{opp.seller_display_name || 'Unknown Seller'}</strong>
          <span>{opp.portfolio_property_count > 1 ? `${opp.portfolio_property_count} matched properties` : (opp.property_address_full || 'Property Unknown')}</span>
        </div>
        {onToggleCollapse && (
          <button type="button" className="plv-command-panel__collapse" onClick={onToggleCollapse} title="Collapse panel">
            ▶
          </button>
        )}
      </header>

      <nav className="plv-command-panel__tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`plv-command-panel__tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="plv-command-panel__body">
        {tab === 'overview' && (
          <>
            <Row label="Stage" value={stageLabel(opp.acquisition_stage)} />
            <Row label="Status" value={opp.opportunity_status.replace(/_/g, ' ')} />
            <Row label="Priority" value={opp.priority} />
            <Row label="Assignee" value={opp.assigned_operator || 'Unassigned'} />
            <Row label="Market" value={opp.market || 'Unknown'} />
            <Row label="Next Action" value={opp.next_action || 'Review'} />
            <Row label="Last Contact" value={opp.last_contact_at ? formatRelativeTime(opp.last_contact_at) : 'No contact'} />
            {opp.blocker && <p className="plv-command-panel__blocker">⚠ {opp.blocker}</p>}
          </>
        )}

        {tab === 'conversation' && (
          <>
            <Row label="Intent" value={opp.latest_intent || 'Unknown'} />
            <Row label="Reply State" value={opp.conversation_state.replace(/_/g, ' ')} />
            <p className="plv-deal-detail__text">{opp.latest_message_preview || 'No recent message.'}</p>
            <button type="button" className="plv-action-btn" onClick={() => onOpenConversation(threadId)}>Open Conversation</button>
          </>
        )}

        {tab === 'intelligence' && (
          <div className="plv-deal-detail__metrics">
            <Metric label="AOS" value={opp.aos != null ? String(Math.round(opp.aos)) : 'Pending engine run'} tone="green" />
            <Metric label="Asking" value={displayCurrency(opp.asking_price)} tone="gold" />
            <Metric label="Strategy" value={opp.strategy || 'Not calculated'} tone="blue" />
            <Metric label="Motivation" value={opp.motivation_score != null ? `${Math.round(opp.motivation_score)}` : 'Unknown'} tone="cyan" />
            <Metric label="Cooperation" value={opp.cooperation_score != null ? `${Math.round(opp.cooperation_score)}` : 'Unknown'} tone="cyan" />
            <Metric label="Confidence" value={opp.confidence != null ? `${Math.round(opp.confidence)}%` : 'Unknown'} tone="neutral" />
            <Metric label="Offer Gap" value={opp.offer_to_ask_gap != null ? displayCurrency(opp.offer_to_ask_gap) : 'Not calculated'} tone="amber" />
          </div>
        )}

        {tab === 'underwriting' && (
          <>
            <Row label="Asset Class" value={opp.asset_class || 'Unknown'} />
            <Row label="Est. Value" value={displayCurrency(opp.estimated_value)} />
            <Row label="ARV" value={displayCurrency(opp.arv)} />
            <Row label="Engine Run" value={opp.acquisition_engine_run_id ? 'Complete' : 'Pending engine run'} />
          </>
        )}

        {tab === 'workflow' && (
          <>
            <Row label="Workflow State" value={opp.workflow_state.replace(/_/g, ' ')} />
            <Row label="Automation" value={opp.automation_state} />
            <Row label="Queue" value={opp.queue_state.replace(/_/g, ' ')} />
            <Row label="Follow-Up" value={opp.next_follow_up_at ? formatRelativeTime(opp.next_follow_up_at) : (opp.next_action_due ? formatRelativeTime(opp.next_action_due) : 'None scheduled')} />
            <Row label="Follow-Up Reason" value={opp.follow_up_reason || '—'} />
            {opp.blocker && <p className="plv-command-panel__blocker">{opp.blocker}</p>}
          </>
        )}

        {tab === 'activity' && (
          <div className="plv-command-panel__timeline">
            {(opp.history ?? []).length > 0 ? (
              opp.history!.map((event) => (
                <div key={event.id} className="plv-command-panel__event">
                  <span>{event.event_type.replace(/_/g, ' ')}</span>
                  <small>{formatRelativeTime(event.created_at)} · {event.source}</small>
                  {event.new_value && <em>{event.new_value}</em>}
                </div>
              ))
            ) : (
              <p className="plv-deal-detail__text">No activity events yet.</p>
            )}
          </div>
        )}
      </div>

      <footer className="plv-command-panel__actions">
        <button type="button" className="plv-action-btn is-primary" onClick={() => onOpenCommandView(threadId)}>Command View</button>
        <button type="button" className="plv-action-btn" onClick={() => onOpenDealIntelligence(threadId)}>Deal Intelligence</button>
        {onRefreshEngine && (
          <button type="button" className="plv-action-btn" onClick={() => onRefreshEngine(opp.id)}>Refresh Engine</button>
        )}
        <button type="button" className="plv-action-btn is-warning" onClick={() => onAction(opp.id, 'pause_automation')}>Pause Automation</button>
        <button type="button" className="plv-action-btn is-danger" onClick={() => onAction(opp.id, 'suppress')}>Suppress</button>
      </footer>
    </div>
  )
}