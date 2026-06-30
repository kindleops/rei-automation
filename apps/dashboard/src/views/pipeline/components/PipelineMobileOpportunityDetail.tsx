import { useMemo, useState } from 'react'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import {
  displayAos,
  displayCurrency,
  formatUnknownMetric,
  isFollowUpDue,
  resolvePipelineStage,
  resolvePropertyState,
  resolvePropertyType,
  resolveTemperature,
  resolveUniversalStatus,
  stageAgeDays,
  stageLabel,
} from '../../../domain/pipeline/pipeline-display-helpers'
import { resolveReplyAttentionState } from '../../../domain/pipeline/pipeline-field-resolver'
import { InboxStreetViewThumb } from '../../../modules/inbox/components/InboxStreetViewThumb'
import { formatRelativeTime } from '../../../shared/formatters'
import { Icon } from '../../../shared/icons'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type PanelTab = 'overview' | 'conversation' | 'property' | 'intelligence' | 'workflow' | 'activity'

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'conversation', label: 'Chat' },
  { id: 'property', label: 'Property' },
  { id: 'intelligence', label: 'Intel' },
  { id: 'workflow', label: 'Flow' },
  { id: 'activity', label: 'Log' },
]

function readMetaNumber(meta: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = Number(meta[key])
    if (Number.isFinite(n) && Math.abs(n) > 0.0001) return n
  }
  return null
}

function resolvePropertyMedia(opp: PipelineOpportunity) {
  const meta = (opp.metadata ?? {}) as Record<string, unknown>
  return {
    address: opp.property_address_full,
    lat: readMetaNumber(meta, ['property_latitude', 'latitude', 'lat']),
    lng: readMetaNumber(meta, ['property_longitude', 'longitude', 'lng']),
    cachedImage: String(meta.streetview_image ?? meta.streetviewImage ?? '').trim() || null,
  }
}

function equityPctLabel(opp: PipelineOpportunity): string | null {
  const value = opp.estimated_value
  const equity = opp.equity_amount
  if (value == null || equity == null || value <= 0) return null
  return `${Math.round((equity / value) * 100)}%`
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="plv-mobile-detail__row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function KpiCell({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="plv-mobile-detail__kpi">
      <em>{label}</em>
      <strong className={cls(`is-${tone}`)}>{value}</strong>
    </div>
  )
}

interface PipelineMobileOpportunityDetailProps {
  opportunity: PipelineOpportunity
  variant?: 'sheet' | 'panel'
  loading?: boolean
  error?: string | null
  hydrating?: boolean
  collapsed?: boolean
  onRetry?: () => void
  onClose?: () => void
  onToggleCollapse?: () => void
  onAction: (id: string, action: string, payload?: Record<string, unknown>) => void | Promise<void>
  onOpenCommandView: (threadId?: string | null) => void
  onOpenSellerAutomation?: (opportunity: PipelineOpportunity) => void
  onRefreshEngine?: (id: string) => void | Promise<void>
}

