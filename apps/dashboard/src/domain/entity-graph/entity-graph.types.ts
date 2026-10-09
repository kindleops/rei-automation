export type EntityGraphTab =
  | 'properties'
  | 'master_owners'
  | 'people'
  | 'organizations'
  | 'contact_methods'
  | 'markets'
  | 'zips'

export type UniversalEntityType =
  | 'property'
  | 'master_owner'
  | 'prospect'
  | 'sub_owner'
  | 'phone'
  | 'email'
  | 'organization'
  | 'market'
  | 'zip'
  | null

export type EntityGraphVisualMode = 'table' | 'cards' | 'graph'

export type UniversalEntityContext = {
  entityType: UniversalEntityType
  entityId: string | null
  propertyId: string | null
  masterOwnerId: string | null
  prospectId: string | null
  contactMethodType: 'phone' | 'email' | null
  contactMethodId: string | null
  threadKey: string | null
  opportunityId: string | null
}

export type EntitySearchResult = {
  entityType: string
  entityId: string
  title: string
  subtitle?: string
  badges: string[]
  score?: number
  linkedCounts: {
    properties?: number
    prospects?: number
    contacts?: number
    threads?: number
    masterOwners?: number
    reachableContacts?: number
    contactCoverage?: number
    avgAcquisitionScore?: number
  }
  details?: {
    mailingAddress?: string
    marketLabel?: string
    /** Canonical market key; carries the `Unmapped · ` prefix when off-zone. */
    marketKey?: string
    /** True when the locality is outside the configured sending zones. */
    isUnmappedMarket?: boolean
    /** `linked_person` when the owner came from the prospect graph rather than
     *  `properties.master_owner_id` (null on ~75% of property rows). */
    ownerVia?: 'linked_person'
    bestPersonName?: string
    bestPersonIsLikelyOwner?: boolean
    /** The selected source columns verbatim, for the table's column picker. */
    row?: Record<string, unknown>
    locality?: string
    county?: string
    state?: string
    metro?: string
    city?: string
    zip?: string
    assetType?: string
    units?: number
    value?: number
    /** Known equity % only (equity_known_v1); null/absent = unknown. */
    equity?: number | null
    equityClass?: 'high' | 'low' | 'unknown'
    equityRule?: 'loan_and_value' | 'free_and_clear' | 'no_recorded_mortgage' | 'recorded_mortgage_balance' | 'vendor_high_equity_flag' | 'vendor_low_equity_flag' | 'unknown'
    /** Known equity in dollars (equity_known_v1 + recorded documents); null = unknown. */
    equityAmount?: number | null
    acquisitionScore?: number
    flagCount?: number
    flags?: string
    ownerType?: string
    priorityTier?: string
    portfolioValue?: number
    portfolioEquity?: number
    occupation?: string
    language?: string
    ownerName?: string
    age?: number
    reachable?: boolean
    contactStatus?: string
    contactType?: string
    phoneType?: string
    eligibility?: string
    reachability?: string
    wrongNumber?: boolean
    entityType?: string
    lastActivity?: string
    ownerCorporate?: boolean
    absentee?: boolean
    taxDelinquent?: boolean
    yearBuilt?: number
    loanBalance?: number
    lat?: number
    lng?: number
    /** Recorded-document facts (properties browse over v_entity_graph_properties). */
    records?: PropertyRecordFacts
    /* Buyer entities (browse tab=buyers). Person buyers carry no name. */
    buyerId?: string
    entityKind?: 'company' | 'person'
    activityStatus?: string
    activityScore?: number
    archetype?: string
    archetypeLabel?: string
    holdFlip?: string
    dominantFamily?: string
    primaryMarket?: string
    topState?: string
    acquisitions?: number
    trailing90?: number
    trailing365?: number
    perYear?: number
    lastAcquisition?: string
    daysSinceLast?: number
    priceP25?: number
    priceP50?: number
    priceP75?: number
    cashShare?: number
    hasBuybox?: boolean
    portfolioCount?: number
    ownedCount?: number
    soldCount?: number
    crossover?: boolean
    confidence?: number
    entityGrade?: string
    /** Outreach facts merged client-side from /entity-graph/outreach-state (property rows). */
    outreach?: EntityOutreachState | null
  }
  contextIds: {
    buyerId?: string
    propertyId?: string
    masterOwnerId?: string
    prospectId?: string
    contactMethodId?: string
    threadKey?: string
  }
}

