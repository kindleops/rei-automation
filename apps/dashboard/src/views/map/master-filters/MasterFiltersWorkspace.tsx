import { MasterFiltersProvider, type MasterFiltersProviderProps } from './MasterFiltersProvider'
import { MasterFiltersDesktop } from './desktop/MasterFiltersDesktop'
import { MasterFiltersMobile } from './mobile/MasterFiltersMobile'
import './styles/master-filters.css'

export interface MasterFiltersWorkspaceProps extends Omit<MasterFiltersProviderProps, 'children'> {
  isMobile: boolean
}

export function MasterFiltersWorkspace({
  isMobile,
  ...providerProps
}: MasterFiltersWorkspaceProps) {
  return (
    <MasterFiltersProvider {...providerProps}>
      {isMobile ? <MasterFiltersMobile /> : <MasterFiltersDesktop />}
    </MasterFiltersProvider>
  )
}

export { MasterFiltersProvider, useMasterFilters } from './MasterFiltersProvider'
export type { MasterFiltersProviderProps } from './MasterFiltersProvider'
export * from './types'
export * from './api'
export * from './expression-utils'