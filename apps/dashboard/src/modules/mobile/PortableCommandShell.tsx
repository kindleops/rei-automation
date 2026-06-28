import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import { applyThemeToDOM, loadSettings, updateSetting, type AccentPalette } from '../../shared/settings'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { LeadCommandNotificationBell, LeadCommandNotificationCenter } from '../notifications/LeadCommandNotificationCenter'
import { getQueueProcessorHealth, type QueueProcessorHealth } from '../../lib/data/inboxData'
import { InboxKpiOrb } from '../inbox/components/InboxKpiOrb'
import { QueueCommandCenter, type QueueCommandMode, type QueueCommandCaps } from '../inbox/components/QueueCommandCenter'
import { CommandDrawer } from '../shell/primitives/CommandDrawer'
import { CommandPopover } from '../shell/primitives/CommandPopover'
import { useShellSurface } from '../shell/useShellSurface'
import { GLOBAL_COMMAND_OPEN_EVENT } from '../../domain/command-center/command.types'
import { useRoutePath } from '../../app/router'
import type { NexusGlobalThemeId } from '../../domain/theme/nexusThemes'

import { MOBILE_MORE_ROUTES } from './mobile-nav-routes'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const PRIMARY_APP_ROUTES = [
  { path: '/inbox', label: 'Inbox', icon: 'inbox' as const },
  { path: '/map', label: 'Map', icon: 'map' as const },
  { path: '/pipeline', label: 'Pipeline', icon: 'radar' as const },
]

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
  const queueTriggerRef = useRef<HTMLButtonElement | null>(null)
  const { activeSurface, toggleSurface, closeAndRestoreFocus, registerTrigger } = useShellSurface()
  const [notifOpen, setNotifOpen] = useState(false)
  const [workspaceSection, setWorkspaceSection] = useState<'apps' | 'appearance' | 'account'>('apps')
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
    registerTrigger('queue', queueTriggerRef.current)
  })

  const processorStatus = queueHealth?.status ?? 'unknown'
  const queueStatusIcon =
    processorStatus === 'healthy' ? 'check'
      : processorStatus === 'warning' ? 'alert'
        : processorStatus === 'critical' ? 'alert'
          : 'activity'

  const activeAppLabel = useMemo(() => {
    const primary = PRIMARY_APP_ROUTES.find((item) => item.path === routePath)
    if (primary) return primary.label
    const more = MOBILE_MORE_ROUTES.find((item) => item.path === routePath)
    return more?.label ?? 'NEXUS'
  }, [routePath])

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

  return (
    <header className="nx-topbar nx-topbar--nexus-shell nx-topbar--portable-shell is-mobile-shell">
      <div className="nx-topbar__left nx-topbar-shell-left nx-mobile-command-row">
        <div className="nx-topbar-shell-zone nx-topbar-shell-zone--controls">
          <div className="nx-topbar-orb-slot">
            <InboxKpiOrb />
          </div>

          <button
            ref={workspaceTriggerRef}
            type="button"
            className={cls('nx-topbar-view-button nx-topbar-workspace-compact nx-topbar-workspace-labeled', activeSurface === 'workspace' && 'is-active')}
            aria-expanded={activeSurface === 'workspace'}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              toggleSurface('workspace')
            }}
          >
            <strong><Icon name="layout-split" /></strong>
            <span className="nx-topbar-workspace-label">{activeAppLabel}</span>
          </button>

          <button
            ref={queueTriggerRef}
            type="button"
            className={cls(
              'nx-processor-button nx-processor-button--compact',
              `is-${processorStatus}`,
              activeSurface === 'queue' && 'is-active',
            )}
            aria-expanded={activeSurface === 'queue'}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              toggleSurface('queue')
            }}
            title="Queue operational intelligence"
          >
            <span className={cls('nx-queue-indicator', `is-${processorStatus}`)}>
              <Icon name={queueStatusIcon} />
              {processorStatus === 'healthy' ? <i className="nx-queue-indicator-dot" /> : null}
            </span>
          </button>

          <CommandPopover
            open={activeSurface === 'queue'}
            anchorRef={queueTriggerRef}
            onClose={() => closeAndRestoreFocus('queue')}
            className="nx-liquid-popover nx-liquid-popover--processor"
            placement="bottom-start"
            width="min(380px, calc(100vw - 24px))"
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
          </CommandPopover>
        </div>
      </div>

      <div className="nx-topbar__actions nx-topbar-shell-zone nx-topbar-shell-zone--operators nx-mobile-action-row">
        <button
          type="button"
          className="nx-notification-button nx-mobile-search-toggle"
          title="Universal search"
          onClick={openSearch}
        >
          <Icon name="search" />
        </button>

        <button
          type="button"
          className="nx-notification-button"
          title="Tasks"
          onClick={() => pushRoutePath('/inbox')}
        >
          <Icon name="check" />
        </button>

        <button
          type="button"
          className="nx-notification-button"
          title="Live Activity"
          onClick={() => pushRoutePath('/inbox')}
        >
          <Icon name="activity" />
        </button>

        <LeadCommandNotificationBell
          unreadCount={unreadCount}
          active={notifOpen}
          onClick={() => setNotifOpen((open) => !open)}
        />
      </div>

      <CommandDrawer
        open={activeSurface === 'workspace'}
        title="Workspace"
        onClose={() => closeAndRestoreFocus('workspace')}
        fullWidth
      >
        <nav className="nx-portable-wsl-nav" aria-label="Workspace sections">
          {(['apps', 'appearance', 'account'] as const).map((section) => (
            <button
              key={section}
              type="button"
              className={cls('nx-wsl-nav__item', workspaceSection === section && 'is-active')}
              onClick={() => setWorkspaceSection(section)}
            >
              {section === 'apps' ? 'Applications' : section === 'appearance' ? 'Appearance' : 'Account'}
            </button>
          ))}
        </nav>

        {workspaceSection === 'apps' ? (
          <div className="nx-wsl-panel__section">
            {PRIMARY_APP_ROUTES.map((item) => (
              <button
                key={item.path}
                type="button"
                className={cls('nx-wsl-menu-row', routePath === item.path && 'is-active')}
                onClick={() => { pushRoutePath(item.path); closeAndRestoreFocus('workspace') }}
              >
                <Icon name={item.icon} size={14} />
                <strong>{item.label}</strong>
              </button>
            ))}
            <h4>More Surfaces</h4>
            {MOBILE_MORE_ROUTES.filter((item) => item.path !== '__settings__').map((item) => (
              <button
                key={item.path}
                type="button"
                className={cls('nx-wsl-menu-row', routePath === item.path && 'is-active')}
                onClick={() => { pushRoutePath(item.path); closeAndRestoreFocus('workspace') }}
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
                </button>
              ))}
            </div>
          </>
        ) : null}

        {workspaceSection === 'account' ? (
          <div className="nx-wsl-panel__section">
            <h4>Account</h4>
            <button type="button" className="nx-wsl-menu-row" onClick={() => { pushRoutePath('/analytics'); closeAndRestoreFocus('workspace') }}>
              <Icon name="stats" size={14} />
              <strong>Theme &amp; KPI Settings</strong>
            </button>
            <button type="button" className="nx-wsl-menu-row" onClick={() => { pushRoutePath('/inbox'); closeAndRestoreFocus('workspace') }}>
              <Icon name="settings" size={14} />
              <strong>Workspace Preferences</strong>
            </button>
          </div>
        ) : null}
      </CommandDrawer>

      <LeadCommandNotificationCenter
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        anchorTop={0}
      />
    </header>
  )
}