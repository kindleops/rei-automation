import { Icon } from '../../shared/icons'
import { formatMoney } from '../../lib/data/propertyData'
import type { PropertyActionHandlers, PropertyOfferPathway } from './property.types'

interface OfferPathwayPanelProps {
  pathway: PropertyOfferPathway
  handlers: PropertyActionHandlers
}

const steps = ['Offer Draft', 'Offer Sent', 'Contract Generated', 'Signed', 'Title', 'Closed']

export const OfferPathwayPanel = ({ pathway, handlers }: OfferPathwayPanelProps) => {
  const hasOffer = Boolean(pathway.latestOffer)
  const hasContract = Boolean(pathway.activeContract)
  const offerSent = pathway.latestOffer?.status?.toLowerCase().includes('sent') ?? false

  return (
    <section className="pi-panel pi-offer-panel">
      <div className="pi-panel-heading">
        <Icon name="file-text" />
        <div>
          <span>Offer & Contract Pathway</span>
          <h2>{hasOffer ? formatMoney(pathway.latestOffer?.amount) : 'No offer created'}</h2>
        </div>
      </div>
      <div className="pi-path-rail">
        {steps.map((step, index) => {
          const active = index === 0
            ? hasOffer
            : index === 1
              ? offerSent
              : index === 2
                ? hasContract
                : false
          return (
            <div key={step} className={active ? 'is-active' : ''}>
              <span>{index + 1}</span>
              <strong>{step}</strong>
            </div>
          )
        })}
      </div>
      <div className="pi-offer-panel__actions">
        <button type="button" disabled={!hasOffer && false} onClick={handlers.createOffer}>Create Offer</button>
        <button type="button" disabled={!hasOffer} onClick={handlers.generateContract}>Generate Contract</button>
      </div>
      {!hasOffer && <p className="pi-action-hint">Pathway progress reflects persisted offer and contract records only.</p>}
    </section>
  )
}