import { Icon } from '../../shared/icons'
import { formatMoney, formatPercent } from '../../lib/data/propertyData'
import type { PropertyIntelligenceContext, PropertyRecord } from './property.types'

interface DealCommandStripProps {
  property: PropertyRecord
  context: PropertyIntelligenceContext
}

const CommandSignal = ({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: 'target' | 'trending-up' | 'activity' | 'spark' | 'send'
  label: string
  value: string
  detail: string
  tone?: 'risk' | 'good'
}) => (
  <article className={`pi-command-signal ${tone ? `is-${tone}` : ''}`}>
    <Icon name={icon} />
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </article>
)

const contactReadiness = (context: PropertyIntelligenceContext) => {
  if (context.contacts.primaryPhone) return ['SMS Ready', context.contacts.primaryPhone.phoneNumber]
  if (context.contacts.primaryEmail) return ['Email Ready', context.contacts.primaryEmail.email]
  if (context.contacts.prospects.length > 0) return ['Prospect Linked', context.contacts.prospects[0]?.name ?? 'Prospect record']
  return ['Not linked', 'Bridge phone/prospect record']
}

export const DealCommandStrip = ({ property, context }: DealCommandStripProps) => {
  const acquisitionScore = property.finalAcquisitionScore ?? property.dealStrengthScore ?? property.priorityScore
  const scoreLabel = acquisitionScore >= 80 ? 'High intent asset' : acquisitionScore >= 55 ? 'Worth operator review' : 'Monitor and qualify'
  const freeClear = (property.valuation.totalLoanBalance ?? 0) <= 0 && (property.valuation.equityAmount ?? 0) > 0
  const [contactValue, contactDetail] = contactReadiness(context)
  const motivation = property.distress.structuredMotivationScore ?? property.distress.tagDistressScore ?? property.distress.aiScore
  const tags = property.allTags.slice(0, 3).join(' / ') || 'No motivation tags'

  return (
    <section className="pi-deal-strip" aria-label="Deal command strip">
      <CommandSignal icon="target" label="Acquisition Score" value={`${acquisitionScore}`} detail={scoreLabel} tone={acquisitionScore >= 80 ? 'risk' : undefined} />
      <CommandSignal
        icon="trending-up"
        label="Equity Signal"
        value={formatPercent(property.valuation.equityPercent)}
        detail={freeClear ? 'Free and clear' : formatMoney(property.valuation.equityAmount)}
        tone="good"
      />
      <CommandSignal
        icon="activity"
        label="Rehab Signal"
        value={property.condition.rehabLevel ?? property.condition.buildingCondition ?? 'Unknown'}
        detail={property.condition.estimatedRepairCost ? `${formatMoney(property.condition.estimatedRepairCost)} repair estimate` : 'Repair estimate unavailable'}
      />
      <CommandSignal icon="spark" label="Motivation Signal" value={motivation !== null && motivation !== undefined ? `${motivation}` : 'Unscored'} detail={tags} />
      <CommandSignal icon="send" label="Contact Readiness" value={contactValue} detail={contactDetail} tone={context.contacts.primaryPhone ? 'good' : undefined} />
    </section>
  )
}
