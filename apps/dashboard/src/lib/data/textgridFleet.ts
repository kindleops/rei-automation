import type { TextgridFleetNumber } from '../../domain/queue/queue.types'

type AnyRecord = Record<string, unknown>

const asString = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : v == null ? fallback : String(v)

const asNumber = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const asRecord = (v: unknown): AnyRecord =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRecord) : {}

const getFirst = (row: AnyRecord, keys: string[]): unknown => {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') return row[k]
  }
  return undefined
}

/** Canonical select list matching public.textgrid_numbers schema. */
export const TEXTGRID_FLEET_SELECT =
  'id,phone_number,friendly_name,market,status,daily_limit,messages_sent_today,last_used_at,health_score,metadata'

export function marketStateFromLabel(market: string): string | null {
  const parts = market.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const code = parts[parts.length - 1].toUpperCase()
  return /^[A-Z]{2}$/.test(code) ? code : null
}

export function isTextgridNumberInactive(row: AnyRecord): boolean {
  const status = asString(getFirst(row, ['status']), '').toLowerCase()
  return status === 'paused' || status === 'inactive' || status === 'disabled'
}

export function mapTextgridFleetRow(row: AnyRecord): TextgridFleetNumber | null {
  const phone = asString(getFirst(row, ['phone_number', 'number']), '').trim()
  if (!phone) return null

  const metadata = asRecord(row.metadata)
  const market =
    asString(getFirst(row, ['market', 'sender_market']), '').trim() ||
    asString(metadata.market, '').trim() ||
    '—'
  const friendlyName =
    asString(getFirst(row, ['friendly_name', 'friendlyName']), '').trim() ||
    asString(metadata.friendly_name, '').trim() ||
    null
  const dailyLimit = asNumber(getFirst(row, ['daily_limit', 'daily_cap', 'dailyCap']), 0)

  return {
    id: asString(row.id, phone),
    phone,
    friendlyName,
    market,
    state: marketStateFromLabel(market),
    status: asString(getFirst(row, ['status']), 'active'),
    isActive: !isTextgridNumberInactive(row),
    dailyCap: dailyLimit > 0 ? dailyLimit : null,
    messagesSentToday: Math.max(asNumber(getFirst(row, ['messages_sent_today']), 0), 0),
    lastUsedAt: asString(getFirst(row, ['last_used_at']), '') || null,
    healthScore: (() => {
      const score = getFirst(row, ['health_score'])
      return score == null ? null : asNumber(score, 0)
    })(),
  }
}

export function buildTextgridFleet(rows: AnyRecord[]): TextgridFleetNumber[] {
  return rows
    .map(mapTextgridFleetRow)
    .filter((n): n is TextgridFleetNumber => Boolean(n))
    .sort((a, b) => a.market.localeCompare(b.market) || a.phone.localeCompare(b.phone))
}

/** Production TextGrid fleet (synced from Supabase textgrid_numbers). */
export const PRODUCTION_TEXTGRID_FLEET: TextgridFleetNumber[] = [
  { id: 'e1ac5e35-d47d-4ae5-8292-6993ba7ff018', phone: '+14704920588', friendlyName: 'ATLANTA', market: 'Atlanta, GA', state: 'GA', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 1, lastUsedAt: '2026-06-26T18:21:45.446Z', healthScore: 1 },
  { id: '013bd315-453b-4171-93c7-a25f467c0390', phone: '+17042405818', friendlyName: 'CHARLOTTE-#1', market: 'Charlotte, NC', state: 'NC', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 3, lastUsedAt: '2026-04-23T14:05:26.235Z', healthScore: 1 },
  { id: '2fb0d9f1-d398-491b-bdee-3c289451d72a', phone: '+19804589889', friendlyName: 'CHARLOTTE-#2', market: 'Charlotte, NC', state: 'NC', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 1, lastUsedAt: '2026-06-19T15:31:45.762Z', healthScore: 1 },
  { id: '2c19333a-d751-4a0b-b76c-e1f860d23a94', phone: '+14693131600', friendlyName: 'DALLAS', market: 'Dallas, TX', state: 'TX', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 1, lastUsedAt: '2026-06-26T18:11:45.833Z', healthScore: 1 },
  { id: '43badc35-d6f3-4733-976c-7903cce143b3', phone: '+12818458577', friendlyName: 'HOUSTON', market: 'Houston, TX', state: 'TX', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 1, lastUsedAt: '2026-06-26T18:01:35.762Z', healthScore: 1 },
  { id: '1a770007-d132-48f3-979c-53f49b600543', phone: '+19048774448', friendlyName: 'JACKSONVILLE', market: 'Jacksonville, FL', state: 'FL', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 3, lastUsedAt: '2026-04-23T13:07:26.533Z', healthScore: 1 },
  { id: 'fcc2b5d2-dfda-4ecc-bc7f-96fd0e628ec0', phone: '+13234104544', friendlyName: 'LOS ANGELES-#1', market: 'Los Angeles, CA', state: 'CA', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 3, lastUsedAt: '2026-04-22T23:28:19.338Z', healthScore: 1 },
  { id: 'fe41b173-2c1e-4f55-8e7f-a19b667305bd', phone: '+13235589881', friendlyName: 'LOS ANGELES-#4', market: 'Los Angeles, CA', state: 'CA', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 1, lastUsedAt: '2026-06-25T15:11:45.500Z', healthScore: 1 },
  { id: 'ff371c02-604d-4b51-ac80-3ed983ab6600', phone: '+17866052999', friendlyName: 'MIAMI', market: 'Miami, FL', state: 'FL', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 1, lastUsedAt: '2026-06-26T19:59:45.458Z', healthScore: 1 },
  { id: '673d34f8-1d3c-47c8-bb1d-c8fda559ec9f', phone: '+16128060495', friendlyName: 'MINNEAPOLIS', market: 'Minneapolis, MN', state: 'MN', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 1, lastUsedAt: '2026-06-26T17:20:45.726Z', healthScore: 1 },
]