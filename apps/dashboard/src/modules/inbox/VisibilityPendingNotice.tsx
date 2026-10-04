/**
 * Owner rule 3, made visible: a seller replied on a conversation whose deals
 * are archived, and the reply does not say which property — the deals stay
 * archived until someone decides. Renders nothing while lead visibility is
 * off or nothing is pending.
 */
import { LCStatus } from '../../shared/lc'
import { useVisibilityPending } from '../../lib/data/leadVisibilityData'

export function VisibilityPendingNotice({ threadKey }: { threadKey: string | null | undefined }) {
  const pending = useVisibilityPending(threadKey)
  if (!pending) return null
  const deals = pending.candidates.map((c) => c.address || c.property_id || c.opportunity_id).filter(Boolean)
  return (
    <div className="ixv-pending" role="status">
      <LCStatus label="Reply on archived deals · property unclear" tone="attn" />
      <span className="ixv-pending__detail">
        {deals.length ? `Still archived: ${deals.join(' · ')}. Restore the deal the seller means from Pipeline › Archived.` : 'Restore the deal the seller means from Pipeline › Archived.'}
      </span>
    </div>
  )
}
