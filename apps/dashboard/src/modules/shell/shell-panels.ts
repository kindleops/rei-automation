import { lazy, type ComponentType, type LazyExoticComponent, type RefObject } from 'react'
import type { IconName } from '../../shared/icons'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHELL PANEL CONTRACT — the mount point Lane A owns and Lane F fills.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before round 2, two operator surfaces were route-locked inside the inbox:
 *
 *  - "Operational Intelligence" existed only as a label inside
 *    `modules/inbox/components/InboxKpiOrb.tsx` — reachable from `/inbox` only.
 *  - "Live Activity" was a button inside `modules/inbox/components/NexusTopBar`
 *    opening `InboxActivityPanel` — also `/inbox` only.
 *
 * They are now shell surfaces with a rail entry point on all 15 routes.
 *
 * ── Division of ownership ─────────────────────────────────────────────────
 * LANE A (shell) owns, and Lane F must NOT re-implement:
 *   · the rail trigger button, its icon, label, tooltip, accessible name,
 *     aria-expanded / aria-controls wiring and 44px hit target
 *   · the open/close state machine — one panel at a time, closed on route
 *     change, closed on Esc, focus restored to the trigger
 *   · the code-split boundary and its Suspense fallback
 *   · optionally the surrounding Drawer chrome (see `surface` below)
 *
 * LANE F owns the panel BODY: what the operator reads and does inside it.
 *
 * ── How Lane F fills a slot ───────────────────────────────────────────────
 * 1. Write a component whose props are exactly `ShellPanelProps`.
 * 2. Point the slot's `Component` at it in `SHELL_PANELS` below.
 * 3. Choose `surface`:
 *      'self'   — the component paints its own surface. It must render nothing
 *                 when `open` is false, and must call `onClose()` itself.
 *                 The shell still handles Esc and focus RESTORE for it; the
 *                 component is responsible for moving focus INTO the panel on
 *                 open and for trapping Tab if it is modal.
 *                 (This is where both slots are today, because both wrap
 *                 pre-existing self-portalling panels.)
 *      'drawer' — RECOMMENDED END STATE. The shell wraps the component in the
 *                 shared `Drawer` primitive: right edge on desktop, bottom
 *                 sheet on mobile, title, close button, Esc, focus trap and
 *                 focus restore all handled. The component then renders BODY
 *                 CONTENT ONLY — no <aside>, no portal, no header, no close
 *                 button, no z-index.
 * Nothing else in the shell has to change. Both paths are already implemented
 * and exercised in `ShellTopRail`.
 *
 * ── Opening a panel from outside the rail ─────────────────────────────────
 * Any module may dispatch `SHELL_PANEL_OPEN_EVENT` with a `ShellPanelId`:
 *
 *   window.dispatchEvent(new CustomEvent(SHELL_PANEL_OPEN_EVENT, {
 *     detail: { id: 'live-activity' },
 *   }))
 *
 * The shell is the only listener, so there is exactly one owner of the state.
 * Do not add a second window-level opener — that is precisely the double-fire
 * defect round 2 removed from ⌘K.
 */

export const SHELL_PANEL_OPEN_EVENT = 'lc:shell-panel-open'

export type ShellPanelId = 'operational-intelligence' | 'live-activity'

export type ShellPanelOpenDetail = {
  id: ShellPanelId
  /** `false` closes the panel instead of opening it. Default `true`. */
  open?: boolean
}

export interface ShellPanelProps {
  /** Whether the shell wants this panel visible. With `surface: 'self'` the
   *  component MUST render null when this is false. */
  open: boolean
  /** Close request. Always call this rather than holding private open state —
   *  the shell owns "one panel at a time" and focus restoration. */
  onClose: () => void
  /** Current route, so a panel can scope or link its content. */
  routePath: string
  /** Current viewport class, from the shell's single `useBreakpoint`. */
  isMobile: boolean
  /** The rail trigger. Anchor popovers to it; the shell already restores focus
   *  here on close, so the panel must not manage focus restoration itself. */
  anchorRef: RefObject<HTMLButtonElement | null>
  /** id of the shell-rendered title element when `surface: 'drawer'`. Use it
   *  for `aria-labelledby` if the body needs its own labelled region. */
  titleId: string
}

export interface ShellPanelDefinition {
  id: ShellPanelId
  /** Rail tooltip + drawer title. Must be the operator's word for the surface. */
  label: string
  /** One sentence: what this panel is for. Shown as the drawer description. */
  description: string
  icon: IconName
  surface: 'self' | 'drawer'
  Component: LazyExoticComponent<ComponentType<ShellPanelProps>>
}

export const SHELL_PANELS: ShellPanelDefinition[] = [
  {
    id: 'operational-intelligence',
    label: 'Operational Intelligence',
    description: 'Live system telemetry — messaging, quality, automation, delivery and pipeline.',
    icon: 'stats',
    surface: 'self',
    Component: lazy(() =>
      import('./panels/OperationalIntelligencePanel').then((m) => ({ default: m.OperationalIntelligencePanel })),
    ),
  },
  {
    id: 'live-activity',
    label: 'Live Activity',
    description: 'System heartbeat across queue, inbox, AI, map, offers, buyers and automation.',
    icon: 'activity',
    surface: 'self',
    Component: lazy(() => import('./panels/LiveActivityPanel').then((m) => ({ default: m.LiveActivityPanel }))),
  },
]

export const findShellPanel = (id: ShellPanelId): ShellPanelDefinition | undefined =>
  SHELL_PANELS.find((panel) => panel.id === id)
