import type { SellerMapCardViewModel } from './seller-map-card.types'
import { SellerMapCardPriorityRing } from './SellerMapCardPriorityRing'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const tierClass = (tier?: string) => {
  if (tier === 'critical') return 'is-critical'
  if (tier === 'motivation') return 'is-motivation'
  if (tier === 'positive') return 'is-positive'
  if (tier === 'context') return 'is-context'
  return 'is-neutral'
}

export const SellerMapCardMetrics = ({
  metrics,
  variant,
}: {
  metrics: SellerMapCardViewModel['peekMetrics']
  variant: 'peek' | 'focus'
}) => (
  <div className={cls('smc-metrics', variant === 'focus' && 'smc-metrics--focus', 'smc-metrics--dense')} aria-label="Primary metrics">
    {metrics.map((metric) => (
      <div key={metric.label} className={cls('smc-metric', metric.emphasis === 'primary' && 'is-primary')}>
        <span>{metric.label}</span>
        <strong>{metric.value}</strong>
      </div>
    ))}
  </div>
)

export const SellerMapCardWeightedTags = ({
  flags,
  hiddenCount = 0,
}: {
  flags: SellerMapCardViewModel['flags']
  hiddenCount?: number
}) => {
  if (flags.length === 0) return null
  return (
    <div className="smc-flags smc-flags--weighted">
      {flags.map((flag) => (
        <span
          key={flag.key}
          className={cls('smc-flag', tierClass(flag.tier), `is-${flag.severity}`)}
          title={flag.tooltip}
        >
          {flag.label}
        </span>
      ))}
      {hiddenCount > 0 ? <span className="smc-flag is-more">+{hiddenCount}</span> : null}
    </div>
  )
}

