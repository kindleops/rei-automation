import { Icon } from '../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export type MobileNavTab = 'inbox' | 'map' | 'pipeline' | 'more'

interface MobileBottomNavProps {
  activeTab: MobileNavTab
  inboxBadge?: number
  notificationBadge?: number
  onNavigate: (tab: MobileNavTab) => void
}

const TAB_META: Array<{ id: MobileNavTab; label: string; icon: 'inbox' | 'map' | 'radar' | 'grid' }> = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'pipeline', label: 'Pipeline', icon: 'radar' },
  { id: 'more', label: 'More', icon: 'grid' },
]

export const MobileBottomNav = ({
  activeTab,
  inboxBadge = 0,
  notificationBadge = 0,
  onNavigate,
}: MobileBottomNavProps) => (
  <nav className="nx-mobile-bottom-nav" aria-label="Primary navigation">
    {TAB_META.map(({ id, label, icon }) => {
      const badge = id === 'inbox' ? inboxBadge : id === 'more' ? notificationBadge : 0
      return (
        <button
          key={id}
          type="button"
          className={cls('nx-mobile-bottom-nav__item', activeTab === id && 'is-active')}
          aria-current={activeTab === id ? 'page' : undefined}
          aria-label={label}
          onClick={() => onNavigate(id)}
        >
          <span className="nx-mobile-bottom-nav__icon-wrap">
            <Icon name={icon} className="nx-mobile-bottom-nav__icon" />
            {badge > 0 ? (
              <span className="nx-mobile-bottom-nav__badge" aria-hidden>
                {badge > 99 ? '99+' : badge}
              </span>
            ) : null}
          </span>
          <span className="nx-mobile-bottom-nav__label">{label}</span>
        </button>
      )
    })}
  </nav>
)