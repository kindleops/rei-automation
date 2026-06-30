import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import { captureAppSession, resolveAppIdFromRoute, restoreAppSession } from './app-session-cache'
import { isCommandNavRouteActive, type CommandNavRoute } from './command-navigation-registry'
import { openInboxDealIntelligence } from './mobile-inbox-bridge'
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

const navigateToApp = (app: CommandNavRoute) => {
  if (app.action === 'deal_intelligence') {
    openInboxDealIntelligence()
    return
  }
  pushRoutePath(app.path)
}

export const PinnedAppDock = ({ routePath }: PinnedAppDockProps) => {
  const badges = usePinnedAppDockBadges()
  const [dockSettings, persistDockSettings] = usePinnedAppDockSettings()
  const [phase, setPhase] = useState<PinnedAppDockPhase>('collapsed')
  const [draggingId, setDraggingId] = useState<PinnedAppId | null>(null)
  const [dragSource, setDragSource] = useState<'pinned' | 'catalog' | null>(null)
  const [dragOverId, setDragOverId] = useState<PinnedAppId | 'track' | 'unpin' | null>(null)
  const [hint, setHint] = useState<string | null>(null)

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

  const switchToApp = useCallback((app: CommandNavRoute) => {
    captureAppSession(activeAppId)
    navigateToApp(app)
    persistDockSettings((current) => recordRecentApp(current, app.path))
    collapse()
  }, [activeAppId, collapse, persistDockSettings])

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
    </>
  )

  return typeof document !== 'undefined' ? createPortal(dock, document.body) : null
}