import { Icon } from '../../shared/icons'
import { formatMoney } from '../../lib/data/propertyData'
import type { PropertyAcquisitionDecision } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface AcquisitionScorePanelProps {
  property: PropertyRecord
  decision?: PropertyAcquisitionDecision | null
}

/**
 * These five are Podio-era import columns, not output of the current model.
 * They stay visible -- they are the only scoring this page has for a property
 * the Decision Engine has not run on -- but under a heading that says what they
 * are, because "AI" and "Final" read as current-model provenance they do not
 * have.
 */
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

export const AcquisitionScorePanel = ({ property, decision = null }: AcquisitionScorePanelProps) => {
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
          <span className="pi-score-panel__legacy-label">Legacy import scores</span>
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
      {/*
        This block used to read `Cash Offer  $26,110` for 5115 Michigan Ave --
        `properties.cash_offer`, a Podio-era import, presented with no
        provenance as the current offer, while the Decision Engine's current
        result for the same property was $62,300.

        The current answer comes from `property_acquisition_scores`. When there
        is no row the honest state is "not run", which is ACTIONABLE -- the
        engine is run on demand -- and never a reason to fall back to the
        legacy number.
      */}
      {decision?.state === 'current' ? (
        <div className="pi-score-panel__offer">
          <div>
            <span>Recommended Offer</span>
            <strong>{formatMoney(decision.recommendedOffer)}</strong>
          </div>
          <div>
            <span>Offer Floor</span>
            <strong>{formatMoney(decision.offerFloor)}</strong>
          </div>
          <div>
            <span>Authorized Ceiling</span>
            <strong>{formatMoney(decision.authorizedCeiling)}</strong>
          </div>
          <div>
            <span>Strategy</span>
            <strong>{decision.strategy ?? 'N/A'}</strong>
          </div>
        </div>
      ) : (
        <div className="pi-score-panel__offer pi-score-panel__offer--not-run">
          <div>
            <span>Recommended Offer</span>
            <strong>Decision Engine not run</strong>
          </div>
          <div>
            <span>Next step</span>
            <strong>Run Decision Engine</strong>
          </div>
          {decision?.legacyCashOffer != null ? (
            <div>
              <span>Legacy import (not current)</span>
              <strong>{formatMoney(decision.legacyCashOffer)}</strong>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
