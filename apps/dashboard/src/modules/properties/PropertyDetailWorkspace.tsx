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
import type { PropertyActionHandlers, PropertyIntelligenceContext, PropertyRecord } from './property.types'

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
}: PropertyDetailWorkspaceProps) => (
  <section className="pi-workspace" aria-label="Property intelligence workspace">
    <PropertyCommandHeader property={property} context={context} priorityMarked={priorityMarked} onBack={onBack} handlers={handlers} />
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