export type RecordSignal = { key: string; label: string; tone: 'alert' | 'warn' | 'info' }

export type PropertyRecordFacts = {
  /** false when the property has no record-summary row: counts are unknown, not 0. */
  captured?: boolean
  mortgageCount: number
  mortgageBalance?: number
  firstRate?: number
  firstLender?: string
  /** Distinct LIEN categories (lien + judgment classes only — entity-graph-recorded-docs.js). */
  lienCount: number
  /** Recorded LIEN categories only; UCC filings, affidavits, probate… are `filings`. */
  lienCategories?: string[]
  /** Lien labels ("General lien", "Mechanic's lien"). */
  liens?: string[]
  /** Every other recorded non-mortgage document, correctly named. */
  filings?: Array<{ category: string; class: string; label: string }>
  /** Every recorded non-mortgage document (liens + filings). */
  documentCount?: number
  /** Present only when every recorded document is a lien (the source sums all documents). */
  lienAmountDue?: number
  lastSaleDocType?: string
  saleCount: number
  lastSaleDate?: string
  lastSalePrice?: number
  yearsOwned?: number
  auctionDate?: string
  ownerBuyer?: { buyerId: string; status?: string; acquisitions?: number; basis?: string }
  signals: RecordSignal[]
}

export type EntityGraphPagination = {
  cursor: number
  pageSize: number
  /** null = the exact count could not be computed in time. Never a guess, never 0. */
  total: number | null
  hasMore: boolean
  nextCursor: number | null
  previousCursor?: number | null
  /** Adapter caveats that change what `total` counts, e.g. `score_order_excludes_unscored`. */
  notes?: string[]
  /**
   * Properties browse only: the order actually used. `sortApplied: false`
   * means the requested sort has no index that can drive it and the page is
   * in the fallback order — the client sorts the loaded rows and says so.
   */
  sort?: {
    requested: { column: string; ascending: boolean }
    applied: { column: string; ascending: boolean }
    sortApplied: boolean
    /** 'keyset' = whole-cohort order continued page to page via `nextAfter`. */
    mode?: 'keyset'
  }
  /** Opaque continuation token; send as `after` for the next page. */
  nextAfter?: string | null
}

export type EntityGraphListResponse = {
  ok: boolean
  results: EntitySearchResult[]
  pagination: EntityGraphPagination
  /**
   * What browse attached to the rows in this same response (fields=… / outreach=1):
   * the visible column values (details.row) and outreach state (details.outreach).
   * A failed attachment is named in `errors` — those cells read "—", said so.
   */
  attached?: { fields: string[]; fieldsLoaded?: string[]; outreach: boolean; errors: Array<{ source: string; message: string }> }
}

export type EntityGraphTabCounts = {
  properties: number
  master_owners: number
  people: number
  organizations: number
  contact_methods: number
  phones: number
  emails: number
  markets: number
  zips: number
  /** null when the buyer read model is unreadable. */
  buyers?: number | null
}

export type ContactLadderEntry = {
  id: string
  type: 'phone' | 'email'
  value: string
  rank?: number | null
  score?: number | null
  phoneType?: string | null
  eligible: boolean
  wrongNumber: boolean
  suppressed: boolean
  optedOut: boolean
  lastContacted?: string | null
  lastResponse?: string | null
  prospectId?: string | null
  relationship?: string | null
  tail?: string | null
}

export type EntityGraphNode = {
  id: string
  type: string
  label: string
  meta?: Record<string, unknown>
}

export type EntityGraphEdge = {
  from: string
  to: string
  label: string
}

export type EntityIdentityHeader = {
  masterOwner?: string | null
  talkingTo?: string | null
  talkingToRelationship?: string | null
  propertyContext?: string | null
  contactMethod?: string | null
}

export type EntityGraphDossier = {
  entityType: string
  entityId: string
  summary: Record<string, unknown>
  identity?: EntityIdentityHeader
  owner?: Record<string, unknown> | null
  prospects?: Record<string, unknown>[]
  properties?: Record<string, unknown>[]
  portfolio?: Record<string, unknown>
  subOwners?: Record<string, unknown>[]
  phones?: Record<string, unknown>[]
  emails?: Record<string, unknown>[]
  threads?: Record<string, unknown>[]
  contactLadder?: { phones: ContactLadderEntry[]; emails: ContactLadderEntry[] }
  eligibility?: Record<string, unknown>
  scores?: Record<string, unknown>
  graph?: { nodes: EntityGraphNode[]; edges: EntityGraphEdge[] }
  timeline?: Record<string, unknown>[]
  /** Mortgages, liens, sales (+ buyer resolution), foreclosures, parcel. null = unavailable, not "none". */
  records?: import('./entity-graph-intel-api').PropertyRecords | null
}

