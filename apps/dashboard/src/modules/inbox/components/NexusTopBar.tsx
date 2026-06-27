import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import type { AccentPalette } from '../../../shared/settings'
import type { CommandResult } from '../../../domain/command-center/command.types'
import type { ActiveOverlay } from '../../../domain/inbox/inbox-layout-state'
import type { NexusGlobalThemeId } from '../../../domain/theme/nexusThemes'
import type { ViewWidthPercent } from '../../../domain/inbox/view-layout'
import { useNotificationIntelligence } from '../../../domain/notifications/useNotificationIntelligence'
import { LeadCommandNotificationBell, LeadCommandNotificationCenter } from '../../notifications/LeadCommandNotificationCenter'
import type { AutonomousEngineModel } from '../autonomy-engine'
import { InboxKpiOrb } from './InboxKpiOrb'
import { QueueCommandCenter, type CampaignControlDiagnostics, type QueueCommandCaps, type QueueCommandMode } from './QueueCommandCenter'
import { ActionCenter } from '../../shell/ActionCenter'
import { ProfileMenu } from '../../shell/ProfileMenu'
import { WorkspaceLauncher } from '../../shell/WorkspaceLauncher'
import { useShellSurface } from '../../shell/useShellSurface'
import type { ActionCenterItem, WorkspaceAvailability, WorkspaceLauncherItem } from '../../shell/shell-types'
import { CommandPopover } from '../../shell/primitives/CommandPopover'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export interface ActionCenterCounts {
  humanReview?: number | null
  followUps?: number | null
  failedSends?: number | null
  decisionsRequired?: number | null
  closingTasks?: number | null
  systemTasks?: number | null
  loading?: boolean
}

interface NexusTopBarProps {
  onSelectSearchResult: (id: string) => void
  topSearchQuery: string
  onTopSearchQueryChange: (value: string) => void
  topSearchGroups: Array<{ key: string; label: string; items: CommandResult[] }>
  topSearchLoading: boolean
  onExecuteTopSearchResult: (result: CommandResult) => void
  selectedThread: InboxWorkflowThread | null
  isSuppressed: boolean
  notificationCount: number
  queueProcessorHealth: QueueProcessorHealth | null
  queueControlDiagnostics?: CampaignControlDiagnostics | null
  queueProcessorHealthLoading: boolean
  onRefreshQueueHealth?: () => void
  queueCommandMode: QueueCommandMode
  queueCommandCaps: QueueCommandCaps
  queueCommandActionLoading: string | null
  onQueueCommandModeChange: (mode: QueueCommandMode) => void
  onQueueCommandCapsChange: (patch: Partial<QueueCommandCaps>) => void
  onRunSafeBatch: () => void
  onQueueMore: () => void
  onRunQueueNow: () => void
  onEmergencyPause: () => void
  onReprocessPaused: (ids?: string[]) => void
  onRetryFailed: () => void
  onReconcileDelivery: () => void
  onCancelStaleFollowUps: () => void
  autonomyModel: AutonomousEngineModel
  activeWorkspaceKey?: string
  activeWorkspaceLabel?: string
  contextSubtitle?: string
  activeViewKey?: string
  activeViewKeys?: string[]
  activeViewChips?: Array<{ key: string; label: string }>
  onToggleActiveViewChip?: (viewKey: string) => void
  activeThemeId: NexusGlobalThemeId
  activeAccentId: AccentPalette
  workspaceOptions?: Array<{ key: string; label: string; description?: string; statusLabel?: string }>
  onSelectWorkspace?: (workspaceKey: string) => void
  viewOptions?: Array<{ key: string; label: string; description?: string; statusLabel?: string }>
  onSelectView?: (viewKey: string) => void
  activeViewWidths?: Partial<Record<string, ViewWidthPercent>>
  onSelectViewWidth?: (viewKey: string, width: ViewWidthPercent) => void
  onSelectTheme: (themeId: NexusGlobalThemeId) => void
  onSelectAccent: (accent: AccentPalette) => void
  onSaveCurrentLayout?: () => void
  onWorkspaceSettings?: () => void
  activeOverlay: ActiveOverlay
  onOpenOverlay: (overlay: ActiveOverlay) => void
  onCloseOverlay: () => void
  onOpenMap: () => void
  onOpenDossier: () => void
  onOpenAi: () => void
  onOpenKeys: () => void
  onOpenKpis: () => void
  onOpenActivity: () => void
  onOpenTasks: () => void
  onOpenSettings?: () => void
  onResetLayout: () => void
  dryRun: boolean
  onToggleDryRun: () => void
  actionCenterCounts?: ActionCenterCounts
  onNavigateInboxView?: (view: string) => void
  onOpenQueueCommand?: () => void
  authReady?: boolean
  authLoading?: boolean
  onSignOut?: () => void
  profileInitials?: string
}

