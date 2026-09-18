import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { useRoutePath, useRouteLocation } from '../../app/router'
import { resolveAppForRoute } from '../../domain/app-registry/app-registry'
import { clearActiveContext, readActiveContext, type ActiveContext } from '../../domain/locator/active-context'
import { PROPERTY_LOCATOR_EVENT } from '../../domain/locator/property-locator'
import { goBack } from '../../domain/navigation/back-stack'
import { useBackTarget } from '../../domain/navigation/useBackHandler'

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
  const routeLocation = useRouteLocation()
  const activeApp = resolveAppForRoute(routePath)
  const backTarget = useBackTarget()

  /**
   * §3 — context must be OBVIOUS, and must never be impossible to escape.
   *
   * Re-read on every route change (the path is the dependency) and on locator
   * changes, because a contextual action can publish an identity for a context
   * the URL already carried.
   */
  const [context, setContext] = useState<ActiveContext | null>(null)
  useEffect(() => {
    const sync = () => setContext(readActiveContext())
    sync()
    window.addEventListener(PROPERTY_LOCATOR_EVENT, sync)
    return () => window.removeEventListener(PROPERTY_LOCATOR_EVENT, sync)
    // `routeLocation`, not `routePath`: clearing a context changes only the
    // query, and the path-only hook reports no change for that.
  }, [routeLocation])

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
        {/*
          §4 — THE LEFT SLOT IS BACK, OR IDENTITY. Never neither.

          Every nested state in this product (a thread, a comp detail, a buyer, a
          campaign step, a closing record) was reachable and not leaveable,
          because the bar rendered no Back at all. It renders one whenever
          `back-stack` reports a destination: a registered dismiss handler first,
          then our own route history. When there is genuinely nowhere back, the
          slot returns to identity-and-launcher, so the control is never dead.
        */}
        {backTarget.kind !== 'none' ? (
          <button
            type="button"
            className={cls('nx-mobile-command-dock__btn', 'nx-mobile-command-dock__btn--back')}
            aria-label={`Back to ${backTarget.label}`}
            onClick={() => { if (!goBack()) toggle('workspace') }}
          >
            <DockGlyph hub>
              <Icon name="chevron-left" size={DOCK_ICON_HUB} strokeWidth={1.9} />
            </DockGlyph>
            <span className="nx-mobile-command-dock__identity">{backTarget.label}</span>
          </button>
        ) : (
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
        )}

        {/*
          THE CONTEXT CHIP.

          Present only when the URL declares a context, which is now the single
          source of truth for scoped-vs-universal (see domain/locator/active-context).
          It states WHAT the app is currently aimed at and carries the X that
          releases it — deliberately in the global bar rather than in an overflow
          menu, because §3 requires the escape hatch to be visible wherever the
          operator is. Clearing keeps the current application and returns it to
          universal mode; it does not bounce anyone back to the Inbox.
        */}
        {context ? (
          <div className="nx-mobile-command-dock__context" title={context.detail}>
            <span className="nx-mobile-command-dock__context-label">{context.label}</span>
            <button
              type="button"
              className="nx-mobile-command-dock__context-clear"
              aria-label={`Clear ${context.detail} — return to all records`}
              onClick={() => {
                clearActiveContext()
                setContext(null)
              }}
            >
              <Icon name="x" size={12} strokeWidth={2} />
            </button>
          </div>
        ) : null}

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

        {/*
          §5 — APPLICATION-LOCAL CONTROLS, AFTER THE GLOBALS AND MARKED AS SUCH.

          The bar carried four controls on some routes, five on others and six on
          others, because these two were injected into the GLOBAL shell by
          whichever host happened to be able to open them. The three globals
          above (Queue, Search, Notifications) are now fixed in count, order and
          position on every route; anything a single application contributes
          trails them behind a hairline so the operator can see which is which.
        */}
        {showTasks || showActivity ? <span className="nx-mobile-command-dock__divider" aria-hidden /> : null}

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

      </div>
    </nav>
  )

  return typeof document !== 'undefined' ? createPortal(dock, document.body) : null
}