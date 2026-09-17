import { useEffect, useState } from 'react'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { MobileNotificationCenter } from '../notifications/MobileNotificationCenter'
import { InboxKpiOrb } from '../inbox/components/InboxKpiOrb'
import { MobileQueueSurface } from './MobileQueueSurface'
import { useQueueCommandState } from './useQueueCommandState'
import { onNotificationsSurfaceRequested, requestAppLauncher } from './shell-surface-bridge'
import { useShellSurface } from '../shell/useShellSurface'
import { GLOBAL_COMMAND_OPEN_EVENT } from '../../domain/command-center/command.types'
import { MobileCommandDock, type DockSurface } from './MobileCommandDock'

/**
 * The mobile top bar for every route OUTSIDE the inbox family.
 *
 * It used to carry its own copy of the application list and its own theme/accent
 * pickers — a second launcher with a Settings row that navigated to /analytics. Both
 * now live in one place: the App Launcher renders the canonical registry, and Settings
 * opens MobileSettingsSheet, which is the real settings surface.
 */

interface PortableCommandShellProps {
  onOpenSearch?: () => void
}

export const PortableCommandShell = ({ onOpenSearch }: PortableCommandShellProps) => {
  const { activeSurface, toggleSurface, closeAndRestoreFocus, setActiveSurface } = useShellSurface()
  const [notifOpen, setNotifOpen] = useState(false)
  const queueState = useQueueCommandState()
  const { unreadCount } = useNotificationIntelligence()

  // The App Launcher lives in the dock; the notification centre lives here. One owner
  // per surface, raised by event — see shell-surface-bridge.
  useEffect(() => onNotificationsSurfaceRequested(() => {
    setActiveSurface(null)
    setNotifOpen(true)
  }), [setActiveSurface])

  const processorStatus = queueState.health?.status ?? 'unknown'

  const openSearch = () => {
    if (onOpenSearch) onOpenSearch()
    else window.dispatchEvent(new CustomEvent(GLOBAL_COMMAND_OPEN_EVENT, { detail: {} }))
  }

  const resolveDockSurface = (): DockSurface => {
    if (activeSurface === 'workspace') return 'workspace'
    if (activeSurface === 'queue') return 'queue'
    if (notifOpen) return 'notifications'
    return null
  }

  const handleDockSurfaceChange = (surface: DockSurface) => {
    if (surface === null) {
      setActiveSurface(null)
      setNotifOpen(false)
      return
    }
    if (surface === 'search') {
      openSearch()
      return
    }
    if (surface === 'workspace') {
      // The canonical App Launcher, not the duplicate application list this shell
      // used to carry. That list was a second registry rendering and its Settings row
      // navigated to /analytics — a straightforwardly wrong destination.
      setNotifOpen(false)
      setActiveSurface(null)
      requestAppLauncher()
      return
    }
    if (surface === 'queue') {
      setNotifOpen(false)
      toggleSurface('queue')
      return
    }
    if (surface === 'notifications') {
      setActiveSurface(null)
      setNotifOpen((open) => !open)
    }
  }

  return (
    <>
      {/*
        showTasks / showActivity are false here because this shell has no attention
        queue and no activity feed to open. Both buttons used to render and then
        silently push /inbox — a control that does not do what its icon says is worse
        than an absent one. The inbox top bar, which HAS both, still shows them.
      */}
      <MobileCommandDock
        activeSurface={resolveDockSurface()}
        onSurfaceChange={handleDockSurfaceChange}
        kpiControl={<InboxKpiOrb />}
        workspaceActive={activeSurface === 'workspace'}
        queueStatus={processorStatus}
        notificationCount={unreadCount}
        notificationsActive={notifOpen}
        showTasks={false}
        showActivity={false}
      />

      {/*
        Q, as a work surface rather than the desktop control board in a half sheet.
        QueueCommandCenter stays the DESKTOP panel; what it was doing here was
        rendering a mode selector, six editable cap fields and ten action buttons
        into 52vh of a 390px screen, with every write target wired to
        pushRoutePath('/queue') anyway — so nothing here could actually act.
      */}
      <MobileQueueSurface
        open={activeSurface === 'queue'}
        onClose={() => closeAndRestoreFocus('queue')}
        health={queueState.health}
        control={queueState.control}
        mode={queueState.mode}
        caps={queueState.caps}
        capsHydrated={queueState.hydrated}
        loading={queueState.loading}
        onRefresh={queueState.refresh}
      />

      <MobileNotificationCenter open={notifOpen} onClose={() => setNotifOpen(false)} />
    </>
  )
}