import { Icon } from '../../shared/icons'
import type { SendingStatus } from './ops-status'

/**
 * The rail indicator.
 *
 * Rendered inside a host-owned trigger button so Lane A keeps full control of
 * the rail's chrome, spacing and theme. This component contributes only the
 * status glyph and count.
 *
 * R6.1 — status is colour AND icon AND text: the icon changes per state and
 * the accessible name spells the state out, so it never relies on colour alone.
 */

export interface OperationsRailBadgeProps {
  status: SendingStatus
  /** Items needing an operator decision. Omitted or 0 renders no count. */
  count?: number
  /** Adds a visible text label next to the glyph (wide rails). */
  showLabel?: boolean
}

export function OperationsRailBadge({ status, count = 0, showLabel = false }: OperationsRailBadgeProps) {
  return (
    <span className={`opsc-rail-badge is-${status.tone}`}>
      <Icon name={status.icon} size={15} />
      {showLabel ? <span className="opsc-rail-badge__label">{status.label}</span> : null}
      {count > 0 ? (
        <b className="opsc-rail-badge__count">{count > 99 ? '99+' : count}</b>
      ) : null}
      <span className="opsc-sr-only">
        {`Operations — sending ${status.label.toLowerCase()}${count > 0 ? `, ${count} item${count === 1 ? '' : 's'} need attention` : ''}`}
      </span>
    </span>
  )
}
