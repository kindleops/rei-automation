/** Canonical map filter expression tree — mirrors backend AdvancedMapFilterNode. */

export type MapFilterEntity = 'property' | 'prospect' | 'master_owner' | 'phone'

/** Registry may expose master_owner as `owner` — normalized on ingest. */
export type RegistryEntity = MapFilterEntity | 'owner' | 'geo'

export type MapFilterCombinator = 'AND' | 'OR'

export type RelationshipMatchMode =
  | 'any_linked'
  | 'primary_only'
  | 'all_linked'
  | 'none_linked'

export interface AdvancedMapFilterRule {
  id: string
  type: 'rule'
  fieldKey: string
  operator: string
  value: unknown
  enabled?: boolean
  relationshipMatch?: RelationshipMatchMode
}

export interface AdvancedMapFilterGroup {
  id: string
  type: 'group'
  combinator: MapFilterCombinator
  negated: boolean
  enabled: boolean
  children: AdvancedMapFilterNode[]
}

export type AdvancedMapFilterNode = AdvancedMapFilterGroup | AdvancedMapFilterRule

export type MapFilterDataType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'json_text_array'
  | 'json_object_array'
  | 'geo'
  | 'derived_presence'

export type MapFilterValueSource =
  | 'free_text'
  | 'distinct'
  | 'range'
  | 'boolean'
  | 'derived_presence'
  | 'geo'

export interface MapFilterFieldJsonMeta {
  storageShape: string
  hasCustomCompiler: boolean
}

export type OperatorControlType =
  | 'boolean_segment'
  | 'enum_picker'
  | 'number_range'
  | 'currency_range'
  | 'date_range'
  | 'status_segment'
  | 'geo_picker'
  | 'tag_picker'
  | 'text_search'

/** Client-safe registry field shape from sanitizeFieldForClient(). */
export interface MapFilterRegistryField {
  key: string
  entity: RegistryEntity
  label: string
  description: string
  category: string
  dataType: MapFilterDataType
  operators: string[]
  populatedRows: number
  totalRows: number
  coveragePercent: number
  valueSource: MapFilterValueSource
  sensitive: boolean
  safeToExpose: boolean
  synonyms: string[]
  partialCoverage?: boolean
  json?: MapFilterFieldJsonMeta
  uiKey?: string
  controlType?: OperatorControlType
  defaultOperator?: string
  searchable?: boolean
  quickFilter?: boolean
  advanced?: boolean
  launchVisible?: boolean
  enumOptions?: string[]
  valueOptions?: { label: string; value: string | number | boolean }[]
  verifiedQuickPresetKeys?: string[]
}

export type MapFilterPreviewStatus =
  | 'baseline'
  | 'loading'
  | 'valid'
  | 'failed'
  | 'incomplete'
  | 'stale'

export interface MapFilterRegistryAlias {
  alias: string
  canonical: string
}

export interface MapFilterCountSemantic {
  id: string
  label: string
  definition: string
}

export interface MapFilterRegistryResponse {
  filterSchemaVersion: string
  registryVersion: string
  generatedAt: string
  catalog?: 'operator' | 'full'
  activeFieldCount: number
  registryFieldCount?: number
  tableBaselines: Record<string, number>
  countSemantics: Record<string, MapFilterCountSemantic>
  relationshipSemantics: Record<string, unknown>
  removedPlaceholderPresets: unknown[]
  aliases: MapFilterRegistryAlias[]
  partialCoverageFields: Array<{ key: string; label: string; coveragePercent: number }>
  excludedEmptyFieldCount: number
  excludedSensitiveFieldCount: number
  fieldsByEntity: Record<string, number>
  fieldsByCategory: Record<string, number>
  fields: MapFilterRegistryField[]
}

export interface MapFilterBounds {
  lat_min: number
  lat_max: number
  lng_min: number
  lng_max: number
}

export interface MapFilterPreviewCounts {
  matchingProperties: number
  matchingProspects: number
  matchingMasterOwners: number
  matchingPhones: number
  propertiesInBounds: number | null
  representedProperties?: number | null
}

export interface MapFilterPreviewResponse {
  filterSchemaVersion: string
  registryVersion: string
  summary: string
  activeRuleCount: number
  referencedFieldKeys: string[]
  referencedEntities: string[]
  counts: MapFilterPreviewCounts
  semantics: Record<string, MapFilterCountSemantic>
  bounds: MapFilterBounds | null
  timing?: Record<string, number>
  meta?: Record<string, unknown>
}

export interface MapFilterTokenResponse {
  filterSchemaVersion: string
  registryVersion: string
  filterToken: string
  expiresAt: string
  summary: string
  activeRuleCount: number
  referencedFieldKeys: string[]
  referencedEntities: string[]
  timing?: Record<string, number>
}

export interface MapFilterPreset {
  key: string
  label: string
  entity: string
  description: string
  expression: AdvancedMapFilterGroup
}

export interface MapFilterPresetsResponse {
  filterSchemaVersion: string
  registryVersion: string
  presets: MapFilterPreset[]
}

/** Query param support for map runtime integration. */
export interface MapFilterQueryParams {
  filter?: string
  filterToken?: string
  token?: string
}

export interface MapFilterPreviewRequest {
  expression?: AdvancedMapFilterGroup
  filterToken?: string
  presetKey?: string
  bounds?: MapFilterBounds | null
}

export interface MapFilterTokenRequest {
  expression: AdvancedMapFilterGroup
  ttlHours?: number
}

export type MasterFiltersMobilePane = 'discover' | 'stack' | 'results' | 'saved'

export interface MapFilterSavedFilter {
  id: string
  organizationId: string
  createdBy: string
  permissionScope: string
  name: string
  description: string
  expression: AdvancedMapFilterGroup
  summary: string
  isFavorite: boolean
  isSystem: boolean
  scope: 'personal' | 'organization'
  filterSchemaVersion: number
  registryVersion: string
  activeRuleCount: number
  lastKnownPropertyCount: number | null
  useCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MapFilterSavedListResponse {
  filterSchemaVersion: string
  registryVersion: string
  savedFilters: MapFilterSavedFilter[]
}

export const MAP_FILTER_ENTITIES: MapFilterEntity[] = [
  'property',
  'prospect',
  'master_owner',
  'phone',
]

export const ENTITY_LABELS: Record<MapFilterEntity, string> = {
  property: 'Properties',
  prospect: 'Prospects',
  master_owner: 'Master Owners',
  phone: 'Phones',
}