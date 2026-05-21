export type {
  PropertyConditionSnapshot,
  PropertyContactContext,
  PropertyDistressSnapshot,
  PropertyEmailContext,
  PropertyFilters,
  PropertyHoaSnapshot,
  PropertyIntelligenceContext,
  PropertyIntelligenceModel,
  PropertyMedia,
  PropertyMessageEvent,
  PropertyMlsSnapshot,
  PropertyOfferItem,
  PropertyOfferPathway,
  PropertyOwnerContext,
  PropertyOwnerSnapshot,
  PropertyPhoneContext,
  PropertyProspectContext,
  PropertyQueueContext,
  PropertyQueueItem,
  PropertyRawFieldGroup,
  PropertyRecord,
  PropertySaleSnapshot,
  PropertyStructureSnapshot,
  PropertySystemSnapshot,
  PropertyValuationSnapshot,
} from '../../lib/data/propertyData'

export type PropertyViewMode = 'list' | 'detail'
export type PropertyNoticeKind = 'info' | 'success' | 'warning'

export interface PropertyActionHandlers {
  openInbox: () => void
  sendSms: () => void
  createOffer: () => void
  generateContract: () => void
  viewOnMap: () => void
  addToCampaign: () => void
  linkContact: () => void
  markPriority: () => void
  openRawRecord: () => void
}
