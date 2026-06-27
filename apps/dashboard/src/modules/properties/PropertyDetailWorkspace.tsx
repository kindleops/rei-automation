import { AcquisitionScorePanel } from './AcquisitionScorePanel'
import { AssessmentPanel } from './AssessmentPanel'
import { DealCommandStrip } from './DealCommandStrip'
import { DistressPanel } from './DistressPanel'
import { LocationLegalPanel } from './LocationLegalPanel'
import { MLSPanel } from './MLSPanel'
import { NextActionPanel } from './NextActionPanel'
import { OfferPathwayPanel } from './OfferPathwayPanel'
import { OutreachPanel } from './OutreachPanel'
import { PropertyCommandHeader } from './PropertyCommandHeader'
import { PropertySpecsPanel } from './PropertySpecsPanel'
import { PropertyVisualIntelligence } from './PropertyVisualIntelligence'
import { RawRecordDrawer } from './RawRecordDrawer'
import { RehabConditionPanel } from './RehabConditionPanel'
import { SaleHistoryPanel } from './SaleHistoryPanel'
import { SellerCommandPanel } from './SellerCommandPanel'
import { ValuationPanel } from './ValuationPanel'
import { CensusIntelligencePanel } from './CensusIntelligencePanel'
import { UniversalLeadStateControls } from '../../domain/lead-state/UniversalLeadStateControls'
import type { PropertyActionHandlers, PropertyIntelligenceContext, PropertyRecord } from './property.types'

const resolvePropertyThreadKey = (context: PropertyIntelligenceContext): string => {
  const phone = context.contacts.primaryPhone?.phoneNumber
    || context.messages.find((m) => m.direction === 'inbound')?.fromPhoneNumber
    || context.messages[0]?.toPhoneNumber
    || context.messages[0]?.fromPhoneNumber
    || ''
  const digits = String(phone).replace(/\D/g, '')
  if (!digits) return ''
  const normalized = digits.length === 10 ? `+1${digits}` : digits.startsWith('1') && digits.length === 11 ? `+${digits}` : `+${digits}`
  return normalized
}

interface PropertyDetailWorkspaceProps {
  property: PropertyRecord
  context: PropertyIntelligenceContext
  rawOpen: boolean
  priorityMarked: boolean
  onBack: () => void
  onCloseRaw: () => void
  handlers: PropertyActionHandlers
}

export const PropertyDetailWorkspace = ({
  property,
  context,
  rawOpen,
  priorityMarked,
  onBack,
  onCloseRaw,
  handlers,
}: PropertyDetailWorkspaceProps) => {
  const threadKey = resolvePropertyThreadKey(context)
  const leadStateThread = threadKey
    ? {
        threadKey,
        thread_key: threadKey,
        property_id: property.propertyId ?? property.id,
        lead_temperature: (property.priorityScore ?? 0) >= 80 ? 'hot' : (property.priorityScore ?? 0) >= 55 ? 'warm' : 'unscored',
      }
    : null

  return (
  <section className="pi-workspace" aria-label="Property intelligence workspace">
    <PropertyCommandHeader property={property} context={context} priorityMarked={priorityMarked} onBack={onBack} handlers={handlers} />
    {leadStateThread ? (
      <div className="pi-lead-state-controls">
        <UniversalLeadStateControls thread={leadStateThread} sourceView="property_lists" compact />
      </div>
    ) : null}
    <main className="pi-workspace-grid">
      <section className="pi-workspace-left">
        <PropertyVisualIntelligence property={property} handlers={handlers} />
        <AcquisitionScorePanel property={property} />
      </section>
      <section className="pi-workspace-center">
        <DealCommandStrip property={property} context={context} />
        <SellerCommandPanel property={property} context={context} onLinkContact={handlers.linkContact} />
        <ValuationPanel property={property} />
        <DistressPanel property={property} />
      </section>
      <section className="pi-workspace-right">
        <NextActionPanel property={property} context={context} priorityMarked={priorityMarked} handlers={handlers} />
        <OfferPathwayPanel pathway={context.offerPathway} handlers={handlers} />
        <OutreachPanel context={context} />
      </section>
    </main>
    <section className="pi-workspace-below" aria-label="Additional property intelligence">
      <CensusIntelligencePanel property={property} />
      <PropertySpecsPanel property={property} />
      <RehabConditionPanel property={property} />
      <AssessmentPanel property={property} />
      <SaleHistoryPanel property={property} />
      <MLSPanel property={property} />
      <LocationLegalPanel property={property} />
    </section>
    <RawRecordDrawer property={property} open={rawOpen} onClose={onCloseRaw} />
  </section>
  )
}
