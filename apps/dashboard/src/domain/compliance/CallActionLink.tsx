import type { ReactNode } from 'react'
import { resolveCallAction, type CallGateInput } from './call-action'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface CallActionLinkProps {
  gate: CallGateInput
  className?: string
  /** Class added when the call is prohibited (keeps each surface's own look). */
  disabledClassName?: string
  children: ReactNode
}

/**
 * The compliance-gated call action. Allowed → a real `tel:` link to the
 * normalised number. Prohibited → no href at all (nothing to tap through),
 * aria-disabled, and the plain reason as its accessible name and title.
 */
export function CallActionLink({ gate, className, disabledClassName, children }: CallActionLinkProps) {
  const verdict = resolveCallAction(gate)
  if (verdict.allowed) {
    return <a className={className} href={verdict.href} aria-label={`Call ${verdict.e164}`}>{children}</a>
  }
  return (
    <a
      className={cls(className, disabledClassName)}
      aria-disabled="true"
      role="link"
      title={verdict.reason}
      aria-label={`Call unavailable: ${verdict.reason}`}
      data-call-blocked="true"
    >
      {children}
    </a>
  )
}
