import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueueProcessorHealth } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import type { AccentPalette } from '../../../shared/settings'
import type { CommandResult } from '../../command-center/command.types'
import type { ActiveOverlay } from '../inbox-layout-state'
import type { NexusGlobalThemeId } from '../../theme/nexusThemes'
import type { ViewWidthPercent } from '../view-layout'
import { buildInboxNotifications, NexusNotificationCenter, type NexusNotification } from './NexusNotificationCenter'
import type { AutonomousEngineModel } from '../autonomy-engine'
import { InboxKpiOrb } from './InboxKpiOrb'
import { QueueCommandCenter, type QueueCommandCaps, type QueueCommandMode } from './QueueCommandCenter'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

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
  onOpenSettings: () => void
  onResetLayout: () => void
  dryRun: boolean
  onToggleDryRun: () => void
}

const THEME_OPTIONS: Array<{ id: NexusGlobalThemeId; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'red_ops', label: 'Red Ops' },
  { id: 'matrix', label: 'Matrix' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'executive', label: 'Executive' },
  { id: 'night_vision', label: 'Night Vision' },
  { id: 'monochrome', label: 'Monochrome' },
]

const ACCENT_OPTIONS: Array<{ id: AccentPalette; label: string }> = [
  { id: 'cyan', label: 'Cyan' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'amber', label: 'Amber' },
  { id: 'violet', label: 'Violet' },
  { id: 'rose', label: 'Rose' },
  { id: 'ice', label: 'Ice' },
]

type WorkspaceSubmenu = null | 'workspaces' | 'views' | 'theme' | 'accent' | 'manage'

