interface BridgeStep {
  label: string
  amount: number | null
  tier?: 'scenario' | 'shadow' | 'authorized'
}

interface Props {
  bridge: BridgeStep[]
  scenarioOffer: number | null
  shadowOffer: number | null
  authorizedOffer: number | null
}

const fmt = (n: number | null) =>
  n != null
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
    : '—'

export function OfferBridge({ bridge, scenarioOffer, shadowOffer, authorizedOffer }: Props) {
  return (
    <section className="ci-offer-bridge" aria-label="Offer bridge">
      <div className="ci-offer-bridge__steps">
        {bridge.map((step) => (
          <div key={step.label} className={`ci-offer-step ci-offer-step--${step.tier ?? 'base'}`}>
            <span className="ci-offer-step__label">{step.label}</span>
            <span className="ci-offer-step__value tabular-nums">{fmt(step.amount)}</span>
          </div>
        ))}
      </div>
      <div className="ci-offer-tiers">
        <article className="ci-offer-tier ci-offer-tier--scenario">
          <h4>Scenario</h4>
          <span className="tabular-nums">{fmt(scenarioOffer)}</span>
        </article>
        <article className="ci-offer-tier ci-offer-tier--shadow">
          <h4>Underwritten Shadow</h4>
          <span className="tabular-nums">{fmt(shadowOffer)}</span>
        </article>
        <article className="ci-offer-tier ci-offer-tier--authorized">
          <h4>Live Authorized</h4>
          <span className="tabular-nums">{fmt(authorizedOffer)}</span>
          {authorizedOffer == null && <span className="ci-offer-tier__note">Disabled</span>}
        </article>
      </div>
    </section>
  )
}