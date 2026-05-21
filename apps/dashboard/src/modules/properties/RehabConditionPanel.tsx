import { Icon } from '../../shared/icons'
import { formatMoney } from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface RehabConditionPanelProps {
  property: PropertyRecord
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-intel-row">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

export const RehabConditionPanel = ({ property }: RehabConditionPanelProps) => (
  <section className="pi-panel">
    <div className="pi-panel-heading">
      <Icon name="activity" />
      <div>
        <span>Condition & Rehab</span>
        <h2>{property.condition.rehabLevel ?? property.condition.buildingCondition ?? 'Condition profile'}</h2>
      </div>
    </div>
    <div className="pi-two-col-list">
      <Row label="Repair Estimate" value={formatMoney(property.condition.estimatedRepairCost)} />
      <Row label="Repair / Sqft" value={formatMoney(property.condition.estimatedRepairCostPerSqft)} />
      <Row label="Building Quality" value={property.condition.buildingQuality ?? 'N/A'} />
      <Row label="Construction" value={property.condition.constructionType ?? 'N/A'} />
      <Row label="County Land Use" value={property.condition.countyLandUseCode ?? 'N/A'} />
      <Row label="Air Conditioning" value={property.condition.airConditioning ?? 'N/A'} />
      <Row label="Heating" value={property.condition.heatingType ?? 'N/A'} />
      <Row label="Roof" value={property.condition.roofCover ?? property.condition.roofType ?? 'N/A'} />
      <Row label="Garage" value={property.condition.garage ?? 'N/A'} />
      <Row label="Pool" value={property.condition.pool ?? 'N/A'} />
      <Row label="Sewer / Water" value={`${property.condition.sewer ?? 'N/A'} / ${property.condition.water ?? 'N/A'}`} />
      <Row label="Other Rooms" value={property.condition.otherRooms ?? 'N/A'} />
    </div>
  </section>
)
