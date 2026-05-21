import { PropertyDetailWorkspace } from './PropertyDetailWorkspace'
import type { PropertyActionHandlers, PropertyIntelligenceContext, PropertyRecord } from './property.types'

interface PropertyDetailProps {
  property: PropertyRecord
  context: PropertyIntelligenceContext
  rawOpen: boolean
  priorityMarked: boolean
  onClose: () => void
  onCloseRaw: () => void
  handlers: PropertyActionHandlers
}

export const PropertyDetail = ({
  property,
  context,
  rawOpen,
  priorityMarked,
  onClose,
  onCloseRaw,
  handlers,
}: PropertyDetailProps) => (
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
