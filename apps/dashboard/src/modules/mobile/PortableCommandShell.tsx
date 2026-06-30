import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pushRoutePath, useRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import { applyThemeToDOM, loadSettings, updateSetting, type AccentPalette } from '../../shared/settings'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { LeadCommandNotificationCenter } from '../notifications/LeadCommandNotificationCenter'
import { getQueueProcessorHealth, type QueueProcessorHealth } from '../../lib/data/inboxData'
import { InboxKpiOrb } from '../inbox/components/InboxKpiOrb'
import { QueueCommandCenter, type QueueCommandMode, type QueueCommandCaps } from '../inbox/components/QueueCommandCenter'
import { useShellSurface } from '../shell/useShellSurface'
import { GLOBAL_COMMAND_OPEN_EVENT } from '../../domain/command-center/command.types'
import type { NexusGlobalThemeId } from '../../domain/theme/nexusThemes'
import { COMMAND_NAV_ROUTES, isCommandNavRouteActive } from './command-navigation-registry'
import { openInboxDealIntelligence } from './mobile-inbox-bridge'
import { MobileCommandDock, type DockSurface } from './MobileCommandDock'
import { MobileSheet } from './MobileSheet'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const THEME_OPTIONS: Array<{ id: NexusGlobalThemeId; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'red_ops', label: 'Red Ops' },
  { id: 'light', label: 'Light' },
]

