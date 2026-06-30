import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { CampaignActionDef } from '../campaign-health'
import { computeCampaignHealth, computeCampaignReadiness } from '../campaign-health'
import { isTestModeCampaign } from '../campaign-operator'
import type { CampaignCommandState, CampaignSummary } from '../campaigns.types'
import { cls, fmt, fmtPct, fmtRelative } from '../campaign-formatters'
import { CampaignStatusBadge } from './CampaignStatusBadge'

function actionIcon(actionId: string) {
  switch (actionId) {
    case 'pause': return 'pause'
    case 'queue_batch': return 'zap'
    case 'schedule':
    case 'reschedule': return 'calendar'
    case 'build_targets': return 'users'
    case 'activate':
    case 'convert_to_live': return 'play'
    case 'archive': return 'archive'
    default: return 'bolt'
  }
}

interface CampaignDetailHeaderProps {
  campaign: CampaignSummary
  commandState: CampaignCommandState
  detailActions: CampaignActionDef[]
  isMobileLayout?: boolean
  onClose: () => void
  onAction: (action: string, campaign: CampaignSummary) => void
}

export function CampaignDetailHeader({
  campaign,
  commandState,
  detailActions,
  isMobileLayout = false,
  onClose,
  onAction,
}: CampaignDetailHeaderProps) {
  const [actionsOpen, setActionsOpen] = useState(false)
  const health = computeCampaignHealth(campaign)
  const readiness = computeCampaignReadiness(campaign)

  const scopeLabel = (() => {
    switch (commandState.displayScope) {
      case 'property': return 'Property'
      case 'target': return 'Target'
      case 'thread': return 'Thread'
      case 'queue_row': return 'Queue'
      default: return null
    }
  })()

  const primaryAction = detailActions[0]
  const secondaryActions = detailActions.slice(1)
  const queueRows = campaign.queued_targets + campaign.scheduled_targets

  const statChips = [
    { label: 'Targets', value: fmt(campaign.total_targets) },
    { label: 'Ready', value: fmt(campaign.ready_targets), tone: 'is-accent' },
    { label: 'Sent', value: fmt(campaign.sent_count) },
    {
      label: 'Leads',
      value: fmt(campaign.positive_reply_count),
      tone: campaign.positive_reply_count > 0 ? 'is-good' : '',
    },
  ]

  const utilityActions = [
    { id: 'sync_metrics', label: 'Sync Metrics', icon: 'activity' as const },
    { id: 'refresh', label: 'Refresh', icon: 'refresh-cw' as const },
    ...secondaryActions.map((a) => ({ id: a.id, label: a.label, icon: actionIcon(a.id) as 'pause' })),
  ]

  return (
    <div className="ccc__detail-header ccc__detail-header--glass">
      {commandState.displayScope !== 'campaign' && (
        <div className="ccc__detail-breadcrumb">
          <span>Campaign Command</span>
          <Icon name="chevron-right" size={10} />
          <span className="ccc__detail-breadcrumb__name">{campaign.campaign_name}</span>
          <Icon name="chevron-right" size={10} />
          <span className="ccc__detail-breadcrumb__scope">{scopeLabel}</span>
        </div>
      )}

      <div className="ccc__detail-hero">
        {isMobileLayout && (
          <button type="button" className="ccc__detail-back" onClick={onClose} aria-label="Back to campaigns">
            <Icon name="chevron-left" size={16} />
          </button>
        )}
        <div className="ccc__detail-hero-copy">
          <div className="ccc__detail-title-row">
            <h2 className="ccc__detail-campaign-name">{campaign.campaign_name}</h2>
            {!isMobileLayout && (
              <button className="ccc__detail-close" onClick={onClose} title="Close" aria-label="Close">
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
          <div className={cls('ccc__detail-hero-meta', isMobileLayout && 'ccc__detail-hero-meta--mobile')}>
            <CampaignStatusBadge status={campaign.status} executionProof={campaign.execution_proof} />
            {!isMobileLayout && scopeLabel && <span className="ccc__detail-scope-pill">{scopeLabel} scope</span>}
            {!isMobileLayout && (
              <span className={cls('ccc__detail-readiness-pill', `is-${readiness.level}`)}>
                {readiness.label}
              </span>
            )}
            {!isMobileLayout && health.sampleSufficient && (
              <span className="ccc__detail-rate-pill">
                {fmtPct(campaign.delivery_rate)} dlv · {fmtPct(campaign.reply_rate)} reply
              </span>
            )}
            {campaign.auto_send_enabled && (
              <span className="ccc__detail-auto-pill">Auto-send</span>
            )}
            {isMobileLayout && (
              <span className="ccc__detail-next-pill">Next {fmtRelative(campaign.next_send_at)}</span>
            )}
          </div>
        </div>
      </div>

      {isTestModeCampaign(campaign) && (
        <div className="ccc__test-mode-banner ccc__test-mode-banner--compact">
          <Icon name="alert" size={12} />
          <span>Test mode — no SMS will transmit</span>
          <button
            type="button"
            className="ccc-btn is-primary ccc-btn--compact"
            onClick={() => onAction('convert_to_live', campaign)}
          >
            Convert to live
          </button>
        </div>
      )}

      {!isMobileLayout && (
        <div className="ccc__detail-stat-chips">
          {statChips.map((chip) => (
            <div key={chip.label} className={cls('ccc__detail-stat-chip', chip.tone)}>
              <span className="ccc__detail-stat-chip__label">{chip.label}</span>
              <strong className="ccc__detail-stat-chip__value">{chip.value}</strong>
            </div>
          ))}
          <div className="ccc__detail-stat-chip">
            <span className="ccc__detail-stat-chip__label">Queue</span>
            <strong className="ccc__detail-stat-chip__value">{fmt(queueRows)}</strong>
          </div>
          <div className="ccc__detail-stat-chip">
            <span className="ccc__detail-stat-chip__label">Next send</span>
            <strong className="ccc__detail-stat-chip__value ccc__detail-stat-chip__value--sm">
              {fmtRelative(campaign.next_send_at)}
            </strong>
          </div>
        </div>
      )}

      {!isMobileLayout && (
        <div className="ccc__detail-action-bar">
          {primaryAction && (
            <button
              type="button"
              className={cls('ccc-btn', 'ccc-btn--detail-primary', primaryAction.variant || 'is-primary')}
              onClick={() => onAction(primaryAction.id, campaign)}
            >
              <Icon name={actionIcon(primaryAction.id)} size={12} />
              {primaryAction.id === 'queue_batch'
                ? `Queue batch (${fmt(campaign.ready_targets)})`
                : primaryAction.label}
            </button>
          )}
          <div className="ccc__detail-action-menu-wrap">
            <button
              type="button"
              className="ccc__detail-action-menu-btn"
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((v) => !v)}
            >
              <Icon name="more" size={14} />
              <span>Actions</span>
            </button>
            {actionsOpen && (
              <>
                <button
                  type="button"
                  className="occ-liquid-filter__backdrop"
                  aria-label="Close actions"
                  onClick={() => setActionsOpen(false)}
                />
                <div className="ccc__detail-action-menu" role="menu">
                  {utilityActions.map((act) => (
                    <button
                      key={act.id}
                      type="button"
                      role="menuitem"
                      className="ccc__detail-action-menu-item"
                      onClick={() => {
                        onAction(act.id, campaign)
                        setActionsOpen(false)
                      }}
                    >
                      <Icon name={act.icon} size={12} />
                      {act.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}