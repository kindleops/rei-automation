import type { QueueItem, TextgridFleetNumber } from '../../domain/queue/queue.types'
import { BLOCKED_STATUSES, isDelivered, isFailed, isSent, pct } from './queue-ui-helpers'

export type SenderFleetState = 'active' | 'paused' | 'degraded' | 'blocked' | 'unregistered'
export type SenderHealth = 'healthy' | 'watch' | 'degraded' | 'critical' | 'blocked'

export interface SenderStat {
  id: string | null
  phone: string
  friendlyName: string | null
  market: string
  stateCode: string | null
  registered: boolean
  configuredActive: boolean
  dailyCap: number | null
  messagesSentToday: number
  registryLastUsedAt: string | null
  healthScore: number | null
  sent: number
  delivered: number
  failed: number
  blocked: number
  optOuts: number
  violations21610: number
  deliveryPct: number
  failPct: number
  blockPct: number
  health: SenderHealth
  performanceLabel: string
  operationalLabel: string
  lastUsed: string | null
  state: SenderFleetState
  rangeRows: number
}

export interface SenderFleetSummary {
  fleetTotal: number
  active: number
  paused: number
  degraded: number
  blocked: number
  unregistered: number
  sent: number
  delivered: number
  failed: number
  blockedRows: number
  optOuts: number
  violations21610: number
  deliveryPct: number
  failPct: number
  dailyCapTotal: number | null
  sentTodayTotal: number
  markets: string[]
}

const ACTIVE_QUEUE_STATUSES = new Set(['scheduled', 'queued', 'ready', 'sending'])

export const normalizeSenderPhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, '')
  if (digits.length >= 10) return digits.slice(-10)
  return digits || phone.trim()
}

function healthFromPct(failRate: number): Exclude<SenderHealth, 'blocked'> {
  if (failRate >= 30) return 'critical'
  if (failRate >= 15) return 'degraded'
  if (failRate >= 5) return 'watch'
  return 'healthy'
}

function makeSenderStat(seed: Partial<SenderStat> & Pick<SenderStat, 'phone'>): SenderStat {
  return {
    id: null,
    friendlyName: null,
    market: '—',
    stateCode: null,
    registered: false,
    configuredActive: true,
    dailyCap: null,
    messagesSentToday: 0,
    registryLastUsedAt: null,
    healthScore: null,
    sent: 0,
    delivered: 0,
    failed: 0,
    blocked: 0,
    optOuts: 0,
    violations21610: 0,
    deliveryPct: 0,
    failPct: 0,
    blockPct: 0,
    health: 'healthy',
    performanceLabel: 'Performance: —',
    operationalLabel: 'Routing available',
    lastUsed: null,
    state: 'unregistered',
    rangeRows: 0,
    ...seed,
  }
}

function resolveSenderState(
  stat: SenderStat,
  hasActive: boolean,
): SenderFleetState {
  if (stat.violations21610 > 0) return 'blocked'
  if (!stat.registered) return 'unregistered'
  if (!stat.configuredActive) return 'paused'
  if (hasActive) return 'active'
  if (stat.health === 'degraded' || stat.health === 'critical') return 'degraded'
  if (stat.sent > 0) return 'paused'
  return 'paused'
}

function finalizeSenderStat(stat: SenderStat, items: QueueItem[]): SenderStat {
  const hasActive = items.some((i) => {
    const phone = i.fromPhoneNumber || i.textgridNumber
    if (!phone) return false
    return normalizeSenderPhone(phone) === normalizeSenderPhone(stat.phone) &&
      ACTIVE_QUEUE_STATUSES.has(i.status)
  })

  stat.deliveryPct = pct(stat.delivered, stat.sent)
  stat.failPct = pct(stat.failed, stat.sent)
  stat.blockPct = pct(stat.blocked, stat.rangeRows)
  stat.health = stat.violations21610 > 0
    ? 'blocked'
    : healthFromPct(stat.failPct)
  stat.state = resolveSenderState(stat, hasActive)
  stat.performanceLabel = stat.sent === 0
    ? 'No sends in range'
    : `Performance: ${stat.deliveryPct}% delivered · ${stat.failPct}% fail`
  stat.operationalLabel = stat.state === 'active'
    ? 'Routing available'
    : stat.state === 'paused' && !stat.configuredActive
      ? 'Paused in TextGrid registry'
      : stat.state === 'paused' && stat.sent === 0
        ? 'Idle — no range activity'
        : stat.state === 'paused'
          ? 'Current routing: unavailable'
          : stat.state === 'degraded'
            ? 'Elevated failure rate — review'
            : stat.state === 'blocked'
              ? 'Blocked — compliance hold'
              : 'Unregistered sender'
  return stat
}

