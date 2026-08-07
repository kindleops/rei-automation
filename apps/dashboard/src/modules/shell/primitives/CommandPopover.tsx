import type { ReactNode } from 'react'
import { Popover } from '../../../shared/ui'

/**
 * MIGRATED (Lane A) — this file no longer implements a popover.
 *
 * It was a hand-rolled portal with a literal `zIndex: 13000`, `role="dialog"`
 * without an accessible name, and no focus trap, no focus restore, no Esc, and
 * no route-change or scroll dismissal. Every consumer — the shell's Action
 * Center, Profile Menu and the Queue Command Center popover in NexusTopBar —
 * inherited those defects.
 *
 * It now delegates to the single primitive in `src/shared/ui/Popover.tsx`
 * (constitution §11.9–§11.12) and keeps its old signature so the three
 * consumers migrate without a call-site change. New code should import
 * `Popover` / `Dropdown` from `src/shared/ui` directly.
 */
export const CommandPopover = ({
  open,
  anchorRef,
  onClose,
  children,
  className,
  placement = 'bottom-start',
  maxHeight = 'min(72vh, 640px)',
  width,
  label = 'Menu',
}: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  className?: string
  placement?: 'bottom-start' | 'bottom-end'
  maxHeight?: string
  width?: number | string
  /** Accessible name (§11 / R16.4). */
  label?: string
}) => (
  <Popover
    open={open}
    anchorRef={anchorRef}
    onClose={onClose}
    label={label}
    placement={placement}
    width={width}
    maxHeight={maxHeight}
    className={['nx-command-popover', className].filter(Boolean).join(' ')}
  >
    {children}
  </Popover>
)
