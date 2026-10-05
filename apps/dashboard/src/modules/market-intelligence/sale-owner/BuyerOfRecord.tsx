import { LCTooltip } from '../../../shared/lc'
import { describeBuyerOfRecord, type SaleOwnerRow } from './sale-owner-client'
import './sale-owner.css'

/**
 * The one renderer for a sale's buyer of record (MI, Map comp card, Comp Intelligence).
 * The visible text is the API label verbatim; the "current owner of record" suffix is muted so it
 * never reads as the deed's buyer. The inferred-investor chip is a separate "modeled" mark.
 */
export function BuyerOfRecord({ row, fallback, pending, compact }: { row: SaleOwnerRow | null | undefined; fallback?: string; pending?: boolean; compact?: boolean }) {
  if (pending && !row) return <span className="lcbo is-pending" aria-busy="true">Resolving buyer…</span>
  const d = describeBuyerOfRecord(row, fallback)
  const body = (
    <span className={`lcbo${d.basis ? ` is-${d.basis}` : ''}${compact ? ' is-compact' : ''}`} tabIndex={d.tooltip ? 0 : undefined} aria-label={d.tooltip ? `${d.text}. ${d.tooltip}` : undefined}>
      <span className="lcbo__lead">{d.lead}</span>
      {d.suffix ? <span className="lcbo__suffix"> · {d.suffix}</span> : null}
    </span>
  )
  return (
    <span className="lcbo-wrap">
      {d.tooltip ? <LCTooltip content={d.tooltip} side="top" align="start">{body}</LCTooltip> : body}
      {d.inferred ? (
        <LCTooltip content={d.inferred.tooltip} side="top" align="start">
          <span className="lcbo-inferred" tabIndex={0} aria-label={`${d.inferred.text}. ${d.inferred.tooltip}`}>{d.inferred.text}</span>
        </LCTooltip>
      ) : null}
    </span>
  )
}
