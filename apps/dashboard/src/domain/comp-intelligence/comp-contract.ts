/**
 * Canonical read-only Comp Intelligence View Contract (Phase 1).
 * One projection for frontend. All fields carry provenance where possible.
 * Never fabricate missing values; use explicit "Not available".
 */

export interface Provenance {
  source: string | null;
  sourceRecordId?: string | null;
  observedAt?: string | null;
  confidence?: number | null;
  status: 'known' | 'inferred' | 'missing';
}

export interface SubjectCore {
  propertyId: string;
  canonicalAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  assetLane: string | null;
  propertySubtype: string | null;
  units: number | null;
  beds: number | null;
  baths: number | null;
  buildingSqft: number | null;
  lotSqft: number | null;
  yearBuilt: number | null;
  effectiveYearBuilt: number | null;
  constructionType: string | null;
  condition: string | null;
  quality: string | null;
  occupancy: string | null;
  zoning: string | null;
  floodZone: string | null;
  taxValue: number | null;
  estimatedValue: number | null;
  lastSalePrice: number | null;
  lastSaleDate: string | null;
  v3ValueClassification: string | null;
  v3Strategy: string | null;
  media: { url: string; type: string; attribution?: string }[];
  provenance: Partial<Record<keyof Omit<SubjectCore, 'media' | 'provenance'>, Provenance>>;
}

export interface CompPropertyCore {
  compId: string;
  propertyId: string | null;
  canonicalAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  propertyType: string | null;
  assetLane: string | null;
  units: number | null;
  beds: number | null;
  baths: number | null;
  buildingSqft: number | null;
  lotSqft: number | null;
  yearBuilt: number | null;
  effectiveYearBuilt: number | null;
  stories: number | null;
  constructionType: string | null;
  condition: string | null;
  quality: string | null;
  occupancy: string | null;
  zoning: string | null;
  floodZone: string | null;
  media: { url: string; type: string; attribution?: string }[];
}

export interface TransactionCore {
  salePrice: number | null;
  saleDate: string | null;
  recordingDate: string | null;
  ppsf: number | null;
  ppu: number | null;
  deedType: string | null;
  source: 'MLS' | 'Public Record' | 'Buyer Purchase Event' | 'Unknown';
  isArmsLength: boolean | null;
  isDistressed: boolean | null;
  isForeclosure: boolean | null;
  isBuilderNew: boolean | null;
  isRenovatedFlip: boolean | null;
  isPackage: boolean | null;
  financingType: string | null;
  mortgageAmount: number | null;
  transactionClusterId: string | null;
  isOutlier: boolean | null;
  provenance: Partial<Record<keyof Omit<TransactionCore, 'provenance'>, Provenance>>;
}

export type BuyerEntityType =
  | 'Individual'
  | 'LLC'
  | 'Corporation'
  | 'Trust'
  | 'Institutional'
  | 'Government'
  | 'Builder'
  | 'Unknown';

export interface BuyerCore {
  canonicalName: string | null;
  rawGrantee: string | null;
  entityType: BuyerEntityType;
  companyName: string | null;
  parentEntity: string | null;
  archetype: string | null;
  isRepeatBuyer: boolean | null;
  purchaseCount: number | null;
  isInstitutional: boolean | null;
  confidence: number | null;
}

export interface SellerCore {
  name: string | null;
  entityType: BuyerEntityType;
  relatedParty: boolean | null;
}

export interface CompIntelligenceCore {
  similarityScore: number | null;
  distanceMiles: number | null;
  recencyMonths: number | null;
  propertyTypeMatch: boolean | null;
  unitMatch: boolean | null;
  sqftDiff: number | null;
  lotDiff: number | null;
  ageDiff: number | null;
  conditionMatch: string | null;
  v3Universe: string | null;
  v3Role: string | null;
  pricingEligible: boolean | null;
  demandEligible: boolean | null;
  status: 'ACCEPTED' | 'REVIEW' | 'REJECTED' | 'UNKNOWN';
  reason: string | null;
  essContribution: number | null;
  packageTreatment: string | null;
  outlierTreatment: string | null;
  confidence: number | null;
  displayTier: 'STRONG' | 'USABLE' | 'WEAK' | 'REVIEW' | 'EXCLUDED';
}

export interface CompView {
  subject: SubjectCore;
  comp: CompPropertyCore;
  transaction: TransactionCore;
  buyer: BuyerCore;
  seller: SellerCore | null;
  intelligence: CompIntelligenceCore;
  raw: any; // for debug / fallback, not displayed raw
}