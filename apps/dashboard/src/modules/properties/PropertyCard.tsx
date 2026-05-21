import { Icon } from '../../shared/icons'
import { formatDate, formatMoney, formatNumber, formatPercent } from '../../lib/data/propertyData'
import type { PropertyIntelligenceContext, PropertyRecord } from './property.types'

interface PropertyCardProps {
  property: PropertyRecord
  context: PropertyIntelligenceContext
  priorityMarked: boolean
  onOpen: () => void
  onFlag: () => void
  onInbox: () => void
  onMap: () => void
}

const Badge = ({ children, risk }: { children: string; risk?: boolean }) => (
  <span className={risk ? 'is-risk' : ''}>{children}</span>
)

export const PropertyCard = ({
  property,
  context,
  priorityMarked,
  onOpen,
  onFlag,
  onInbox,
  onMap,
}: PropertyCardProps) => {
  const outreachStatus = context.queue.latest?.status ?? context.messages[0]?.deliveryStatus ?? context.messages[0]?.status ?? 'No outreach'
  const distressBadges = property.distressSignals.slice(0, 4)

  return (
    <article className={`pi-property-card ${property.priorityScore >= 80 ? 'is-priority' : ''}`}>
      <button type="button" className="pi-property-card__body" onClick={onOpen}>
        <header>
          <div>
            <span>{property.market ?? 'Unknown Market'}</span>
            <h3>{property.address}</h3>
          </div>
          <strong>{property.priorityScore}</strong>
        </header>
        <section className="pi-property-card__owner">
          <div>
            <span>Owner</span>
            <strong>{property.ownerName ?? 'Unknown Owner'}</strong>
          </div>
          <div>
            <span>Type</span>
            <strong>{property.ownerType ?? 'N/A'}</strong>
          </div>
        </section>
        <section className="pi-property-card__metrics">
          <div>
            <span>Estimated Value</span>
            <strong>{formatMoney(property.estimatedValue)}</strong>
          </div>
          <div>
            <span>Equity</span>
            <strong>{formatMoney(property.equityAmount)} / {formatPercent(property.equityPercent)}</strong>
          </div>
          <div>
            <span>Beds / Baths</span>
            <strong>{property.beds ?? 'N/A'} / {property.baths ?? 'N/A'}</strong>
          </div>
          <div>
            <span>Sqft / Built</span>
            <strong>{property.sqft ? formatNumber(property.sqft) : 'N/A'} / {property.yearBuilt ?? 'N/A'}</strong>
          </div>
        </section>
        <section className="pi-property-card__signals">
          {property.taxDelinquent && <Badge risk>Tax Delinquent</Badge>}
          {property.activeLien && <Badge risk>Active Lien</Badge>}
          {distressBadges.map((signal) => <Badge key={signal}>{signal}</Badge>)}
          {distressBadges.length === 0 && !property.taxDelinquent && !property.activeLien && <Badge>Clear Signals</Badge>}
        </section>
        <footer>
          <span>{property.saleDate ? `Last sale ${formatDate(property.saleDate)}` : 'Sale history unavailable'}</span>
          <span>{property.ownershipYears ? `${property.ownershipYears} yrs owned` : 'Ownership age N/A'}</span>
          <em>{outreachStatus}</em>
        </footer>
      </button>
      <div className="pi-property-card__actions">
        <button type="button" className={priorityMarked ? 'is-active' : ''} onClick={onFlag} title="Mark priority">
          <Icon name={priorityMarked ? 'star' : 'flag'} />
        </button>
        <button type="button" onClick={onInbox} title="Open inbox thread">
          <Icon name="inbox" />
        </button>
        <button type="button" onClick={onMap} title="View on map">
          <Icon name="map" />
        </button>
      </div>
    </article>
  )
}
