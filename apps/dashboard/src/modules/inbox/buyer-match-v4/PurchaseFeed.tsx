import type { PurchaseEvent, RankedBuyer } from './buyer-match-v4.types'
import { formatBuyerClassLabel } from './buyerFilters'
import { fmtCurrency, fmtDate, fmtMiles } from './formatters'

interface Props {
  events: PurchaseEvent[]
  buyers: RankedBuyer[]
  selectedEventId: string | null
  selectedBuyerId: string | null
  onSelectEvent: (eventId: string, buyerId: string) => void
}

function buyerLabel(event: PurchaseEvent, buyers: RankedBuyer[]): string {
  const fid = event.buyerFamilyId ?? event.buyerId
  const b = buyers.find((x) => x.buyerId === fid)
  if (b?.buyerName) return b.buyerName
  if (event.buyerName && event.buyerName !== 'Unknown buyer') return event.buyerName
  if (event.demandEligibility === 'IDENTITY_UNRESOLVED') return 'Identity unresolved'
  return event.legalEntityName ?? 'Identity unresolved'
}

function priceLabel(e: PurchaseEvent): string {
  if (e.transactionScope === 'MULTI_ASSET_PACKAGE' || e.transactionScope === 'PORTFOLIO') {
    const total = fmtCurrency(e.totalConsideration)
    const count = e.packageAssetCount ?? '—'
    return `Portfolio · ${count} properties · ${total} total`
  }
  if (!e.pricingEligible && e.totalConsideration) {
    return `Demand evidence · ${fmtCurrency(e.totalConsideration)} package (not per-property)`
  }
  return fmtCurrency(e.propertyAllocatedConsideration ?? e.purchasePrice)
}

export function PurchaseFeed({
  events,
  buyers,
  selectedEventId,
  selectedBuyerId,
  onSelectEvent,
}: Props) {
  return (
    <aside className="bmv4-rail bmv4-rail--feed">
      <div className="bmv4-rail__head">
        <span className="bmv4-eyebrow">Purchase Timeline</span>
        <span className="bmv4-tabular">{events.length} events</span>
      </div>
      {events.length === 0 ? (
        <p className="bmv4-muted">No purchase events match current filters.</p>
      ) : (
        <ul className="bmv4-feed">
          {events.map((e) => {
            const familyId = e.buyerFamilyId ?? e.buyerId
            const isPackage = e.transactionScope !== 'SINGLE_ASSET'
            return (
              <li key={e.eventId}>
                <button
                  type="button"
                  className={`bmv4-feed__item${selectedEventId === e.eventId ? ' is-selected' : ''}${selectedBuyerId === familyId ? ' is-buyer' : ''}${isPackage ? ' is-package' : ''}`}
                  onClick={() => onSelectEvent(e.eventId, familyId)}
                >
                  <div className="bmv4-feed__buyer">{buyerLabel(e, buyers)}</div>
                  {e.legalEntityName && e.legalEntityName !== buyerLabel(e, buyers) && (
                    <div className="bmv4-feed__entity">{e.legalEntityName}</div>
                  )}
                  <div className="bmv4-feed__addr">{e.address}</div>
                  <div className="bmv4-feed__meta bmv4-tabular">
                    <span>{priceLabel(e)}</span>
                    <span>{fmtDate(e.purchaseDate)}</span>
                    <span>{fmtMiles(e.distanceMiles)}</span>
                    <span>{e.assetLane ?? '—'}</span>
                  </div>
                  <div className="bmv4-feed__tags">
                    <span>{e.transactionScope?.replace(/_/g, ' ') ?? 'unknown scope'}</span>
                    <span>{formatBuyerClassLabel(e.buyerClass)}</span>
                    {e.pricingEligible ? <span>Pricing eligible</span> : <span>Demand evidence</span>}
                  </div>
                  <div className="bmv4-feed__source">{e.sourceLabel ?? 'Verified purchase record'}</div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}