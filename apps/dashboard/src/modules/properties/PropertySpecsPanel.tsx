import { Icon } from '../../shared/icons'
import { formatNumber } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface PropertySpecsPanelProps {
  property: PropertyRecord
}

const Spec = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-intel-row">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const PropertySpecsPanel = ({ property }: PropertySpecsPanelProps) => (
  <section className="pi-panel">
    <div className="pi-panel-heading">
      <Icon name="grid" />
      <div>
        <span>Property Specs</span>
        <h2>{property.structure.propertyType ?? 'Asset profile'}</h2>
      </div>
    </div>
    <div className="pi-two-col-list">
      <Spec label="Class" value={property.structure.propertyClass ?? 'N/A'} />
      <Spec label="Beds / Baths" value={`${property.structure.beds ?? 'N/A'} / ${property.structure.baths ?? 'N/A'}`} />
      <Spec label="Units" value={property.structure.unitsCount ? `${property.structure.unitsCount}` : 'N/A'} />
      <Spec label="Building Sqft" value={property.structure.buildingSqft ? formatNumber(property.structure.buildingSqft) : 'N/A'} />
      <Spec label="Lot Sqft" value={property.structure.lotSqft ? formatNumber(property.structure.lotSqft) : 'N/A'} />
      <Spec label="Lot Acreage" value={property.structure.lotAcreage ? `${property.structure.lotAcreage}` : 'N/A'} />
      <Spec label="Year Built" value={property.structure.yearBuilt ? `${property.structure.yearBuilt}` : 'N/A'} />
      <Spec label="Effective Year" value={property.structure.effectiveYearBuilt ? `${property.structure.effectiveYearBuilt}` : 'N/A'} />
      <Spec label="Stories" value={property.structure.stories ? `${property.structure.stories}` : 'N/A'} />
      <Spec label="Garage Sqft" value={property.structure.garageSqft ? formatNumber(property.structure.garageSqft) : 'N/A'} />
      <Spec label="Sqft Range" value={property.structure.sqftRange ?? 'N/A'} />
      <Spec label="Style" value={property.structure.style ?? 'N/A'} />
    </div>
  </section>
)
