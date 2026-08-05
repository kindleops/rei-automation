import { InboxKpiOrb } from '../../inbox/components/InboxKpiOrb'
import type { ShellPanelProps } from '../shell-panels'

/**
 * Shell slot adapter — `operational-intelligence`, `surface: 'self'`.
 *
 * "Operational Intelligence" was a string inside a 945-line inbox component
 * that shipped its own trigger orb. Lane A does not rebuild that content; it
 * drives the existing panel in controlled, trigger-less mode so the SHELL owns
 * the entry point (rail button, open state, focus restore) on all 15 routes.
 *
 * Lane F replaces the body: point the slot at a new component in
 * `shell-panels.ts` and switch `surface` to `'drawer'`.
 */
export const OperationalIntelligencePanel = ({ open, onClose, anchorRef }: ShellPanelProps) => (
  <InboxKpiOrb hideTrigger open={open} onClose={onClose} anchorRef={anchorRef} />
)

export default OperationalIntelligencePanel
