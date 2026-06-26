import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { getAvailableCampaignActions } from './campaign-health'
import type { CampaignSummary } from './campaigns.types'

const ACTION_LABELS: Record<string, string> = {
  open: 'Open',
  rename: 'Rename',
  duplicate: 'Duplicate',
  restore: 'Restore',
  archive: 'Archive',
  delete_draft: 'Delete Draft',
  delete: 'Delete',
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
  const [pos, setPos] = useState({ top: y, left: x })
  const actions = getAvailableCampaignActions(campaign)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      setPos({ top: y, left: x })
      return
    }
    const rect = el.getBoundingClientRect()
    const pad = 8
    let top = y
    let left = x
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, y - rect.height - 4)
    }
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad)
    }
    if (left < pad) left = pad
    setPos({ top, left })
  }, [x, y, actions.length])

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

  return createPortal(
    <div
      ref={ref}
      className="ccc-context-menu"
      style={{ top: pos.top, left: pos.left }}
      role="menu"
    >
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={`ccc-context-menu__item ${action === 'delete_draft' || action === 'delete' ? 'is-danger' : ''}`}
          onClick={() => {
            onAction(action, campaign)
            onClose()
          }}
        >
          {ACTION_LABELS[action] ?? action}
        </button>
      ))}
    </div>,
    document.body,
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