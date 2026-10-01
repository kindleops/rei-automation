import { useCallback, useEffect, useState } from 'react'
import type { CommandResult, GlobalCommandSearchContext } from '../../domain/command-center/command.types'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { useAuth } from '../../components/auth/AuthProvider'
import { LeadCommandNotificationCenter } from '../notifications/LeadCommandNotificationCenter'
import { onNotificationsSurfaceRequested } from '../mobile/shell-surface-bridge'
import { useQueueCommandState } from '../mobile/useQueueCommandState'
import { DesktopSidebar } from './DesktopSidebar'
import { CommandDeck } from './deck/CommandDeck'
import { queueLabel, queueTone } from './DesktopQueuePanel'
import { DesktopProfilePanel, operatorInitials } from './DesktopProfilePanel'
import { useDesktopShellPrefs } from './desktop-shell-prefs'
import { useDisplayMode } from './display-mode'
import * as L from './workspace/layout'
import { getWorkspace, markPaneInteraction, openApp } from './workspace/workspace-store'
import { pushRoutePath } from '../../app/router'
import './desktop-shell.css'
import './desktop-calm.css'
import './desktop-backdrop.css'
import { DesktopBackdrop } from './DesktopBackdrop'
import { UniversalInspector } from './inspector/UniversalInspector'
import { TimeMachine } from './replay/TimeMachine'
import { openInspector } from './inspector/inspector-store'

// DEV: inspect any object from the console — window.__lcInspect({ type: 'property', id: '…' })
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __lcInspect?: typeof openInspector }).__lcInspect = openInspector

/**
 * THE DESKTOP SHELL — three surfaces frame the OS: the Command Rail (what
 * exists and what is happening), the Command Deck (where am I, what do I want
 * to command) and the Workspace (the applications in use). Every control reads
 * the same stores the phone shell reads.
 */

type Panel = 'notifications' | 'profile' | null

const ULTRAWIDE_SEEDED = 'nexus.desktop.ultrawide.seeded'

export interface DesktopCommandShellProps {
  routePath: string
  searchOpen: boolean
  searchQuery: string
  commandContext: GlobalCommandSearchContext
  onSearchOpen: () => void
  onSearchClose: () => void
  onExecute: (result: CommandResult) => void
}

export function DesktopCommandShell({ routePath, searchOpen, searchQuery, commandContext, onSearchOpen, onSearchClose, onExecute }: DesktopCommandShellProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const [prefs] = useDesktopShellPrefs()
  const { ultrawide } = useDisplayMode()
  const queue = useQueueCommandState()
  const { unreadCount } = useNotificationIntelligence()
  const { user, signOut } = useAuth()
  const email = user?.email ?? null
  const name = (user?.user_metadata?.full_name as string | undefined) || null

  const toggle = useCallback((p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p)), [])

  // Settings is a page on the desktop; it opens in whichever pane has focus.
  const openSettings = useCallback(() => {
    setPanel(null)
    onSearchClose()
    markPaneInteraction(getWorkspace().layout.focus)
    pushRoutePath('/settings')
  }, [onSearchClose])

  // ⌘, — the platform's own settings chord.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ',') { e.preventDefault(); openSettings() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSettings])

  // The sidebar width drives the content inset; published on <html> so every
  // surface (and fixed-position layer) can clear it.
  useEffect(() => {
    document.documentElement.classList.toggle('is-dsk-side-collapsed', prefs.collapsed)
    return () => document.documentElement.classList.remove('is-dsk-side-collapsed')
  }, [prefs.collapsed])

  // A 49" 32:9 panel: wider chrome, and — the first time — four full apps side by side.
  useEffect(() => {
    document.documentElement.classList.toggle('is-ultrawide', ultrawide)
    if (ultrawide && L.panes(getWorkspace().layout.root).length === 1) {
      let seeded = false
      try { seeded = localStorage.getItem(ULTRAWIDE_SEEDED) === '1' } catch { /* ignore */ }
      if (!seeded) {
        for (const path of ['/map', '/pipeline', '/deal-intelligence']) openApp(path, 'beside')
        try { localStorage.setItem(ULTRAWIDE_SEEDED, '1') } catch { /* ignore */ }
      }
    }
    return () => document.documentElement.classList.remove('is-ultrawide')
  }, [ultrawide])

  // Other surfaces ask for the notification centre by event (the phone shell's bridge).
  useEffect(() => onNotificationsSurfaceRequested(() => setPanel('notifications')), [])

  // A route change closes transient panels.
  useEffect(() => { setPanel(null) }, [routePath])

  useEffect(() => {
    if (!panel) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel])

  const tone = queueTone(queue)
  const failed = queue.health?.failedTodayCount ?? 0

  return (
    <>
      <DesktopBackdrop />
      <DesktopSidebar
        routePath={routePath}
        status={{ tone, label: queueLabel(queue), detail: queue.health ? `${(queue.health.sentTodayCount ?? 0).toLocaleString()} sent today` : undefined }}
        queueFailedToday={queue.health ? failed : null}
        onOpenSettings={openSettings}
      />

      <CommandDeck
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        commandContext={commandContext}
        onSearchOpen={onSearchOpen}
        onSearchClose={onSearchClose}
        onExecute={onExecute}
        notificationsOpen={panel === 'notifications'}
        onToggleNotifications={() => toggle('notifications')}
        unreadCount={unreadCount}
        profileOpen={panel === 'profile'}
        onToggleProfile={() => toggle('profile')}
        initials={operatorInitials(email, name)}
      />

      {panel === 'profile' ? (
        <div className="dsk-anchor dsk-anchor--right">
          <DesktopProfilePanel email={email} name={name} onClose={() => setPanel(null)} onSignOut={() => { setPanel(null); void signOut() }} onOpenSettings={openSettings} />
        </div>
      ) : null}
      <LeadCommandNotificationCenter open={panel === 'notifications'} onClose={() => setPanel(null)} anchorTop={84} />
      <UniversalInspector />
      <TimeMachine />
      {panel === 'profile' ? <button type="button" className="dsk-scrim" aria-label="Close" onClick={() => setPanel(null)} /> : null}
    </>
  )
}
