import { useState, useEffect, useCallback } from 'react'
import { getSupabaseClient } from '../supabaseClient'

export type TimeWindow = 'today' | '24h' | '7d' | '30d' | 'all_time'

export interface PerformanceFilters {
  time_window: TimeWindow
  market?: string
  textgrid_number_key?: string
  property_type?: string
  owner_type?: string
  zip?: string
  stage?: string
  language?: string
  touch_number?: number
  template_key?: string
  seller_signal?: string
  property_signal?: string
}

export interface BasePerformanceMetric {
  time_window: TimeWindow
  sends: number
  delivered: number
  failed: number
  inbound_replies: number
  positive_replies: number
  opt_outs: number
  wrong_numbers: number
  not_interested: number
  hostile_or_legal: number
  asking_price_replies: number
  ownership_confirmed_replies: number
  avg_response_hours: number | null
  median_response_hours: number | null
  reply_rate_pct: number
  positive_rate_pct: number
  opt_out_rate_pct: number
  wrong_number_rate_pct: number
  not_interested_rate_pct: number
  delivery_rate_pct: number
  failure_rate_pct: number
  sample_size: number
  confidence_bucket: 'insufficient_data' | 'low_confidence' | 'medium_confidence' | 'high_confidence'
  performance_label: 'winner' | 'rising' | 'stable' | 'watch' | 'risky' | 'pause_candidate' | 'insufficient_data'
}

export interface TemplatePerformance extends BasePerformanceMetric {
  template_key: string
}

export interface NumberPerformance extends BasePerformanceMetric {
  textgrid_number_key: string
  from_phone_number: string | null
  market: string | null
}

export interface MarketPerformance extends BasePerformanceMetric {
  market: string
}

export interface PropertyTypePerformance extends BasePerformanceMetric {
  property_type: string
}

export interface SellerSignalPerformance extends BasePerformanceMetric {
  seller_signal: string
}

export interface PropertySignalPerformance extends BasePerformanceMetric {
  podio_tags: string
}

export interface OwnerTypePerformance extends BasePerformanceMetric {
  owner_type: string
}

export interface StagePerformance extends BasePerformanceMetric {
  current_stage: string
  stage_before: string | null
  stage_after: string | null
}

export interface TouchPerformance extends BasePerformanceMetric {
  touch_number: number
}

export interface LanguagePerformance extends BasePerformanceMetric {
  language: string
}

export interface PerformanceTrend {
  trend_date: string
  sends: number
  delivered: number
  failed: number
  inbound_replies: number
  positive_replies: number
  opt_outs: number
  reply_rate_pct: number
  positive_rate_pct: number
  opt_out_rate_pct: number
}

export interface Outlier {
  outlier_type: string
  key: string
  score: number
  performance_label: string
}

// Data Fetchers

