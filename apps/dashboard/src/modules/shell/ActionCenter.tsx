import { Icon } from '../../shared/icons'
import { CommandPopover } from './primitives/CommandPopover'
import { ShellSkeleton } from './primitives/ShellSkeleton'
import type { ActionCenterItem } from './shell-types'

const itemIcon = (id: string): Parameters<typeof Icon>[0]['name'] => {
  if (id === 'human-review') return 'shield'
  if (id === 'follow-ups') return 'clock'
  if (id === 'failed-sends') return 'alert'
  if (id === 'decisions') return 'flag'
  if (id === 'closing-tasks') return 'dollar-sign'
  return 'activity'
}

const renderCount = (item: ActionCenterItem) => {
  if (item.loading) return <ShellSkeleton rows={1} />
  if (typeof item.count === 'number') return <b className="nx-action-center__count">{item.count}</b>
  if (item.unavailableReason) {
    return <span className="nx-action-center__unavailable" title={item.unavailableReason}>—</span>
  }
  return null
}

export const ActionCenter = ({
  open,
  anchorRef,
  onClose,
  items,
  loading,
}: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  items: ActionCenterItem[]
  loading?: boolean
}) => {
  const visibleItems = items.filter((item) => !item.hidden)

  return (
    <CommandPopover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      className="nx-action-center-popover"
      placement="bottom-end"
      width={300}
    >
      <header className="nx-action-center__header">
        <strong>Action Center</strong>
        <small>Operator tasks requiring attention</small>
      </header>
      <div className="nx-action-center__list" role="menu">
        {loading && visibleItems.length === 0 ? <ShellSkeleton rows={4} /> : null}
        {visibleItems.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="nx-action-center__row"
            disabled={Boolean(item.unavailableReason) && item.count == null}
            onClick={() => {
              if (item.unavailableReason && item.count == null) return
              item.onSelect()
              onClose()
            }}
          >
            <span className="nx-action-center__icon" aria-hidden>
              <Icon name={itemIcon(item.id)} />
            </span>
            <span className="nx-action-center__label">{item.label}</span>
            {renderCount(item)}
          </button>
        ))}
        {!loading && visibleItems.length === 0 ? (
          <p className="nx-action-center__empty">No action categories available.</p>
        ) : null}
      </div>
    </CommandPopover>
  )
}