import { Icon } from '../../shared/icons'
import { formatMoney, formatPercent } from '../../lib/data/propertyData'
import type { PropertyActionHandlers, PropertyRecord } from './property.types'

interface PropertyCommandHeaderProps {
  property: PropertyRecord
  priorityMarked: boolean
  onBack: () => void
  handlers: PropertyActionHandlers
}

const StatChip = ({ label, value, tone }: { label: string; value: string; tone?: 'risk' | 'good' }) => (
  <div className={`pi-command-stat ${tone ? `is-${tone}` : ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const PropertyCommandHeader = ({ property, priorityMarked, onBack, handlers }: PropertyCommandHeaderProps) => (
  <header className="pi-command-header">
    <div className="pi-command-header__main">
      <nav className="pi-breadcrumb" aria-label="Property Intelligence breadcrumb">
        <span>LeadCommand</span>
        <span>Acquisition</span>
        <span>Property Intelligence</span>
        <strong>{property.street ?? property.address}</strong>
      </nav>
      <div className="pi-command-title-row">
        <button type="button" className="pi-command-back" onClick={onBack}>
          <Icon name="chevron-right" />
          List
        </button>
        <div>
          <h1>{property.address}</h1>
          <p>{property.owner.name ?? 'Unknown Owner'}</p>
        </div>
      </div>
      <div className="pi-command-pills">
        {property.structure.propertyType && <span>{property.structure.propertyType}</span>}
        {property.market && <span>{property.market}</span>}
        {property.owner.type && <span>{property.owner.type}</span>}
        {property.distress.contactStatus && <span>{property.distress.contactStatus}</span>}
        {priorityMarked && <span className="is-priority">Priority Marked</span>}
      </div>
    </div>
    <div className="pi-command-header__stats">
      <StatChip label="Estimated Value" value={formatMoney(property.valuation.estimatedValue)} />
      <StatChip label="Equity" value={`${formatMoney(property.valuation.equityAmount)} / ${formatPercent(property.valuation.equityPercent)}`} tone="good" />
      <StatChip label="Score" value={`${property.finalAcquisitionScore ?? property.dealStrengthScore ?? property.priorityScore}`} tone={(property.finalAcquisitionScore ?? property.priorityScore) >= 80 ? 'risk' : undefined} />
    </div>
    <div className="pi-command-actions" aria-label="Primary property actions">
      <button type="button" className="is-primary" onClick={handlers.sendSms}>
        <Icon name="send" />
        Send SMS
      </button>
      <button type="button" className="is-primary" onClick={handlers.createOffer}>
        <Icon name="trending-up" />
        Create Offer
      </button>
      <button type="button" className="is-primary" onClick={handlers.generateContract}>
        <Icon name="file-text" />
        Generate Contract
      </button>
    </div>
  </header>
)
