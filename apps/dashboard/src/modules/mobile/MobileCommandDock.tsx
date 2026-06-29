import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export type DockSurface =
  | 'kpi'
  | 'workspace'
  | 'queue'
  | 'search'
  | 'tasks'
  | 'activity'
  | 'notifications'
  | null

export interface MobileCommandDockProps {
  activeSurface: DockSurface
  onSurfaceChange: (surface: DockSurface) => void
  kpiControl: ReactNode
  workspaceActive?: boolean
  queueStatus?: 'healthy' | 'warning' | 'critical' | 'unknown'
  searchActive?: boolean
  tasksCount?: number
  activityActive?: boolean
  notificationCount?: number
  notificationsActive?: boolean
}

export const MobileCommandDock = ({
  activeSurface,
  onSurfaceChange,
  kpiControl,
  workspaceActive = false,
  queueStatus = 'unknown',
  searchActive = false,
  tasksCount = 0,
  activityActive = false,
  notificationCount = 0,
  notificationsActive = false,
}: MobileCommandDockProps) => {
  const toggle = (surface: Exclude<DockSurface, null>) => {
    onSurfaceChange(activeSurface === surface ? null : surface)
  }

  const dock = (
    <nav className="nx-mobile-command-dock is-top-dock" aria-label="Mobile command menu">
      <div className="nx-mobile-command-dock__inner nx-liquid-surface">
        <span className="nx-mobile-command-dock__sheen" aria-hidden="true" />
        <span className="nx-mobile-command-dock__rim" aria-hidden="true" />
        <div className="nx-mobile-command-dock__slot nx-mobile-command-dock__slot--kpi">
          {kpiControl}
        </div>

        <button
          type="button"
          className={cls(
            'nx-mobile-command-dock__btn',
            'nx-mobile-command-dock__btn--workspace',
            (workspaceActive || activeSurface === 'workspace') && 'is-active',
          )}
          aria-label="Workspace launcher"
          aria-expanded={activeSurface === 'workspace'}
          onClick={() => toggle('workspace')}
        >
          <Icon name="layout-split" />
        </button>

        <button
          type="button"
          className={cls(
            'nx-mobile-command-dock__btn',
            'nx-mobile-command-dock__btn--queue',
            `is-${queueStatus}`,
            activeSurface === 'queue' && 'is-active',
          )}
          aria-label="Queue operational intelligence"
          aria-expanded={activeSurface === 'queue'}
          onClick={() => toggle('queue')}
        >
          <span className={cls('nx-queue-indicator', `is-${queueStatus}`)}>
            <Icon name={queueStatus === 'healthy' ? 'check' : queueStatus === 'unknown' ? 'activity' : 'alert'} />
            {queueStatus === 'healthy' ? <i className="nx-queue-indicator-dot" /> : null}
          </span>
        </button>

        <button
          type="button"
          className={cls(
            'nx-mobile-command-dock__btn',
            (searchActive || activeSurface === 'search') && 'is-active',
          )}
          aria-label="Universal search"
          aria-expanded={searchActive || activeSurface === 'search'}
          onClick={() => toggle('search')}
        >
          <Icon name="search" />
        </button>

        <button
          type="button"
          className={cls('nx-mobile-command-dock__btn', activeSurface === 'tasks' && 'is-active')}
          aria-label="Tasks"
          aria-expanded={activeSurface === 'tasks'}
          onClick={() => toggle('tasks')}
        >
          <Icon name="check" />
          {tasksCount > 0 ? (
            <span className="nx-mobile-command-dock__badge">{tasksCount > 99 ? '99+' : tasksCount}</span>
          ) : null}
        </button>

        <button
          type="button"
          className={cls(
            'nx-mobile-command-dock__btn',
            (activityActive || activeSurface === 'activity') && 'is-active',
          )}
          aria-label="Live activity"
          aria-expanded={activityActive || activeSurface === 'activity'}
          onClick={() => toggle('activity')}
        >
          <Icon name="activity" />
        </button>

        <button
          type="button"
          className={cls(
            'nx-mobile-command-dock__btn',
            notificationsActive && 'is-active',
          )}
          aria-label="Notifications"
          aria-expanded={notificationsActive}
          onClick={() => toggle('notifications')}
        >
          <Icon name="bell" />
          {notificationCount > 0 ? (
            <span className="nx-mobile-command-dock__badge">{notificationCount > 99 ? '99+' : notificationCount}</span>
          ) : null}
        </button>
      </div>
    </nav>
  )

  return typeof document !== 'undefined' ? createPortal(dock, document.body) : null
}