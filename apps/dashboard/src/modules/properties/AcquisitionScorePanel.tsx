import { Icon } from '../../shared/icons'
import { formatMoney, formatPercent } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface AcquisitionScorePanelProps {
  property: PropertyRecord
}

const scoreRows = [
  ['Final', 'finalAcquisitionScore'],
  ['Deal', 'dealStrengthScore'],
  ['Motivation', 'structuredMotivationScore'],
  ['Tag Distress', 'tagDistressScore'],
  ['AI', 'aiScore'],
] as const

const buildOpportunityNarrative = (property: PropertyRecord) => {
  const fragments = []
  const freeClear = (property.valuation.totalLoanBalance ?? 0) <= 0 && (property.valuation.equityAmount ?? 0) > 0
  if (freeClear) fragments.push('free and clear')
  if ((property.valuation.equityPercent ?? 0) >= 65) fragments.push('high equity')
  if (property.owner.outOfState) fragments.push('out-of-state owner')
  if (property.condition.rehabLevel) fragments.push(`${property.condition.rehabLevel.toLowerCase()} rehab profile`)
  if (property.distress.taxDelinquent) fragments.push('tax delinquency signal')
  if (property.allTags.length > 0) fragments.push(property.allTags.slice(0, 2).join(' and ').toLowerCase())

  if (fragments.length === 0) {
    return 'Opportunity quality needs more contact, motivation, and valuation evidence before a confident next move.'
  }

  return `${property.structure.propertyType ?? 'Property'} with ${fragments.join(', ')}. Prioritize clean contact linkage, validate repair exposure, then move to offer math.`
}

export const AcquisitionScorePanel = ({ property }: AcquisitionScorePanelProps) => {
  const score = property.finalAcquisitionScore ?? property.dealStrengthScore ?? property.priorityScore
  const circumference = 314
  const progress = circumference - (Math.max(0, Math.min(100, score)) / 100) * circumference

  return (
    <section className="pi-panel pi-score-panel">
      <div className="pi-panel-heading">
        <Icon name="brain" />
        <div>
          <span>Acquisition Intelligence</span>
          <h2>Why this asset matters</h2>
        </div>
      </div>
      <div className="pi-score-panel__body">
        <div className="pi-score-orbit" aria-label={`Acquisition score ${score}`}>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="50" />
            <circle cx="60" cy="60" r="50" style={{ strokeDashoffset: progress }} />
          </svg>
          <strong>{score}</strong>
          <span>Score</span>
        </div>
        <div>
          <p>{buildOpportunityNarrative(property)}</p>
          <div className="pi-score-panel__metrics">
            {scoreRows.map(([label, key]) => (
              <div key={key}>
                <span>{label}</span>
                <strong>{property[key] ?? 'N/A'}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="pi-score-panel__offer">
        <div>
          <span>Cash Offer</span>
          <strong>{formatMoney(property.valuation.cashOffer)}</strong>
        </div>
        <div>
          <span>Offer vs Loan</span>
          <strong>{formatPercent(property.valuation.offerVsLoan)}</strong>
        </div>
        <div>
          <span>Offer vs Sale</span>
          <strong>{formatPercent(property.valuation.offerVsSalePrice)}</strong>
        </div>
      </div>
    </section>
  )
}
