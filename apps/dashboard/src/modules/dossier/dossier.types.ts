/* Seller Dossier Data Model */

export type OwnerType = 'individual' | 'corporation' | 'trust' | 'entity' | 'entity_llc' | 'entity_partnership' | 'nonprofit';
export type PhoneType = 'mobile' | 'landline' | 'business' | 'voip';
export type DNCStatus = 'dnc' | 'dnc_tx' | 'active' | 'unverified';
export type VerificationStatus = 'verified' | 'unverified' | 'invalid';
export type PropertyType = 'single_family' | 'multifamily' | 'commercial' | 'land' | 'mobile_home' | 'mixed_use';
export type DistressSignal = 'vacant' | 'tax_delinquent' | 'probate' | 'foreclosure' | 'tired_landlord' | 'senior_owner' | 'high_equity' | 'absentee' | 'free_and_clear';
export type LeadStage = 'prospect' | 'contacted' | 'engaged' | 'negotiating' | 'offer_sent' | 'deal_pending' | 'closed';
export type DealStage = 'no_deal' | 'preliminary' | 'offer_generated' | 'offer_sent' | 'offer_accepted' | 'contract_pending' | 'title_open' | 'closing';
export type MessageChannel = 'sms' | 'email' | 'phone' | 'mail' | 'platform';
export type Sentiment = 'positive' | 'neutral' | 'negative' | 'interested' | 'objection';
export type Temperature = 'cold' | 'warm' | 'hot';

export interface Phone {
  id: string;
  phone: string;
  type: PhoneType;
  status: VerificationStatus;
  carrier?: string;
  dncStatus: DNCStatus;
  confidence: number; // 0-100
  lastContacted?: string;
}

export interface Email {
  id: string;
  email: string;
  role: string;
  status: VerificationStatus;
  confidence: number; // 0-100
  language?: string;
}

export interface Property {
  propertyId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
  propertyType: PropertyType;
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
  effectiveYearBuilt?: number;
  unitsCount?: number;
  estimatedValue: number;
  equity: number;
  equityPercent?: number;
  mortgageBalance: number;
  absentee: boolean;
  vacant: boolean;
  taxDelinquent: boolean;
  probate: boolean;
  foreclosure: boolean;
  freeAndClear: boolean;
  highEquity: boolean;
  tiredLandlord: boolean;
  distressSignals: DistressSignal[];
  aiPropertyScore: number; // 0-100
  recommendedStrategy: string;
  buildingCondition?: string;
  buildingQuality?: string;
  rehabLevel?: string;
  stories?: number;
  style?: string;
  hvac?: string;
  constructionType?: string;
  lotAcreage?: number;
  annualTax?: number;
  assessedValue?: number;
  lastSalePrice?: number;
  lastSaleDate?: string;
}

export interface ConversationThread {
  threadId: string;
  channel: MessageChannel;
  lastMessage: string;
  lastMessageAt: string;
  sentiment: Sentiment;
  objection?: string;
  stage: LeadStage;
  nextAction?: string;
  aiSummary: string;
}

export interface TimelineEvent {
  id: string;
  type: string;
  label: string;
  timestamp: string;
  source: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
}

export interface MotivationSignal {
  signal: DistressSignal; strength: number; explanation: string; relevance: 'high' | 'medium' | 'low';
}

export interface SellerDossier {
  id: string;
  masterOwnerId: string;
  masterKey: string;
  displayName: string;
  firstName: string;
  lastName: string;
  entityName?: string;
  ownerType: OwnerType;
  ownerAddress: string;
  mailingCity: string;
  mailingState: string;
  mailingZip: string;
  outOfStateOwner: boolean;
  corporateOwner: boolean;
  trustEstate: boolean;
  hedgeFundMatch: boolean;
  language: string;
  contactProbability: number; // 0-100
  preferredChannel: MessageChannel;
  bestContactTime: string;
  market: string;
  status: string;
  temperature: Temperature;
  priority: 'low' | 'medium' | 'high';
  aiScore: number; // 0-100
  motivationScore: number; // 0-100
  riskScore: number; // 0-100
  portfolioValue: number;
  estimatedEquity: number;
  propertyCount: number;
  linkedProspectsCount: number;
  linkedPhoneCount: number;
  linkedEmailCount: number;
  phones: Phone[];
  emails: Email[];
  properties: Property[];
  conversations: ConversationThread[];
  timeline: TimelineEvent[];
  leadStage: LeadStage;
  sellerStage: DealStage;
  askingPrice?: number;
  offerStatus: string;
  recommendedCashOffer?: number;
  creativeOfferEligible: boolean;
  multifamilyUnderwriteRequired: boolean;
  contractStatus: string;
  titleStatus: string;
  closingStatus: string;
  buyerMatchStatus: string;
  nextBestAction: string;
  nextBestActionReason: string;
  aiConfidence: number; // 0-100

  // HYDRATION EXTENSIONS
  prospectFullName?: string;
  prospectContactScore?: number;
  financialPressureScore?: number;
  urgencyScore?: number;
  priorityTier?: string;
  followUpCadence?: string;
  portfolioTotalLoanBalance?: number;
  taxDelinquentCount?: number;
  activeLienCount?: number;
}

export interface DossierModel {
  sellers: SellerDossier[];
  stats: {
    totalOwners: number;
    hotSellers: number;
    portfolioOwners: number;
    needsAction: number;
    averageMotivationScore: number;
  };
}

export type DossierView = 'overview' | 'properties' | 'conversation' | 'motivation' | 'deals' | 'timeline';

export interface DossierFilter {
  temperature?: Temperature;
  status?: string;
  hasDistress?: boolean;
  highEquity?: boolean;
  corporate?: boolean;
  outOfState?: boolean;
  portfolioOwners?: boolean;
}
