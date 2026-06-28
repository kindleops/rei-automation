import { Icon } from '../../shared/icons'
import type { NavIconName } from './mobile-nav-routes'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export interface MobileMoreItem {
  path: string
  label: string
  description?: string
  icon: NavIconName
  badge?: number
  active?: boolean
}

interface MobileMoreSheetProps {
  open: boolean
  items: MobileMoreItem[]
  onClose: () => void
  onNavigate: (path: string) => void
  onOpenSearch: () => void
  onOpenNotifications: () => void
  notificationBadge?: number
}

export const MobileMoreSheet = ({
  open,
  items,
  onClose,
  onNavigate,
  onOpenSearch,
  onOpenNotifications,
  notificationBadge = 0,
}: MobileMoreSheetProps) => {
  if (!open) return null

  return (
    <>
      <button
        type="button"
        className="nx-mobile-sheet-backdrop"
        aria-label="Close menu"
        onClick={onClose}
      />
      <aside className="nx-mobile-more-sheet" role="dialog" aria-label="More destinations">
        <header className="nx-mobile-more-sheet__header">
          <strong>Command Surfaces</strong>
          <button type="button" className="nx-mobile-more-sheet__close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="nx-mobile-more-sheet__quick">
          <button type="button" className="nx-mobile-more-sheet__quick-btn" onClick={() => { onOpenSearch(); onClose() }}>
            <Icon name="search" />
            <span>Search &amp; Command</span>
          </button>
          <button type="button" className="nx-mobile-more-sheet__quick-btn" onClick={() => { onOpenNotifications(); onClose() }}>
            <Icon name="bell" />
            <span>Notifications</span>
            {notificationBadge > 0 ? (
              <span className="nx-mobile-more-sheet__badge">{notificationBadge > 99 ? '99+' : notificationBadge}</span>
            ) : null}
          </button>
        </div>

        <div className="nx-mobile-more-sheet__grid">
          {items.map((item) => (
            <button
              key={item.path}
              type="button"
              className={cls('nx-mobile-more-sheet__tile', item.active && 'is-active')}
              onClick={() => { onNavigate(item.path); onClose() }}
            >
              <span className="nx-mobile-more-sheet__tile-icon">
                <Icon name={item.icon} />
              </span>
              <span className="nx-mobile-more-sheet__tile-label">{item.label}</span>
              {item.description ? (
                <span className="nx-mobile-more-sheet__tile-desc">{item.description}</span>
              ) : null}
              {item.badge && item.badge > 0 ? (
                <span className="nx-mobile-more-sheet__tile-badge">{item.badge}</span>
              ) : null}
            </button>
          ))}
        </div>
      </aside>
    </>
  )
}