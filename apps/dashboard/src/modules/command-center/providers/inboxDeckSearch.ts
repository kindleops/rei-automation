import { callBackend } from '../../../lib/api/backendClient'

/**
 * THE INBOX, SEARCHED FROM THE COMMAND DECK — one bounded server request.
 *
 * The seller and property providers used to query `v_operator_inbox_threads`
 * for columns that view does not have (seller_display_name, owner_display_name,
 * contact_name, email, property_address_city, …), so PostgREST rejected every
 * query and both providers silently returned nothing. They now share this one
 * read of the Inbox's own search (GET /api/cockpit/inbox/live, filter=all,
 * search_scope=deck):
 *
 *   searchable  seller / owner / prospect name · phone · street address ·
 *               city · ZIP · market · the latest reply
 *   not         older message text (the corpus scan is excluded for type-ahead
 *               speed), email, stage, intent, campaign, value, follow-up date
 *
 * Bounded: ≥ 3 characters, 8 rows, an 8 s ceiling, one request per distinct
 * query (in-flight and recent results are shared by both providers). A
 * degraded answer (the server's stale boot snapshot) is NOT a search result
 * and is never shown as one.
 */

export interface InboxDeckHit {
  threadKey: string
  propertyId: string | null
  masterOwnerId: string | null
  name: string
  street: string | null
  locality: string | null
  market: string | null
  latest: string | null
  latestDirection: 'inbound' | 'outbound' | 'unknown'
  latestAt: string | null
  stage: string | null
  suppressed: boolean
}

export const DECK_SEARCH_MIN_CHARS = 3
const LIMIT = 8
const TIMEOUT_MS = 8_000
const TTL_MS = 30_000
const MAX_ENTRIES = 24

const cache = new Map<string, { at: number; promise: Promise<InboxDeckHit[]> }>()

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim())

const formatPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : value
}

function splitAddress(full: string): { street: string | null; rest: string | null } {
  if (!full) return { street: null, rest: null }
  const comma = full.indexOf(',')
  return comma < 0 ? { street: full, rest: null } : { street: full.slice(0, comma).trim(), rest: full.slice(comma + 1).trim() || null }
}

/** One Inbox row (compact contract) as a search hit. Exported for tests. */
export function toDeckHit(row: Record<string, unknown>): InboxDeckHit | null {
  const threadKey = str(row.thread_key) || str(row.canonical_thread_key)
  if (!threadKey) return null
  const phone = str(row.canonical_e164) || str(row.seller_phone) || threadKey
  const name = str(row.seller_display_name) || str(row.owner_name) || str(row.display_name) || formatPhone(phone)
  const address = splitAddress(str(row.property_address_full) || str(row.property_address))
  const direction = str(row.latest_message_direction || row.latest_direction || row.direction).toLowerCase()
  return {
    threadKey,
    propertyId: str(row.property_id) || null,
    masterOwnerId: str(row.master_owner_id) || null,
    name,
    street: address.street,
    locality: address.rest,
    market: str(row.market) || null,
    latest: str(row.latest_message_body || row.preview).replace(/\s+/g, ' ') || null,
    latestDirection: direction.startsWith('in') ? 'inbound' : direction.startsWith('out') ? 'outbound' : 'unknown',
    latestAt: str(row.latest_message_at || row.latest_activity_at) || null,
    stage: str(row.seller_stage) || null,
    suppressed: row.is_suppressed === true || row.opt_out === true,
  }
}

async function run(query: string): Promise<{ ok: boolean; hits: InboxDeckHit[] }> {
  const params = new URLSearchParams({
    filter: 'all',
    q: query,
    limit: String(LIMIT),
    map: '0',
    timeout_mode: 'manual_bucket_switch',
    search_scope: 'deck',
    skip_counts: '1',
    skip_delivery: '1',
    refresh_reason: 'command_deck_search',
  })
  const timeout = new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), TIMEOUT_MS) })
  const result = await Promise.race([callBackend<Record<string, unknown>>(`/api/cockpit/inbox/live?${params.toString()}`), timeout])
  if (!result || !result.ok) return { ok: false, hits: [] }
  const body = (result.data ?? {}) as Record<string, unknown>
  const nested = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>
  if (body.degraded === true || nested.degraded === true) return { ok: false, hits: [] }
  const rows = (Array.isArray(body.threads) ? body.threads : Array.isArray(nested.threads) ? nested.threads : []) as Record<string, unknown>[]
  const seen = new Set<string>()
  const hits: InboxDeckHit[] = []
  for (const row of rows) {
    const hit = toDeckHit(row)
    if (!hit || seen.has(hit.threadKey)) continue
    seen.add(hit.threadKey)
    hits.push(hit)
  }
  return { ok: true, hits }
}

/** The shared search. Both providers await the same promise for the same query. */
export function searchInboxDeck(rawQuery: string): Promise<InboxDeckHit[]> {
  const query = rawQuery.trim().replace(/\s+/g, ' ')
  if (query.length < DECK_SEARCH_MIN_CHARS || typeof window === 'undefined') return Promise.resolve([])
  const key = query.toLowerCase()
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < TTL_MS) return hit.promise
  // A failed or degraded answer is not remembered: the next keystroke asks again.
  const promise = run(query)
    .then((result) => { if (!result.ok) cache.delete(key); return result.hits })
    .catch(() => { cache.delete(key); return [] as InboxDeckHit[] })
  cache.set(key, { at: now, promise })
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return promise
}
