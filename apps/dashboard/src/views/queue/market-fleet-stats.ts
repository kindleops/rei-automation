import type { ConfiguredMarket, QueueItem, TextgridFleetNumber } from '../../domain/queue/queue.types'
import { marketStateFromLabel } from '../../lib/data/textgridFleet'
import { BLOCKED_STATUSES, isDelivered, isFailed, isSent, pct } from './queue-ui-helpers'

export type MarketHealth = 'healthy' | 'watch' | 'degraded' | 'critical' | 'idle'

export interface MarketStat {
  market: string
  stateCode: string | null
  senderCount: number
  activeSenderCount: number
  senderPhones: string[]
  dailyCapTotal: number | null
  messagesSentToday: number
  total: number
  sent: number
  delivered: number
  failed: number
  blocked: number
  optOuts: number
  violations21610: number
  deliveryPct: number
  failPct: number
  blockPct: number
  health: MarketHealth
  performanceHealth: string
  senderReadiness: string
  suggestedAction: string
  exceptionCount: number
  configured: boolean
  senderExists: boolean
  active: boolean
}

export interface MarketFleetSummary {
  marketCount: number
  configuredCount: number
  readyCount: number
  watchCount: number
  degradedCount: number
  noSenderCount: number
  idleCount: number
  unregisteredActivityCount: number
  totalRows: number
  sent: number
  delivered: number
  failed: number
  blocked: number
  optOuts: number
  violations21610: number
  exceptions: number
  deliveryPct: number
  failPct: number
  dailyCapTotal: number | null
  sentTodayTotal: number
  senderTotal: number
}

export type MarketHealthFilter = 'all' | 'configured' | 'ready' | 'watch' | 'degraded' | 'no-sender' | 'idle'

function healthFromPct(failRate: number): Exclude<MarketHealth, 'idle'> {
  if (failRate >= 30) return 'critical'
  if (failRate >= 15) return 'degraded'
  if (failRate >= 5) return 'watch'
  return 'healthy'
}

function makeMarketStat(market: string, seed: Partial<MarketStat> = {}): MarketStat {
  return {
    market,
    stateCode: marketStateFromLabel(market),
    senderCount: 0,
    activeSenderCount: 0,
    senderPhones: [],
    dailyCapTotal: null,
    messagesSentToday: 0,
    total: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    blocked: 0,
    optOuts: 0,
    violations21610: 0,
    deliveryPct: 0,
    failPct: 0,
    blockPct: 0,
    health: 'idle',
    performanceHealth: 'idle',
    senderReadiness: 'No registered sender',
    suggestedAction: 'Register an active sender for this market',
    exceptionCount: 0,
    configured: false,
    senderExists: false,
    active: false,
    ...seed,
  }
}

function seedFromFleet(fleet: TextgridFleetNumber[]): Map<string, MarketStat> {
  const map = new Map<string, MarketStat>()
  for (const n of fleet) {
    const market = n.market?.trim()
    if (!market || market === '—') continue
    const s = map.get(market) ?? makeMarketStat(market, {
      configured: true,
      senderExists: true,
      active: false,
    })
    s.senderCount++
    if (n.isActive) {
      s.activeSenderCount++
      s.active = true
    }
    s.senderPhones.push(n.phone)
    s.messagesSentToday += n.messagesSentToday
    if (n.dailyCap) {
      s.dailyCapTotal = (s.dailyCapTotal ?? 0) + n.dailyCap
    }
    if (!s.stateCode && n.state) s.stateCode = n.state
    map.set(market, s)
  }
  return map
}

function seedFromDirectory(directory: ConfiguredMarket[], map: Map<string, MarketStat>) {
  for (const d of directory) {
    const existing = map.get(d.market)
    if (existing) {
      existing.configured = true
      existing.senderExists = d.senderCount > 0
      existing.senderCount = Math.max(existing.senderCount, d.senderCount)
      existing.active = d.active
      existing.activeSenderCount = d.active ? Math.max(existing.activeSenderCount, d.senderCount) : existing.activeSenderCount
      continue
    }
    map.set(d.market, makeMarketStat(d.market, {
      configured: true,
      senderExists: d.senderCount > 0,
      senderCount: d.senderCount,
      activeSenderCount: d.active ? d.senderCount : 0,
      active: d.active,
    }))
  }
}

