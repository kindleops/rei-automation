import type { PipelineCardDesign, PipelineCardSlotConfig } from './pipeline-card-design.types'
import type { PipelineGroupByMode } from './pipeline-opportunity.types'

function slot(fieldKey: string | null, disabled = false): PipelineCardSlotConfig {
  return { fieldKey, disabled }
}

function makeDesign(
  id: string,
  label: string,
  slots: Partial<Record<string, PipelineCardSlotConfig>>,
  overrides: Partial<PipelineCardDesign> = {},
): PipelineCardDesign {
  const base: Record<string, PipelineCardSlotConfig> = {
    accent: slot('temperature'),
    eyebrow: slot('property_type_market'),
    title: slot('seller_display_name'),
    subtitle: slot('property_address_full'),
    badge_1: slot('pipeline_stage'),
    badge_2: slot('universal_status'),
    badge_3: slot('temperature'),
    preview: slot('latest_message_preview'),
    metric_1: slot('follow_up_due'),
    metric_2: slot('asking_price'),
    metric_3: slot('stage_age'),
    footer: slot('last_activity_at'),
  }
  for (const [k, v] of Object.entries(slots)) {
    if (v) base[k] = v
  }
  return {
    id,
    label,
    density: 'standard',
    previewLines: 2,
    accentSource: 'temperature',
    emptyBehavior: 'placeholder',
    slots: base as PipelineCardDesign['slots'],
    ...overrides,
  }
}

/** Default card — no AOS unless engine succeeded at Offer+ stage (handled by resolver). */
export const DEFAULT_PIPELINE_CARD_DESIGN: PipelineCardDesign = makeDesign(
  'default',
  'Default',
  {
    badge_3: slot('reply_attention_state'),
    preview: slot('latest_message_preview'),
    metric_1: slot('follow_up_due'),
    metric_2: slot('asking_price'),
    metric_3: slot('stage_age'),
  },
)

const VIEW_PRESETS: Partial<Record<PipelineGroupByMode, PipelineCardDesign>> = {
  stage: makeDesign('preset_stage', 'Stage View', {
    badge_1: slot('universal_status'),
    badge_2: slot('temperature'),
    badge_3: slot(null),
    preview: slot('latest_message_preview'),
    metric_1: slot('stage_age'),
    metric_2: slot('next_action'),
    metric_3: slot(null),
  }),
  status: makeDesign('preset_status', 'Status View', {
    badge_1: slot('pipeline_stage'),
    badge_2: slot('temperature'),
    badge_3: slot(null),
    preview: slot('next_action'),
    metric_1: slot('last_activity_at'),
    metric_2: slot(null),
    metric_3: slot(null),
    footer: slot('next_action_due'),
  }),
  temperature: makeDesign('preset_temperature', 'Temperature View', {
    badge_1: slot('pipeline_stage'),
    badge_2: slot('latest_intent'),
    badge_3: slot(null),
    preview: slot('latest_message_preview'),
    metric_1: slot('motivation_score'),
    metric_2: slot('follow_up_due'),
    metric_3: slot(null),
  }),
  market: makeDesign('preset_market', 'Market View', {
    eyebrow: slot('property_type'),
    badge_1: slot('pipeline_stage'),
    badge_2: slot('temperature'),
    badge_3: slot(null),
    preview: slot('latest_message_preview'),
    metric_1: slot('last_activity_at'),
    metric_2: slot(null),
    metric_3: slot(null),
  }),
  property_type: makeDesign('preset_property_type', 'Property Type View', {
    eyebrow: slot('market'),
    badge_1: slot('pipeline_stage'),
    badge_2: slot('universal_status'),
    badge_3: slot(null),
    preview: slot('latest_message_preview'),
    metric_1: slot('units_count'),
    metric_2: slot('market'),
    metric_3: slot(null),
  }),
  queue_status: makeDesign('preset_queue', 'Queue Status View', {
    badge_1: slot('queue_state'),
    badge_2: slot('pipeline_stage'),
    badge_3: slot(null),
    preview: slot('next_action'),
    metric_1: slot('last_contact_at'),
    metric_2: slot(null),
    metric_3: slot(null),
    footer: slot('last_activity_at'),
  }),
  workflow_status: makeDesign('preset_workflow', 'Workflow Status View', {
    badge_1: slot('workflow_state'),
    badge_2: slot('blocker'),
    badge_3: slot(null),
    preview: slot('next_action'),
    metric_1: slot('follow_up_due'),
    metric_2: slot(null),
    metric_3: slot(null),
  }),
  follow_up_state: makeDesign('preset_follow_up', 'Follow-Up State View', {
    badge_1: slot('pipeline_stage'),
    badge_2: slot('temperature'),
    badge_3: slot(null),
    preview: slot('latest_message_preview'),
    metric_1: slot('follow_up_due'),
    metric_2: slot('follow_up_reason'),
    metric_3: slot(null),
  }),
}

export function getRecommendedCardDesign(groupBy: PipelineGroupByMode): PipelineCardDesign {
  const preset = VIEW_PRESETS[groupBy]
  if (!preset) return { ...DEFAULT_PIPELINE_CARD_DESIGN, id: `preset_${groupBy}`, label: `${groupBy} View` }
  return JSON.parse(JSON.stringify(preset)) as PipelineCardDesign
}

export function cloneCardDesign(design: PipelineCardDesign): PipelineCardDesign {
  return JSON.parse(JSON.stringify(design)) as PipelineCardDesign
}