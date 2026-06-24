export type TemplateTimeRange = 'today' | '24h' | '7d' | '30d' | '90d' | 'all' | 'custom'
export type AutopilotMode = 'off' | 'shadow' | 'recommend' | 'controlled' | 'autonomous'
export type ColumnPreset = 'performance' | 'execution' | 'funnel' | 'autopilot' | 'data_quality'
export type TableDensity = 'compact' | 'comfortable'

export interface RateValue {
  numerator: number
  denominator: number
  value: number | null
  unit?: string
}

export interface CountComparison {
  current: number
  prior: number
  baseline: number
  delta_absolute: number
  delta_percent: number
  baseline_delta_absolute: number
  baseline_delta_percent: number
}

export interface TemplateIdentity {
  template_id: string
  template_uuid: string | null
  template_name: string
  canonical_display_name: string
  template_version: string
  stage_code: string | null
  stage_label: string
  touch_number: number | null
  follow_up_number: number
  use_case: string | null
  language: string
  persona: string | null
  asset_scope: string | null
  deal_strategy: string | null
  source: string
  lifecycle: string
  active_state: string
  canonical_body: string
  english_translation: string | null
  variable_contract: string[]
  allowed_property_groups: string[]
  prohibited_property_groups: string[]
}

export interface TemplateIntelligenceRow {
  identity: TemplateIdentity
  metrics: {
    current: Record<string, unknown>
    comparison: {
      metrics: Record<string, CountComparison>
      rates: Record<string, RateValue & { current?: RateValue; prior?: RateValue; baseline?: RateValue }>
    }
    confidence: {
      current_range: { bucket: string; sample_size: number }
      historical: { bucket: string; sample_size: number }
    }
    performance_label: string
  }
  execution: Record<string, unknown>
  data_quality: Record<string, unknown>
  autopilot: Record<string, unknown> | null
  control: Record<string, unknown>
}

export interface TemplateIntelligenceFilters {
  range: TemplateTimeRange
  customStart?: string
  customEnd?: string
  stage?: string
  touch?: number
  followUp?: number
  useCase?: string
  language?: string
  persona?: string
  assetType?: string
  market?: string
  campaign?: string
  sender?: string
  agent?: string
  lifecycle?: string
  activeState?: string
  rotationState?: string
  performanceLabel?: string
  confidence?: string
  riskFlag?: string
  source?: string
  query?: string
}

export interface TemplateIntelligenceMeta {
  page: number
  page_size: number
  total_count: number
  filtered_count: number
  range: string
  prior_range: string
  baseline_range: string
  kpi_source: string
  autopilot_mode: AutopilotMode
  shadow_mode: boolean
  production_mutations_enabled: boolean
}

export interface TemplateKpiCard {
  key: string
  label: string
  current: number | null
  numerator?: number
  denominator?: number
  priorDelta?: number | null
  priorLabel?: string
  baseline?: number | null
  unavailable?: boolean
  unavailableReason?: string
  insufficientData?: boolean
}