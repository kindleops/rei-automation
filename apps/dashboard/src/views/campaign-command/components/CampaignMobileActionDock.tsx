import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { CampaignActionDef } from '../campaign-health'
import type { CampaignSummary } from '../campaigns.types'
import { cls, fmt } from '../campaign-formatters'

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

interface CampaignMobileActionDockProps {
  campaign: CampaignSummary
  detailActions: CampaignActionDef[]
  onAction: (action: string, campaign: CampaignSummary) => void
}

export function CampaignMobileActionDock({
  campaign,
  detailActions,
  onAction,
}: CampaignMobileActionDockProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const primaryAction = detailActions[0]
  const secondaryActions = detailActions.slice(1)

  const utilityActions = [
    { id: 'sync_metrics', label: 'Sync metrics', icon: 'activity' as const },
    { id: 'refresh', label: 'Refresh campaign', icon: 'refresh-cw' as const },
    ...secondaryActions.map((a) => ({
      id: a.id,
      label: a.label,
      icon: actionIcon(a.id) as 'pause',
    })),
  ]

  const sheet = sheetOpen ? createPortal(
    <>
      <button
        type="button"
        className="occ-liquid-filter__backdrop"
        aria-label="Close actions"
        onClick={() => setSheetOpen(false)}
      />
      <div className="ccc-mobile-sheet" role="dialog" aria-label="Campaign actions">
        <div className="ccc-mobile-sheet__head">
          <strong>Actions</strong>
          <button type="button" className="occ-liquid-filter__close" onClick={() => setSheetOpen(false)} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="ccc-mobile-sheet__body">
          {utilityActions.map((act) => (
            <button
              key={act.id}
              type="button"
              className="ccc-mobile-sheet__item"
              onClick={() => {
                onAction(act.id, campaign)
                setSheetOpen(false)
              }}
            >
              <Icon name={act.icon} size={14} />
              {act.label}
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body,
  ) : null

  return (
    <>
      <div className="ccc-mobile-dock" role="toolbar" aria-label="Campaign actions">
        {primaryAction ? (
          <button
            type="button"
            className={cls('ccc-mobile-dock__primary', primaryAction.variant || 'is-primary')}
            onClick={() => onAction(primaryAction.id, campaign)}
          >
            <Icon name={actionIcon(primaryAction.id)} size={14} />
            {primaryAction.id === 'queue_batch'
              ? `Queue ${fmt(campaign.ready_targets)}`
              : primaryAction.label}
          </button>
        ) : (
          <button type="button" className="ccc-mobile-dock__primary" onClick={() => onAction('refresh', campaign)}>
            <Icon name="refresh-cw" size={14} />
            Refresh
          </button>
        )}
        <button
          type="button"
          className="ccc-mobile-dock__more"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
        >
          <Icon name="more" size={16} />
        </button>
      </div>
      {sheet}
    </>
  )
}