/** Seed from the full TextGrid fleet, then merge queue-item metrics for the range. */
export function buildSenderStats(
  items: QueueItem[],
  fleet: TextgridFleetNumber[] = [],
): SenderStat[] {
  const phoneToFleetKey = new Map<string, string>()
  const map = new Map<string, SenderStat>()

  for (const n of fleet) {
    const key = normalizeSenderPhone(n.phone)
    phoneToFleetKey.set(key, n.phone)
    map.set(n.phone, makeSenderStat({
      id: n.id,
      phone: n.phone,
      friendlyName: n.friendlyName,
      market: n.market,
      stateCode: n.state,
      registered: true,
      configuredActive: n.isActive,
      dailyCap: n.dailyCap,
      messagesSentToday: n.messagesSentToday,
      registryLastUsedAt: n.lastUsedAt,
      healthScore: n.healthScore,
      state: n.isActive ? 'paused' : 'paused',
    }))
  }

  for (const i of items) {
    const rawPhone = i.fromPhoneNumber || i.textgridNumber
    if (!rawPhone || rawPhone === 'unknown') continue
    const norm = normalizeSenderPhone(rawPhone)
    const fleetPhone = phoneToFleetKey.get(norm)
    const phone = fleetPhone ?? rawPhone
    const fleetRow = fleet.find((n) => normalizeSenderPhone(n.phone) === norm)

    const s = map.get(phone) ?? makeSenderStat({
      phone,
      market: i.market || '—',
      registered: Boolean(fleetRow),
      configuredActive: fleetRow?.isActive ?? true,
      friendlyName: fleetRow?.friendlyName ?? null,
      stateCode: fleetRow?.state ?? null,
      dailyCap: fleetRow?.dailyCap ?? null,
      messagesSentToday: fleetRow?.messagesSentToday ?? 0,
      registryLastUsedAt: fleetRow?.lastUsedAt ?? null,
      healthScore: fleetRow?.healthScore ?? null,
      id: fleetRow?.id ?? null,
    })

    s.rangeRows++
    if (isSent(i.status)) s.sent++
    if (isDelivered(i.status)) s.delivered++
    if (isFailed(i.status)) s.failed++
    if (BLOCKED_STATUSES.has(i.status)) s.blocked++
    if (i.failureCategory === 'recipient_opted_out') s.optOuts++
    if (i.failureCategory === 'blacklist_pair_21610') s.violations21610++

    const ts = i.lastEventAt || i.sentAt || i.updatedAt
    if (ts && (!s.lastUsed || ts > s.lastUsed)) s.lastUsed = ts

    if (fleetRow) {
      s.market = fleetRow.market
      s.friendlyName = fleetRow.friendlyName
      s.stateCode = fleetRow.state
      s.configuredActive = fleetRow.isActive
      s.dailyCap = fleetRow.dailyCap
      s.messagesSentToday = fleetRow.messagesSentToday
      s.registryLastUsedAt = fleetRow.lastUsedAt
      s.healthScore = fleetRow.healthScore
    } else if ((!s.market || s.market === '—') && i.market) {
      s.market = i.market
    }

    map.set(phone, s)
  }

  return Array.from(map.values())
    .map((s) => finalizeSenderStat(s, items))
    .sort((a, b) => {
      const aRegistered = a.registered ? 0 : 1
      const bRegistered = b.registered ? 0 : 1
      if (aRegistered !== bRegistered) return aRegistered - bRegistered
      if (a.market !== b.market) return a.market.localeCompare(b.market)
      return (b.sent + b.rangeRows) - (a.sent + a.rangeRows) || a.phone.localeCompare(b.phone)
    })
}

export function summarizeSenderFleet(stats: SenderStat[]): SenderFleetSummary {
  const registered = stats.filter((s) => s.registered)
  const sent = stats.reduce((n, s) => n + s.sent, 0)
  const delivered = stats.reduce((n, s) => n + s.delivered, 0)
  const failed = stats.reduce((n, s) => n + s.failed, 0)
  const caps = registered.map((s) => s.dailyCap).filter((c): c is number => c != null && c > 0)

  return {
    fleetTotal: registered.length || stats.length,
    active: stats.filter((s) => s.state === 'active').length,
    paused: stats.filter((s) => s.state === 'paused').length,
    degraded: stats.filter((s) => s.state === 'degraded').length,
    blocked: stats.filter((s) => s.state === 'blocked').length,
    unregistered: stats.filter((s) => s.state === 'unregistered').length,
    sent,
    delivered,
    failed,
    blockedRows: stats.reduce((n, s) => n + s.blocked, 0),
    optOuts: stats.reduce((n, s) => n + s.optOuts, 0),
    violations21610: stats.reduce((n, s) => n + s.violations21610, 0),
    deliveryPct: pct(delivered, sent),
    failPct: pct(failed, sent),
    dailyCapTotal: caps.length > 0 ? caps.reduce((n, c) => n + c, 0) : null,
    sentTodayTotal: registered.reduce((n, s) => n + s.messagesSentToday, 0),
    markets: Array.from(new Set(registered.map((s) => s.market).filter((m) => m && m !== '—'))).sort(),
  }
}