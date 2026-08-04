import { useMemo, useRef, useState } from 'react'
import { pushRoutePath, useRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import { Dropdown, Modal, Tooltip, type DropdownItem } from '../../shared/ui'
import { useAuth } from '../../components/auth/AuthProvider'
import { GLOBAL_COMMAND_OPEN_EVENT } from '../../domain/command-center/command.types'
import { useBreakpoint } from '../mobile/useBreakpoint'
import { AppearanceMenu } from './AppearanceMenu'
import { SHELL_NAV_ITEMS, findShellNavItem } from './shell-nav'
import './shell-rail.css'

/**
 * ShellTopRail — the application's ONE top rail, owned by the shell.
 *
 * Before: `modules/inbox/components/NexusTopBar` rendered the only rail in the
 * app and its single consumer was `InboxPage`, so 14 of 15 routes had no top
 * bar and no route identity, and the theme/accent picker was unreachable
 * anywhere but `/inbox` (conflict register #1, #2, #3).
 *
 * Composition, per §2/§4: ONE aligned line — brand, route, navigation,
 * appearance, account. It replaces the stacked four-label
 * "NEXUS / Deal Desk / breadcrumb" block and the floating `.nx-room-label`
 * overlay that used to collide with each view's own page header.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export const ShellTopRail = ({ routeTitle }: { routeTitle?: string }) => {
  const routePath = useRoutePath()
  const { width, isMobile } = useBreakpoint()
  const auth = useAuth()

  const moreRef = useRef<HTMLButtonElement | null>(null)
  const navRef = useRef<HTMLButtonElement | null>(null)
  const appearanceRef = useRef<HTMLButtonElement | null>(null)
  const accountRef = useRef<HTMLButtonElement | null>(null)

  const [openSurface, setOpenSurface] = useState<'more' | 'nav' | 'appearance' | 'account' | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const close = () => setOpenSurface(null)
  const toggle = (surface: 'more' | 'nav' | 'appearance' | 'account') =>
    setOpenSurface((current) => (current === surface ? null : surface))

  const active = findShellNavItem(routePath)
  const roomLabel = active?.room ?? routeTitle?.replace(/^NEXUS \| /, '') ?? 'Command Center'

  /** §15.4 — the rail recomposes by width, it does not hide chrome. */
  const inlineCount = width >= 1600 ? 8 : width >= 1360 ? 6 : width >= 1180 ? 4 : 0

  const inlineItems = useMemo(() => {
    if (inlineCount === 0) return []
    const primary = SHELL_NAV_ITEMS.filter((item) => item.primary)
    const visible = primary.slice(0, inlineCount)
    // Always keep the current route visible in the rail.
    if (active && !visible.some((item) => item.path === active.path)) {
      visible[visible.length - 1] = active
    }
    return visible
  }, [inlineCount, active])

  const overflowItems = useMemo<DropdownItem[]>(() => {
    const shown = new Set(inlineItems.map((item) => item.path))
    return SHELL_NAV_ITEMS.filter((item) => !shown.has(item.path)).map((item) => ({
      id: item.path,
      label: item.label,
      meta: item.shortcut,
      group: item.group,
      active: item.path === routePath,
      onSelect: () => pushRoutePath(item.path),
    }))
  }, [inlineItems, routePath])

  const accountItems = useMemo<DropdownItem[]>(
    () => [
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        onSelect: () => setShortcutsOpen(true),
      },
      {
        id: 'command',
        label: 'Command palette',
        meta: '⌘K',
        onSelect: () => window.dispatchEvent(new CustomEvent(GLOBAL_COMMAND_OPEN_EVENT)),
      },
      {
        id: 'sign-out',
        label: auth.loading ? 'Checking session…' : 'Sign out',
        disabled: auth.loading || !auth.session,
        onSelect: () => void auth.signOut(),
      },
    ],
    [auth],
  )

  const operatorEmail = auth.user?.email ?? null
  const initials = (operatorEmail?.slice(0, 2) ?? 'OP').toUpperCase()

  /** Mobile portrait always carries a fixed command dock at y=0 — the portable
   *  shell on most routes, the inbox command shell on `/inbox`. The rail sits
   *  directly beneath it rather than underneath it. */
  const belowMobileDock = isMobile

  /** `GlobalNotificationShell` paints a position:fixed bell at the top-right on
   *  every non-inbox desktop route. Reserve its footprint so the rail's own
   *  controls are never covered by it. Same predicate as CommandCenterApp. */
  const hasGlobalBell = !isMobile && routePath !== '/inbox'

  return (
    <header
      className={cls(
        'lc-ui',
        'lc-rail',
        isMobile && 'is-mobile',
        belowMobileDock && 'is-below-dock',
        hasGlobalBell && 'has-global-bell',
      )}
      role="banner"
    >
      <div className="lc-rail__identity">
        <button
          type="button"
          className="lc-rail__brand"
          aria-label="LeadCommand home — Inbox"
          onClick={() => pushRoutePath('/inbox')}
        >
          <span className="lc-rail__mark" aria-hidden>
            <Icon name="spark" size={14} />
          </span>
          {!isMobile ? <span className="lc-rail__wordmark">NEXUS</span> : null}
        </button>
        <span className="lc-rail__sep" aria-hidden>
          /
        </span>
        <span className="lc-rail__room" title={roomLabel}>
          {roomLabel}
        </span>
      </div>

      <nav className="lc-rail__nav" aria-label="Global navigation">
        {inlineItems.map((item) => {
          const isActive = item.path === routePath
          return (
            <button
              key={item.path}
              type="button"
              className={cls('lc-rail__nav-item', isActive && 'is-active')}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => pushRoutePath(item.path)}
            >
              <span className="lc-rail__nav-icon" aria-hidden>
                <Icon name={item.icon} size={14} />
              </span>
              <span className="lc-rail__nav-label">{item.label}</span>
            </button>
          )
        })}

        {inlineCount > 0 ? (
          <>
            <button
              ref={moreRef}
              type="button"
              className={cls('lc-rail__nav-item', 'lc-rail__more', openSurface === 'more' && 'is-active')}
              aria-haspopup="menu"
              aria-expanded={openSurface === 'more'}
              onClick={() => toggle('more')}
            >
              <span className="lc-rail__nav-label">More</span>
              <span className="lc-rail__nav-icon" aria-hidden>
                <Icon name="chevron-down" size={12} />
              </span>
            </button>
            <Dropdown
              open={openSurface === 'more'}
              anchorRef={moreRef}
              onClose={close}
              items={overflowItems}
              label="More workspaces"
              placement="bottom-start"
              width={300}
            />
          </>
        ) : (
          <>
            <button
              ref={navRef}
              type="button"
              className={cls('lc-rail__nav-item', 'lc-rail__more', openSurface === 'nav' && 'is-active')}
              aria-haspopup="menu"
              aria-expanded={openSurface === 'nav'}
              onClick={() => toggle('nav')}
            >
              <span className="lc-rail__nav-icon" aria-hidden>
                <Icon name="grid" size={14} />
              </span>
              <span className="lc-rail__nav-label">Workspaces</span>
              <span className="lc-rail__nav-icon" aria-hidden>
                <Icon name="chevron-down" size={12} />
              </span>
            </button>
            <Dropdown
              open={openSurface === 'nav'}
              anchorRef={navRef}
              onClose={close}
              items={overflowItems}
              label="Workspaces"
              placement="bottom-start"
              width={300}
            />
          </>
        )}
      </nav>

      <div className="lc-rail__actions">
        <Tooltip label="Appearance — theme, accent, density">
          <button
            ref={appearanceRef}
            type="button"
            className={cls('lc-rail__icon-btn', openSurface === 'appearance' && 'is-active')}
            aria-label="Appearance"
            aria-haspopup="dialog"
            aria-expanded={openSurface === 'appearance'}
            onClick={() => toggle('appearance')}
          >
            <Icon name="palette" size={15} />
          </button>
        </Tooltip>
        <AppearanceMenu open={openSurface === 'appearance'} anchorRef={appearanceRef} onClose={close} />

        <button
          ref={accountRef}
          type="button"
          className={cls('lc-rail__avatar', openSurface === 'account' && 'is-active')}
          aria-label={operatorEmail ? `Account — ${operatorEmail}` : 'Account'}
          aria-haspopup="menu"
          aria-expanded={openSurface === 'account'}
          onClick={() => toggle('account')}
        >
          {initials}
        </button>
        <Dropdown
          open={openSurface === 'account'}
          anchorRef={accountRef}
          onClose={close}
          items={accountItems}
          label="Account"
          placement="bottom-end"
          width={260}
          header={
            <div className="lc-rail__account-header">
              <strong>{operatorEmail ?? 'Operator'}</strong>
              <small>{auth.session ? 'Signed in' : 'No active session'}</small>
            </div>
          }
        />

        {/* Uses the shared Modal primitive: focus trapped, Esc closes, focus
            returns to the avatar that opened it (§11.3 / §16.3). */}
        <Modal
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          title="Keyboard shortcuts"
          description="Single keys navigate between workspaces. Modifier keys drive global surfaces."
          size="content"
          restoreFocusRef={accountRef}
          footer={
            <button type="button" className="lc-ui-btn lc-ui-btn--primary" onClick={() => setShortcutsOpen(false)}>
              Close
            </button>
          }
        >
          <dl className="lc-rail__keys">
            {SHELL_NAV_ITEMS.map((item) => (
              <div key={item.path}>
                <dt>{item.label}</dt>
                <dd>
                  <kbd>{item.shortcut}</kbd>
                </dd>
              </div>
            ))}
            <div>
              <dt>Command palette</dt>
              <dd>
                <kbd>⌘</kbd> <kbd>K</kbd>
              </dd>
            </div>
            <div>
              <dt>Copilot</dt>
              <dd>
                <kbd>⌘</kbd> <kbd>J</kbd>
              </dd>
            </div>
            <div>
              <dt>Briefing</dt>
              <dd>
                <kbd>⌘</kbd> <kbd>.</kbd>
              </dd>
            </div>
          </dl>
        </Modal>
      </div>
    </header>
  )
}
