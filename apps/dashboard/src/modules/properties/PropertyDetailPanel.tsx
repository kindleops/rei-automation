import { PropertyDetailWorkspace } from './PropertyDetailWorkspace'
import type { PropertyActionHandlers, PropertyIntelligenceContext, PropertyRecord } from './property.types'

interface PropertyDetailPanelProps {
  property: PropertyRecord
  context: PropertyIntelligenceContext
  rawOpen: boolean
  priorityMarked: boolean
  onClose: () => void
  onCloseRaw: () => void
  handlers: PropertyActionHandlers
}

export const PropertyDetailPanel = ({
  property,
  context,
  rawOpen,
  priorityMarked,
  onClose,
  onCloseRaw,
  handlers,
}: PropertyDetailPanelProps) => (
  <PropertyDetailWorkspace
    property={property}
    context={context}
    rawOpen={rawOpen}
    priorityMarked={priorityMarked}
    onBack={onClose}
    onCloseRaw={onCloseRaw}
    handlers={handlers}
  />
)
