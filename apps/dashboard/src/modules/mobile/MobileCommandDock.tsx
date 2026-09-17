import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { useRoutePath } from '../../app/router'
import { resolveAppForRoute } from '../../domain/app-registry/app-registry'

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
  /**
   * Tasks and Live Activity are only rendered by a host that can actually open them.
   * PortableCommandShell has neither, and painted both anyway — each one silently
   * pushed /inbox. An icon that lies about its destination costs more than the slot
   * it occupies, so the host now has to opt in.
   */
  showTasks?: boolean
  showActivity?: boolean
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
  showTasks = true,
  showActivity = true,
}: MobileCommandDockProps) => {
  const routePath = useRoutePath()
  const activeApp = resolveAppForRoute(routePath)

  const toggle = (surface: Exclude<DockSurface, null>) => {
    onSurfaceChange(activeSurface === surface ? null : surface)
  }

  /* `activity` for unknown collided with the KPI orb and the live-activity button,
     which both paint a waveform — the bar read as three copies of one control.
     A queue whose health has not resolved is genuinely unknown, so it says so. */
  const queueIcon =
    queueStatus === 'healthy' ? 'check'
      : queueStatus === 'unknown' ? 'slash'
        : 'alert'

  const dock = (
    <nav className="nx-mobile-command-dock is-top-dock" aria-label="Mobile command menu">
      <div className="nx-mobile-command-dock__inner nx-liquid-surface">
        <span className="nx-mobile-command-dock__sheen" aria-hidden="true" />
        <span className="nx-mobile-command-dock__rim" aria-hidden="true" />
        <div className="nx-mobile-command-dock__slot nx-mobile-command-dock__slot--kpi">
          {kpiControl}
        </div>

        {/*
          THE IDENTITY CONTROL.

          §2 asks the mobile top bar to say which application the operator is in. A
          390px bar holding seven 44px targets has no room for a separate title, and
          a second row would be exactly the stacked-chrome §2 forbids. So identity and
          the launcher are one control: it shows where you ARE and opens the list of
          where you can go, which is also the honest answer to what the button does.

          The label shrinks away before the glyph does, so on the densest bar (the
          inbox, which also carries Tasks and Live Activity) it degrades to the app's
          own icon rather than overflowing.
        */}
        <button
          type="button"
          className={cls(
            'nx-mobile-command-dock__btn',
            'nx-mobile-command-dock__btn--workspace',
            (workspaceActive || activeSurface === 'workspace') && 'is-active',
          )}
          aria-label={`${activeApp.label} — open applications`}
          aria-expanded={activeSurface === 'workspace'}
          onClick={() => toggle('workspace')}
        >
          <DockGlyph hub>
            <Icon name={activeApp.icon} size={DOCK_ICON_HUB} strokeWidth={1.55} />
          </DockGlyph>
          <span className="nx-mobile-command-dock__identity">{activeApp.shortLabel}</span>
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

        {showTasks ? (
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
        ) : null}

        {showActivity ? (
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
              {/* `zap` rather than `activity`: the KPI orb already renders a
                  waveform, and two identical squiggles in a seven-slot bar are
                  indistinguishable at 15px. */}
              <Icon name="zap" size={DOCK_ICON} strokeWidth={1.55} />
            </DockGlyph>
          </button>
        ) : null}

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