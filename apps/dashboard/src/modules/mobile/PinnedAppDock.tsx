import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { captureAppSession, resolveAppIdFromRoute, restoreAppSession } from './app-session-cache'
import {
  appForCommandNavRoute,
  isCommandNavRouteActive,
  type CommandNavRoute,
} from './command-navigation-registry'
import { closeInboxDealIntelligence, isInboxRoute, openInboxDealIntelligence } from './mobile-inbox-bridge'
import { AppLauncher, APP_LAUNCHER_OPEN_EVENT } from './AppLauncher'
import { navigateToApp as navigateToRegistryApp } from '../../domain/app-registry/contextual-navigation'
import type { NexusApp } from '../../domain/app-registry/app-registry'
import { MobileSettingsSheet } from './MobileSettingsSheet'
import { requestNotificationsSurface } from './shell-surface-bridge'
import {
  DOCKABLE_APPS,
  addPinApp,
  recordRecentApp,
  removePinApp,
  reorderPinnedApps,
  resolveDockApp,
  togglePinApp,
} from './pinned-app-dock-store'
import type { DockAppBadge, PinnedAppDockPhase, PinnedAppId } from './pinned-app-dock.types'
import { badgeForApp, usePinnedAppDockBadges } from './usePinnedAppDockBadges'
import { usePinnedAppDockSettings } from './usePinnedAppDockSettings'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const LONG_PRESS_MS = 520
const EXPAND_DRAG_THRESHOLD = 40

interface PinnedAppDockProps {
  routePath: string
}

const formatBadge = (count?: number) => {
  if (!count || count <= 0) return null
  return count > 99 ? '99+' : String(count)
}

/**
 * Dock navigation, delegated to the ONE contextual navigator.
 *
 * This used to be a hand-written switch living only in the dock, so tapping a
 * destination from the dock carried the operator's selected property while the
 * workspace launcher and the command palette — which push the same paths — dropped it.
 * Context preservation now belongs to the platform (domain/app-registry), and every
 * entry point inherits it.
 */
const navigateToApp = (item: CommandNavRoute, effects: DockNavigationEffects) => {
  const app = appForCommandNavRoute(item)
  if (!app) return
  navigateToRegistryApp(app, {
    openDealIntelligence: (identity) => openInboxDealIntelligence(identity ?? undefined),
    openNotifications: effects.openNotifications,
    openSettings: effects.openSettings,
    closeInboxDealIntelligence,
    isInboxRoute,
  })
}

interface DockNavigationEffects {
  openNotifications: () => void
  openSettings: () => void
}

