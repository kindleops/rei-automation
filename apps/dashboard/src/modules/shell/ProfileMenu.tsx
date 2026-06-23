import { Icon } from '../../shared/icons'
import { CommandPopover } from './primitives/CommandPopover'

export interface ProfileMenuProps {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  initials?: string
  authReady: boolean
  authLoading?: boolean
  onProfile: () => void
  onSettings?: () => void
  onWorkspaceSettings?: () => void
  onThemeSettings: () => void
  onKeyboardShortcuts: () => void
  onDiagnostics: () => void
  onSignOut?: () => void
}

export const ProfileMenu = ({
  open,
  anchorRef,
  onClose,
  initials = 'RK',
  authReady,
  authLoading,
  onProfile,
  onSettings,
  onWorkspaceSettings,
  onThemeSettings,
  onKeyboardShortcuts,
  onDiagnostics,
  onSignOut,
}: ProfileMenuProps) => (
  <CommandPopover
    open={open}
    anchorRef={anchorRef}
    onClose={onClose}
    className="nx-profile-menu-popover"
    placement="bottom-end"
    width={260}
  >
    <header className="nx-profile-menu__header">
      <span className="nx-profile-menu__avatar">{initials}</span>
      <div>
        <strong>Operator</strong>
        <small>Nexus command shell</small>
      </div>
    </header>
    <div className="nx-profile-menu__list" role="menu">
      <button type="button" role="menuitem" onClick={() => { onProfile(); onClose() }}>
        <Icon name="briefing" /> Profile
      </button>
      {onSettings ? (
        <button type="button" role="menuitem" onClick={() => { onSettings(); onClose() }}>
          <Icon name="settings" /> Workspace Settings
        </button>
      ) : null}
      <button type="button" role="menuitem" onClick={() => { onWorkspaceSettings?.(); onClose() }}>
        <Icon name="layout-split" /> Workspace Layout
      </button>
      <button type="button" role="menuitem" onClick={() => { onThemeSettings(); onClose() }}>
        <Icon name="stats" /> Theme Settings
      </button>
      <button type="button" role="menuitem" onClick={() => { onKeyboardShortcuts(); onClose() }}>
        <Icon name="key" /> Keyboard Shortcuts
      </button>
      <button type="button" role="menuitem" onClick={() => { onDiagnostics(); onClose() }}>
        <Icon name="activity" /> Diagnostics
      </button>
      <button
        type="button"
        role="menuitem"
        className="is-sign-out"
        disabled={!authReady || authLoading}
        title={!authReady ? 'Authentication is not ready' : authLoading ? 'Checking session…' : 'Sign out'}
        onClick={() => {
          if (!authReady || authLoading) return
          onSignOut?.()
          onClose()
        }}
      >
        <Icon name="close" />
        {authLoading ? 'Checking session…' : authReady ? 'Sign Out' : 'Sign Out unavailable'}
      </button>
    </div>
  </CommandPopover>
)