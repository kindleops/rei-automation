import { Icon } from '../../shared/icons'
import { formatMoney } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface DistressPanelProps {
  property: PropertyRecord
}

const severeTerms = ['foreclosure', 'default', 'tax delinquent', 'active lien']
const riskTerms = ['absentee', 'senior', 'tired landlord', 'dated', 'vacant', 'probate', 'distressed']

const tagTone = (tag: string) => {
  const normalized = tag.toLowerCase()
  if (severeTerms.some((term) => normalized.includes(term))) return 'severe'
  if (riskTerms.some((term) => normalized.includes(term))) return 'risk'
  return 'opportunity'
}

export const DistressPanel = ({ property }: DistressPanelProps) => {
  const tags = Array.from(new Set([...property.distressSignals, ...property.allTags])).slice(0, 16)

  return (
    <section className="pi-panel pi-distress-panel">
      <div className="pi-panel-heading">
        <Icon name="alert" />
        <div>
          <span>Risk & Motivation</span>
          <h2>{property.distress.marketStatusLabel ?? property.distress.marketSubStatus ?? 'Signal review'}</h2>
        </div>
      </div>
      <div className="pi-distress-facts">
        <div>
          <span>Tax Delinquent</span>
          <strong>{property.distress.taxDelinquent ? `Yes${property.distress.taxDelinquentYear ? ` (${property.distress.taxDelinquentYear})` : ''}` : 'No'}</strong>
        </div>
        <div>
          <span>Active Lien</span>
          <strong>{property.distress.activeLien ? 'Yes' : 'No'}</strong>
        </div>
        <div>
          <span>Past Due</span>
          <strong>{formatMoney(property.distress.pastDueAmount)}</strong>
        </div>
        <div>
          <span>Flood Zone</span>
          <strong>{property.distress.floodZone ?? 'N/A'}</strong>
        </div>
      </div>
      <div className="pi-intel-tags">
        {tags.length > 0 ? (
          tags.map((tag) => <span key={tag} className={`is-${tagTone(tag)}`}>{tag}</span>)
        ) : (
          <span>No motivation tags detected</span>
        )}
      </div>
      {property.distress.lienholderName && (
        <p className="pi-panel-note">Lienholder: {property.distress.lienholderName}</p>
      )}
    </section>
  )
}
