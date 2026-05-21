import { PropertiesPage } from '../../properties/PropertiesPage'
import type { AcquisitionWorkspaceModel } from '../acquisition.types'

interface PropertyIntelligenceAppProps {
  data: AcquisitionWorkspaceModel
}

export const PropertyIntelligenceApp = ({ data }: PropertyIntelligenceAppProps) => (
  <PropertiesPage workspaceStatus={data.status} fallbackMarketOptions={data.marketOptions} />
)
