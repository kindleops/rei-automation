import { Icon } from '../../shared/icons'
import { formatDate, formatMoney } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface MLSPanelProps {
  property: PropertyRecord
}

const MlsMetric = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-intel-row">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const MLSPanel = ({ property }: MLSPanelProps) => (
  <section className="pi-panel">
    <div className="pi-panel-heading">
      <Icon name="archive" />
      <div>
        <span>MLS</span>
        <h2>{property.mls.marketStatus ?? 'No MLS status'}</h2>
      </div>
    </div>
    <div className="pi-two-col-list">
      <MlsMetric label="Current Listing" value={formatMoney(property.mls.currentListingPrice)} />
      <MlsMetric label="Sold Date" value={formatDate(property.mls.soldDate)} />
      <MlsMetric label="Sold Price" value={formatMoney(property.mls.soldPrice)} />
      <MlsMetric label="Market Status" value={property.mls.marketStatus ?? 'N/A'} />
    </div>
  </section>
)
