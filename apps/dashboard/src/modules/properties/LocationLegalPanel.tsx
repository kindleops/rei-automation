import { Icon } from '../../shared/icons'
import type { PropertyRecord } from './property.types'

interface LocationLegalPanelProps {
  property: PropertyRecord
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-intel-row">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const LocationLegalPanel = ({ property }: LocationLegalPanelProps) => (
  <section className="pi-panel">
    <div className="pi-panel-heading">
      <Icon name="map" />
      <div>
        <span>Location / Legal</span>
        <h2>{property.city ?? property.market ?? 'Location profile'}</h2>
      </div>
    </div>
    <div className="pi-two-col-list">
      <Row label="County" value={property.county ?? 'N/A'} />
      <Row label="Market Region" value={property.marketRegion ?? 'N/A'} />
      <Row label="APN" value={property.apnParcelId ?? 'N/A'} />
      <Row label="Census Tract" value={property.situsCensusTract ?? 'N/A'} />
      <Row label="Subdivision" value={property.subdivisionName ?? 'N/A'} />
      <Row label="School District" value={property.schoolDistrictName ?? 'N/A'} />
      <Row label="Zoning" value={property.zoning ?? 'N/A'} />
      <Row label="Geo Features" value={property.geographicFeatures ?? 'N/A'} />
    </div>
    {property.legalDescription && <p className="pi-panel-note">{property.legalDescription}</p>}
  </section>
)