const ACCENT_OPTIONS: Array<{ id: AccentPalette; label: string }> = [
  { id: 'cyan', label: 'Cyan' },
  { id: 'blue', label: 'Blue' },
  { id: 'teal', label: 'Teal' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
  { id: 'violet', label: 'Violet' },
]

interface PortableCommandShellProps {
  onOpenSearch?: () => void
}

export const PortableCommandShell = ({ onOpenSearch }: PortableCommandShellProps) => {
  const routePath = useRoutePath()
  const workspaceTriggerRef = useRef<HTMLButtonElement | null>(null)
  const { activeSurface, toggleSurface, closeAndRestoreFocus, registerTrigger, setActiveSurface } = useShellSurface()
  const [notifOpen, setNotifOpen] = useState(false)
  const [workspaceSection, setWorkspaceSection] = useState<'apps' | 'appearance'>('apps')
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [queueHealth, setQueueHealth] = useState<QueueProcessorHealth | null>(null)
  const [queueLoading, setQueueLoading] = useState(false)
  const { unreadCount } = useNotificationIntelligence()

  const settings = loadSettings()
  const activeThemeId = (settings.nexusTheme ?? 'dark') as NexusGlobalThemeId
  const activeAccentId = (settings.accentPalette ?? 'cyan') as AccentPalette

  const refreshQueueHealth = useCallback(async () => {
    setQueueLoading(true)
    try {
      setQueueHealth(await getQueueProcessorHealth())
    } catch {
      setQueueHealth(null)
    } finally {
      setQueueLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshQueueHealth()
    const interval = window.setInterval(() => { void refreshQueueHealth() }, 60_000)
    return () => window.clearInterval(interval)
  }, [refreshQueueHealth])

  useEffect(() => {
    registerTrigger('workspace', workspaceTriggerRef.current)
  })

  useEffect(() => {
    if (activeSurface !== 'workspace') setWorkspaceQuery('')
  }, [activeSurface])

  const processorStatus = queueHealth?.status ?? 'unknown'

  const openSearch = () => {
    if (onOpenSearch) onOpenSearch()
    else window.dispatchEvent(new CustomEvent(GLOBAL_COMMAND_OPEN_EVENT, { detail: {} }))
  }

  const queueMode: QueueCommandMode = 'assisted'
  const queueCaps: QueueCommandCaps = {
    sends_per_run: 25,
    auto_replies_per_run: 10,
    followups_per_run: 10,
    first_touches_per_run: 10,
    max_per_number_per_day: 200,
    max_per_market_per_hour: 60,
  }

  const resolveDockSurface = (): DockSurface => {
    if (activeSurface === 'workspace') return 'workspace'
    if (activeSurface === 'queue') return 'queue'
    if (notifOpen) return 'notifications'
    return null
  }

  const filteredApplications = useMemo(() => {
    const q = workspaceQuery.trim().toLowerCase()
    if (!q) return COMMAND_NAV_ROUTES
    return COMMAND_NAV_ROUTES.filter((item) =>
      `${item.label} ${item.description ?? ''}`.toLowerCase().includes(q),
    )
  }, [workspaceQuery])

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
      setNotifOpen(false)
      toggleSurface('workspace')
      return
    }
    if (surface === 'queue') {
      setNotifOpen(false)
      toggleSurface('queue')
      return
    }
    if (surface === 'tasks') {
      pushRoutePath('/inbox')
      return
    }
    if (surface === 'activity') {
      pushRoutePath('/inbox')
      return
    }
    if (surface === 'notifications') {
      setActiveSurface(null)
      setNotifOpen((open) => !open)
    }
  }

  return (
    <>
      <span ref={workspaceTriggerRef} className="nx-sr-only" aria-hidden />

      <MobileCommandDock
        activeSurface={resolveDockSurface()}
        onSurfaceChange={handleDockSurfaceChange}
        kpiControl={<InboxKpiOrb />}
        workspaceActive={activeSurface === 'workspace'}
        queueStatus={processorStatus}
        notificationCount={unreadCount}
        notificationsActive={notifOpen}
      />

      <MobileSheet
        open={activeSurface === 'workspace'}
        title="Workspace Launcher"
        height="full"
        className="is-mobile-wsl"
        onClose={() => closeAndRestoreFocus('workspace')}
      >
        <div className="nx-wsl-root">
          <div className="nx-wsl-search">
            <Icon name="search" />
            <input
              type="search"
              value={workspaceQuery}
              placeholder="Search applications…"
              aria-label="Search applications"
              onChange={(event) => setWorkspaceQuery(event.target.value)}
            />
          </div>
          <div className="nx-wsl-body is-mobile-shell">
            <nav className="nx-wsl-nav" aria-label="Workspace launcher categories">
              {(['apps', 'appearance'] as const).map((section) => (
                <button
                  key={section}
                  type="button"
                  className={cls('nx-wsl-nav__item', workspaceSection === section && 'is-active')}
                  onClick={() => setWorkspaceSection(section)}
                >
                  {section === 'apps' ? 'Applications' : 'Appearance'}
                </button>
              ))}
            </nav>
            <div className="nx-wsl-panel">
              {workspaceSection === 'apps' ? (
                <div className="nx-wsl-panel__section">
                  <h4>Applications</h4>
                  {filteredApplications.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className={cls('nx-wsl-menu-row', isCommandNavRouteActive(routePath, item) && 'is-active')}
                      onClick={() => {
                        if (item.action === 'notifications') setNotifOpen(true)
                        else if (item.action === 'settings') pushRoutePath('/analytics')
                        else if (item.action === 'deal_intelligence') openInboxDealIntelligence()
                        else pushRoutePath(item.path)
                        closeAndRestoreFocus('workspace')
                      }}
                    >
                      <Icon name={item.icon} size={14} />
                      <strong>{item.label}</strong>
                      {item.description ? <small>{item.description}</small> : null}
                    </button>
                  ))}
                </div>
              ) : null}

              {workspaceSection === 'appearance' ? (
                <>
                  <div className="nx-wsl-panel__section">
                    <h4>Theme</h4>
                    {THEME_OPTIONS.map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        className={cls('nx-wsl-menu-row', activeThemeId === theme.id && 'is-active')}
                        onClick={() => {
                          updateSetting('nexusTheme', theme.id)
                          applyThemeToDOM()
                        }}
                      >
                        <span className="nx-theme-dot" data-theme={theme.id} />
                        <strong>{theme.label}</strong>
                        {activeThemeId === theme.id ? (
                          <span className="nx-wsl-menu-row__check" aria-hidden>
                            <Icon name="check" size={14} />
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                  <div className="nx-wsl-panel__section nx-wsl-panel__section--accents">
                    <h4>Accent Palette</h4>
                    {ACCENT_OPTIONS.map((accent) => (
                      <button
                        key={accent.id}
                        type="button"
                        className={cls('nx-wsl-menu-row', activeAccentId === accent.id && 'is-active')}
                        onClick={() => {
                          updateSetting('accentPalette', accent.id)
                          applyThemeToDOM()
                        }}
                      >
                        <span className="nx-accent-dot" data-accent={accent.id} />
                        <strong>{accent.label}</strong>
                        {activeAccentId === accent.id ? (
                          <span className="nx-wsl-menu-row__check" aria-hidden>
                            <Icon name="check" size={14} />
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </MobileSheet>

      <MobileSheet
        open={activeSurface === 'queue'}
        title="Queue Intelligence"
        height="half"
        onClose={() => closeAndRestoreFocus('queue')}
      >
        <QueueCommandCenter
          health={queueHealth}
          control={null}
          loading={queueLoading}
          mode={queueMode}
          caps={queueCaps}
          actionLoading={null}
          onModeChange={() => {}}
          onCapsChange={() => {}}
          onRefresh={() => { void refreshQueueHealth() }}
          onRunSafeBatch={() => pushRoutePath('/queue')}
          onQueueMore={() => pushRoutePath('/queue')}
          onRunQueueNow={() => pushRoutePath('/queue')}
          onEmergencyPause={() => pushRoutePath('/queue')}
          onReprocessPaused={() => pushRoutePath('/queue')}
          onRetryFailed={() => pushRoutePath('/queue')}
          onReconcileDelivery={() => pushRoutePath('/queue')}
          onCancelStaleFollowUps={() => pushRoutePath('/queue')}
          onClose={() => closeAndRestoreFocus('queue')}
        />
      </MobileSheet>

      <LeadCommandNotificationCenter
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        mobileSheet
      />
    </>
  )
}