import type { PipelineGroupByMode } from './pipeline-opportunity.types'

export type CardDensity = 'compact' | 'standard' | 'expanded'
export type CardPreviewLines = 1 | 2
export type CardEmptyBehavior = 'hide' | 'placeholder'

export type CardSlotKey =
  | 'accent'
  | 'eyebrow'
  | 'title'
  | 'subtitle'
  | 'badge_1'
  | 'badge_2'
  | 'badge_3'
  | 'preview'
  | 'metric_1'
  | 'metric_2'
  | 'metric_3'
  | 'footer'

export const CARD_SLOT_KEYS: CardSlotKey[] = [
  'accent', 'eyebrow', 'title', 'subtitle',
  'badge_1', 'badge_2', 'badge_3',
  'preview', 'metric_1', 'metric_2', 'metric_3', 'footer',
]

export interface PipelineCardSlotConfig {
  fieldKey: string | null
  disabled?: boolean
}

export interface PipelineCardDesign {
  id: string
  label: string
  density: CardDensity
  previewLines: CardPreviewLines
  accentSource: string | null
  emptyBehavior: CardEmptyBehavior
  slots: Record<CardSlotKey, PipelineCardSlotConfig>
}

export interface PipelineSortSpec {
  field: string
  direction: 'asc' | 'desc'
  nulls: 'first' | 'last'
}

export interface PipelineFilterClause {
  field: string
  operator: string
  value?: string | number | boolean | string[] | number[] | null
}

export interface PipelineFilterGroup {
  logic: 'and' | 'or'
  clauses: Array<PipelineFilterClause | PipelineFilterGroup>
}

export interface PipelineViewState {
  scope: string
  groupBy: PipelineGroupByMode
  filters: PipelineFilterGroup
  sorts: PipelineSortSpec[]
  cardDesign: PipelineCardDesign
  cardDesignsByGroup: Partial<Record<PipelineGroupByMode, PipelineCardDesign>>
  density: CardDensity
  activeViewId: string | null
}

export interface PipelineFieldDefinition {
  key: string
  label: string
  description: string
  group: string
  dataType: string
  emptyLabel: string
  sortable: boolean
  filterable: boolean
  groupable: boolean
  cardCompatible: boolean
  detailPanelCompatible: boolean
  stageApplicability: string
  visibilityCondition: string | null
  editable: boolean
  calculated: boolean
  canBeStale: boolean
  operators: string[]
}