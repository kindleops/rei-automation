import type { SellerMapCardViewModel } from './seller-map-card.types'
import type { DossierField, DossierFieldGroup } from './seller-property-dossier-contract'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const tierClass = (tier?: string) => {
  if (tier === 'critical') return 'is-critical'
  if (tier === 'motivation') return 'is-motivation'
  if (tier === 'positive') return 'is-positive'
  if (tier === 'context') return 'is-context'
  return 'is-neutral'
}

export const SellerMapCardBadgeRail = ({ badges }: { badges: SellerMapCardViewModel['headerBadges'] }) => (
  <div className="smc-state-row smc-state-row--below-image" aria-label="Canonical lead state">
    {badges.map((badge) => (
      <span
        key={badge.key}
        className={cls(
          'smc-badge',
          badge.tone === 'stage' && 'smc-badge--stage',
          badge.tone === 'status' && 'smc-badge--status',
          badge.tone === 'score' && 'smc-badge--score',
          badge.tone === 'asset' && 'smc-badge--asset',
          badge.tone === 'units' && 'smc-badge--units',
        )}
      >
        {badge.label}
      </span>
    ))}
  </div>
)

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
  flags: SellerMapCardViewModel['weightedSignals']
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

const DossierFieldGrid = ({ fields }: { fields: DossierField[] }) => {
  if (fields.length === 0) return null
  return (
    <div className="smc-kv-grid smc-kv-grid--compact smc-kv-grid--micro">
      {fields.map((field) => (
        <div key={field.key} className="smc-kv smc-kv--flat">
          <span>{field.label}</span>
          <strong>{field.value}</strong>
        </div>
      ))}
    </div>
  )
}

const DossierGroup = ({ group }: { group: DossierFieldGroup }) => (
  <div className="smc-dossier-group">
    <h5>{group.label}</h5>
    <DossierFieldGrid fields={group.fields} />
  </div>
)

export const SellerMapCardDossierSections = ({
  viewModel,
  loading,
}: {
  viewModel: SellerMapCardViewModel
  loading?: boolean
}) => {
  if (loading) {
    return (
      <div className="smc-dossier-skeleton" aria-label="Loading property dossier">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="smc-dossier-skeleton__row" />
        ))}
      </div>
    )
  }

  const dossier = viewModel.dossier
  if (!dossier) return null

  return (
    <div className="smc-dossier-scroll">
      {dossier.propertyDetails.length > 0 ? (
        <section className="smc-section smc-section--property-details" aria-label="Property details">
          <h4>Property Details</h4>
          {dossier.propertyDetails.map((group) => (
            <DossierGroup key={group.key} group={group} />
          ))}
        </section>
      ) : null}

      {dossier.valuationAssessment.length > 0 ? (
        <section className="smc-section smc-section--valuation" aria-label="Valuation and assessment">
          <h4>Valuation & Assessment</h4>
          <DossierFieldGrid fields={dossier.valuationAssessment} />
        </section>
      ) : null}

      {dossier.loanTransaction.length > 0 ? (
        <section className="smc-section smc-section--loan" aria-label="Loan and transaction">
          <h4>Loan & Transaction</h4>
          <DossierFieldGrid fields={dossier.loanTransaction} />
        </section>
      ) : null}

      {dossier.distressLegal && dossier.distressLegal.length > 0 ? (
        <section className="smc-section smc-section--distress" aria-label="Distress and legal">
          <h4>Distress & Legal</h4>
          <DossierFieldGrid fields={dossier.distressLegal} />
        </section>
      ) : null}

      {dossier.assetSpecific.length > 0 ? (
        <section className="smc-section smc-section--asset-specific" aria-label="Asset-specific details">
          <h4>Asset-Specific Details</h4>
          <DossierFieldGrid fields={dossier.assetSpecific} />
        </section>
      ) : null}

      {viewModel.weightedSignals.length > 0 ? (
        <section className="smc-section smc-section--signals" aria-label="Weighted property signals">
          <h4>Weighted Property Signals</h4>
          <SellerMapCardWeightedTags flags={viewModel.weightedSignals} />
        </section>
      ) : null}
    </div>
  )
}

export const SellerMapCardOperationalState = ({ state }: { state: string | null }) => {
  if (!state) return null
  return <p className="smc-operational-state">{state}</p>
}