import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { CommandResult, GlobalCommandSearchContext } from '../../domain/command-center/command.types'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { useAuth } from '../../components/auth/AuthProvider'
import { LeadCommandNotificationCenter } from '../notifications/LeadCommandNotificationCenter'
import { InboxKpiOrb } from '../inbox/components/InboxKpiOrb'
import { InboxActivityPanel } from '../inbox/components/InboxActivityPanel'
import { openInboxThread } from '../mobile/mobile-inbox-bridge'
import { onNotificationsSurfaceRequested } from '../mobile/shell-surface-bridge'
import { useQueueCommandState } from '../mobile/useQueueCommandState'
import { DesktopSidebar } from './DesktopSidebar'
import { DesktopCommandBar } from './DesktopCommandBar'
import { DesktopQueuePanel, queueLabel, queueTone } from './DesktopQueuePanel'
import { DesktopProfilePanel, operatorInitials } from './DesktopProfilePanel'
import { useDesktopShellPrefs } from './desktop-shell-prefs'
import { DesktopLayoutPanel } from './DesktopLayoutPanel'
import { useDisplayMode } from './display-mode'
import { applyLayout, getSplitState, useSplitWorkspace } from './split-workspace'
import './desktop-shell.css'

/**
 * THE DESKTOP COMMAND CENTER — the chrome around every modern surface on a
 * wide screen. A collapsible Liquid Glass sidebar holds the product; the top
 * bar holds only what spans it: one command search, the KPI, notifications,
 * live activity, the queue, and the operator's profile (theme, accent, glass,
 * sound). Every control reads the same stores the phone shell reads.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Panel = 'notifications' | 'activity' | 'queue' | 'profile' | 'layout' | null

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
  const split = useSplitWorkspace()
  const { ultrawide } = useDisplayMode()
  const queue = useQueueCommandState()
  const { unreadCount } = useNotificationIntelligence()
  const { user, signOut } = useAuth()
  const email = user?.email ?? null
  const name = (user?.user_metadata?.full_name as string | undefined) || null

  const toggle = useCallback((p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p)), [])

  // The sidebar width drives the content inset; published on <html> so every
  // surface (and fixed-position layer) can clear it.
  useEffect(() => {
    document.documentElement.classList.toggle('is-dsk-side-collapsed', prefs.collapsed)
    return () => document.documentElement.classList.remove('is-dsk-side-collapsed')
  }, [prefs.collapsed])

  // A 49" 32:9 panel: wider chrome, and — the first time — four full apps side by side.
  useEffect(() => {
    document.documentElement.classList.toggle('is-ultrawide', ultrawide)
    if (ultrawide && getSplitState().panes.length === 0) {
      let seeded = false
      try { seeded = localStorage.getItem(ULTRAWIDE_SEEDED) === '1' } catch { /* ignore */ }
      if (!seeded) {
        applyLayout(['/map', '/pipeline', '/deal-intelligence'])
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
      <DesktopSidebar
        routePath={routePath}
        status={{ tone, label: queueLabel(queue), detail: queue.health ? `${(queue.health.sentTodayCount ?? 0).toLocaleString()} sent today` : undefined }}
        onOpenSettings={() => setPanel('profile')}
      />

      <header className="dsk-top" aria-label="Command bar">
        <div className="dsk-top__glass">
          <span className="dsk-top__liquid" aria-hidden><i /><i /></span>
          <DesktopCommandBar
            open={searchOpen}
            initialQuery={searchQuery}
            context={commandContext}
            onOpen={onSearchOpen}
            onClose={onSearchClose}
            onExecute={onExecute}
          />
          <div className="dsk-top__actions">
            <button
              type="button"
              className={cls('dsk-top__btn dsk-top__btn--layout', panel === 'layout' && 'is-active', split.panes.length > 0 && 'is-split')}
              onClick={() => toggle('layout')}
              aria-label={`Split screen — ${split.panes.length + 1} open`}
              aria-expanded={panel === 'layout'}
              data-tip="Split screen"
            >
              <span className={cls('dsk-top__panes', `is-${split.panes.length + 1}`)} aria-hidden>{Array.from({ length: split.panes.length + 1 }, (_, k) => <i key={k} />)}</span>
            </button>
            <span className="dsk-top__sep" aria-hidden />
            <div className="dsk-top__kpi" title="Performance KPI"><InboxKpiOrb /></div>
            <button
              type="button"
              className={cls('dsk-top__btn', panel === 'notifications' && 'is-active')}
              onClick={() => toggle('notifications')}
              aria-label={unreadCount ? `Notifications — ${unreadCount} unread` : 'Notifications'}
              aria-expanded={panel === 'notifications'}
              data-tip="Notifications"
            >
              <Icon name="bell" size={17} strokeWidth={1.7} />
              {unreadCount > 0 ? <span className="dsk-top__badge">{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
            </button>
            <button
              type="button"
              className={cls('dsk-top__btn dsk-top__btn--live', panel === 'activity' && 'is-active')}
              onClick={() => toggle('activity')}
              aria-label="Live activity"
              aria-expanded={panel === 'activity'}
              data-tip="Live activity"
            >
              <Icon name="activity" size={17} strokeWidth={1.7} />
              <span className="dsk-top__live" aria-hidden />
            </button>
            <button
              type="button"
              className={cls('dsk-top__btn dsk-top__btn--queue', `is-${tone}`, panel === 'queue' && 'is-active')}
              onClick={() => toggle('queue')}
              aria-label={`Queue — ${queueLabel(queue)}`}
              aria-expanded={panel === 'queue'}
              data-tip={queueLabel(queue)}
            >
              <span className="dsk-top__q" aria-hidden>Q</span>
              {failed > 0 ? <span className="dsk-top__badge is-warn">{failed > 99 ? '99+' : failed}</span> : null}
            </button>
            <span className="dsk-top__sep" aria-hidden />
            <button
              type="button"
              className={cls('dsk-top__profile', panel === 'profile' && 'is-active')}
              onClick={() => toggle('profile')}
              aria-label="Profile and system settings"
              aria-expanded={panel === 'profile'}
            >
              <span className="dsk-top__avatar">{operatorInitials(email, name)}</span>
              <Icon name="chevron-down" size={12} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </header>

      {panel === 'queue' ? <div className="dsk-anchor dsk-anchor--right"><DesktopQueuePanel queue={queue} onClose={() => setPanel(null)} /></div> : null}
      {panel === 'layout' ? <div className="dsk-anchor dsk-anchor--right"><DesktopLayoutPanel mainPath={`${routePath}${typeof window === 'undefined' ? '' : window.location.search}`} onClose={() => setPanel(null)} /></div> : null}
      {panel === 'profile' ? (
        <div className="dsk-anchor dsk-anchor--right">
          <DesktopProfilePanel email={email} name={name} onClose={() => setPanel(null)} onSignOut={() => { setPanel(null); void signOut() }} />
        </div>
      ) : null}
      {panel === 'activity' ? (
        <div className="dsk-activity">
          <InboxActivityPanel
            onClose={() => setPanel(null)}
            onViewThread={(threadKey) => { setPanel(null); openInboxThread({ threadKey }) }}
          />
        </div>
      ) : null}
      <LeadCommandNotificationCenter open={panel === 'notifications'} onClose={() => setPanel(null)} anchorTop={84} />
      {panel && panel !== 'notifications' && panel !== 'activity' ? <button type="button" className="dsk-scrim" aria-label="Close" onClick={() => setPanel(null)} /> : null}
    </>
  )
}
