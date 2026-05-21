import { useState } from 'react'
import type { NotificationsModel, NotificationItem } from './notifications.adapter'
import { Icon } from '../../shared/icons'
import { pushRoutePath } from '../../app/router'

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const kindIcon: Record<NotificationItem['kind'], string> = {
  autopilot: 'zap',
  alert: 'alert',
  deal: 'target',
  system: 'settings',
  inbox: 'message',
}

const kindLabel: Record<NotificationItem['kind'], string> = {
  autopilot: 'AUTOPILOT',
  alert: 'ALERT',
  deal: 'DEAL',
  system: 'SYSTEM',
  inbox: 'MESSAGE',
}

const severityClass: Record<NotificationItem['severity'], string> = {
  critical: 'is-critical',
  warning: 'is-warning',
  info: 'is-info',
}

export const NotificationsPage = ({ data }: { data: NotificationsModel }) => {
  const [readIds, setReadIds] = useState<string[]>(
    data.items.filter((i) => i.read).map((i) => i.id),
  )
  const [filterKind, setFilterKind] = useState<string>('all')

  const markRead = (id: string) => {
    setReadIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }

  const markAllRead = () => {
    setReadIds(data.items.map((i) => i.id))
  }

  const filtered = filterKind === 'all'
    ? data.items
    : data.items.filter(i => i.kind === filterKind)

  const unreadFiltered = filtered.filter(i => !readIds.includes(i.id)).length

  return (
    <div className="nx-notifications">
      <header className="nx-surface-header">
        <div className="nx-surface-header__title">
          <Icon className="nx-surface-icon" name="bell" />
          <h1>Notifications</h1>
        </div>
        <div className="nx-surface-header__stats">
          <span className="nx-badge nx-badge--primary">
            {unreadFiltered} unread
          </span>
          <button className="nx-inline-button" type="button" onClick={markAllRead}>
            Mark all read
          </button>
        </div>
      </header>

      <div className="nx-notifications__filters">
        {['all', 'alert', 'deal', 'autopilot', 'inbox', 'system'].map((kind) => (
          <button
            key={kind}
            type="button"
            className={classes('nx-filter-pill', filterKind === kind && 'is-active')}
            onClick={() => setFilterKind(kind)}
          >
            {kind === 'all' ? `All (${data.items.length})` : `${kind.charAt(0).toUpperCase() + kind.slice(1)} (${data.items.filter(i => i.kind === kind).length})`}
          </button>
        ))}
      </div>

      <div className="nx-notifications__list">
        {filtered.map((item) => {
          const isRead = readIds.includes(item.id)
          return (
            <article
              key={item.id}
              className={classes(
                'nx-notif-card',
                severityClass[item.severity],
                isRead && 'is-read',
              )}
            >
              <div className="nx-notif-card__icon-wrap">
                <Icon
                  className="nx-notif-card__icon"
                  name={kindIcon[item.kind] as any}
                />
              </div>
              <div className="nx-notif-card__body">
                <div className="nx-notif-card__header">
                  <div className="nx-notif-card__title-row">
                    <strong>{item.title}</strong>
                    <span className="nx-notif-card__kind">{kindLabel[item.kind]}</span>
                  </div>
                  <span className="nx-notif-card__time">{item.timestampLabel}</span>
                </div>
                <p>{item.detail}</p>
                <div className="nx-notif-card__actions">
                  {item.actionLabel && item.actionRoute && (
                    <button
                      className="nx-action-button"
                      type="button"
                      onClick={() => {
                        markRead(item.id)
                        pushRoutePath(item.actionRoute!)
                      }}
                    >
                      {item.actionLabel}
                    </button>
                  )}
                  {!isRead && (
                    <button
                      className="nx-action-button nx-action-button--muted"
                      type="button"
                      onClick={() => markRead(item.id)}
                    >
                      Mark Read
                    </button>
                  )}
                </div>
              </div>
              {!isRead && <div className="nx-notif-card__unread-dot" />}
            </article>
          )
        })}
        {filtered.length === 0 && (
          <div className="nx-empty-state">
            <Icon className="nx-empty-icon" name="bell" />
            <p>No notifications</p>
          </div>
        )}
      </div>
    </div>
  )
}