export type EntityGraphFilters = {
  market: string
  city: string
  state: string
  zip: string
  assetType: string
  ownerType: string
  priorityTier: string
  contactStatus: string
  reachable: boolean
  unitsMin: string
  unitsMax: string
  scoreMin: string
  scoreMax: string
  coverageMin: string
  language: string
  entityType: string
}

export const EMPTY_ENTITY_GRAPH_FILTERS: EntityGraphFilters = {
  market: '',
  city: '',
  state: '',
  zip: '',
  assetType: '',
  ownerType: '',
  priorityTier: '',
  contactStatus: '',
  reachable: false,
  unitsMin: '',
  unitsMax: '',
  scoreMin: '',
  scoreMax: '',
  coverageMin: '',
  language: '',
  entityType: '',
}

export type EntityGraphAction =
  | 'open_conversation'
  | 'contact_owner'
  | 'contact_person'
  | 'email'
  | 'open_thread'
  | 'create_manual_draft'
  | 'open_deal_intelligence'
  | 'open_seller_automation'
  | 'open_workflow_studio'
  | 'open_comp_intelligence'
  | 'open_buyer_match'
  | 'show_on_map'
  | 'open_in_map'
  | 'run_decision_engine'
  | 'add_to_campaign'
  | 'open_opportunity'
  | 'open_portfolio'
  | 'view_threads'
  | 'view_properties'
  | 'select_contact_method'
  | 'mark_wrong_number'
  | 'view_owner'
  | 'view_prospect'
  | 'create_opportunity'
  | 'view_portfolio'
  | 'view_master_owner'
  | 'view_linked_properties'
  | 'view_linked_person'
  | 'apply_zip_filter'
  | 'apply_market_filter'
  | 'view_zip_intelligence'
  | 'view_market_intelligence'
/**
 * Per-property outreach facts (GET /api/cockpit/entity-graph/outreach-state).
 * `sms` is the campaign target builder's own readiness verdict; null = the
 * source did not answer (never "not eligible").
 */
export type EntityOutreachState = {
  sms: { eligible: boolean; reason: string | null; rows: number; ready: number; source: string; reviewChecked: boolean } | null
  /**
   * Phones on prospects linked to the property when the campaign graph has none
   * for it. EVIDENCE only — never eligibility. Numbers arrive masked.
   */
  contactCandidates?: {
    people: number
    phones: number
    unresolved: number
    candidates: Array<{ prospectId?: string | null; name: string; resolution: 'resolved_owner' | 'graph_person' | 'linked_unresolved'; evidence: string[]; matching: string | null; phones: Array<{ masked: string; type: string | null; score: number | null; usage: string | null; inCampaignGraph: boolean }> }>
  } | null
  /**
   * The entity's candidate contact when its role needs review
   * (seller.property_entity_contact_v1). Display only — SMS eligibility stays
   * the campaign graph's verdict. The phone arrives masked (•••-1234).
   */
  entityContact?: {
    entityName: string | null
    entityStatus: string | null
    person: string | null
    phoneMasked: string | null
    phoneCallable: boolean
    hasEmail: boolean
    emailUsable: boolean
    role: string
    roleLabel: string
    requiresReview: boolean
    reviewReasons: Array<{ code: string; label: string }>
  } | null
  lastContact: { at: string; direction: 'inbound' | 'outbound'; channel: string; source: string } | null
  stage: { value: string; source: 'pipeline' | 'conversation' } | null
  status: { value: string; source: 'pipeline' | 'conversation' } | null
  /** The deal's stage/status and the conversation's, kept apart (absent on older APIs). */
  pipeline?: { stage: string | null; status: string | null } | null
  conversationState?: { stage: string | null; status: string | null } | null
  dealId: string | null
  conversation: { threadKey: string | null; at: string | null; direction: string | null; preview: string | null; bucket: string | null; suppressed: boolean } | null
  campaigns: { count: number; latest: { id: string; name: string | null; status: string | null; targetStatus: string | null; blockReason: string | null } | null } | null
}
