import { Icon } from '../../shared/icons'
import { formatDate, formatMoney } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface SaleHistoryPanelProps {
  property: PropertyRecord
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-intel-row">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const SaleHistoryPanel = ({ property }: SaleHistoryPanelProps) => (
  <section className="pi-panel">
    <div className="pi-panel-heading">
      <Icon name="calendar" />
      <div>
        <span>Sale / Recording</span>
        <h2>{property.sale.saleDate ? formatDate(property.sale.saleDate) : 'Sale history'}</h2>
      </div>
    </div>
    <div className="pi-two-col-list">
      <Row label="Sale Price" value={formatMoney(property.sale.salePrice)} />
      <Row label="Alt Sale Price" value={formatMoney(property.sale.salePriceAlt)} />
      <Row label="Document Type" value={property.sale.documentType ?? 'N/A'} />
      <Row label="Last Sale Doc" value={property.sale.lastSaleDocType ?? 'N/A'} />
      <Row label="Recording Date" value={formatDate(property.sale.recordingDate)} />
      <Row label="Default Date" value={formatDate(property.sale.defaultDate)} />
    </div>
  </section>
)
