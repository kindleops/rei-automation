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
    locality?: string
    county?: string
    state?: string
    metro?: string
  }
  contextIds: {
    propertyId?: string
    masterOwnerId?: string
    prospectId?: string
    contactMethodId?: string
    threadKey?: string
  }
}

export type EntityGraphPagination = {
  cursor: number
  pageSize: number
  total: number
  hasMore: boolean
  nextCursor: number | null
  previousCursor?: number | null
}

export type EntityGraphListResponse = {
  ok: boolean
  results: EntitySearchResult[]
  pagination: EntityGraphPagination
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
}

export type EntityGraphAction =
  | 'open_conversation'
  | 'contact_owner'
  | 'contact_person'
  | 'email'
  | 'open_thread'
  | 'create_manual_draft'
  | 'open_deal_intelligence'
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