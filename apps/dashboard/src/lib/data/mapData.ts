import type { LiveDashboardModel } from '../../modules/dashboard/live/live-dashboard.adapter'
import { getSupabaseClient } from '../supabaseClient'
import {
  asNumber,
  asString,
  getFirst,
  mapErrorMessage,
  normalizeStatus,
  safeArray,
  type AnyRecord,
} from './shared'

const marketKey = (value: string) => value.trim().toLowerCase()

const matchMarket = (
  market: LiveDashboardModel['markets'][number],
  supabaseMarketRows: AnyRecord[],
): AnyRecord | undefined => {
  const wanted = new Set([
    marketKey(market.id),
    marketKey(market.slug),
    marketKey(market.name),
    marketKey(market.label),
  ])

  return supabaseMarketRows.find((row) => {
    const candidates = [
      asString(getFirst(row, ['market_id']), ''),
      asString(getFirst(row, ['slug']), ''),
      asString(getFirst(row, ['name', 'label']), ''),
      asString(getFirst(row, ['city']), ''),
      asString(getFirst(row, ['market']), ''),
    ]
    return candidates.some((candidate) => candidate && wanted.has(marketKey(candidate)))
  })
}

const toneForHeat = (hotLeads: number): 'hot' | 'warm' | 'steady' => {
  if (hotLeads >= 20) return 'hot'
  if (hotLeads >= 8) return 'warm'
  return 'steady'
}