export const fetchTemplatePerformance = async (filters: PerformanceFilters, limit = 100): Promise<TemplatePerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('template_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  // view only supports template_key as filter dimension
  if (filters.template_key) q = q.eq('template_key', filters.template_key)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchNumberPerformance = async (filters: PerformanceFilters, limit = 100): Promise<NumberPerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('number_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.textgrid_number_key) q = q.eq('textgrid_number_key', filters.textgrid_number_key)
  if (filters.market) q = q.eq('market', filters.market) // number view has market
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchMarketPerformance = async (filters: PerformanceFilters, limit = 100): Promise<MarketPerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('market_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.market) q = q.eq('market', filters.market)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchPropertyTypePerformance = async (filters: PerformanceFilters, limit = 100): Promise<PropertyTypePerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('property_type_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.property_type) q = q.eq('property_type', filters.property_type)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchSellerSignalPerformance = async (filters: PerformanceFilters, limit = 100): Promise<SellerSignalPerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('seller_signal_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.seller_signal) q = q.eq('seller_signal', filters.seller_signal)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchPropertySignalPerformance = async (filters: PerformanceFilters, limit = 100): Promise<PropertySignalPerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('property_signal_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.property_signal) q = q.eq('podio_tags', filters.property_signal)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchOwnerTypePerformance = async (filters: PerformanceFilters, limit = 100): Promise<OwnerTypePerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('owner_type_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.owner_type) q = q.eq('owner_type', filters.owner_type)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchStagePerformance = async (filters: PerformanceFilters, limit = 100): Promise<StagePerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('stage_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.stage) q = q.eq('current_stage', filters.stage)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchTouchPerformance = async (filters: PerformanceFilters, limit = 100): Promise<TouchPerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('touch_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.touch_number !== undefined) q = q.eq('touch_number', filters.touch_number)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchLanguagePerformance = async (filters: PerformanceFilters, limit = 100): Promise<LanguagePerformance[]> => {
  const supabase = getSupabaseClient()
  let q = supabase.from('language_performance_kpis_v').select('*').eq('time_window', filters.time_window)
  if (filters.language) q = q.eq('language', filters.language)
  const { data, error } = await q.order('sends', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export const fetchPerformanceTrends = async (_filters: PerformanceFilters, days = 30): Promise<PerformanceTrend[]> => {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('performance_trends_v')
    .select('*')
    .order('trend_date', { ascending: false })
    .limit(days)

  if (error) throw error
  
  return (data || []).map((d: any) => ({
    ...d,
    reply_rate_pct: d.sends > 0 ? (d.inbound_replies / d.sends) * 100 : 0,
    positive_rate_pct: d.sends > 0 ? (d.positive_replies / d.sends) * 100 : 0,
    opt_out_rate_pct: d.sends > 0 ? (d.opt_outs / d.sends) * 100 : 0,
  })).reverse()
}

export const fetchPerformanceOutliers = async (): Promise<Outlier[]> => {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.from('performance_outliers_v').select('*')
  if (error) throw error
  return data || []
}

export const fetchAttributionCoverage = async () => {
  const supabase = getSupabaseClient()
  
  // Base check for coverage from the primary view
  const { count: total, error: totalError } = await supabase
    .from('performance_message_events_v')
    .select('*', { count: 'exact', head: true })
    .eq('direction', 'outbound')

  if (totalError) throw totalError

  const { count: known, error: knownError } = await supabase
    .from('performance_message_events_v')
    .select('*', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .neq('template_key', 'unknown')

  if (knownError) throw knownError
  
  const totalCount = total || 0
  const knownCount = known || 0

  return {
    total: totalCount,
    known: knownCount,
    coverage_pct: totalCount > 0 ? (knownCount / totalCount) * 100 : 0
  }
}

export const fetchPerformanceOverview = async (filters: PerformanceFilters) => {
  // A helper that fetches the top metrics across dimensions to feed the main overview cards
  const [
    templates,
    numbers,
    markets,
    propertyTypes,
    sellerSignals,
    propertySignals,
    stages,
    touches,
    trends
  ] = await Promise.all([
    fetchTemplatePerformance(filters, 50),
    fetchNumberPerformance(filters, 50),
    fetchMarketPerformance(filters, 50),
    fetchPropertyTypePerformance(filters, 50),
    fetchSellerSignalPerformance(filters, 50),
    fetchPropertySignalPerformance(filters, 50),
    fetchStagePerformance(filters, 50),
    fetchTouchPerformance(filters, 50),
    fetchPerformanceTrends(filters, filters.time_window === '7d' ? 7 : (filters.time_window === '30d' ? 30 : 14))
  ])

  // Aggregate totals using the most granular dimension without massive overlap issues.
  // Templates are a good proxy for overall volume.
  const totalSends = templates.reduce((acc, t) => acc + t.sends, 0)
  const totalDelivered = templates.reduce((acc, t) => acc + t.delivered, 0)
  const totalFailed = templates.reduce((acc, t) => acc + t.failed, 0)
  const totalReplies = templates.reduce((acc, t) => acc + t.inbound_replies, 0)
  const totalPositives = templates.reduce((acc, t) => acc + t.positive_replies, 0)
  const totalOptOuts = templates.reduce((acc, t) => acc + t.opt_outs, 0)
  const totalWrongNumbers = templates.reduce((acc, t) => acc + t.wrong_numbers, 0)

  return {
    sends: totalSends,
    delivered: totalDelivered,
    failed: totalFailed,
    replies: totalReplies,
    positives: totalPositives,
    opt_outs: totalOptOuts,
    wrong_numbers: totalWrongNumbers,
    reply_rate_pct: totalSends > 0 ? (totalReplies / totalSends) * 100 : 0,
    positive_rate_pct: totalSends > 0 ? (totalPositives / totalSends) * 100 : 0,
    opt_out_rate_pct: totalSends > 0 ? (totalOptOuts / totalSends) * 100 : 0,
    delivery_rate_pct: totalSends > 0 ? (totalDelivered / totalSends) * 100 : 0,
    failure_rate_pct: totalSends > 0 ? (totalFailed / totalSends) * 100 : 0,
    templates,
    numbers,
    markets,
    propertyTypes,
    sellerSignals,
    propertySignals,
    stages,
    touches,
    trends
  }
}

export const usePerformanceIntelligence = (window: TimeWindow = '7d') => {
  const [outliers, setOutliers] = useState<{
    bestTemplate: TemplatePerformance | undefined
    riskiestTemplate: TemplatePerformance | undefined
    bestNumber: NumberPerformance | undefined
    riskiestNumber: NumberPerformance | undefined
  } | null>(null)
  const [coverage, setCoverage] = useState<{
    total: number
    known: number
    coverage_pct: number
  } | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const [templates, numbers, cov] = await Promise.all([
        fetchTemplatePerformance({ time_window: window }, 50),
        fetchNumberPerformance({ time_window: window }, 50),
        fetchAttributionCoverage()
      ])

      setOutliers({
        bestTemplate: templates.find(t => t.performance_label === 'winner') || templates[0],
        riskiestTemplate: templates.find(t => t.performance_label === 'pause_candidate' || t.performance_label === 'risky') || [...templates].sort((a, b) => (b.opt_out_rate_pct || 0) - (a.opt_out_rate_pct || 0))[0],
        bestNumber: numbers.find(n => n.performance_label === 'winner' || n.performance_label === 'stable') || [...numbers].sort((a, b) => (a.failure_rate_pct || 0) - (b.failure_rate_pct || 0))[0],
        riskiestNumber: numbers.find(n => n.performance_label === 'pause_candidate' || n.performance_label === 'risky') || [...numbers].sort((a, b) => (b.failure_rate_pct || 0) - (a.failure_rate_pct || 0))[0]
      })
      setCoverage(cov)
    } catch (err) {
      console.error('[Performance Hook] Failed:', err)
    } finally {
      setIsLoading(false)
    }
  }, [window])

  useEffect(() => {
    load()
  }, [load])

  return { outliers, coverage, isLoading, refresh: load }
}