export const SellerMapCardFinancialSection = ({
  financialProfile,
}: {
  financialProfile: SellerMapCardViewModel['financialProfile']
}) => {
  if (financialProfile.fields.length === 0 && financialProfile.meters.length === 0) return null
  return (
    <section className="smc-section smc-section--financial" aria-label="Financial profile">
      <h4>Financial Profile</h4>
      {financialProfile.meters.length > 0 ? (
        <div className="smc-fin-meters">
          {financialProfile.meters.map((meter) => (
            <div key={meter.key} className="smc-fin-meter">
              <div className="smc-fin-meter__head">
                <span>{meter.label}</span>
                <strong>{meter.caption || `${meter.percent}%`}</strong>
              </div>
              <div className="smc-fin-meter__track" aria-hidden="true">
                <span className="smc-fin-meter__fill" style={{ width: `${meter.percent}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {financialProfile.pressureCaption ? (
        <p className="smc-fin-caption">{financialProfile.pressureCaption}</p>
      ) : null}
      <div className="smc-kv-grid smc-kv-grid--compact">
        {financialProfile.fields.map((field) => (
          <div key={field.label} className="smc-kv"><span>{field.label}</span><strong>{field.value}</strong></div>
        ))}
      </div>
    </section>
  )
}

export const SellerMapCardOwnerPressureSection = ({
  ownerPressure,
  ownerFields,
}: {
  ownerPressure: SellerMapCardViewModel['ownerPressure']
  ownerFields: SellerMapCardViewModel['focusOwnerFields']
}) => {
  if (ownerPressure.score == null && ownerFields.length === 0) return null
  return (
    <section className="smc-section smc-section--owner-pressure" aria-label="Master owner profile">
      <h4>Ownership / Master Owner</h4>
      {ownerPressure.score != null ? (
        <div className="smc-pressure-card">
          <div className="smc-pressure-card__head">
            <span>Owner Pressure</span>
            <strong>{ownerPressure.score} · {ownerPressure.label}</strong>
          </div>
          {ownerPressure.summary ? <p className="smc-pressure-card__summary">{ownerPressure.summary}</p> : null}
          {ownerPressure.drivers.length > 0 ? (
            <div className="smc-pressure-card__drivers">
              {ownerPressure.drivers.slice(0, 4).map((driver) => (
                <span key={driver.label} className={cls('smc-pressure-driver', `is-${driver.impact}`)}>
                  {driver.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {ownerFields.length > 0 ? (
        <div className="smc-kv-grid smc-kv-grid--compact">
          {ownerFields.map((field) => (
            <div key={field.label} className="smc-kv"><span>{field.label}</span><strong>{field.value}</strong></div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

export const SellerMapCardProspectSection = ({
  prospectProfile,
}: {
  prospectProfile: SellerMapCardViewModel['prospectProfile']
}) => (
  <section className="smc-section smc-section--prospect" aria-label="Prospect contactability">
    <h4>Prospect / Contactability</h4>
    {prospectProfile.emptyState ? (
      <p className="smc-empty-line">{prospectProfile.emptyState}</p>
    ) : (
      <>
        <div className="smc-contact-meter">
          <div className="smc-contact-meter__head">
            <span>Contactability</span>
            <strong>{prospectProfile.meterLabel}</strong>
          </div>
          <div className="smc-contact-meter__track" aria-hidden="true">
            <span className="smc-contact-meter__fill" style={{ width: `${prospectProfile.meterPercent}%` }} />
          </div>
          <div className="smc-contact-badges">
            {prospectProfile.badges.map((badge) => (
              <span key={badge.key} className={cls('smc-contact-badge', `is-${badge.tone}`)}>{badge.label}</span>
            ))}
          </div>
        </div>
        <div className="smc-kv-grid smc-kv-grid--compact">
          {prospectProfile.fields.map((field) => (
            <div key={field.label} className="smc-kv"><span>{field.label}</span><strong>{field.value}</strong></div>
          ))}
        </div>
      </>
    )}
  </section>
)

export const SellerMapCardIntelligenceSection = ({
  viewModel,
}: {
  viewModel: SellerMapCardViewModel
}) => (
  <section className="smc-intel-section smc-intel-section--compact" aria-label="Property intelligence">
    <div className="smc-intel-head">
      <span className="smc-intel-head__label">Property Intelligence</span>
    </div>
    <div className="smc-intel-strip smc-intel-strip--compact">
      {viewModel.intelligenceStrip.map((field) => (
        <div key={field.label} className="smc-intel-strip__cell">
          <span>{field.label}</span>
          <strong>{field.value}</strong>
        </div>
      ))}
      <div className="smc-intel-strip__priority smc-intel-strip__priority--compact">
        <SellerMapCardPriorityRing
          score={viewModel.masterOwner.priorityScore}
          tier={null}
          classification={viewModel.masterOwner.priorityClassification}
          size={36}
          showUnscoredLabel={viewModel.masterOwner.priorityScore == null}
        />
      </div>
    </div>
  </section>
)

export const SellerMapCardPropertyProfileSection = ({
  groups,
}: {
  groups: SellerMapCardViewModel['propertyProfileGroups']
}) => {
  if (groups.length === 0) return null
  return (
    <section className="smc-section smc-section--profile" aria-label="Property profile">
      <h4>Property Profile</h4>
      {groups.map((group) => (
        <div key={group.key} className="smc-profile-group">
          <h5>{group.label}</h5>
          <div className="smc-kv-grid smc-kv-grid--compact">
            {group.fields.map((field) => (
              <div key={`${group.key}-${field.label}`} className="smc-kv">
                <span>{field.label}</span>
                <strong>{field.value}</strong>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

export const SellerMapCardContactStateStrip = ({
  label,
  activeCommunication,
}: {
  label: string
  activeCommunication: boolean
}) => (
  <div className="smc-contact-state" aria-label="Contact state">
    <span className={cls('smc-contact-state__pill', activeCommunication && 'is-active')}>{label}</span>
    {activeCommunication ? <span className="smc-contact-state__badge">Active Communication</span> : null}
  </div>
)

export const SellerMapCardOperationSection = ({
  fields,
}: {
  fields: SellerMapCardViewModel['focusOperationFields']
}) => {
  if (fields.length === 0) return null
  return (
    <section className="smc-section smc-section--ops" aria-label="Contact state and automation">
      <h4>Contact State</h4>
      <div className="smc-kv-grid smc-kv-grid--compact">
        {fields.map((field) => (
          <div key={field.label} className="smc-kv"><span>{field.label}</span><strong>{field.value}</strong></div>
        ))}
      </div>
    </section>
  )
}