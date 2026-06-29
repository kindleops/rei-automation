import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const DOCK_ICON = 15
const DOCK_ICON_HUB = 16

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

const DockGlyph = ({
  children,
  hub = false,
}: {
  children: ReactNode
  hub?: boolean
}) => (
  <span className={cls('nx-mobile-command-dock__glyph', hub && 'is-hub')} aria-hidden>
    {children}
  </span>
)

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

  const queueIcon =
    queueStatus === 'healthy' ? 'check'
      : queueStatus === 'unknown' ? 'activity'
        : 'alert'

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
          <DockGlyph hub>
            <Icon name="layout-split" size={DOCK_ICON_HUB} strokeWidth={1.55} />
          </DockGlyph>
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
          <DockGlyph>
            <span className={cls('nx-mobile-command-dock__queue', `is-${queueStatus}`)}>
              <Icon name={queueIcon} size={DOCK_ICON} strokeWidth={1.55} />
              {queueStatus === 'healthy' ? <i className="nx-mobile-command-dock__queue-dot" /> : null}
            </span>
          </DockGlyph>
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
          <DockGlyph>
            <Icon name="search" size={DOCK_ICON} strokeWidth={1.55} />
          </DockGlyph>
        </button>

        <button
          type="button"
          className={cls('nx-mobile-command-dock__btn', activeSurface === 'tasks' && 'is-active')}
          aria-label="Tasks"
          aria-expanded={activeSurface === 'tasks'}
          onClick={() => toggle('tasks')}
        >
          <DockGlyph>
            <Icon name="check" size={DOCK_ICON} strokeWidth={1.55} />
          </DockGlyph>
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
          <DockGlyph>
            <Icon name="activity" size={DOCK_ICON} strokeWidth={1.55} />
          </DockGlyph>
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
          <DockGlyph>
            <Icon name="bell" size={DOCK_ICON} strokeWidth={1.55} />
          </DockGlyph>
          {notificationCount > 0 ? (
            <span className="nx-mobile-command-dock__badge">{notificationCount > 99 ? '99+' : notificationCount}</span>
          ) : null}
        </button>
      </div>
    </nav>
  )

  return typeof document !== 'undefined' ? createPortal(dock, document.body) : null
}