import { getSupabaseClient } from '../../lib/supabaseClient'
import { isDev } from '../../lib/data/shared'

export interface AgentPerformanceRow {
  sms_agent_id: string
  agent_name: string
  persona: string
  tone: string
  language: string
  strategy: string
  time_window: string
  sends: number
  replies: number
  positive_replies: number
  opt_outs: number
  wrong_numbers: number
  hostile_replies: number
  asking_price_replies: number
  ownership_confirmed: number
  qualified_leads: number
  avg_response_hours: number | null
  reply_rate_pct: number
  positive_rate_pct: number
  opt_out_rate_pct: number
  wrong_number_rate_pct: number
  qualification_rate_pct: number
  stage_advance_rate_pct: number
  current_volume_weight: number
  recommended_volume_weight: number
  recommended_status: string
  auto_pause_candidate: boolean
  confidence_bucket: string
}

export interface AgentAttributionMetrics {
  total_events: number
  attributed_events: number
  unknown_events: number
  attribution_coverage_pct: number
  unknown_agent_pct: number
  agent_attribution_confidence: string
}

export interface AgentsModel {
  performance: AgentPerformanceRow[]
  attribution: AgentAttributionMetrics | null
}

export const loadAgents = async (): Promise<AgentsModel> => {
  const supabase = getSupabaseClient()
  
  const [perfResult, attrResult] = await Promise.all([
    supabase.from('agent_performance_kpis_v').select('*'),
    supabase.from('agent_attribution_metrics_v').select('*').single()
  ])

  if (perfResult.error && isDev) {
    console.error('Error fetching agent performance:', perfResult.error)
  }
  
  if (attrResult.error && isDev && attrResult.error.code !== 'PGRST116') {
    console.error('Error fetching agent attribution:', attrResult.error)
  }

  // Aggregate daily data to all-time for the UI (or whatever default view)
  // For simplicity, we can do a client-side rollup of the daily data
  const rawRows = (perfResult.data || []) as AgentPerformanceRow[]
  
  // Group by sms_agent_id, etc.
  const map = new Map<string, AgentPerformanceRow>()
  
  for (const row of rawRows) {
    const key = `${row.sms_agent_id}-${row.agent_name}-${row.persona}-${row.tone}-${row.language}-${row.strategy}`
    if (!map.has(key)) {
      map.set(key, { ...row, sends: 0, replies: 0, positive_replies: 0, opt_outs: 0, wrong_numbers: 0, hostile_replies: 0, asking_price_replies: 0, ownership_confirmed: 0, qualified_leads: 0 })
    }
    const acc = map.get(key)!
    acc.sends += row.sends
    acc.replies += row.replies
    acc.positive_replies += row.positive_replies
    acc.opt_outs += row.opt_outs
    acc.wrong_numbers += row.wrong_numbers
    acc.hostile_replies += row.hostile_replies
    acc.asking_price_replies += row.asking_price_replies
    acc.ownership_confirmed += row.ownership_confirmed
    acc.qualified_leads += row.qualified_leads
    // Averages are re-calculated
    acc.reply_rate_pct = acc.sends > 0 ? (acc.replies / acc.sends) * 100 : 0
    acc.positive_rate_pct = acc.sends > 0 ? (acc.positive_replies / acc.sends) * 100 : 0
    acc.opt_out_rate_pct = acc.sends > 0 ? (acc.opt_outs / acc.sends) * 100 : 0
    acc.wrong_number_rate_pct = acc.sends > 0 ? (acc.wrong_numbers / acc.sends) * 100 : 0
    acc.qualification_rate_pct = acc.sends > 0 ? (acc.qualified_leads / acc.sends) * 100 : 0
    acc.stage_advance_rate_pct = acc.positive_rate_pct
    
    // Auto optimize values based on aggregated sends
    acc.recommended_volume_weight = acc.sends > 50 && acc.positive_rate_pct > 5 ? 1.5 : (acc.sends > 50 && acc.opt_out_rate_pct > 5 ? 0.5 : 1.0)
    acc.recommended_status = acc.sends > 50 && acc.positive_rate_pct > 5 ? 'scale_up' : (acc.sends > 50 && acc.opt_out_rate_pct > 5 ? 'scale_down' : 'maintain')
    acc.auto_pause_candidate = acc.sends > 100 && acc.opt_out_rate_pct > 8
    acc.confidence_bucket = acc.sends < 25 ? 'low_data' : (acc.sends < 100 ? 'learning' : 'high_confidence')
    
    // Naive avg response time rollup (weighted average would be better, but acceptable for now)
    if (row.avg_response_hours != null) {
       acc.avg_response_hours = acc.avg_response_hours == null 
        ? row.avg_response_hours 
        : (acc.avg_response_hours + row.avg_response_hours) / 2
    }
  }

  const performance = Array.from(map.values()).sort((a, b) => b.sends - a.sends)

  return {
    performance,
    attribution: attrResult.data as AgentAttributionMetrics | null
  }
}