export const NexusTopBar = ({
  onSelectSearchResult,
  selectedThread,
  notificationCount,
  queueProcessorHealth,
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
  autonomyModel,
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
  onOpenActivity,
  onOpenTasks,
  onOpenSettings,
  onResetLayout,
  topSearchQuery,
  onTopSearchQueryChange,
  topSearchGroups,
  topSearchLoading,
  onExecuteTopSearchResult,
}: NexusTopBarProps) => {
  const DEV = Boolean(import.meta.env.DEV)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [openControlMenu, setOpenControlMenu] = useState<null | 'workspace'>(null)
  const [activeSubmenu, setActiveSubmenu] = useState<WorkspaceSubmenu>(null)
  const [openQuickMenu, setOpenQuickMenu] = useState<null | 'tasks' | 'activity' | 'profile'>(null)
  const [isQueuePanelPinned, setIsQueuePanelPinned] = useState(false)
  const [isQueuePanelHovered, setIsQueuePanelHovered] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchActiveIndex, setSearchActiveIndex] = useState(0)
  const [isCompactMenu, setIsCompactMenu] = useState(false)
  const [submenuFlipLeft, setSubmenuFlipLeft] = useState(false)
  const workspaceControlRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1024px)')
    const apply = () => setIsCompactMenu(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    if (DEV && activeOverlay) {
      console.log(`[NexusPopover]`, { name: activeOverlay, action: 'open', open: true })
    }
  }, [activeOverlay, DEV])

  useEffect(() => {
    const focusSearch = () => {
      searchInputRef.current?.focus()
    }
    window.addEventListener('nexus:focus-search', focusSearch as EventListener)
    return () => window.removeEventListener('nexus:focus-search', focusSearch as EventListener)
  }, [])

  useEffect(() => {
    const handleWindowClick = () => {
      setOpenControlMenu(null)
      setActiveSubmenu(null)
      setOpenQuickMenu(null)
    }
    window.addEventListener('click', handleWindowClick)
    return () => window.removeEventListener('click', handleWindowClick)
  }, [])

  useEffect(() => {
    if (openControlMenu !== 'workspace' || isCompactMenu) return
    const rect = workspaceControlRef.current?.getBoundingClientRect()
    if (!rect) return
    const expectedRight = rect.left + 300 + 300
    setSubmenuFlipLeft(expectedRight > window.innerWidth - 16)
  }, [openControlMenu, isCompactMenu])

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

  const notifications = buildInboxNotifications({ unreadCount: notificationCount, selectedThread, queueProcessorHealth, autonomyModel })
  const unreadNotifications = notifications.filter((item) => item.status !== 'read').length
  const topSearchItems = useMemo(
    () => topSearchGroups.flatMap((group) => group.items),
    [topSearchGroups],
  )

  useEffect(() => {
    setSearchActiveIndex(0)
  }, [topSearchQuery, topSearchGroups])

  const showSearchPopover = searchOpen && (topSearchLoading || topSearchItems.length > 0 || topSearchQuery.trim().length >= 2)

  const handleNotificationAction = (notification: NexusNotification) => {
    if (notification.related_thread_id) onSelectSearchResult(notification.related_thread_id)
    onCloseOverlay()
  }

  const handleSearchSubmit = (result: CommandResult | undefined) => {
    if (!result) return
    onExecuteTopSearchResult(result)
    setSearchOpen(false)
  }

  const closeWorkspaceMenu = () => {
    setOpenControlMenu(null)
    setActiveSubmenu(null)
  }


  const selectAndClose = (action: () => void) => {
    action()
    closeWorkspaceMenu()
  }

  const renderWorkspaceRoot = () => (
    <div className="nx-workspace-menu-root" role="menu">
      <button type="button" className={cls('nx-workspace-menu-item', activeSubmenu === 'workspaces' && 'is-active')} onMouseEnter={() => !isCompactMenu && setActiveSubmenu('workspaces')} onClick={() => setActiveSubmenu('workspaces')}>
        <span>Pinned Workspaces</span><Icon name="chevron-right" />
      </button>
      <button type="button" className={cls('nx-workspace-menu-item', activeSubmenu === 'views' && 'is-active')} onMouseEnter={() => !isCompactMenu && setActiveSubmenu('views')} onClick={() => setActiveSubmenu('views')}>
        <span>Views</span><Icon name="chevron-right" />
      </button>
      <button type="button" className={cls('nx-workspace-menu-item', activeSubmenu === 'theme' && 'is-active')} onMouseEnter={() => !isCompactMenu && setActiveSubmenu('theme')} onClick={() => setActiveSubmenu('theme')}>
        <span>Theme</span><Icon name="chevron-right" />
      </button>
      <button type="button" className={cls('nx-workspace-menu-item', activeSubmenu === 'accent' && 'is-active')} onMouseEnter={() => !isCompactMenu && setActiveSubmenu('accent')} onClick={() => setActiveSubmenu('accent')}>
        <span>Accent Palette</span><Icon name="chevron-right" />
      </button>
      <button type="button" className={cls('nx-workspace-menu-item', activeSubmenu === 'manage' && 'is-active')} onMouseEnter={() => !isCompactMenu && setActiveSubmenu('manage')} onClick={() => setActiveSubmenu('manage')}>
        <span>Manage</span><Icon name="chevron-right" />
      </button>
    </div>
  )

  const renderSubmenu = () => {
    if (!activeSubmenu) return null

    if (activeSubmenu === 'workspaces') {
      return (
        <div className="nx-workspace-submenu-scroll" role="menu">
          {workspaceOptions.map((workspace) => (
            <button key={workspace.key} type="button" className={cls('nx-workspace-submenu-item', activeWorkspaceKey === workspace.key && 'is-active')} onClick={() => selectAndClose(() => onSelectWorkspace?.(workspace.key))}>
              <span className="nx-workspace-submenu-item__text" title={workspace.description || ''}><strong>{workspace.label}</strong><small>{workspace.description || ''}</small></span>
              <span className="nx-workspace-submenu-item__meta">
                {workspace.statusLabel ? <em className="nx-workspace-submenu-item__badge">{workspace.statusLabel}</em> : null}
                {activeWorkspaceKey === workspace.key ? <Icon name="check" /> : null}
              </span>
            </button>
          ))}
        </div>
      )
    }

    if (activeSubmenu === 'views') {
      return (
        <div className="nx-workspace-submenu-scroll" role="menu">
          {viewOptions.map((view) => (
            <div key={view.key} className={cls('nx-workspace-submenu-item nx-workspace-submenu-item--view', activeViewKey === view.key && 'is-active')}>
              <button
                type="button"
                className="nx-workspace-submenu-item__select"
                onClick={() => selectAndClose(() => onSelectView?.(view.key))}
              >
                <span className="nx-workspace-submenu-item__text" title={view.description || ''}><strong>{view.label}</strong><small>{view.description || ''}</small></span>
                <span className="nx-workspace-submenu-item__meta">
                  {view.statusLabel ? <em className="nx-workspace-submenu-item__badge">{view.statusLabel}</em> : null}
                  {activeViewKeys.includes(view.key) ? <Icon name="check" /> : null}
                </span>
              </button>
              <div className="nx-workspace-view-widths" aria-label={`${view.label} width`}>
                {(['25', '50', '75', '100'] as ViewWidthPercent[]).map((width) => (
                  <button
                    key={width}
                    type="button"
                    className={cls('nx-topbar-width-pill', activeViewWidths[view.key] === width && 'is-active')}
                    onClick={() => selectAndClose(() => onSelectViewWidth?.(view.key, width))}
                    title={width === '100' ? 'Fullscreen' : `${width}% width`}
                  >
                    {width === '100' ? 'Full' : `${width}%`}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )
    }

    if (activeSubmenu === 'theme') {
      return (
        <div className="nx-workspace-submenu-scroll" role="menu">
          <div className="nx-workspace-submenu-title">NEXUS Theme</div>
          <div className="nx-workspace-submenu-note">Command center color scheme</div>
          {THEME_OPTIONS.map((themeOption) => (
            <button key={themeOption.id} type="button" className={cls('nx-workspace-submenu-item', activeThemeId === themeOption.id && 'is-active')} onClick={() => selectAndClose(() => onSelectTheme(themeOption.id))}>
              <span className="nx-theme-dot" data-theme={themeOption.id} />
              <strong>{themeOption.label}</strong>
              {activeThemeId === themeOption.id ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
      )
    }

    if (activeSubmenu === 'accent') {
      return (
        <div className="nx-workspace-submenu-scroll" role="menu">
          <div className="nx-workspace-submenu-title">Accent Palette</div>
          <div className="nx-workspace-submenu-note">Primary accent color</div>
          {ACCENT_OPTIONS.map((accentOption) => (
            <button key={accentOption.id} type="button" className={cls('nx-workspace-submenu-item', activeAccentId === accentOption.id && 'is-active')} onClick={() => selectAndClose(() => onSelectAccent(accentOption.id))}>
              <span className="nx-accent-dot" data-accent={accentOption.id} />
              <strong>{accentOption.label}</strong>
              {activeAccentId === accentOption.id ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
      )
    }

    return (
      <div className="nx-workspace-submenu-scroll" role="menu">
        <div className="nx-workspace-submenu-title">Layout Size</div>
        <div className="nx-workspace-view-widths" aria-label="Active view width">
          {(['25', '50', '75', '100'] as ViewWidthPercent[]).map((width) => (
            <button
              key={width}
              type="button"
              className={cls('nx-topbar-width-pill', activeViewKey && activeViewWidths[activeViewKey] === width && 'is-active')}
              onClick={() => selectAndClose(() => {
                if (activeViewKey && onSelectViewWidth) onSelectViewWidth(activeViewKey, width)
              })}
              title={width === '100' ? 'Fullscreen' : `${width}% width`}
            >
              {width === '100' ? 'Full' : `${width}%`}
            </button>
          ))}
        </div>
        <button type="button" className="nx-workspace-submenu-item" onClick={() => selectAndClose(() => onSaveCurrentLayout?.())}><strong>Save Current Layout</strong></button>
        <button type="button" className="nx-workspace-submenu-item" onClick={() => selectAndClose(() => onResetLayout())}><strong>Reset Layout</strong></button>
        <button type="button" className="nx-workspace-submenu-item" onClick={() => selectAndClose(() => onWorkspaceSettings?.())}><strong>Workspace Settings</strong></button>
      </div>
    )
  }

  return (
    <header className="nx-topbar nx-topbar--nexus-shell">
      <div className="nx-topbar__left nx-topbar-shell-left">
        <div className="nx-topbar__brand" aria-label="NEXUS Dashboard">
          <div className="nx-topbar__logo">
            <Icon name="spark" />
          </div>
          <div>
            <span>NEXUS</span>
            <strong>Dashboard</strong>
          </div>
        </div>
        <div className="nx-topbar-orb-slot">
          <InboxKpiOrb />
        </div>
        <div className="nx-topbar-view-control" ref={workspaceControlRef}>
            <button
              type="button"
              className={cls('nx-topbar-view-button nx-topbar-workspace-compact', openControlMenu === 'workspace' && 'is-active')}
              title={`Workspace: ${activeWorkspaceLabel}`}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setOpenControlMenu((current) => current === 'workspace' ? null : 'workspace')
                setActiveSubmenu('workspaces')
              }}
            >
              <strong><Icon name="layout-split" /></strong>
            </button>
            {openControlMenu === 'workspace' && !isCompactMenu && (
              <div
                className={cls('nx-liquid-popover nx-topbar-workspace-menu', submenuFlipLeft && 'is-submenu-left')}
                role="menu"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
              >
                {renderWorkspaceRoot()}
                <div className="nx-workspace-submenu-panel">
                  {activeSubmenu === 'views' && activeViewChips.length > 0 ? (
                    <div className="nx-workspace-active-view-strip" aria-label="Active views">
                      {activeViewChips.map((chip) => (
                        <button
                          key={chip.key}
                          type="button"
                          className={cls('nx-active-view-chip', chip.key === activeViewKey && 'is-active')}
                          onClick={() => onToggleActiveViewChip?.(chip.key)}
                          title={`Remove ${chip.label}`}
                        >
                          <span>{chip.label}</span>
                          <Icon name="close" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {renderSubmenu()}
                </div>
              </div>
            )}
        </div>
        <div
          className="nx-notification-control"
          onMouseEnter={() => setIsQueuePanelHovered(true)}
          onMouseLeave={() => setIsQueuePanelHovered(false)}
        >
          <button
            type="button"
            className={cls('nx-processor-button nx-processor-button--compact', `is-${processorStatus}`, isQueuePanelPinned && 'is-active')}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setIsQueuePanelPinned((prev) => !prev)
            }}
            aria-expanded={isQueuePanelPinned || isQueuePanelHovered}
            title={`Queue Processor · ${processorHealthLabel}`}
          >
            <span className={cls('nx-queue-indicator', `is-${processorStatus}`)}>
              <Icon name={queueStatusIcon} />
              {processorStatus === 'healthy' ? <i className="nx-queue-indicator-dot" /> : null}
            </span>
          </button>
          {isQueuePanelPinned || isQueuePanelHovered ? (
            <div className="nx-liquid-popover nx-liquid-popover--processor" role="status" onClick={(e) => e.stopPropagation()}>
              <QueueCommandCenter
                health={queueProcessorHealth}
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
                onClose={() => {
                  setIsQueuePanelPinned(false)
                  setIsQueuePanelHovered(false)
                }}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="nx-topbar__center nx-topbar-shell-center">
        {openControlMenu === 'workspace' && isCompactMenu ? (
            <>
              <button className="nx-workspace-drawer-backdrop" type="button" aria-label="Close workspace menu" onClick={closeWorkspaceMenu} />
              <div className="nx-workspace-drawer" role="menu" onClick={(event) => { event.stopPropagation() }}>
                <div className="nx-workspace-drawer__header">
                  <strong>Workspace Menu</strong>
                  <button type="button" onClick={closeWorkspaceMenu}><Icon name="close" /></button>
                </div>
                <div className="nx-workspace-drawer__body">
                  {renderWorkspaceRoot()}
                  <div className="nx-workspace-submenu-panel is-drawer">{renderSubmenu()}</div>
                </div>
              </div>
            </>
          ) : null}
        <div className="nx-global-search">
          <Icon name="search" />
          <input
            ref={searchInputRef}
            aria-label="Search Inbox sellers, buyers, properties, conversations, and markets"
            value={topSearchQuery}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              onTopSearchQueryChange(event.target.value)
              setSearchOpen(true)
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
            <div className="nx-search-results-popover" role="listbox" aria-label="Inbox search suggestions">
              <div className="nx-search-results-popover__header">
                <span>Inbox Search</span>
                <b>{topSearchLoading ? 'Live' : `${topSearchItems.length} matches`}</b>
              </div>
              <div className="nx-search-results-list">
                {topSearchGroups.map((group) => {
                  let runningIndex = -1
                  return (
                    <section key={group.key} className="nx-search-result-group">
                      <header className="nx-search-result-group__label">{group.label}</header>
                      {group.items.map((result) => {
                        runningIndex = topSearchItems.findIndex((item) => item.id === result.id)
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
                  )
                })}
                {!topSearchLoading && topSearchItems.length === 0 ? (
                  <div className="nx-search-results-empty">
                    <strong>No inbox matches</strong>
                    <span>Try a seller, buyer, address, market, phone, or queue status.</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="nx-topbar__actions">
        <div className="nx-notification-control">
          <button
            type="button"
            className="nx-notification-button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setOpenQuickMenu((current) => current === 'tasks' ? null : 'tasks')
            }}
            title="Tasks"
          >
            <Icon name="check" />
          </button>
          {openQuickMenu === 'tasks' ? (
            <div className="nx-liquid-popover nx-quick-menu-popover" role="menu">
              {['Manual Review', 'Follow-ups', 'Failed Sends', 'Needs Decision', 'Closing Tasks', 'System Tasks'].map((item) => (
                <button key={item} type="button" onClick={onOpenTasks}>
                  <span>{item}</span><small>Count unavailable</small>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="nx-notification-control">
          <button
            type="button"
            className="nx-notification-button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onOpenActivity()
            }}
            aria-expanded={activeOverlay === 'activity'}
            title="Activity"
          >
            <Icon name="activity" />
          </button>
        </div>

        <div className="nx-notification-control">
          <button
            type="button"
            className={cls('nx-notification-button', unreadNotifications > 0 && 'has-alerts')}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onOpenOverlay(activeOverlay === 'notifications' ? null : 'notifications')
            }}
            aria-expanded={activeOverlay === 'notifications'}
            title="Notifications"
          >
            <Icon name="bell" />
            {unreadNotifications > 0 && <span>{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>}
          </button>
        </div>

        <button
          type="button"
          className="nx-avatar-menu nx-avatar-menu--compact"
          title="User menu"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpenQuickMenu((current) => current === 'profile' ? null : 'profile')
          }}
          aria-expanded={openQuickMenu === 'profile'}
        >
          <span>RK</span>
        </button>

        {openQuickMenu === 'profile' && (
          <div className="nx-avatar-popover nx-liquid-popover">
            <button type="button" onClick={onOpenDossier}><Icon name="briefing" /> Profile</button>
            <button type="button" onClick={onOpenSettings}><Icon name="settings" /> Settings</button>
            <button type="button" onClick={() => onWorkspaceSettings?.()}><Icon name="layout-split" /> Workspace Settings</button>
            <button type="button" onClick={onOpenKpis}><Icon name="stats" /> Theme Settings</button>
            <button type="button" onClick={onOpenKeys}><Icon name="key" /> Keyboard Shortcuts</button>
            <button type="button" onClick={onOpenAi}><Icon name="activity" /> Diagnostics</button>
            <button type="button" disabled><Icon name="close" /> Sign Out (Not Ready)</button>
          </div>
        )}
      </div>

      <NexusNotificationCenter
        open={activeOverlay === 'notifications'}
        notifications={notifications}
        onClose={onCloseOverlay}
        onOpenRecord={handleNotificationAction}
      />
    </header>
  )
}
