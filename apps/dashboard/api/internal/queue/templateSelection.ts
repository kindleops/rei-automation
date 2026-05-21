import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { asString } from '../../../src/lib/data/shared'

export interface SelectedTemplate {
  template_id: string
  template_text: string
  score: number
  recommendation?: string
  bucket: string
  reason: string
  language?: string
  paired_with_agent_type?: string
}

export async function selectWeightedTemplate(params: {
  market: string
  language: string
  assetClass: string
}): Promise<SelectedTemplate | null> {
  const supabase = getSupabaseClient()
  
  // 1. Fetch eligible templates with weights and performance scores
  // Joining v_sms_template_performance_analytics to get real-world conversion data
  const { data: templates, error } = await supabase
    .from('sms_templates')
    .select('*')
    .eq('is_active', true)
    .eq('is_controlled_rollout', true)
    .or(`language.eq.${params.language},language.is.null`)

  if (error || !templates || templates.length === 0) {
    return null
  }

  // 2. Filter by market and asset class if specified in template metadata
  const eligible = templates.filter(t => {
    const meta = t.metadata || {}
    const marketMatch = !meta.market_restriction || meta.market_restriction === params.market
    const assetMatch = !meta.asset_class_restriction || meta.asset_class_restriction === params.assetClass
    return marketMatch && assetMatch
  })

  if (eligible.length === 0) return null

  // 3. Simple Weighted Random Selection (Phase 1)
  // In Phase 2, this will use Thomson Sampling against Conversion Rate
  const totalWeight = eligible.reduce((sum, t) => sum + (Number(t.traffic_weight) || 1), 0)
  let roll = Math.random() * totalWeight
  
  let selectedBucket = 'baseline'
  const template = eligible.find(t => {
    roll -= (Number(t.traffic_weight) || 1)
    return roll <= 0
  }) || eligible[0]

  return {
    template_id: template.template_id,
    template_text: template.template_text,
    score: Number(template.overall_template_score ?? 0),
    recommendation: template.recommendation,
    bucket: selectedBucket,
    reason: `Selected via ${selectedBucket} bucket (roll: ${roll.toFixed(1)}) weight: ${template.traffic_weight}`,
    language: template.language || 'English',
    paired_with_agent_type: template.agent_persona
  }
}
