import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { useRoutePath, useRouteLocation } from '../../app/router'
import { resolveAppForRoute } from '../../domain/app-registry/app-registry'
import { clearActiveContext, readActiveContext, type ActiveContext } from '../../domain/locator/active-context'
import { PROPERTY_LOCATOR_EVENT } from '../../domain/locator/property-locator'
import { goBack } from '../../domain/navigation/back-stack'
import { useBackTarget } from '../../domain/navigation/useBackHandler'
import { MobileOverflowSheet } from './MobileOverflowSheet'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const DOCK_ICON = 15
const DOCK_ICON_HUB = 16

/** Says what the queue state MEANS, which a status glyph alone never did. */
const QUEUE_DETAIL: Record<string, string> = {
  healthy: 'Processor healthy',
  warning: 'Processor degraded',
  critical: 'Processor critical',
  unknown: 'Status not yet resolved',
}

const QUEUE_TONE: Record<string, 'positive' | 'warning' | 'critical' | 'default'> = {
  healthy: 'positive',
  warning: 'warning',
  critical: 'critical',
  unknown: 'default',
}

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
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [context, setContext] = useState<ActiveContext | null>(null)
  useEffect(() => {
    const sync = () => setContext(readActiveContext())
    sync()
    window.addEventListener(PROPERTY_LOCATOR_EVENT, sync)
    return () => window.removeEventListener(PROPERTY_LOCATOR_EVENT, sync)
    // `routeLocation`, not `routePath`: clearing a context changes only the
    // query, and the path-only hook reports no change for that.
  }, [routeLocation])

  /* Counts that used to ride on the displaced buttons must still be visible
     from the closed bar, or moving them into the sheet would hide work. */
  const overflowBadge = (showTasks ? tasksCount : 0)

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
          §1 — ONE OVERFLOW, ALWAYS IN THE SAME PLACE.

          Queue, Tasks and Live Activity used to sit out here as three more
          38px glyphs, which is how the bar reached six and seven controls. At
          390px those targets were close enough that their 44px hit areas
          overlapped -- a probe 21px either side of a control's centre resolved
          to its NEIGHBOUR -- so the density was not just visual clutter, it
          made the bar mis-tappable. They are secondary utilities, which is
          exactly what §1 says belongs behind an overflow.

          The trailing slot is now fixed on every route, so the operator learns
          one position rather than a different arrangement per application, and
          an application contributing its own control no longer changes the
          shape of the global bar.
        */}
        <button
          type="button"
          className={cls(
            'nx-mobile-command-dock__btn',
            'nx-mobile-command-dock__btn--overflow',
            overflowOpen && 'is-active',
          )}
          aria-label={overflowBadge > 0 ? `More controls — ${overflowBadge} pending` : 'More controls'}
          aria-expanded={overflowOpen}
          aria-haspopup="dialog"
          onClick={() => setOverflowOpen(true)}
        >
          <DockGlyph>
            <Icon name="more" size={DOCK_ICON} strokeWidth={1.9} />
          </DockGlyph>
          {/*
            §9 — A DOT, NOT A COUNT.

            This first shipped as a numeric badge and immediately sat beside the
            notification badge as a second identical red "99+" pill. Two loud
            counters competing in adjacent 38px slots is worse noise than the
            buttons they replaced, and neither one read as more urgent than the
            other. The dot says "there is something in here" without pretending
            to outrank notifications; the exact figure is one tap away on the
            Tasks row, which is where a number is actually legible.
          */}
          {overflowBadge > 0 ? (
            <span className="nx-mobile-command-dock__dot" aria-hidden />
          ) : null}
        </button>

      </div>
    </nav>
  )

  return typeof document !== 'undefined'
    ? createPortal(
      <>
        {dock}
        <MobileOverflowSheet
          open={overflowOpen}
          onClose={() => setOverflowOpen(false)}
          subtitle={activeApp.label}
          groups={[
            {
              id: 'operations',
              label: 'Operations',
              actions: [
                {
                  id: 'queue',
                  label: 'Queue',
                  detail: QUEUE_DETAIL[queueStatus],
                  icon: queueIcon,
                  tone: QUEUE_TONE[queueStatus],
                  active: activeSurface === 'queue',
                  onSelect: () => toggle('queue'),
                },
                ...(showTasks
                  ? [{
                    id: 'tasks',
                    label: 'Tasks',
                    icon: 'check' as const,
                    meta: tasksCount > 0 ? tasksCount : undefined,
                    active: activeSurface === 'tasks',
                    onSelect: () => toggle('tasks'),
                  }]
                  : []),
                ...(showActivity
                  ? [{
                    id: 'activity',
                    label: 'Live activity',
                    detail: 'Operating events as they happen',
                    icon: 'zap' as const,
                    active: activityActive || activeSurface === 'activity',
                    onSelect: () => toggle('activity'),
                  }]
                  : []),
              ],
            },
          ]}
        />
      </>,
      document.body,
    )
    : null
}