export function PipelineMobileOpportunityDetail({
  opportunity: opp,
  variant = 'sheet',
  loading,
  error,
  hydrating,
  collapsed,
  onRetry,
  onClose,
  onToggleCollapse,
  onAction,
  onOpenCommandView,
  onOpenSellerAutomation,
  onRefreshEngine,
}: PipelineMobileOpportunityDetailProps) {
  const [tab, setTab] = useState<PanelTab>('overview')
  const [safetyOpen, setSafetyOpen] = useState(false)
  const isPanel = variant === 'panel'
  const media = useMemo(() => resolvePropertyMedia(opp), [opp])
  const engineRunId = opp.acquisition_engine_run_id
  const timeline = opp.activity_timeline ?? []
  const temp = resolveTemperature(opp)
  const attention = resolveReplyAttentionState(opp)
  const equityPct = equityPctLabel(opp)
  const due = isFollowUpDue(opp)

  const heroKpis = [
    { label: 'Value', value: displayCurrency(opp.estimated_value, { engineRunId }), tone: 'blue' },
    equityPct ? { label: 'Equity', value: equityPct, tone: 'green' } : null,
    opp.asking_price != null ? { label: 'Ask', value: displayCurrency(opp.asking_price, { engineRunId }), tone: 'gold' } : null,
    opp.aos != null ? { label: 'AOS', value: displayAos(opp), tone: 'cyan' } : null,
  ].filter(Boolean) as Array<{ label: string; value: string; tone: string }>

  if (isPanel && collapsed) {
    return (
      <div className="plv-mobile-detail plv-mobile-detail--panel plv-mobile-detail--collapsed">
        <button
          type="button"
          className="plv-mobile-detail__expand"
          onClick={onToggleCollapse}
          title="Expand detail panel"
          aria-label="Expand detail panel"
        >
          ◀
        </button>
      </div>
    )
  }

  return (
    <div className={cls('plv-mobile-detail', isPanel && 'plv-mobile-detail--panel')}>
      <div className="plv-mobile-detail__hero">
        <InboxStreetViewThumb
          address={media.address}
          lat={media.lat}
          lng={media.lng}
          cachedImageUrl={media.cachedImage}
          size="hero"
          className="plv-mobile-detail__streetview"
        />
        <div className="plv-mobile-detail__hero-shade" aria-hidden />
        <div className="plv-mobile-detail__hero-actions">
          {isPanel && onToggleCollapse && (
            <button type="button" className="plv-mobile-detail__collapse" onClick={onToggleCollapse} aria-label="Collapse panel">
              <Icon name="chevron-right" size={16} />
            </button>
          )}
          {onClose && (
            <button type="button" className="plv-mobile-detail__close" onClick={onClose} aria-label="Close">
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
        {hydrating && <span className="plv-mobile-detail__sync">Syncing…</span>}
        <span className="plv-mobile-detail__maps-attr" aria-hidden>Google</span>

        <div className="plv-mobile-detail__hero-copy">
          <div className="plv-mobile-detail__eyebrow">
            <span>{resolvePropertyType(opp)}</span>
            <span>·</span>
            <span>{opp.market || 'Market unknown'}</span>
            {opp.property_state && (
              <>
                <span>·</span>
                <span>{opp.property_state}</span>
              </>
            )}
          </div>
          <h2>{opp.seller_display_name || 'Unknown seller'}</h2>
          <p>{opp.property_address_full || 'Address unavailable'}</p>
          <div className="plv-mobile-detail__chips">
            <span className="plv-mobile-detail__chip is-stage">{stageLabel(resolvePipelineStage(opp))}</span>
            <span className="plv-mobile-detail__chip">{stageLabel(resolveUniversalStatus(opp))}</span>
            {temp !== 'unknown' && (
              <span className={cls('plv-mobile-detail__chip', `is-${temp}`)}>{stageLabel(temp)}</span>
            )}
            {attention && <span className="plv-mobile-detail__chip is-attention">{attention}</span>}
            {due && <span className="plv-mobile-detail__chip is-due">Due</span>}
          </div>
        </div>
      </div>

      {loading && !opp.seller_display_name && (
        <div className="plv-mobile-detail__banner is-loading" aria-live="polite">Loading opportunity…</div>
      )}
      {error && (
        <div className="plv-mobile-detail__banner is-error" role="alert">
          <span>{error}</span>
          {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
        </div>
      )}

      {heroKpis.length > 0 && (
        <div className="plv-mobile-detail__kpi-strip">
          {heroKpis.map((k) => <KpiCell key={k.label} {...k} />)}
        </div>
      )}

      <nav className="plv-mobile-detail__tabs" aria-label="Opportunity sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={cls('plv-mobile-detail__tab', tab === t.id && 'is-active')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="plv-mobile-detail__body">
        {tab === 'overview' && (
          <div className="plv-mobile-detail__section">
            <div className="plv-mobile-detail__grid">
              <KpiCell label="Stage age" value={`${Math.round(stageAgeDays(opp))}d`} tone={stageAgeDays(opp) >= 14 ? 'amber' : 'neutral'} />
              <KpiCell label="Last contact" value={opp.last_contact_at ? formatRelativeTime(opp.last_contact_at) : 'None'} />
              <KpiCell label="Next action" value={opp.next_action || 'Review'} tone="blue" />
              <KpiCell
                label="Follow-up"
                value={opp.next_follow_up_at
                  ? formatRelativeTime(opp.next_follow_up_at)
                  : (opp.next_action_due ? formatRelativeTime(opp.next_action_due) : 'None')}
                tone={due ? 'amber' : 'neutral'}
              />
            </div>
            {opp.latest_message_preview && (
              <blockquote className="plv-mobile-detail__quote">&ldquo;{opp.latest_message_preview}&rdquo;</blockquote>
            )}
            {opp.blocker && <p className="plv-mobile-detail__blocker">{opp.blocker}</p>}
          </div>
        )}

        {tab === 'conversation' && (
          <div className="plv-mobile-detail__section">
            <DetailRow label="Intent" value={opp.latest_intent || 'Unknown'} />
            <DetailRow label="Reply state" value={(opp.conversation_state || 'unknown').replace(/_/g, ' ')} />
            <DetailRow label="Thread" value={opp.primary_thread_key || 'No thread linked'} />
            <p className="plv-mobile-detail__quote">{opp.latest_message_preview || 'No recent message.'}</p>
          </div>
        )}

        {tab === 'property' && (
          <div className="plv-mobile-detail__section">
            <DetailRow label="Address" value={opp.property_address_full || 'Unknown'} />
            <DetailRow label="City" value={opp.property_city || 'Unknown'} />
            <DetailRow label="State" value={resolvePropertyState(opp)} />
            <DetailRow label="ZIP" value={opp.property_zip || 'Unknown'} />
            <DetailRow label="County" value={opp.property_county || 'Unknown'} />
            <DetailRow label="Units" value={opp.units_count != null ? String(opp.units_count) : 'Unknown'} />
            <DetailRow label="Portfolio" value={opp.portfolio_property_count > 1 ? `${opp.portfolio_property_count} properties` : 'Single property'} />
            <DetailRow label="Est. value" value={displayCurrency(opp.estimated_value, { engineRunId })} />
            <DetailRow label="Equity" value={displayCurrency(opp.equity_amount, { engineRunId })} />
            <DetailRow label="ARV" value={displayCurrency(opp.arv, { engineRunId })} />
          </div>
        )}

        {tab === 'intelligence' && (
          <div className="plv-mobile-detail__section">
            <div className="plv-mobile-detail__grid">
              <KpiCell label="AOS" value={displayAos(opp)} tone="green" />
              <KpiCell label="Strategy" value={opp.strategy || (engineRunId ? 'Unknown' : 'Not run')} tone="blue" />
              <KpiCell label="Motivation" value={formatUnknownMetric(opp.motivation_score, 'score', engineRunId)} />
              <KpiCell label="Cooperation" value={formatUnknownMetric(opp.cooperation_score, 'score', engineRunId)} />
              <KpiCell label="Confidence" value={opp.confidence != null ? `${Math.round(opp.confidence)}%` : '—'} />
              <KpiCell label="Rec. offer" value={displayCurrency(opp.recommended_offer, { engineRunId })} tone="green" />
            </div>
            {onRefreshEngine && engineRunId && (
              <button type="button" className="plv-mobile-detail__dock-secondary" onClick={() => onRefreshEngine(opp.id)}>
                Refresh analysis
              </button>
            )}
          </div>
        )}

        {tab === 'workflow' && (
          <div className="plv-mobile-detail__section">
            <DetailRow label="Workflow" value={(opp.workflow_state || 'not_enrolled').replace(/_/g, ' ')} />
            <DetailRow label="Automation" value={opp.automation_state} />
            <DetailRow label="Queue" value={(opp.queue_state || 'not_queued').replace(/_/g, ' ')} />
            <DetailRow label="Follow-up reason" value={opp.follow_up_reason || '—'} />
          </div>
        )}

        {tab === 'activity' && (
          <div className="plv-mobile-detail__section plv-mobile-detail__timeline">
            {timeline.length > 0 ? timeline.map((event) => (
              <div key={event.id} className="plv-mobile-detail__event">
                <strong>{event.label}</strong>
                <span>{formatRelativeTime(event.timestamp)} · {event.source}</span>
                {event.detail && <em>{event.detail}</em>}
              </div>
            )) : (opp.history ?? []).length > 0 ? opp.history!.map((event) => (
              <div key={event.id} className="plv-mobile-detail__event">
                <strong>{event.event_type.replace(/_/g, ' ')}</strong>
                <span>{formatRelativeTime(event.created_at)} · {event.source}</span>
                {event.new_value && <em>{event.new_value}</em>}
              </div>
            )) : (
              <p className="plv-mobile-detail__empty-copy">No activity events yet.</p>
            )}
          </div>
        )}
      </div>

      <footer className="plv-mobile-detail__dock">
        <button
          type="button"
          className="plv-mobile-detail__dock-primary"
          onClick={() => onOpenCommandView(opp.primary_thread_key)}
        >
          <Icon name="message" size={14} />
          Open conversation
        </button>
        {onOpenSellerAutomation && (
          <button type="button" className="plv-mobile-detail__dock-secondary" onClick={() => onOpenSellerAutomation(opp)}>
            Automation
          </button>
        )}
        <div className="plv-mobile-detail__safety">
          <button type="button" className="plv-mobile-detail__dock-secondary" onClick={() => setSafetyOpen((v) => !v)}>
            Safety
          </button>
          {safetyOpen && (
            <div className="plv-mobile-detail__safety-menu">
              <button type="button" onClick={() => { void onAction(opp.id, 'pause_automation'); setSafetyOpen(false) }}>Pause automation</button>
              <button type="button" className="is-danger" onClick={() => { void onAction(opp.id, 'suppress'); setSafetyOpen(false) }}>Suppress</button>
            </div>
          )}
        </div>
      </footer>
    </div>
  )
}

export const PipelineOpportunityDetail = PipelineMobileOpportunityDetail