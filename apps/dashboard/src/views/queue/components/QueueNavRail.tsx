import { Icon } from '../../../shared/icons'
import type { QueueSection } from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface NavRailItem {
  key: QueueSection
  label: string
  icon: string
  count: number
  health?: 'good' | 'warn' | 'critical' | 'neutral'
  preview?: string
}

interface QueueNavRailProps {
  items: NavRailItem[]
  active: QueueSection
  onSelect: (key: QueueSection) => void
}

export function QueueNavRail({ items, active, onSelect }: QueueNavRailProps) {
  return (
    <nav className="occ-nav-rail occ-glass-rail" role="tablist" aria-label="Outbound workspace navigation">
      <div className="occ-nav-rail__track">
        {items.map(item => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active === item.key}
            className={cls('occ-nav-tab', active === item.key && 'is-active', item.health && `is-health-${item.health}`)}
            onClick={() => onSelect(item.key)}
            title={item.preview}
          >
            <span className="occ-nav-tab__glow" aria-hidden="true" />
            <Icon name={item.icon as any} size={14} />
            <span className="occ-nav-tab__text">
              <span className="occ-nav-tab__label">{item.label}</span>
              {item.count > 0 && item.key !== 'queue' && (
                <span className={cls('occ-nav-tab__count', item.health === 'critical' && 'is-critical')}>
                  · {item.count > 999 ? '999+' : item.count}
                </span>
              )}
            </span>
            {item.health && item.health !== 'neutral' && (
              <span className={cls('occ-nav-tab__health', `is-${item.health}`)} aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
    </nav>
  )
}

export const NAV_SECTIONS: Array<{ key: QueueSection; label: string; icon: string }> = [
  { key: 'queue', label: 'Queue Rows', icon: 'list' },
  { key: 'templates', label: 'Templates', icon: 'file-text' },
  { key: 'senders', label: 'Sender Fleet', icon: 'phone' },
  { key: 'market', label: 'Market Health', icon: 'map-pin' },
  { key: 'failures', label: 'Failure Taxonomy', icon: 'alert-circle' },
  { key: 'events', label: 'Event Timeline', icon: 'activity' },
]