export const hydrateLiveDashboardFromSupabase = async (
  baseModel: LiveDashboardModel,
): Promise<LiveDashboardModel> => {
  const supabase = getSupabaseClient()

  const [marketResult, propertyResult, queueResult, eventResult] = await Promise.all([
    supabase
      .from('markets')
      .select('market_id,slug,name,label,city,state,state_code,latitude,lat,longitude,lng,status')
      .limit(500),
    supabase
      .from('properties')
      .select('property_id,market_id,market,motivation_score,priority_score,status')
      .limit(4000),
    supabase
      .from('send_queue')
      .select('queue_id,market_id,market,status')
      .limit(4000),
    supabase
      .from('message_events')
      .select('event_id,market_id,market,direction,sentiment')
      .limit(6000),
  ])

  if (marketResult.error) throw new Error(mapErrorMessage(marketResult.error))
  if (propertyResult.error) throw new Error(mapErrorMessage(propertyResult.error))
  if (queueResult.error) throw new Error(mapErrorMessage(queueResult.error))
  if (eventResult.error) throw new Error(mapErrorMessage(eventResult.error))

  const marketRows = safeArray(marketResult.data as AnyRecord[])
  const propertyRows = safeArray(propertyResult.data as AnyRecord[])
  const queueRows = safeArray(queueResult.data as AnyRecord[])
  const eventRows = safeArray(eventResult.data as AnyRecord[])

  const propertiesByMarket = new Map<string, number>()
  const hotByMarket = new Map<string, number>()
  for (const row of propertyRows) {
    const key = marketKey(asString(getFirst(row, ['market_id', 'market']), 'unknown'))
    propertiesByMarket.set(key, (propertiesByMarket.get(key) ?? 0) + 1)
    const motive = asNumber(getFirst(row, ['motivation_score', 'priority_score']), 0)
    if (motive >= 70) hotByMarket.set(key, (hotByMarket.get(key) ?? 0) + 1)
  }

  const outboundByMarket = new Map<string, number>()
  const failuresByMarket = new Map<string, number>()
  for (const row of queueRows) {
    const key = marketKey(asString(getFirst(row, ['market_id', 'market']), 'unknown'))
    outboundByMarket.set(key, (outboundByMarket.get(key) ?? 0) + 1)
    const status = normalizeStatus(getFirst(row, ['status']))
    if (status === 'failed' || status === 'retry' || status === 'held') {
      failuresByMarket.set(key, (failuresByMarket.get(key) ?? 0) + 1)
    }
  }

  const repliesByMarket = new Map<string, number>()
  const positiveByMarket = new Map<string, number>()
  for (const row of eventRows) {
    const key = marketKey(asString(getFirst(row, ['market_id', 'market']), 'unknown'))
    const direction = normalizeStatus(getFirst(row, ['direction']))
    if (direction === 'inbound') repliesByMarket.set(key, (repliesByMarket.get(key) ?? 0) + 1)
    const sentiment = normalizeStatus(getFirst(row, ['sentiment']))
    if (sentiment === 'positive' || sentiment === 'interested' || sentiment === 'hot') {
      positiveByMarket.set(key, (positiveByMarket.get(key) ?? 0) + 1)
    }
  }

  const markets = baseModel.markets.map((market) => {
    const matched = matchMarket(market, marketRows)
    const idKey = marketKey(asString(getFirst(matched ?? {}, ['market_id']), market.id))
    const fallbackKey = marketKey(market.name)

    const marketProps =
      propertiesByMarket.get(idKey) ??
      propertiesByMarket.get(fallbackKey) ??
      market.activeProperties
    const outbound =
      outboundByMarket.get(idKey) ??
      outboundByMarket.get(fallbackKey) ??
      market.outboundToday
    const replies =
      repliesByMarket.get(idKey) ??
      repliesByMarket.get(fallbackKey) ??
      market.repliesToday
    const hotLeads =
      hotByMarket.get(idKey) ??
      hotByMarket.get(fallbackKey) ??
      market.hotLeads
    const failures =
      failuresByMarket.get(idKey) ??
      failuresByMarket.get(fallbackKey) ??
      0

    const deliverability = outbound > 0 ? Math.max(70, ((outbound - failures) / outbound) * 100) : market.deliverability
    const replyRate = outbound > 0 ? (replies / outbound) * 100 : market.replyRate
    const positive = positiveByMarket.get(idKey) ?? positiveByMarket.get(fallbackKey) ?? 0
    const positiveRate = replies > 0 ? (positive / replies) * 100 : market.positiveRate

    return {
      ...market,
      slug: asString(getFirst(matched ?? {}, ['slug']), market.slug),
      name: asString(getFirst(matched ?? {}, ['name', 'city']), market.name),
      stateCode: asString(getFirst(matched ?? {}, ['state_code', 'state']), market.stateCode),
      lat: asNumber(getFirst(matched ?? {}, ['latitude', 'lat']), market.lat),
      lng: asNumber(getFirst(matched ?? {}, ['longitude', 'lng']), market.lng),
      activeProperties: marketProps,
      outboundToday: outbound,
      repliesToday: replies,
      hotLeads,
      heat: toneForHeat(hotLeads),
      deliverability,
      replyRate,
      positiveRate,
      healthScore: Math.round((deliverability + replyRate + positiveRate) / 3),
    }
  })

  const totalOutbound = markets.reduce((sum, market) => sum + market.outboundToday, 0)
  const totalReplies = markets.reduce((sum, market) => sum + market.repliesToday, 0)
  const totalHot = markets.reduce((sum, market) => sum + market.hotLeads, 0)

  const summaryMetrics = baseModel.summaryMetrics.map((metric) => {
    if (metric.id === 'total-outbound') {
      return { ...metric, value: new Intl.NumberFormat('en-US').format(totalOutbound), detail: 'from Supabase send_queue' }
    }
    if (metric.id === 'replies-today') {
      return { ...metric, value: new Intl.NumberFormat('en-US').format(totalReplies), detail: `${totalHot} hot leads` }
    }
    if (metric.id === 'active-markets') {
      return { ...metric, value: `${markets.length}`, detail: `${markets.filter((m) => m.campaignStatus === 'live').length} live` }
    }
    return metric
  })

  return {
    ...baseModel,
    generatedAtIso: new Date().toISOString(),
    dataSource: 'live',
    markets,
    summaryMetrics,
  }
}