function finalizeMarketStat(stat: MarketStat, items: QueueItem[]): MarketStat {
  stat.deliveryPct = pct(stat.delivered, stat.sent)
  stat.failPct = pct(stat.failed, stat.sent)
  stat.blockPct = pct(stat.blocked, stat.total)
  const failHealth = healthFromPct(stat.failPct)

  stat.exceptionCount = items.filter((i) =>
    (i.market || 'Unknown') === stat.market &&
    (isFailed(i.status) || BLOCKED_STATUSES.has(i.status)),
  ).length

  stat.performanceHealth = stat.sent === 0 ? 'idle' : failHealth
  stat.senderReadiness = !stat.senderExists
    ? 'No registered sender'
    : stat.active
      ? `${stat.activeSenderCount} active sender${stat.activeSenderCount === 1 ? '' : 's'}`
      : 'Paused sender pool'

  if (!stat.senderExists && stat.total > 0) {
    stat.health = 'critical'
    stat.suggestedAction = 'Assign and activate a TextGrid sender for this market'
  } else if (!stat.active && stat.total > 0) {
    stat.health = failHealth === 'healthy' ? 'watch' : failHealth
    stat.suggestedAction = 'Resume sender pool or reroute queue rows'
  } else if (stat.total === 0) {
    stat.health = 'idle'
    stat.suggestedAction = stat.senderExists
      ? (stat.active ? 'No queue activity in range' : 'Activate sender before routing')
      : 'Register an active sender for this market'
  } else {
    stat.health = failHealth
    stat.suggestedAction = stat.exceptionCount > 0
      ? 'Review market exceptions in Failure Taxonomy'
      : 'No action required'
  }

  return stat
}

/** Seed configured markets from TextGrid fleet, merge queue metrics, surface unregistered activity. */
export function buildMarketStats(
  items: QueueItem[],
  directory: ConfiguredMarket[] = [],
  fleet: TextgridFleetNumber[] = [],
): MarketStat[] {
  const map = seedFromFleet(fleet)
  seedFromDirectory(directory, map)

  for (const i of items) {
    const m = i.market?.trim() || 'Unknown'
    const s = map.get(m) ?? makeMarketStat(m)
    s.total++
    if (isSent(i.status)) s.sent++
    if (isDelivered(i.status)) s.delivered++
    if (isFailed(i.status)) s.failed++
    if (BLOCKED_STATUSES.has(i.status)) s.blocked++
    if (i.failureCategory === 'recipient_opted_out') s.optOuts++
    if (i.failureCategory === 'blacklist_pair_21610') s.violations21610++
    map.set(m, s)
  }

  return Array.from(map.values())
    .map((s) => finalizeMarketStat(s, items))
    .sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? -1 : 1
      if (b.total !== a.total) return b.total - a.total
      return a.market.localeCompare(b.market)
    })
}

export function summarizeMarketFleet(stats: MarketStat[]): MarketFleetSummary {
  const configured = stats.filter((s) => s.configured)
  const sent = stats.reduce((n, s) => n + s.sent, 0)
  const delivered = stats.reduce((n, s) => n + s.delivered, 0)
  const failed = stats.reduce((n, s) => n + s.failed, 0)
  const caps = configured.map((s) => s.dailyCapTotal).filter((c): c is number => c != null && c > 0)

  return {
    marketCount: stats.length,
    configuredCount: configured.length,
    readyCount: stats.filter((s) => s.senderExists && s.active && s.health === 'healthy' && s.total > 0).length,
    watchCount: stats.filter((s) => s.health === 'watch').length,
    degradedCount: stats.filter((s) => s.health === 'degraded' || s.health === 'critical').length,
    noSenderCount: stats.filter((s) => !s.senderExists).length,
    idleCount: stats.filter((s) => s.total === 0).length,
    unregisteredActivityCount: stats.filter((s) => !s.configured && s.total > 0).length,
    totalRows: stats.reduce((n, s) => n + s.total, 0),
    sent,
    delivered,
    failed,
    blocked: stats.reduce((n, s) => n + s.blocked, 0),
    optOuts: stats.reduce((n, s) => n + s.optOuts, 0),
    violations21610: stats.reduce((n, s) => n + s.violations21610, 0),
    exceptions: stats.reduce((n, s) => n + s.exceptionCount, 0),
    deliveryPct: pct(delivered, sent),
    failPct: pct(failed, sent),
    dailyCapTotal: caps.length > 0 ? caps.reduce((n, c) => n + c, 0) : null,
    sentTodayTotal: configured.reduce((n, s) => n + s.messagesSentToday, 0),
    senderTotal: configured.reduce((n, s) => n + s.senderCount, 0),
  }
}

export function filterMarketStats(stats: MarketStat[], filter: MarketHealthFilter): MarketStat[] {
  switch (filter) {
    case 'configured':
      return stats.filter((s) => s.configured)
    case 'ready':
      return stats.filter((s) => s.senderExists && s.active && s.health === 'healthy')
    case 'watch':
      return stats.filter((s) => s.health === 'watch')
    case 'degraded':
      return stats.filter((s) => s.health === 'degraded' || s.health === 'critical')
    case 'no-sender':
      return stats.filter((s) => !s.senderExists)
    case 'idle':
      return stats.filter((s) => s.total === 0)
    default:
      return stats
  }
}