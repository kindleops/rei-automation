import { Icon } from '../../shared/icons'
import { formatMoney, formatPercent } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface ValuationPanelProps {
  property: PropertyRecord
}

const ValuationMetric = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-valuation-metric">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const ValuationPanel = ({ property }: ValuationPanelProps) => {
  const equityPercent = Math.max(0, Math.min(100, property.valuation.equityPercent ?? 0))
  const loanLabel =
    property.valuation.totalLoanBalance === null
      ? 'Loan balance unavailable'
      : property.valuation.totalLoanBalance <= 0
        ? 'No recorded debt'
        : formatMoney(property.valuation.totalLoanBalance)

  return (
    <section className="pi-panel pi-workspace-valuation">
      <div className="pi-panel-heading">
        <Icon name="trending-up" />
        <div>
          <span>Valuation & Equity</span>
          <h2>{formatMoney(property.valuation.estimatedValue)}</h2>
        </div>
      </div>
      <div className="pi-workspace-valuation__bar">
        <span style={{ width: `${equityPercent}%` }} />
      </div>
      <div className="pi-workspace-valuation__grid">
        <ValuationMetric label="Equity Amount" value={formatMoney(property.valuation.equityAmount)} />
        <ValuationMetric label="Equity Percent" value={formatPercent(property.valuation.equityPercent)} />
        <ValuationMetric label="Loan Balance" value={loanLabel} />
        <ValuationMetric label="Cash Offer" value={formatMoney(property.valuation.cashOffer)} />
        <ValuationMetric label="Tax Amount" value={formatMoney(property.valuation.taxAmount)} />
        <ValuationMetric label="Tax Year" value={property.valuation.taxYear ? `${property.valuation.taxYear}` : 'N/A'} />
      </div>
    </section>
  )
}
