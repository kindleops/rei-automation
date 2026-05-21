import { Icon } from '../../shared/icons'
import { formatMoney } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface AssessmentPanelProps {
  property: PropertyRecord
}

const Value = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-intel-row">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const AssessmentPanel = ({ property }: AssessmentPanelProps) => (
  <section className="pi-panel">
    <div className="pi-panel-heading">
      <Icon name="stats" />
      <div>
        <span>Assessment</span>
        <h2>{formatMoney(property.valuation.assessedTotalValue)}</h2>
      </div>
    </div>
    <div className="pi-two-col-list">
      <Value label="Assessed Improvement" value={formatMoney(property.valuation.assessedImprovementValue)} />
      <Value label="Assessed Land" value={formatMoney(property.valuation.assessedLandValue)} />
      <Value label="Assessed Year" value={property.valuation.assessedYear ? `${property.valuation.assessedYear}` : 'N/A'} />
      <Value label="Calculated Total" value={formatMoney(property.valuation.calculatedTotalValue)} />
      <Value label="Calculated Improvement" value={formatMoney(property.valuation.calculatedImprovementValue)} />
      <Value label="Calculated Land" value={formatMoney(property.valuation.calculatedLandValue)} />
    </div>
  </section>
)
