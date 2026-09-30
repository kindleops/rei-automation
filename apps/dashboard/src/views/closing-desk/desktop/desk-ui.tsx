import type { ReactNode } from 'react'
import { pushRoutePath } from '../../../app/router'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import type { Closing, ClosingRow, Owner, Severity } from '../mobile/closing-execution-api'
import { SEVERITY_WORD } from './desk-model'

/** Small shared pieces of the desktop Closing Desk. Words always accompany colour. */

export function StateChip({ tone, word, big = false }: { tone: string; word: string; big?: boolean }) {
  return <span className={`cdx-state is-${tone}${big ? ' is-big' : ''}`}><i aria-hidden />{word}</span>
}

export function SevChip({ severity }: { severity: Severity }) {
  return <span className={`cdx-sev is-${severity}`}>{SEVERITY_WORD[severity]}</span>
}

/** Facts as one dot-separated spec line (never a row of pills). */
export function Spec({ parts, className = '' }: { parts: Array<ReactNode | null | undefined | false>; className?: string }) {
  const shown = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== '')
  if (!shown.length) return null
  return <span className={`cdx-spec ${className}`}>{shown.map((p, i) => <span key={i}>{p}</span>)}</span>
}

export function Fact({ k, v, mono = false, tone }: { k: string; v: ReactNode; mono?: boolean; tone?: string }) {
  if (v === null || v === undefined || v === '' || v === false) return null
  return <div className={`cdx-fact${tone ? ` is-${tone}` : ''}`}><dt>{k}</dt><dd className={mono ? 'is-mono' : undefined}>{v}</dd></div>
}

export function OwnerTag({ owner }: { owner: Owner | null | undefined }) {
  if (!owner) return null
  return <span className={`cdx-owner is-${owner}`}>{owner === 'you' ? 'You' : owner === 'system' ? 'System' : owner[0].toUpperCase() + owner.slice(1)}</span>
}

type Linkable = Pick<Closing, 'propertyId' | 'threadKey' | 'masterOwnerId' | 'opportunityId'> & { property: { address: string | null } }

/** Navigate to another app on this transaction's exact context (canonical ids only). */
export function go(path: string, locate?: Linkable | ClosingRow | null) {
  if (locate) setPropertyLocator({ propertyId: locate.propertyId, threadKey: locate.threadKey, masterOwnerId: locate.masterOwnerId, opportunityId: locate.opportunityId, address: locate.property.address })
  pushRoutePath(path)
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="cdx-empty"><strong>{title}</strong>{children ? <p>{children}</p> : null}</div>
}
