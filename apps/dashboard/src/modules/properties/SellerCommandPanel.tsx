import { Icon } from '../../shared/icons'
import type { PropertyIntelligenceContext, PropertyRecord } from './property.types'

interface SellerCommandPanelProps {
  property: PropertyRecord
  context: PropertyIntelligenceContext
  onLinkContact: () => void
}

const Detail = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-intel-row">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const SellerCommandPanel = ({ property, context, onLinkContact }: SellerCommandPanelProps) => {
  const owner = context.owner
  const primaryPhone = context.contacts.primaryPhone
  const primaryEmail = context.contacts.primaryEmail
  const ownerName = owner?.name ?? property.owner.name ?? 'Unknown Owner'

  return (
    <section className="pi-panel pi-seller-panel">
      <div className="pi-panel-heading">
        <Icon name="users" />
        <div>
          <span>Seller Command</span>
          <h2>{ownerName}</h2>
        </div>
      </div>
      <div className="pi-seller-panel__grid">
        <Detail label="Owner Type" value={owner?.type ?? property.owner.type ?? 'N/A'} />
        <Detail label="Owner Location" value={owner?.location ?? property.owner.location ?? 'N/A'} />
        <Detail label="Mailing Address" value={owner?.mailingAddress ?? property.owner.mailingAddress ?? 'N/A'} />
        <Detail label="Ownership" value={property.owner.ownershipYears ? `${property.owner.ownershipYears} years` : 'N/A'} />
        <Detail label="Corporate" value={property.owner.isCorporate ? 'Yes' : 'No'} />
        <Detail label="Out of State" value={property.owner.outOfState ? 'Yes' : 'No'} />
      </div>
      <div className="pi-contact-readiness">
        {primaryPhone || primaryEmail ? (
          <>
            <Icon name="send" />
            <div>
              <span>Best Channel</span>
              <strong>{primaryPhone ? primaryPhone.phoneNumber : primaryEmail?.email}</strong>
              <small>{context.contacts.bestPhoneConfidence ? `${context.contacts.bestPhoneConfidence}% phone confidence` : context.contacts.bestChannel ?? 'Linked contact'}</small>
            </div>
          </>
        ) : (
          <>
            <Icon name="alert" />
            <div>
              <span>Contact Readiness</span>
              <strong>Not linked</strong>
              <small>No phone, email, or prospect records linked.</small>
            </div>
            <button type="button" onClick={onLinkContact}>Link Contact</button>
          </>
        )}
      </div>
    </section>
  )
}
