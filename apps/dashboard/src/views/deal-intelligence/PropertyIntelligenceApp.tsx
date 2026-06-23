import { PropertiesPage } from '../../modules/properties/PropertiesPage'
import type { AcquisitionWorkspaceModel } from '../../domain/acquisition/acquisition.types'

interface PropertyIntelligenceAppProps {
  data: AcquisitionWorkspaceModel
}

export const PropertyIntelligenceApp = ({ data }: PropertyIntelligenceAppProps) => (
  <PropertiesPage workspaceStatus={data.status} fallbackMarketOptions={data.marketOptions} />
)