const toAvailability = (statusLabel?: string): WorkspaceAvailability | undefined => {
  if (!statusLabel) return 'ready'
  const normalized = statusLabel.toLowerCase()
  if (normalized.includes('backend')) return 'backend_not_ready'
  if (normalized.includes('coming')) return 'coming_soon'
  return 'ready'
}

export const NexusTopBar = ({
  queueProcessorHealth,
  queueControlDiagnostics,
  queueProcessorHealthLoading,
  onRefreshQueueHealth,
  queueCommandMode,
  queueCommandCaps,
  queueCommandActionLoading,
  onQueueCommandModeChange,
  onQueueCommandCapsChange,
  onRunSafeBatch,
  onQueueMore,
  onRunQueueNow,
  onEmergencyPause,
  onReprocessPaused,
  onRetryFailed,
  onReconcileDelivery,
  onCancelStaleFollowUps,
  activeWorkspaceKey,
  activeWorkspaceLabel = 'Deal Desk',
  contextSubtitle,
  activeViewKey,
  activeViewKeys = [],
  activeViewChips = [],
  onToggleActiveViewChip,
  activeThemeId,
  activeAccentId,
  workspaceOptions = [],
  viewOptions = [],
  onSelectWorkspace,
  onSelectView,
  activeViewWidths = {},
  onSelectViewWidth,
  onSelectTheme,
  onSelectAccent,
  onSaveCurrentLayout,
  onWorkspaceSettings,
  activeOverlay,
  onOpenOverlay,
  onCloseOverlay,
  onOpenDossier,
  onOpenAi,
  onOpenKeys,
  onOpenKpis,
  onOpenActivity,
  onOpenTasks,
  onOpenSettings,
  onResetLayout,
  topSearchQuery,
  onTopSearchQueryChange,
  topSearchGroups,
  topSearchLoading,
  onExecuteTopSearchResult,
  actionCenterCounts,
  onNavigateInboxView,
  onOpenQueueCommand,
  authReady = false,
  authLoading = false,
  onSignOut,
  profileInitials = 'RK',
}: NexusTopBarProps) => {
  const DEV = Boolean(import.meta.env.DEV)
  const DEBUG_INBOX = DEV && String(import.meta.env.VITE_INBOX_DEBUG ?? 'false').toLowerCase() === 'true'

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const workspaceTriggerRef = useRef<HTMLButtonElement | null>(null)
  const queueTriggerRef = useRef<HTMLButtonElement | null>(null)
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null)
  const workspaceControlRef = useRef<HTMLDivElement | null>(null)

  const { activeSurface, toggleSurface, closeAndRestoreFocus, setActiveSurface, registerTrigger } = useShellSurface()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchActiveIndex, setSearchActiveIndex] = useState(0)
  const [isCompactMenu, setIsCompactMenu] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1024px)')
    const apply = () => setIsCompactMenu(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    registerTrigger('workspace', workspaceTriggerRef.current)
    registerTrigger('queue', queueTriggerRef.current)
    registerTrigger('action-center', actionTriggerRef.current)
    registerTrigger('profile', profileTriggerRef.current)
  })

  useEffect(() => {
    if (DEBUG_INBOX && activeOverlay) {
      console.log(`[NexusPopover]`, { name: activeOverlay, action: 'open', open: true })
    }
  }, [activeOverlay, DEBUG_INBOX])

  useEffect(() => {
    const focusSearch = () => {
      searchInputRef.current?.focus()
    }
    window.addEventListener('nexus:focus-search', focusSearch as EventListener)
    return () => window.removeEventListener('nexus:focus-search', focusSearch as EventListener)
  }, [])

  const openExclusiveSurface = (surface: Exclude<typeof activeSurface, null>) => {
    onCloseOverlay()
    setSearchOpen(false)
    toggleSurface(surface)
  }

  const openOverlayExclusive = (overlay: ActiveOverlay) => {
    setActiveSurface(null)
    setSearchOpen(false)
    onOpenOverlay(overlay)
  }

  const processorStatus = queueProcessorHealth?.status ?? 'unknown'
  const processorHealthLabel =
    processorStatus === 'healthy' ? 'Healthy'
      : processorStatus === 'warning' ? 'Warning'
        : processorStatus === 'critical' ? 'Critical'
          : 'Unknown'
  const queueStatusIcon =
    processorStatus === 'healthy' ? 'check'
      : processorStatus === 'warning' ? 'alert'
        : processorStatus === 'critical' ? 'alert'
          : 'activity'

  const { unreadCount: intelligenceUnreadCount } = useNotificationIntelligence()
  const unreadNotifications = intelligenceUnreadCount
  const topSearchItems = useMemo(
    () => topSearchGroups.flatMap((group) => group.items),
    [topSearchGroups],
  )

  useEffect(() => {
    setSearchActiveIndex(0)
  }, [topSearchQuery, topSearchGroups])

  const showSearchPopover = searchOpen && (topSearchLoading || topSearchItems.length > 0 || topSearchQuery.trim().length >= 2)

  const handleSearchSubmit = (result: CommandResult | undefined) => {
    if (!result) return
    onExecuteTopSearchResult(result)
    setSearchOpen(false)
  }

  const launcherWorkspaces: WorkspaceLauncherItem[] = useMemo(
    () => workspaceOptions.map((workspace) => ({
      key: workspace.key,
      label: workspace.label,
      description: workspace.description,
      availability: toAvailability(workspace.statusLabel),
      pinned: workspace.key === activeWorkspaceKey,
      selected: workspace.key === activeWorkspaceKey,
    })),
    [workspaceOptions, activeWorkspaceKey],
  )

  const launcherViews: WorkspaceLauncherItem[] = useMemo(
    () => viewOptions.map((view) => ({
      key: view.key,
      label: view.label,
      description: view.description,
      availability: toAvailability(view.statusLabel),
      selected: activeViewKeys.includes(view.key),
    })),
    [viewOptions, activeViewKeys],
  )

  const actionItems: ActionCenterItem[] = useMemo(() => {
    const counts = actionCenterCounts
    const navigate = (view: string) => {
      if (onNavigateInboxView) onNavigateInboxView(view)
      else onOpenTasks()
    }

    return [
      {
        id: 'human-review',
        label: 'Human Review',
        count: counts?.humanReview ?? null,
        loading: counts?.loading,
        onSelect: () => navigate('needs_review'),
      },
      {
        id: 'follow-ups',
        label: 'Follow-Ups',
        count: counts?.followUps ?? null,
        loading: counts?.loading,
        onSelect: () => navigate('follow_up'),
      },
      {
        id: 'failed-sends',
        label: 'Failed Sends',
        count: counts?.failedSends ?? null,
        loading: counts?.loading,
        onSelect: () => onOpenQueueCommand?.() ?? onOpenTasks(),
      },
      {
        id: 'decisions',
        label: 'Decisions Required',
        count: counts?.decisionsRequired ?? null,
        loading: counts?.loading,
        onSelect: () => navigate('needs_review'),
      },
      {
        id: 'closing-tasks',
        label: 'Closing Tasks',
        count: counts?.closingTasks,
        loading: counts?.loading,
        hidden: counts?.closingTasks == null && !counts?.loading,
        unavailableReason: counts?.closingTasks == null ? 'Closing desk not connected' : undefined,
        onSelect: onOpenTasks,
      },
      {
        id: 'system-tasks',
        label: 'System Tasks',
        count: counts?.systemTasks,
        loading: counts?.loading,
        hidden: counts?.systemTasks == null && !counts?.loading,
        unavailableReason: counts?.systemTasks == null ? 'No system task feed' : undefined,
        onSelect: onOpenTasks,
      },
    ]
  }, [actionCenterCounts, onNavigateInboxView, onOpenQueueCommand, onOpenTasks])

  const actionCountTotal = actionItems.reduce((sum, item) => {
    if (item.hidden || typeof item.count !== 'number') return sum
    return sum + item.count
  }, 0)

  return (
    <header className="nx-topbar nx-topbar--nexus-shell">
      {/* Zone 1: Workspace identity */}
      <div className="nx-topbar__left nx-topbar-shell-left">
        <div className="nx-topbar__brand" aria-label="NEXUS Dashboard">
          <div className="nx-topbar__logo">
            <Icon name="spark" />
          </div>
          <div className="nx-topbar-identity">
            <span>NEXUS</span>
            <strong>{activeWorkspaceLabel}</strong>
            {contextSubtitle ? <small>{contextSubtitle}</small> : null}
          </div>
        </div>

        {/* Zone 2: Operational controls */}
        <div className="nx-topbar-shell-zone nx-topbar-shell-zone--controls">
          <div className="nx-topbar-orb-slot">
            <InboxKpiOrb />
          </div>

          <div className="nx-topbar-view-control" ref={workspaceControlRef}>
            <button
              ref={workspaceTriggerRef}
              type="button"
              className={cls('nx-topbar-view-button nx-topbar-workspace-compact', activeSurface === 'workspace' && 'is-active')}
              title={`Workspace: ${activeWorkspaceLabel}`}
              aria-expanded={activeSurface === 'workspace'}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                openExclusiveSurface('workspace')
              }}
            >
              <strong><Icon name="layout-split" /></strong>
            </button>

            <WorkspaceLauncher
              open={activeSurface === 'workspace'}
              compact={isCompactMenu}
              anchorRef={workspaceTriggerRef}
              onClose={() => closeAndRestoreFocus('workspace')}
              activeWorkspaceKey={activeWorkspaceKey}
              workspaceOptions={launcherWorkspaces}
              viewOptions={launcherViews}
              activeViewKeys={activeViewKeys}
              activeViewWidths={activeViewWidths}
              activeViewChips={activeViewChips}
              activeViewKey={activeViewKey}
              activeThemeId={activeThemeId}
              activeAccentId={activeAccentId}
              onSelectWorkspace={(key) => {
                onSelectWorkspace?.(key)
                closeAndRestoreFocus('workspace')
              }}
              onSelectView={(key) => onSelectView?.(key)}
              onSelectViewWidth={(key, width) => onSelectViewWidth?.(key, width)}
              onToggleActiveViewChip={onToggleActiveViewChip}
              onSelectTheme={onSelectTheme}
              onSelectAccent={onSelectAccent}
              onSaveCurrentLayout={onSaveCurrentLayout}
              onResetLayout={onResetLayout}
              onWorkspaceSettings={onWorkspaceSettings}
            />
          </div>

          <div className="nx-notification-control">
            <button
              ref={queueTriggerRef}
              type="button"
              className={cls(
                'nx-processor-button nx-processor-button--compact',
                `is-${processorStatus}`,
                activeSurface === 'queue' && 'is-active',
              )}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                openExclusiveSurface('queue')
              }}
              aria-expanded={activeSurface === 'queue'}
              title={`Queue & System Status · ${processorHealthLabel}`}
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
                health={queueProcessorHealth}
                control={queueControlDiagnostics}
                loading={queueProcessorHealthLoading}
                mode={queueCommandMode}
                caps={queueCommandCaps}
                actionLoading={queueCommandActionLoading}
                onModeChange={onQueueCommandModeChange}
                onCapsChange={onQueueCommandCapsChange}
                onRefresh={() => onRefreshQueueHealth?.()}
                onRunSafeBatch={onRunSafeBatch}
                onQueueMore={onQueueMore}
                onRunQueueNow={onRunQueueNow}
                onEmergencyPause={onEmergencyPause}
                onReprocessPaused={onReprocessPaused}
                onRetryFailed={onRetryFailed}
                onReconcileDelivery={onReconcileDelivery}
                onCancelStaleFollowUps={onCancelStaleFollowUps}
                onClose={() => closeAndRestoreFocus('queue')}
              />
            </CommandPopover>
          </div>
        </div>
      </div>

      {/* Zone 3: Global search */}
      <div className="nx-topbar__center nx-topbar-shell-center">
        <div className="nx-global-search">
          <Icon name="search" />
          <input
            ref={searchInputRef}
            aria-label="Search sellers, owners, properties, conversations, buyers, campaigns, and entities"
            value={topSearchQuery}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              onTopSearchQueryChange(event.target.value)
              setSearchOpen(true)
              setActiveSurface(null)
              onCloseOverlay()
            }}
            onFocus={(event) => {
              event.currentTarget.select()
              setSearchOpen(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSearchOpen(true)
                setSearchActiveIndex((current) => Math.min(current + 1, Math.max(topSearchItems.length - 1, 0)))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSearchActiveIndex((current) => Math.max(current - 1, 0))
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                handleSearchSubmit(topSearchItems[searchActiveIndex])
                return
              }
              if (event.key === 'Escape') {
                setSearchOpen(false)
              }
            }}
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
            placeholder="Search sellers, buyers, addresses, locations, conversations..."
          />
          <kbd>CMD+K</kbd>
          {showSearchPopover ? (
            <div className="nx-search-results-popover nx-liquid-surface" role="listbox" aria-label="Universal search suggestions">
              <div className="nx-search-results-popover__header">
                <span>Universal Search</span>
                <b>{topSearchLoading ? 'Searching…' : `${topSearchItems.length} matches`}</b>
              </div>
              <div className="nx-search-results-list">
                {topSearchGroups.map((group) => (
                  <section key={group.key} className="nx-search-result-group">
                    <header className="nx-search-result-group__label">{group.label}</header>
                    {group.items.map((result) => {
                      const runningIndex = topSearchItems.findIndex((item) => item.id === result.id)
                      const isActive = runningIndex === searchActiveIndex
                      return (
                        <button
                          key={result.id}
                          type="button"
                          className={cls('nx-search-result-item', isActive && 'is-active')}
                          onMouseEnter={() => setSearchActiveIndex(runningIndex)}
                          onMouseDown={(event) => {
                            event.preventDefault()
                            handleSearchSubmit(result)
                          }}
                        >
                          <span className="nx-search-result-item__row">
                            <strong>{result.title}</strong>
                            {result.badge ? <em>{result.badge}</em> : null}
                          </span>
                          <small>{result.subtitle}</small>
                          {result.description ? <p>{result.description}</p> : null}
                        </button>
                      )
                    })}
                  </section>
                ))}
                {!topSearchLoading && topSearchItems.length === 0 ? (
                  <div className="nx-search-results-empty">
                    <strong>No matches</strong>
                    <span>Try a seller, buyer, address, market, phone, or queue status.</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Zone 4: Operator controls */}
      <div className="nx-topbar__actions nx-topbar-shell-zone nx-topbar-shell-zone--operators">
        <div className="nx-notification-control">
          <button
            ref={actionTriggerRef}
            type="button"
            className={cls('nx-notification-button', activeSurface === 'action-center' && 'is-active')}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              openExclusiveSurface('action-center')
            }}
            aria-expanded={activeSurface === 'action-center'}
            title="Action Center"
          >
            <Icon name="check" />
            {actionCountTotal > 0 ? <span>{actionCountTotal > 99 ? '99+' : actionCountTotal}</span> : null}
          </button>
          <ActionCenter
            open={activeSurface === 'action-center'}
            anchorRef={actionTriggerRef}
            onClose={() => closeAndRestoreFocus('action-center')}
            items={actionItems}
            loading={actionCenterCounts?.loading}
          />
        </div>

        <div className="nx-notification-control">
          <button
            type="button"
            className={cls('nx-notification-button', activeOverlay === 'activity' && 'is-active')}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (activeOverlay === 'activity') onCloseOverlay()
              else {
                setActiveSurface(null)
                setSearchOpen(false)
                onOpenActivity()
              }
            }}
            aria-expanded={activeOverlay === 'activity'}
            title="Live Activity"
          >
            <Icon name="activity" />
          </button>
        </div>

        <LeadCommandNotificationBell
          unreadCount={unreadNotifications}
          active={activeOverlay === 'notifications'}
          onClick={() => {
            if (activeOverlay === 'notifications') onCloseOverlay()
            else openOverlayExclusive('notifications')
          }}
        />

        <div className="nx-notification-control">
          <button
            ref={profileTriggerRef}
            type="button"
            className={cls('nx-avatar-menu nx-avatar-menu--compact', activeSurface === 'profile' && 'is-active')}
            title="Profile menu"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              openExclusiveSurface('profile')
            }}
            aria-expanded={activeSurface === 'profile'}
          >
            <span>{profileInitials}</span>
          </button>

          <ProfileMenu
            open={activeSurface === 'profile'}
            anchorRef={profileTriggerRef}
            onClose={() => closeAndRestoreFocus('profile')}
            initials={profileInitials}
            authReady={authReady}
            authLoading={authLoading}
            onProfile={onOpenDossier}
            onSettings={onOpenSettings}
            onWorkspaceSettings={onWorkspaceSettings}
            onThemeSettings={onOpenKpis}
            onKeyboardShortcuts={onOpenKeys}
            onDiagnostics={onOpenAi}
            onSignOut={onSignOut}
          />
        </div>
      </div>

      <LeadCommandNotificationCenter
        open={activeOverlay === 'notifications'}
        onClose={onCloseOverlay}
        anchorTop={58}
      />
    </header>
  )
}