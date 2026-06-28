import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { AccentPalette } from '../../shared/settings'
import type { NexusGlobalThemeId } from '../../domain/theme/nexusThemes'
import type { ViewWidthPercent } from '../../domain/inbox/view-layout'
import { CommandDrawer } from './primitives/CommandDrawer'
import { FilterChip } from './primitives/FilterChip'
import type { WorkspaceAvailability, WorkspaceLauncherItem } from './shell-types'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type LauncherCategory = 'pinned' | 'workspaces' | 'views' | 'appearance' | 'administration' | 'account'

const CATEGORY_OPTIONS: Array<{ id: LauncherCategory; label: string }> = [
  { id: 'pinned', label: 'Pinned' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'views', label: 'Views' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'administration', label: 'Administration' },
  { id: 'account', label: 'Account' },
]

const THEME_OPTIONS: Array<{ id: NexusGlobalThemeId; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'red_ops', label: 'Red Ops' },
  { id: 'light', label: 'Light' },
]

const ACCENT_OPTIONS: Array<{ id: AccentPalette; label: string }> = [
  { id: 'cyan', label: 'Cyan' },
  { id: 'blue', label: 'Blue' },
  { id: 'ice', label: 'Ice' },
  { id: 'teal', label: 'Teal' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'lime', label: 'Lime' },
  { id: 'amber', label: 'Amber' },
  { id: 'gold', label: 'Gold' },
  { id: 'orange', label: 'Orange' },
  { id: 'rose', label: 'Rose' },
  { id: 'pink', label: 'Pink' },
  { id: 'violet', label: 'Violet' },
]

const WIDTH_OPTIONS: ViewWidthPercent[] = ['25', '50', '75', '100']

const widthLabel = (width: ViewWidthPercent) => (width === '100' ? 'Full' : `${width}%`)

const availabilityLabel = (availability?: WorkspaceAvailability) => {
  if (!availability || availability === 'ready') return null
  if (availability === 'backend_not_ready') return 'Unavailable'
  return 'Coming soon'
}

const workspaceIcon = (key: string): Parameters<typeof Icon>[0]['name'] => {
  if (key.includes('deal')) return 'briefing'
  if (key.includes('queue')) return 'activity'
  if (key.includes('map') || key.includes('market')) return 'map'
  if (key.includes('pipeline')) return 'trending-up'
  if (key.includes('buyer')) return 'users'
  if (key.includes('comp')) return 'stats'
  if (key.includes('closing')) return 'dollar-sign'
  if (key === 'thread') return 'inbox'
  if (key === 'sms_thread') return 'message'
  if (key === 'analytics') return 'stats'
  return 'layout-split'
}

export interface WorkspaceLauncherProps {
  open: boolean
  compact: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  activeWorkspaceKey?: string
  workspaceOptions: WorkspaceLauncherItem[]
  viewOptions: WorkspaceLauncherItem[]
  activeViewKeys: string[]
  activeViewWidths: Partial<Record<string, ViewWidthPercent>>
  activeViewChips: Array<{ key: string; label: string }>
  activeViewKey?: string
  activeThemeId: NexusGlobalThemeId
  activeAccentId: AccentPalette
  onSelectWorkspace: (key: string) => void
  onSelectView: (key: string) => void
  onSelectViewWidth: (viewKey: string, width: ViewWidthPercent) => void
  onToggleActiveViewChip?: (viewKey: string) => void
  onSelectTheme: (themeId: NexusGlobalThemeId) => void
  onSelectAccent: (accent: AccentPalette) => void
  onSaveCurrentLayout?: () => void
  onResetLayout: () => void
  onWorkspaceSettings?: () => void
  profileInitials?: string
  authReady?: boolean
  authLoading?: boolean
  onProfile?: () => void
  onSettings?: () => void
  onThemeSettings?: () => void
  onKeyboardShortcuts?: () => void
  onDiagnostics?: () => void
  onSignOut?: () => void
}

