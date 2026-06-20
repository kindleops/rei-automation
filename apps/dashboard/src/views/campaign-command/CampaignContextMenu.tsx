import { useEffect, useRef } from 'react'
import { Icon } from '../../shared/icons'
import { getAvailableCampaignActions } from './campaign-health'
import type { CampaignSummary } from './campaigns.types'

const ACTION_LABELS: Record<string, string> = {
  open: 'Open',
  edit: 'Edit',
  duplicate: 'Duplicate',
  rename: 'Rename',
  pause: 'Pause',
  resume: 'Resume',
  schedule: 'Schedule',
  reschedule: 'Reschedule',
  activate: 'Activate',
  build_targets: 'Build Targets',
  queue_batch: 'Queue Batch',
  archive: 'Archive',
  delete_draft: 'Delete Draft',
}

interface CampaignContextMenuProps {
  campaign: CampaignSummary
  x: number
  y: number
  onAction: (action: string, campaign: CampaignSummary) => void
  onClose: () => void
}

export const CampaignContextMenu = ({
  campaign,
  x,
  y,
  onAction,
  onClose,
}: CampaignContextMenuProps) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const actions = getAvailableCampaignActions(campaign)

  return (
    <div
      ref={ref}
      className="ccc-context-menu"
      style={{ top: y, left: x }}
      role="menu"
    >
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={`ccc-context-menu__item ${action === 'delete_draft' ? 'is-danger' : ''}`}
          onClick={() => {
            onAction(action, campaign)
            onClose()
          }}
        >
          {ACTION_LABELS[action] ?? action}
        </button>
      ))}
    </div>
  )
}

export const CampaignOverflowButton = ({
  onClick,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}) => (
  <button
    type="button"
    className="ccc-list-overflow"
    onClick={onClick}
    aria-label="Campaign actions"
    title="More actions"
  >
    <Icon name="more" size={12} />
  </button>
)