import { useState } from 'react'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import {
  displayAos,
  displayCurrency,
  formatUnknownMetric,
  resolvePipelineStage,
  resolvePropertyState,
  resolvePropertyType,
  resolveTemperature,
  resolveUniversalStatus,
  stageLabel,
} from '../../../domain/pipeline/pipeline-display-helpers'
import { formatRelativeTime } from '../../../shared/formatters'

type PanelTab = 'overview' | 'conversation' | 'property' | 'intelligence' | 'workflow' | 'activity'

interface PipelineCommandPanelProps {
  opportunity: PipelineOpportunity
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  collapsed?: boolean
  onToggleCollapse?: () => void
  onClose?: () => void
  hydrating?: boolean
  onOpenCommandView: (threadId?: string | null) => void
  onOpenConversation: (threadId?: string | null) => void
  onOpenDealIntelligence: (threadId?: string | null) => void
  onAction: (id: string, action: string, payload?: Record<string, unknown>) => void | Promise<void>
  onRefreshEngine?: (id: string) => void | Promise<void>
}

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'property', label: 'Property' },
  { id: 'intelligence', label: 'Intelligence' },
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
  loading,
  error,
  onRetry,
  collapsed,
  onToggleCollapse,
  onClose,
  hydrating,
  onOpenCommandView,
  onOpenConversation,
  onOpenDealIntelligence,
  onAction,
  onRefreshEngine,
}: PipelineCommandPanelProps) {
  const [tab, setTab] = useState<PanelTab>('overview')
  const threadId = opp.primary_thread_key
  const engineRunId = opp.acquisition_engine_run_id
  const timeline = opp.activity_timeline ?? []

  if (collapsed) {
    return (
      <div className="plv-command-panel plv-command-panel--collapsed">
        <button type="button" className="plv-command-panel__expand" onClick={onToggleCollapse} title="Expand panel (])">
          ◀
        </button>
      </div>
    )
  }

  return (
    <div className="plv-command-panel nx-glass-panel">
      <header className="plv-command-panel__header">
        <div>
          <strong>{opp.seller_display_name || 'Unknown Seller'}</strong>
          <span>{opp.portfolio_property_count > 1 ? `${opp.portfolio_property_count} matched properties` : (opp.property_address_full || 'Property Unknown')}</span>
        </div>
        <div className="plv-command-panel__header-actions">
          {hydrating && <span className="plv-command-panel__hydrate" aria-live="polite">Refreshing…</span>}
          {onToggleCollapse && (
            <button type="button" className="plv-command-panel__collapse" onClick={onToggleCollapse} title="Collapse panel">
              ▶
            </button>
          )}
          {onClose && (
            <button type="button" className="plv-command-panel__close" onClick={onClose} title="Close inspector" aria-label="Close inspector">
              ×
            </button>
          )}
        </div>
      </header>

      {loading && !opp.seller_display_name && !opp.property_address_full && (
        <div className="plv-command-panel__skeleton" aria-live="polite">
          <span className="plv-command-panel__skeleton-pulse" />
          Loading summary…
        </div>
      )}
      {error && (
        <div className="plv-command-panel__error" role="alert">
          <p>{error}</p>
          {onRetry && <button type="button" className="plv-action-btn" onClick={onRetry}>Retry</button>}
        </div>
      )}

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
          <div className="plv-command-panel__metric-grid">
            <Metric label="Stage" value={stageLabel(resolvePipelineStage(opp))} tone="cyan" />
            <Metric label="Status" value={stageLabel(resolveUniversalStatus(opp))} tone="blue" />
            <Metric label="Temperature" value={stageLabel(resolveTemperature(opp))} tone="amber" />
            <Metric label="Market" value={opp.market || 'Unknown'} tone="gold" />
            <Metric label="Property Type" value={resolvePropertyType(opp)} tone="green" />
            <Metric label="Last Contact" value={opp.last_contact_at ? formatRelativeTime(opp.last_contact_at) : 'No contact'} tone="neutral" />
            <Metric label="Next Action" value={opp.next_action || 'Review'} tone="blue" />
            <Metric label="Follow-Up" value={opp.next_follow_up_at ? formatRelativeTime(opp.next_follow_up_at) : (opp.next_action_due ? formatRelativeTime(opp.next_action_due) : 'None')} tone="amber" />
          </div>
        )}

        {tab === 'conversation' && (
          <>
            <Row label="Intent" value={opp.latest_intent || 'Unknown'} />
            <Row label="Reply State" value={(opp.conversation_state || 'unknown').replace(/_/g, ' ')} />
            <p className="plv-deal-detail__text">{opp.latest_message_preview || 'No recent message.'}</p>
            <button type="button" className="plv-action-btn" onClick={() => onOpenConversation(threadId)}>Open Conversation</button>
            <button type="button" className="plv-action-btn" onClick={() => onAction(opp.id, 'open_inbox_thread')}>Open Inbox Thread</button>
          </>
        )}

        {tab === 'property' && (
          <>
            <Row label="Address" value={opp.property_address_full || 'Unknown'} />
            <Row label="Property Type" value={resolvePropertyType(opp)} />
            <Row label="City" value={opp.property_city || 'Unknown'} />
            <Row label="State" value={resolvePropertyState(opp)} />
            <Row label="ZIP" value={opp.property_zip || 'Unknown'} />
            <Row label="County" value={opp.property_county || 'Unknown'} />
            <Row label="Market" value={opp.market || 'Unknown'} />
            <Row label="Units" value={opp.units_count != null ? String(opp.units_count) : 'Unknown'} />
            <Row label="Portfolio" value={opp.portfolio_property_count > 1 ? `${opp.portfolio_property_count} properties` : 'Single property'} />
            <Row label="Est. Value" value={displayCurrency(opp.estimated_value, { engineRunId })} />
            <Row label="Equity" value={displayCurrency(opp.equity_amount, { engineRunId })} />
            <Row label="ARV" value={displayCurrency(opp.arv, { engineRunId })} />
            <div className="plv-command-panel__actions-inline">
              <button type="button" className="plv-action-btn" onClick={() => onAction(opp.id, 'open_property')}>Open Property</button>
              <button type="button" className="plv-action-btn" onClick={() => onAction(opp.id, 'open_map')}>Open Map</button>
              <button type="button" className="plv-action-btn" onClick={() => onAction(opp.id, 'open_comp_intelligence')}>Comp Intelligence</button>
            </div>
          </>
        )}

        {tab === 'intelligence' && (
          <div className="plv-deal-detail__metrics">
            <Metric label="AOS" value={displayAos(opp)} tone="green" />
            <Metric label="Asking" value={displayCurrency(opp.asking_price, { engineRunId })} tone="gold" />
            <Metric label="Strategy" value={opp.strategy || (engineRunId ? 'Unknown' : 'Not calculated')} tone="blue" />
            <Metric label="Motivation" value={formatUnknownMetric(opp.motivation_score, 'score', engineRunId)} tone="cyan" />
            <Metric label="Cooperation" value={formatUnknownMetric(opp.cooperation_score, 'score', engineRunId)} tone="cyan" />
            <Metric label="Confidence" value={opp.confidence != null ? `${Math.round(opp.confidence)}%` : 'Not calculated'} tone="neutral" />
            <Metric label="Offer Gap" value={formatUnknownMetric(opp.offer_to_ask_gap, 'currency', engineRunId)} tone="amber" />
            <Metric label="Recommended Offer" value={displayCurrency(opp.recommended_offer, { engineRunId })} tone="green" />
            {onRefreshEngine && (
              <button type="button" className="plv-action-btn is-primary" onClick={() => onRefreshEngine(opp.id)}>
                {engineRunId ? 'Refresh Analysis' : 'Run Analysis'}
              </button>
            )}
          </div>
        )}

        {tab === 'workflow' && (
          <>
            <Row label="Workflow State" value={(opp.workflow_state || 'not_enrolled').replace(/_/g, ' ')} />
            <Row label="Automation" value={opp.automation_state} />
            <Row label="Queue" value={(opp.queue_state || 'not_queued').replace(/_/g, ' ')} />
            <Row label="Follow-Up" value={opp.next_follow_up_at ? formatRelativeTime(opp.next_follow_up_at) : (opp.next_action_due ? formatRelativeTime(opp.next_action_due) : 'None scheduled')} />
            <Row label="Follow-Up Reason" value={opp.follow_up_reason || '—'} />
            {opp.blocker && <p className="plv-command-panel__blocker">{opp.blocker}</p>}
            <button type="button" className="plv-action-btn" onClick={() => onAction(opp.id, 'open_workflow_run')}>Open Workflow Run</button>
          </>
        )}

        {tab === 'activity' && (
          <div className="plv-command-panel__timeline">
            {timeline.length > 0 ? (
              timeline.map((event) => (
                <div key={event.id} className="plv-command-panel__event">
                  <span>{event.label}</span>
                  <small>{formatRelativeTime(event.timestamp)} · {event.source}</small>
                  {event.detail && <em>{event.detail}</em>}
                </div>
              ))
            ) : (opp.history ?? []).length > 0 ? (
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
        <button type="button" className="plv-action-btn is-primary" onClick={() => onOpenCommandView(threadId)}>Open Conversation</button>
        <button type="button" className="plv-action-btn" onClick={() => onOpenDealIntelligence(threadId)}>Deal Intelligence</button>
        <button type="button" className="plv-action-btn is-warning" onClick={() => onAction(opp.id, 'pause_automation')}>Pause Automation</button>
        <button type="button" className="plv-action-btn is-danger" onClick={() => onAction(opp.id, 'suppress')}>Suppress</button>
      </footer>
    </div>
  )
}