export const WorkspaceLauncher = ({
  open,
  compact,
  anchorRef,
  onClose,
  activeWorkspaceKey,
  workspaceOptions,
  viewOptions,
  activeViewKeys,
  activeViewWidths,
  activeViewChips,
  activeViewKey,
  activeThemeId,
  activeAccentId,
  onSelectWorkspace,
  onSelectView,
  onSelectViewWidth,
  onToggleActiveViewChip,
  onSelectTheme,
  onSelectAccent,
  onSaveCurrentLayout,
  onResetLayout,
  onWorkspaceSettings,
  profileInitials = 'RK',
  authReady = false,
  authLoading = false,
  onProfile,
  onSettings,
  onThemeSettings,
  onKeyboardShortcuts,
  onDiagnostics,
  onSignOut,
}: WorkspaceLauncherProps) => {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(null)
  const [category, setCategory] = useState<LauncherCategory>('workspaces')
  const [query, setQuery] = useState('')

  const updatePopoverPosition = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    const panel = popoverRef.current
    if (!anchor) return

    const panelWidth = panel?.offsetWidth || Math.min(540, window.innerWidth - 24)
    const gap = 8
    let left = anchor.left
    if (left + panelWidth > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - panelWidth - 12)
    }

    setPopoverPosition({
      top: anchor.bottom + gap,
      left,
    })
  }, [anchorRef])

  useLayoutEffect(() => {
    if (!open || compact) {
      setPopoverPosition(null)
      return
    }
    updatePopoverPosition()
  }, [open, compact, updatePopoverPosition, category, query])

  useEffect(() => {
    if (!open || compact) return
    const handleViewportChange = () => updatePopoverPosition()
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open, compact, updatePopoverPosition])

  useEffect(() => {
    if (!open || compact) return
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('mousedown', handlePointer)
    return () => window.removeEventListener('mousedown', handlePointer)
  }, [open, compact, onClose, anchorRef])

  const pinnedWorkspaces = useMemo(
    () => workspaceOptions.filter((item) => item.pinned || item.key === activeWorkspaceKey).slice(0, 4),
    [workspaceOptions, activeWorkspaceKey],
  )

  const filteredWorkspaces = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return workspaceOptions
    return workspaceOptions.filter((item) =>
      `${item.label} ${item.description ?? ''}`.toLowerCase().includes(q),
    )
  }, [workspaceOptions, query])

  const filteredViews = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return viewOptions
    return viewOptions.filter((item) =>
      `${item.label} ${item.description ?? ''}`.toLowerCase().includes(q),
    )
  }, [viewOptions, query])

  const readyWorkspaces = filteredWorkspaces.filter((item) => !item.availability || item.availability === 'ready')
  const unavailableWorkspaces = filteredWorkspaces.filter((item) => item.availability && item.availability !== 'ready')

  const readyViews = filteredViews.filter((item) => !item.availability || item.availability === 'ready')
  const unavailableViews = filteredViews.filter((item) => item.availability && item.availability !== 'ready')

  const selectAndClose = (action: () => void) => {
    action()
    onClose()
  }

  const renderWorkspaceRow = (workspace: WorkspaceLauncherItem, disabled = false) => {
    const isActive = activeWorkspaceKey === workspace.key
    const modes = workspace.layoutModes
    return (
      <div
        key={workspace.key}
        className={cls('nx-wsl-row', isActive && 'is-active', disabled && 'is-disabled')}
        title={disabled ? availabilityLabel(workspace.availability) ?? 'Unavailable' : undefined}
      >
        <button
          type="button"
          className="nx-wsl-row__main"
          disabled={disabled}
          onClick={() => selectAndClose(() => onSelectWorkspace(workspace.key))}
        >
          <span className="nx-wsl-row__icon" aria-hidden>
            <Icon name={workspaceIcon(workspace.key)} />
          </span>
          <span className="nx-wsl-row__copy">
            <strong>{workspace.label}</strong>
            {workspace.description ? <small>{workspace.description}</small> : null}
          </span>
          <span className="nx-wsl-row__state" aria-hidden>
            {disabled ? (
              <em className="nx-wsl-row__availability">{availabilityLabel(workspace.availability)}</em>
            ) : isActive ? (
              <Icon name="check" />
            ) : null}
          </span>
        </button>
        {modes && modes.length > 0 ? (
          <div className="nx-wsl-row__modes" aria-label={`${workspace.label} layout modes`}>
            {modes.map((mode) => (
              <span key={mode} className="nx-wsl-mode-chip">{widthLabel(mode)}</span>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  const renderViewRow = (view: WorkspaceLauncherItem, disabled = false) => {
    const isActiveView = activeViewKeys.includes(view.key)
    const widthKey = view.key === 'analytics' ? 'metrics' : view.key
    const tooltip = disabled
      ? (availabilityLabel(view.availability) ?? 'Unavailable')
      : (view.description ?? undefined)
    return (
      <div
        key={view.key}
        className={cls('nx-wsv-row', isActiveView && 'is-active', disabled && 'is-disabled')}
        role="group"
        title={tooltip}
      >
        <button
          type="button"
          className="nx-wsv-row__toggle"
          disabled={disabled}
          onClick={() => onSelectView(view.key)}
        >
          <span className="nx-wsv-row__icon" aria-hidden>
            <Icon name={workspaceIcon(view.key)} />
          </span>
          <span className="nx-wsv-row__label">{view.label}</span>
        </button>
        {!disabled ? (
          <div className="nx-wsv-row__pills" aria-label={`${view.label} width`}>
            {WIDTH_OPTIONS.map((width) => (
              <button
                key={width}
                type="button"
                className={cls('nx-wsv-pill', activeViewWidths[widthKey] === width && 'is-active')}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onSelectViewWidth(view.key, width)
                }}
              >
                {widthLabel(width)}
              </button>
            ))}
          </div>
        ) : null}
        <span className="nx-wsv-row__meta" aria-hidden>
          {disabled ? (
            <em className="nx-wsv-row__availability">{availabilityLabel(view.availability)}</em>
          ) : isActiveView ? (
            <Icon name="check" />
          ) : null}
        </span>
      </div>
    )
  }

  const renderCategoryPanel = () => {
    if (category === 'pinned') {
      return (
        <div className="nx-wsl-panel__section">
          <h4>Pinned &amp; Recent</h4>
          {pinnedWorkspaces.length === 0 ? (
            <p className="nx-wsl-panel__note">Pin a workspace from Workspaces to keep it here.</p>
          ) : (
            pinnedWorkspaces.map((workspace) =>
              renderWorkspaceRow(workspace, workspace.availability !== 'ready' && Boolean(workspace.availability)),
            )
          )}
        </div>
      )
    }

    if (category === 'workspaces') {
      return (
        <>
          <div className="nx-wsl-panel__section">
            <h4>Workspaces</h4>
            {readyWorkspaces.map((workspace) => renderWorkspaceRow(workspace))}
          </div>
          {unavailableWorkspaces.length > 0 ? (
            <div className="nx-wsl-panel__section is-unavailable">
              <h4>Unavailable</h4>
              {unavailableWorkspaces.map((workspace) => renderWorkspaceRow(workspace, true))}
            </div>
          ) : null}
        </>
      )
    }

    if (category === 'views') {
      return (
        <>
          {activeViewChips.length > 0 ? (
            <div className="nx-workspace-active-view-strip" aria-label="Active views">
              {activeViewChips.map((chip) => (
                <FilterChip
                  key={chip.key}
                  label={chip.label}
                  active={chip.key === activeViewKey}
                  onClick={() => onToggleActiveViewChip?.(chip.key)}
                />
              ))}
            </div>
          ) : null}
          <div className="nx-wsl-panel__section nx-wsl-panel__section--views">
            <h4>Views</h4>
            {readyViews.map((view) => renderViewRow(view))}
          </div>
          {unavailableViews.length > 0 ? (
            <div className="nx-wsl-panel__section is-unavailable">
              <h4>Unavailable</h4>
              {unavailableViews.map((view) => renderViewRow(view, true))}
            </div>
          ) : null}
        </>
      )
    }

    if (category === 'appearance') {
      return (
        <>
          <div className="nx-wsl-panel__section">
            <h4>Theme</h4>
            {THEME_OPTIONS.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={cls('nx-wsl-menu-row', activeThemeId === theme.id && 'is-active')}
                onClick={() => selectAndClose(() => onSelectTheme(theme.id))}
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
                onClick={() => selectAndClose(() => onSelectAccent(accent.id))}
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
      )
    }

    if (category === 'administration') {
      return (
        <div className="nx-wsl-panel__section">
          <h4>Administration</h4>
          <button type="button" className="nx-wsl-menu-row" onClick={() => selectAndClose(() => onSaveCurrentLayout?.())}>
            <Icon name="check" size={14} />
            <strong>Save Current Layout</strong>
          </button>
          <button type="button" className="nx-wsl-menu-row" onClick={() => selectAndClose(() => onResetLayout())}>
            <Icon name="refresh-cw" size={14} />
            <strong>Reset Layout</strong>
          </button>
          <button type="button" className="nx-wsl-menu-row" onClick={() => selectAndClose(() => onWorkspaceSettings?.())}>
            <Icon name="settings" size={14} />
            <strong>Workspace Settings</strong>
          </button>
        </div>
      )
    }

    return (
      <div className="nx-wsl-panel__section">
        <header className="nx-wsl-account-header">
          <span className="nx-profile-menu__avatar">{profileInitials}</span>
          <div>
            <strong>Operator</strong>
            <small>Nexus command shell</small>
          </div>
        </header>
        {onProfile ? (
          <button type="button" className="nx-wsl-menu-row" onClick={() => selectAndClose(() => onProfile())}>
            <Icon name="briefing" size={14} />
            <strong>Profile</strong>
          </button>
        ) : null}
        {onSettings ? (
          <button type="button" className="nx-wsl-menu-row" onClick={() => selectAndClose(() => onSettings())}>
            <Icon name="settings" size={14} />
            <strong>Preferences</strong>
          </button>
        ) : null}
        {onThemeSettings ? (
          <button type="button" className="nx-wsl-menu-row" onClick={() => selectAndClose(() => onThemeSettings())}>
            <Icon name="stats" size={14} />
            <strong>Theme Settings</strong>
          </button>
        ) : null}
        {onKeyboardShortcuts ? (
          <button type="button" className="nx-wsl-menu-row" onClick={() => selectAndClose(() => onKeyboardShortcuts())}>
            <Icon name="key" size={14} />
            <strong>Keyboard Shortcuts</strong>
          </button>
        ) : null}
        {onDiagnostics ? (
          <button type="button" className="nx-wsl-menu-row" onClick={() => selectAndClose(() => onDiagnostics())}>
            <Icon name="activity" size={14} />
            <strong>Diagnostics</strong>
          </button>
        ) : null}
        {onSignOut ? (
          <button
            type="button"
            className="nx-wsl-menu-row is-sign-out"
            disabled={!authReady || authLoading}
            onClick={() => {
              if (!authReady || authLoading) return
              selectAndClose(() => onSignOut())
            }}
          >
            <Icon name="close" size={14} />
            <strong>{authLoading ? 'Checking session…' : authReady ? 'Sign Out' : 'Sign Out unavailable'}</strong>
          </button>
        ) : null}
      </div>
    )
  }

  const launcherBody = (
    <div className="nx-wsl-root">
      <div className="nx-wsl-search">
        <Icon name="search" />
        <input
          type="search"
          value={query}
          placeholder="Search workspaces and views…"
          aria-label="Search workspaces and views"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className={cls('nx-wsl-body', compact && 'is-compact')}>
        <nav className="nx-wsl-nav" aria-label="Workspace launcher categories">
          {CATEGORY_OPTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cls('nx-wsl-nav__item', category === item.id && 'is-active')}
              onClick={() => setCategory(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="nx-wsl-panel">{renderCategoryPanel()}</div>
      </div>
    </div>
  )

  if (compact) {
    return (
      <CommandDrawer open={open} title="Workspace Launcher" onClose={onClose} fullWidth>
        {launcherBody}
      </CommandDrawer>
    )
  }

  if (!open) return null

  if (!popoverPosition) return null

  const popover = (
    <div
      ref={popoverRef}
      className="nx-wsl-popover nx-shell-popover-portal"
      style={{
        position: 'fixed',
        top: popoverPosition.top,
        left: popoverPosition.left,
        zIndex: 13000,
      }}
      role="dialog"
      aria-label="Workspace launcher"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {launcherBody}
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(popover, document.body) : null
}