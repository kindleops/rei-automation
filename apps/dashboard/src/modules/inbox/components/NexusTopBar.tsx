import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import type { AccentPalette } from '../../../shared/settings'
import { GLOBAL_COMMAND_OPEN_EVENT } from '../../../domain/command-center/command.types'
import { SHELL_PANEL_OPEN_EVENT } from '../../shell/shell-panels'
import type { ActiveOverlay } from '../../../domain/inbox/inbox-layout-state'
import type { NexusGlobalThemeId } from '../../../domain/theme/nexusThemes'
import type { ViewWidthPercent } from '../../../domain/inbox/view-layout'
import { useNotificationIntelligence } from '../../../domain/notifications/useNotificationIntelligence'
import { LeadCommandNotificationBell, LeadCommandNotificationCenter } from '../../notifications/LeadCommandNotificationCenter'
import type { AutonomousEngineModel } from '../autonomy-engine'
import { QueueCommandCenter, type CampaignControlDiagnostics, type QueueCommandCaps, type QueueCommandMode } from './QueueCommandCenter'
import { ActionCenter } from '../../shell/ActionCenter'
import { ProfileMenu } from '../../shell/ProfileMenu'
import { WorkspaceLauncher } from '../../shell/WorkspaceLauncher'
import { useShellSurface } from '../../shell/useShellSurface'
import type { ActionCenterItem, WorkspaceAvailability, WorkspaceLauncherItem } from '../../shell/shell-types'
import { CommandPopover } from '../../shell/primitives/CommandPopover'
import { useBreakpoint } from '../../mobile/useBreakpoint'
import { MobileCommandDock, type DockSurface } from '../../mobile/MobileCommandDock'
import { MobileSheet } from '../../mobile/MobileSheet'

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
  /**
   * @deprecated Accepted for call-site compatibility but no longer rendered.
   * The shell rail (`modules/shell/ShellTopRail`) owns route identity and the
   * breadcrumb on every route; this bar no longer renders an identity block.
   */
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
  onOpenTasks,
  onOpenSettings,
  onResetLayout,
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
  const { isMobile } = useBreakpoint()

  const workspaceTriggerRef = useRef<HTMLButtonElement | null>(null)
  const queueTriggerRef = useRef<HTMLButtonElement | null>(null)
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null)
  const workspaceControlRef = useRef<HTMLDivElement | null>(null)

  const { activeSurface, toggleSurface, closeAndRestoreFocus, setActiveSurface, registerTrigger } = useShellSurface()
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

  const openExclusiveSurface = (surface: Exclude<typeof activeSurface, null>) => {
    onCloseOverlay()
    toggleSurface(surface)
  }

  const openOverlayExclusive = (overlay: ActiveOverlay) => {
    setActiveSurface(null)
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

  const resolveDockSurface = (): DockSurface => {
    if (activeSurface === 'workspace') return 'workspace'
    if (activeSurface === 'queue') return 'queue'
    if (activeSurface === 'action-center') return 'tasks'
    if (activeOverlay === 'notifications') return 'notifications'
    return null
  }

  const handleDockSurfaceChange = (surface: DockSurface) => {
    if (surface === null) {
      setActiveSurface(null)
      onCloseOverlay()
      return
    }
    /* Search is the global ⌘K palette now — one search surface for the whole
       app, on every route, instead of a second mobile-only implementation. */
    if (surface === 'search') {
      onCloseOverlay()
      setActiveSurface(null)
      window.dispatchEvent(new CustomEvent(GLOBAL_COMMAND_OPEN_EVENT, { detail: {} }))
      return
    }
    if (surface === 'workspace') {
      openExclusiveSurface('workspace')
      return
    }
    if (surface === 'queue') {
      openExclusiveSurface('queue')
      return
    }
    if (surface === 'tasks') {
      openExclusiveSurface('action-center')
      return
    }
    /* Same single owner as the desktop rail button. */
    if (surface === 'activity') {
      setActiveSurface(null)
      onCloseOverlay()
      window.dispatchEvent(new CustomEvent(SHELL_PANEL_OPEN_EVENT, { detail: { id: 'live-activity' } }))
      return
    }
    if (surface === 'notifications') {
      if (activeOverlay === 'notifications') onCloseOverlay()
      else openOverlayExclusive('notifications')
    }
  }

  const workspaceLauncher = (
    <WorkspaceLauncher
      open={activeSurface === 'workspace'}
      mobileShell
      compact={false}
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
      profileInitials={profileInitials}
      authReady={authReady}
      authLoading={authLoading}
      onProfile={onOpenDossier}
      onSettings={onOpenSettings}
      onThemeSettings={onOpenKpis}
      onKeyboardShortcuts={onOpenKeys}
      onDiagnostics={onOpenAi}
      onSignOut={onSignOut}
      onOpenNotifications={() => openOverlayExclusive('notifications')}
    />
  )

  const queuePanel = (
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
  )

  if (isMobile) {
    return (
      <>
        <span ref={workspaceTriggerRef} className="nx-sr-only" aria-hidden />
        <span ref={queueTriggerRef} className="nx-sr-only" aria-hidden />
        <span ref={actionTriggerRef} className="nx-sr-only" aria-hidden />

        <MobileCommandDock
          activeSurface={resolveDockSurface()}
          onSurfaceChange={handleDockSurfaceChange}
          workspaceActive={activeSurface === 'workspace'}
          queueStatus={processorStatus}
          searchActive={false}
          tasksCount={actionCountTotal}
          activityActive={false}
          notificationCount={unreadNotifications}
          notificationsActive={activeOverlay === 'notifications'}
        />

        {workspaceLauncher}

        <MobileSheet
          open={activeSurface === 'queue'}
          title="Queue Intelligence"
          subtitle={processorHealthLabel}
          height="half"
          onClose={() => closeAndRestoreFocus('queue')}
        >
          {queuePanel}
        </MobileSheet>

        <MobileSheet
          open={activeSurface === 'action-center'}
          title="Tasks"
          subtitle="Operator attention queue"
          height="compact"
          onClose={() => closeAndRestoreFocus('action-center')}
        >
          <div className="nx-action-center__list" role="menu">
            {actionItems.filter((item) => !item.hidden).map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="nx-action-center__row"
                disabled={Boolean(item.unavailableReason) && item.count == null}
                onClick={() => {
                  if (item.unavailableReason && item.count == null) return
                  item.onSelect()
                  closeAndRestoreFocus('action-center')
                }}
              >
                <span className="nx-action-center__label">{item.label}</span>
                {typeof item.count === 'number' ? <b className="nx-action-center__count">{item.count}</b> : null}
              </button>
            ))}
          </div>
        </MobileSheet>

        <LeadCommandNotificationCenter
          open={activeOverlay === 'notifications'}
          onClose={onCloseOverlay}
          mobileSheet
        />
      </>
    )
  }

  return (
    <header className="nx-topbar nx-topbar--nexus-shell">
      {/* Zone 1: Workspace identity */}
      <div className="nx-topbar__left nx-topbar-shell-left nx-mobile-command-row">
        {/*
          Lane A: the stacked four-label identity block that used to live here
          ("NEXUS" / workspace / breadcrumb, plus the logo tile) has moved to the
          shell-owned rail — `modules/shell/ShellTopRail`. It renders on all 15
          routes instead of only `/inbox`, on ONE aligned line (§2/§4), and it is
          no longer duplicated by the fixed `.nx-room-label` overlay.
          Everything below stays inbox-owned: this bar is now a control toolbar.
        */}

        {/* Zone 2: Operational controls */}
        <div className="nx-topbar-shell-zone nx-topbar-shell-zone--controls">
          {/* Operational Intelligence lives in the shell rail now — one
              trigger, one open state, all 15 routes. A second orb here would
              give the same panel two owners. */}

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
              {isMobile ? <span className="nx-topbar-workspace-label">{activeWorkspaceLabel}</span> : null}
            </button>

            <WorkspaceLauncher
              open={activeSurface === 'workspace'}
              mobileShell={false}
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
              profileInitials={profileInitials}
              authReady={authReady}
              authLoading={authLoading}
              onProfile={onOpenDossier}
              onSettings={onOpenSettings}
              onThemeSettings={onOpenKpis}
              onKeyboardShortcuts={onOpenKeys}
              onDiagnostics={onOpenAi}
              onSignOut={onSignOut}
              onOpenNotifications={() => openOverlayExclusive('notifications')}
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
              label="Queue and system status"
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

      {/* Zone 3 (global search) is gone. The always-visible input carried a
          <kbd>CMD+K</kbd> hint that was untrue — ⌘K opens the command palette,
          it never focused this field. Search is now the palette, reached from
          the shell rail on all 15 routes (modules/shell/ShellTopRail).
          The palette runs the same providers plus app/filter/map actions, so
          nothing searchable was lost. */}

      {/* Zone 4: Operator controls */}
      <div className={cls('nx-topbar__actions nx-topbar-shell-zone nx-topbar-shell-zone--operators', isMobile && 'nx-mobile-action-row')}>
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

        {/* Live Activity moved to the shell rail: one control, all 15 routes.
            Keeping a second trigger here would put two openers on one panel —
            the same duplicate-owner defect as the old double ⌘K binding. */}

        <LeadCommandNotificationBell
          unreadCount={unreadNotifications}
          active={activeOverlay === 'notifications'}
          onClick={() => {
            if (activeOverlay === 'notifications') onCloseOverlay()
            else openOverlayExclusive('notifications')
          }}
        />

        {!isMobile ? (
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
        ) : null}
      </div>

      <LeadCommandNotificationCenter
        open={activeOverlay === 'notifications'}
        onClose={onCloseOverlay}
        anchorTop={58}
      />
    </header>
  )
}