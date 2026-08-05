import type { Icon } from '../../shared/icons'

/**
 * The single global navigation registry — owned by the shell.
 *
 * These 15 routes previously lived inside `CommandCenterApp.tsx` where they
 * were used ONLY for keyboard bindings and a room-label lookup; they were never
 * rendered as navigation (conflict register #2). `ShellTopRail` now renders
 * them, and `CommandCenterApp` keeps binding the same shortcuts from this list,
 * so the keyboard map and the visible nav can never drift apart.
 */

export type ShellNavIcon = Parameters<typeof Icon>[0]['name']

export interface ShellNavItem {
  path: string
  label: string
  icon: ShellNavIcon
  /** Single-key command-grammar shortcut. */
  shortcut: string
  /** Room name shown in the rail's breadcrumb. */
  room: string
  /** Rendered inline in the rail at wide viewports; the rest go to the overflow menu. */
  primary?: boolean
  group: 'Operate' | 'Investigate' | 'Build'
  /**
   * R16.5 — exactly one `<h1>` per view.
   *
   * These seven views already render their own page title as an `<h1>` inside
   * `#lc-main`, with its own styling; the other nine had none at all, which is
   * ledger IL-16 and the only remaining red in the a11y gate. Rather than bolt
   * a title bar onto nine dense operator surfaces — or demote seven working
   * headings and re-point fourteen CSS rules keyed on `h1` — the rail promotes
   * the room label it ALREADY renders visibly to `<h1>` on every route that
   * does not own one. Zero new chrome, zero extra vertical space, and the
   * heading an operator can actually see is the heading in the tree.
   *
   * This flag is the seam, so it can rot. It cannot rot silently:
   * `LC_A11Y_ROUTES=all npm run gate:a11y` asserts `h1Count === 1` on all
   * sixteen routes, so a view that gains or loses its own `<h1>` without
   * updating this flag fails the gate.
   */
  ownsHeading?: boolean
}

export const SHELL_NAV_ITEMS: ShellNavItem[] = [
  { path: '/inbox', label: 'Inbox', icon: 'inbox', shortcut: 'I', room: 'Inbox', primary: true, group: 'Operate' },
  { path: '/queue', ownsHeading: true, label: 'Outbound', icon: 'send', shortcut: 'Q', room: 'Outbound Command Center', primary: true, group: 'Operate' },
  { path: '/pipeline', label: 'Pipeline', icon: 'radar', shortcut: 'P', room: 'Pipeline', primary: true, group: 'Operate' },
  { path: '/deal-intelligence', label: 'Deal Intel', icon: 'target', shortcut: 'D', room: 'Deal Intelligence', primary: true, group: 'Investigate' },
  { path: '/analytics', ownsHeading: true, label: 'Analytics', icon: 'stats', shortcut: 'A', room: 'Analytics', primary: true, group: 'Investigate' },
  { path: '/map', label: 'Map', icon: 'map', shortcut: 'M', room: 'Map', primary: true, group: 'Investigate' },
  { path: '/closing-desk', ownsHeading: true, label: 'Closing', icon: 'file-text', shortcut: 'K', room: 'Closing Desk', primary: true, group: 'Operate' },
  { path: '/campaign-command', label: 'Campaigns', icon: 'send', shortcut: 'G', room: 'Campaign Command', primary: true, group: 'Operate' },
  { path: '/conversation', label: 'Conversation', icon: 'message', shortcut: 'C', room: 'Conversation', group: 'Operate' },
  { path: '/calendar', label: 'Calendar', icon: 'calendar', shortcut: 'L', room: 'Calendar', group: 'Operate' },
  { path: '/email-command', label: 'Email Command', icon: 'mail', shortcut: 'Y', room: 'Email Command', group: 'Operate' },
  { path: '/buyer-match', ownsHeading: true, label: 'Buyer Match', icon: 'users', shortcut: 'B', room: 'Buyer Match', group: 'Investigate' },
  { path: '/comp-intelligence', label: 'Comp Intelligence', icon: 'layers', shortcut: 'O', room: 'Comp Intelligence', group: 'Investigate' },
  { path: '/entity-graph', ownsHeading: true, label: 'Entity Graph', icon: 'grid', shortcut: 'E', room: 'Entity Graph', group: 'Investigate' },
  { path: '/workflow-studio', ownsHeading: true, label: 'Workflow Studio', icon: 'command', shortcut: 'W', room: 'Workflow Studio', group: 'Build' },
]

export const findShellNavItem = (path: string): ShellNavItem | undefined =>
  SHELL_NAV_ITEMS.find((item) => item.path === path)