export const PinnedAppDock = ({ routePath }: PinnedAppDockProps) => {
  const badges = usePinnedAppDockBadges()
  const [dockSettings, persistDockSettings] = usePinnedAppDockSettings()
  const [phase, setPhase] = useState<PinnedAppDockPhase>('collapsed')
  const [draggingId, setDraggingId] = useState<PinnedAppId | null>(null)
  const [dragSource, setDragSource] = useState<'pinned' | 'catalog' | null>(null)
  const [dragOverId, setDragOverId] = useState<PinnedAppId | 'track' | 'unpin' | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  /**
   * The route the launcher was opened ON, rather than a bare boolean.
   *
   * Openness is then DERIVED: a route change makes it false with no effect and no
   * setState-in-effect, which is what keeps a back-navigation from leaving the
   * launcher floating over a surface the operator never opened it from.
   */
  const [launcherRoute, setLauncherRoute] = useState<string | null>(null)
  const launcherOpen = launcherRoute !== null && launcherRoute === routePath
  const [settingsOpen, setSettingsOpen] = useState(false)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragYRef = useRef(0)
  const longPressRef = useRef<number | null>(null)
  const suppressClickRef = useRef(false)
  const prevRouteRef = useRef(routePath)

  const activeAppId = resolveAppIdFromRoute(routePath)

  const pinnedApps = useMemo(
    () => dockSettings.pinnedIds
      .map((id) => resolveDockApp(id))
      .filter((app): app is CommandNavRoute => Boolean(app)),
    [dockSettings.pinnedIds],
  )

  const recentUnpinned = useMemo(() => {
    const pinned = new Set(dockSettings.pinnedIds)
    return dockSettings.recentIds
      .filter((id) => !pinned.has(id))
      .map((id) => resolveDockApp(id))
      .filter((app): app is CommandNavRoute => Boolean(app))
      .slice(0, 8)
  }, [dockSettings.pinnedIds, dockSettings.recentIds])

  const catalogApps = useMemo(() => {
    const pinned = new Set(dockSettings.pinnedIds)
    return DOCKABLE_APPS.filter((app) => !pinned.has(app.path))
  }, [dockSettings.pinnedIds])

  const collapse = useCallback(() => setPhase('collapsed'), [])
  const openDocked = useCallback(() => setPhase('docked'), [])
  const openExpanded = useCallback(() => setPhase('expanded'), [])

  useEffect(() => {
    const prev = prevRouteRef.current
    if (prev === routePath) return
    captureAppSession(resolveAppIdFromRoute(prev))
    const nextId = resolveAppIdFromRoute(routePath)
    persistDockSettings((current) => recordRecentApp(current, nextId))
    requestAnimationFrame(() => restoreAppSession(nextId))
    prevRouteRef.current = routePath
  }, [persistDockSettings, routePath])

  const navigationEffects = useMemo(() => ({
    openNotifications: requestNotificationsSurface,
    openSettings: () => setSettingsOpen(true),
  }), [])

  const switchToApp = useCallback((app: CommandNavRoute) => {
    captureAppSession(activeAppId)
    navigateToApp(app, navigationEffects)
    persistDockSettings((current) => recordRecentApp(current, app.path))
    collapse()
  }, [activeAppId, collapse, navigationEffects, persistDockSettings])

  /** Launcher selections arrive as canonical apps; reuse the same one path. */
  const switchToRegistryApp = useCallback((app: NexusApp) => {
    captureAppSession(activeAppId)
    navigateToRegistryApp(app, {
      openDealIntelligence: (identity) => openInboxDealIntelligence(identity ?? undefined),
      openNotifications: navigationEffects.openNotifications,
      openSettings: navigationEffects.openSettings,
      closeInboxDealIntelligence,
      isInboxRoute,
    })
    persistDockSettings((current) => recordRecentApp(current, app.route))
    setLauncherRoute(null)
    collapse()
  }, [activeAppId, collapse, navigationEffects, persistDockSettings])

  // The top bar and the command palette can raise the launcher without knowing
  // where it is mounted.
  useEffect(() => {
    const open = () => setLauncherRoute(routePath)
    window.addEventListener(APP_LAUNCHER_OPEN_EVENT, open)
    return () => window.removeEventListener(APP_LAUNCHER_OPEN_EVENT, open)
  }, [routePath])

  const handleReorder = useCallback((fromId: PinnedAppId, toId: PinnedAppId) => {
    if (fromId === toId) return
    persistDockSettings((current) => {
      const ids = [...current.pinnedIds]
      const fromIndex = ids.indexOf(fromId)
      const toIndex = ids.indexOf(toId)
      if (fromIndex < 0 || toIndex < 0) return current
      ids.splice(fromIndex, 1)
      ids.splice(toIndex, 0, fromId)
      return { ...current, pinnedIds: reorderPinnedApps(ids) }
    })
  }, [persistDockSettings])

  const handleTogglePin = useCallback((appId: PinnedAppId) => {
    persistDockSettings((current) => {
      const next = togglePinApp(current, appId)
      const pinned = next.pinnedIds.includes(appId)
      setHint(pinned ? 'Pinned to dock' : 'Removed from dock')
      window.setTimeout(() => setHint(null), 1400)
      return next
    })
  }, [persistDockSettings])

  const handleAddPin = useCallback((appId: PinnedAppId) => {
    persistDockSettings((current) => {
      const next = addPinApp(current, appId)
      if (next.pinnedIds.length !== current.pinnedIds.length) {
        setHint('Added to dock')
        window.setTimeout(() => setHint(null), 1400)
      }
      return next
    })
  }, [persistDockSettings])

  const handleRemovePin = useCallback((appId: PinnedAppId) => {
    persistDockSettings((current) => {
      const next = removePinApp(current, appId)
      if (next.pinnedIds.length !== current.pinnedIds.length) {
        setHint('Removed from dock')
        window.setTimeout(() => setHint(null), 1400)
      }
      return next
    })
  }, [persistDockSettings])

  const resetDragState = useCallback(() => {
    setDraggingId(null)
    setDragSource(null)
    setDragOverId(null)
  }, [])

  const clearLongPress = () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current)
    longPressRef.current = null
  }

  const startLongPress = (appId: PinnedAppId) => {
    clearLongPress()
    longPressRef.current = window.setTimeout(() => {
      suppressClickRef.current = true
      handleTogglePin(appId)
      if (navigator.vibrate) navigator.vibrate(12)
      window.setTimeout(() => { suppressClickRef.current = false }, 240)
      clearLongPress()
    }, LONG_PRESS_MS)
  }

  const onHandlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    dragYRef.current = event.clientY
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onHandlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const delta = event.clientY - dragYRef.current
    if (phase === 'collapsed' && delta < -EXPAND_DRAG_THRESHOLD) openDocked()
    if (phase === 'docked' && delta < -EXPAND_DRAG_THRESHOLD) openExpanded()
    if (phase === 'expanded' && delta > EXPAND_DRAG_THRESHOLD) openDocked()
    if (phase === 'docked' && delta > EXPAND_DRAG_THRESHOLD) collapse()
  }

  const onHandlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onHandleTap = () => {
    if (phase === 'collapsed') openDocked()
    else if (phase === 'docked') collapse()
  }

  const renderBadge = (badge?: DockAppBadge) => {
    if (!badge) return null
    const label = formatBadge(badge.count)
    if (label) {
      return (
        <span className={cls('nx-pinned-app-dock__badge', badge.tone && `is-${badge.tone}`)}>
          {label}
        </span>
      )
    }
    if (badge.dot) return <span className="nx-pinned-app-dock__dot" />
    return null
  }

  /**
   * THE PERMANENT RAIL.
   *
   * The collapsed dock used to be a bare 16px shelf with a drag handle and nothing
   * else — measured at 390x844 the dock was 20px tall and showed zero applications.
   * Every destination was behind an undiscoverable upward drag, so on a phone the
   * product had no navigation at all.
   *
   * The rail shows the first four pinned destinations plus the launcher. Four is the
   * ceiling: five 44px targets plus gutters is 280px of a 390px viewport before the
   * launcher, and shrinking them to fit is how touch targets die. Anything beyond four
   * is one tap away in the launcher, and pinning still reorders what those four are.
   */
  const railApps = pinnedApps.slice(0, 4)

  const renderRailButton = (app: CommandNavRoute) => {
    const isActive = isCommandNavRouteActive(routePath, app)
    const badge = badgeForApp(badges, app.path)
    const canonical = appForCommandNavRoute(app)
    return (
      <button
        key={`rail-${app.path}`}
        type="button"
        className={cls('nx-pinned-app-dock__rail-app', isActive && 'is-active')}
        aria-label={app.label}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => {
          if (suppressClickRef.current) return
          switchToApp(app)
        }}
        onPointerDown={() => startLongPress(app.path)}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
      >
        <span className="nx-pinned-app-dock__rail-glyph">
          <Icon name={app.icon} size={19} strokeWidth={1.6} />
          {renderBadge(badge)}
        </span>
        <span className="nx-pinned-app-dock__rail-label">
          {canonical?.shortLabel ?? app.label}
        </span>
      </button>
    )
  }

  const rail = (
    <nav className="nx-pinned-app-dock__rail" aria-label="Primary applications">
      {railApps.map(renderRailButton)}
      <button
        type="button"
        className={cls('nx-pinned-app-dock__rail-app', 'is-launcher', launcherOpen && 'is-active')}
        aria-label="All applications"
        aria-haspopup="dialog"
        aria-expanded={launcherOpen}
        onClick={() => setLauncherRoute(routePath)}
      >
        <span className="nx-pinned-app-dock__rail-glyph">
          <Icon name="grid" size={19} strokeWidth={1.6} />
        </span>
        <span className="nx-pinned-app-dock__rail-label">Apps</span>
      </button>
    </nav>
  )

  const renderAppButton = (
    app: CommandNavRoute,
    opts?: { pinned?: boolean; draggable?: boolean; catalog?: boolean },
  ) => {
    const isActive = isCommandNavRouteActive(routePath, app)
    const badge = badgeForApp(badges, app.path)
    const isDragging = draggingId === app.path
    const isDragOver = dragOverId === app.path

    return (
      <button
        key={`${opts?.catalog ? 'catalog' : 'pinned'}-${app.path}`}
        type="button"
        draggable={opts?.draggable || opts?.catalog}
        className={cls(
          'nx-pinned-app-dock__app',
          isActive && 'is-active',
          isDragging && 'is-dragging',
          isDragOver && 'is-drag-over',
          opts?.catalog && 'is-catalog',
          opts?.pinned === false && 'is-unpinned',
        )}
        aria-label={app.label}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => {
          if (suppressClickRef.current) return
          switchToApp(app)
        }}
        onPointerDown={() => startLongPress(app.path)}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
        onDragStart={() => {
          setDraggingId(app.path)
          setDragSource(opts?.catalog ? 'catalog' : 'pinned')
          if (!opts?.catalog && phase === 'docked') openExpanded()
          clearLongPress()
        }}
        onDragEnd={resetDragState}
        onDragOver={(event) => {
          if (!draggingId || draggingId === app.path) return
          event.preventDefault()
          if (dragSource === 'pinned' && opts?.catalog) {
            setDragOverId('unpin')
            return
          }
          if (dragSource === 'catalog' && opts?.pinned) return
          setDragOverId(app.path)
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (!draggingId) return
          if (dragSource === 'catalog') handleAddPin(draggingId)
          else if (dragSource === 'pinned' && opts?.catalog) handleRemovePin(draggingId)
          else if (dragSource === 'pinned') handleReorder(draggingId, app.path)
          resetDragState()
        }}
      >
        <span className="nx-pinned-app-dock__glyph">
          <Icon name={app.icon} size={16} strokeWidth={1.55} />
          {renderBadge(badge)}
        </span>
        <span className="nx-pinned-app-dock__label">{app.label}</span>
      </button>
    )
  }

  const dock = (
    <>
      {phase !== 'collapsed' ? (
        <button
          type="button"
          className="nx-pinned-app-dock__backdrop"
          aria-label="Close app dock"
          onClick={collapse}
        />
      ) : null}

      <div className={cls('nx-pinned-app-dock', `is-${phase}`, draggingId && 'is-reordering')}>
        <div className="nx-pinned-app-dock__glass nx-liquid-surface">
          <span className="nx-pinned-app-dock__sheen" aria-hidden />
          <span className="nx-pinned-app-dock__rim" aria-hidden />

          <button
            type="button"
            className="nx-pinned-app-dock__handle"
            aria-label={phase === 'collapsed' ? 'Open pinned apps' : 'Resize app dock'}
            aria-expanded={phase !== 'collapsed'}
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerUp}
            onClick={onHandleTap}
          >
            <i />
          </button>

          {hint ? <div className="nx-pinned-app-dock__hint" role="status">{hint}</div> : null}

          {phase === 'collapsed' ? rail : null}

          <div className="nx-pinned-app-dock__panel">
            <div className="nx-pinned-app-dock__panel-head">
              <strong>Apps</strong>
              {phase === 'docked' ? (
                <button type="button" className="nx-pinned-app-dock__customize" onClick={openExpanded}>
                  Customize
                </button>
              ) : (
                <button type="button" className="nx-pinned-app-dock__customize" onClick={openDocked}>
                  Done
                </button>
              )}
            </div>

            <div
              ref={trackRef}
              className={cls('nx-pinned-app-dock__track', dragOverId === 'track' && 'is-drop-target')}
              role="tablist"
              aria-label="Pinned applications"
              onDragOver={(event) => {
                if (!draggingId || dragSource !== 'catalog') return
                event.preventDefault()
                setDragOverId('track')
              }}
              onDragLeave={() => {
                if (dragOverId === 'track') setDragOverId(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (draggingId && dragSource === 'catalog') handleAddPin(draggingId)
                resetDragState()
              }}
            >
              {pinnedApps.map((app) => renderAppButton(app, { pinned: true, draggable: true }))}
              {phase === 'expanded' ? (
                <div className="nx-pinned-app-dock__drop-slot" aria-hidden>
                  Drag apps here
                </div>
              ) : null}
            </div>

            {phase === 'expanded' || (draggingId && dragSource === 'pinned') ? (
              <div
                className={cls('nx-pinned-app-dock__unpin-zone', dragOverId === 'unpin' && 'is-drop-target')}
                onDragOver={(event) => {
                  if (!draggingId || dragSource !== 'pinned') return
                  event.preventDefault()
                  setDragOverId('unpin')
                }}
                onDragLeave={() => {
                  if (dragOverId === 'unpin') setDragOverId(null)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (draggingId && dragSource === 'pinned') handleRemovePin(draggingId)
                  resetDragState()
                }}
              >
                <Icon name="close" size={12} />
                <span>Drag apps here to remove from dock</span>
              </div>
            ) : null}
          </div>

          <div
            className="nx-pinned-app-dock__sheet"
            aria-hidden={phase !== 'expanded'}
            onDragOver={(event) => {
              if (!draggingId || dragSource !== 'pinned') return
              event.preventDefault()
              setDragOverId('unpin')
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (draggingId && dragSource === 'pinned') handleRemovePin(draggingId)
              resetDragState()
            }}
          >
            {recentUnpinned.length ? (
              <section className="nx-pinned-app-dock__sheet-section">
                <h4>Recent</h4>
                <div className="nx-pinned-app-dock__sheet-grid">
                  {recentUnpinned.map((app) => renderAppButton(app, { catalog: true }))}
                </div>
              </section>
            ) : null}

            <section className="nx-pinned-app-dock__sheet-section">
              <h4>{draggingId && dragSource === 'pinned' ? 'Drop here to remove' : 'Drag into dock'}</h4>
              <div className="nx-pinned-app-dock__sheet-grid">
                {catalogApps.map((app) => renderAppButton(app, { catalog: true }))}
              </div>
            </section>
          </div>
        </div>
      </div>

      {launcherOpen ? (
        <AppLauncher
          routePath={routePath}
          onClose={() => setLauncherRoute(null)}
          onSelect={switchToRegistryApp}
        />
      ) : null}

      <MobileSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )

  return typeof document !== 'undefined' ? createPortal(dock, document.body) : null
}