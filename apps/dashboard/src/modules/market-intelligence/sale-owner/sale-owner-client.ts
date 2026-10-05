import { useEffect, useSyncExternalStore } from 'react'
import { callBackend } from '../../../lib/api/backendClient'

/**
 * THE shared buyer-of-record client (owner-approved rule, 2026-10-05). It is used by Market
 * Intelligence (recent sales, inspector), the Map desktop comp card and the Comp Intelligence
 * evidence rows.
 *
 * Rule (decided server-side; this client only fetches and renders):
 *   - a recorded deed buyer is the buyer;
 *   - otherwise, for a property's MOST RECENT sale with no later transfer, today's owner of
 *     record is shown as "… · current owner of record", never implying the deed named them;
 *   - any other sale: "Buyer not on record";
 *   - individuals are never named, and a missing company name stays
 *     "Company (name not on record)".
 *
 * Fetching: keys requested anywhere in the same tick are batched into ONE request
 * (GET /api/cockpit/market-intel?op=sale_owner&ids=…&props=…, ≤ 100 of each per request).
 * Results are cached by key (comp id, or "<property_id>@<YYYY-MM-DD>"). There is no per-row
 * fan-out and no fetch on hover (peek only).
 */
export type BuyerBasis = 'recorded_buyer' | 'current_owner_of_record' | 'not_on_record'
export interface BuyerOfRecord { label: string; short?: string; basis: BuyerBasis; kind: 'company' | 'individual' | 'trust' | null | string; name: string | null; linked: boolean; reason: string | null }
export interface OwnerLink { linked: boolean; reason: string | null; explanation: string | null; rule?: string; owner_observed_on: string | null; later_transfer_on: string | null }
export interface InferredSale { tier: string; label: string; investor: boolean; evidence: string[]; rule?: string; mailing_stack: number | null }
export interface SaleOwnerRow { comp_id?: string; buyer_of_record: BuyerOfRecord | null; owner_link: OwnerLink | null; inferred: InferredSale | null; missing?: true }

export const SALE_OWNER_MAX = 100
const TTL_MS = 10 * 60_000
const ERROR_RETRY_MS = 60_000
const COMP_ID = /^[a-z]:[A-Za-z0-9_.:-]{1,80}$/
const PROP_KEY = /^[A-Za-z0-9_.:-]{1,80}@\d{4}-\d{2}-\d{2}$/

/** Key for a sale without a comp id: "<property_id>@<YYYY-MM-DD>" (null when unusable). */
export function propSaleKey(propertyId: string | null | undefined, saleDate: string | null | undefined): string | null {
  if (!propertyId || !saleDate) return null
  const k = `${String(propertyId).trim()}@${String(saleDate).slice(0, 10)}`
  return PROP_KEY.test(k) ? k : null
}
export const isCompKey = (k: string) => COMP_ID.test(k)
export const isPropKey = (k: string) => PROP_KEY.test(k)

type Entry = { status: 'pending' | 'ready' | 'error'; row: SaleOwnerRow | null; at: number }
export type SaleOwnerFetcher = (ids: string[], props: string[]) => Promise<SaleOwnerRow[] | null>

const defaultFetcher: SaleOwnerFetcher = async (ids, props) => {
  const q = new URLSearchParams({ op: 'sale_owner' })
  if (ids.length) q.set('ids', ids.join(','))
  if (props.length) q.set('props', props.join(','))
  const res = await callBackend<{ ok: boolean; rows?: SaleOwnerRow[] }>(`/api/cockpit/market-intel?${q.toString()}`, { timeoutMs: 20_000 })
  return res.ok && res.data?.ok && Array.isArray(res.data.rows) ? res.data.rows : null
}

export function createSaleOwnerClient(fetcher: SaleOwnerFetcher = defaultFetcher, clock: () => number = () => Date.now()) {
  const cache = new Map<string, Entry>()
  const queue = new Set<string>()
  const subs = new Set<() => void>()
  let version = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let requests = 0
  const notify = () => { version += 1; for (const s of subs) s() }

  const fresh = (e: Entry | undefined) => Boolean(e) && (e!.status === 'pending' || (e!.status === 'ready' && clock() - e!.at < TTL_MS) || (e!.status === 'error' && clock() - e!.at < ERROR_RETRY_MS))

  async function flush() {
    timer = null
    const keys = [...queue]
    queue.clear()
    const ids = keys.filter(isCompKey)
    const props = keys.filter(isPropKey)
    for (let i = 0; i < Math.max(ids.length, props.length); i += SALE_OWNER_MAX) {
      const idChunk = ids.slice(i, i + SALE_OWNER_MAX)
      const propChunk = props.slice(i, i + SALE_OWNER_MAX)
      requests += 1
      let rows: SaleOwnerRow[] | null = null
      try { rows = await fetcher(idChunk, propChunk) } catch { rows = null }
      const now = clock()
      // The API answers ids first, then props, one row per requested key, in request order.
      ;[...idChunk, ...propChunk].forEach((k, j) => {
        const row = rows ? rows[j] ?? null : null
        cache.set(k, rows ? { status: 'ready', row: row && !row.missing ? row : null, at: now } : { status: 'error', row: null, at: now })
      })
      notify()
    }
  }

  /** Ask for keys (batched into the next flush; cached keys are not re-asked). */
  function request(keys: ReadonlyArray<string | null | undefined>) {
    let added = false
    for (const k of keys) {
      if (!k || !(isCompKey(k) || isPropKey(k)) || fresh(cache.get(k)) || queue.has(k)) continue
      queue.add(k)
      cache.set(k, { status: 'pending', row: null, at: clock() })
      added = true
    }
    if (added && !timer) timer = setTimeout(() => { void flush() }, 0)
  }
  /** Seed rows a read already carried (op=recent_sales): no request. */
  function prime(entries: ReadonlyArray<[string, SaleOwnerRow | null]>) {
    const now = clock()
    for (const [k, row] of entries) if (k && row) cache.set(k, { status: 'ready', row, at: now })
    notify()
  }
  /** Cached row, if any (never fetches). */
  const peek = (k: string | null | undefined): SaleOwnerRow | null => (k ? cache.get(k)?.row ?? null : null)
  const statusOf = (k: string | null | undefined) => (k ? cache.get(k)?.status ?? 'idle' : 'idle')
  const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb) } }
  const getVersion = () => version
  return { request, prime, peek, statusOf, subscribe, getVersion, flushNow: flush, stats: () => ({ requests, cached: cache.size }) }
}
export type SaleOwnerClient = ReturnType<typeof createSaleOwnerClient>

export const saleOwnerClient = createSaleOwnerClient()

/** Rows for a view's keys: one batched request for whatever is not cached yet. */
export function useSaleOwners(keys: ReadonlyArray<string | null | undefined>, client: SaleOwnerClient = saleOwnerClient): (key: string | null | undefined) => SaleOwnerRow | null {
  useSyncExternalStore(client.subscribe, client.getVersion, client.getVersion)
  const sig = keys.filter(Boolean).join('|')
  useEffect(() => { client.request(sig ? sig.split('|') : []) }, [sig, client])
  return client.peek
}

// ── display (exact copy per the spec) ────────────────────────────────────────
const TIER_SHORT: Record<string, string> = { strong: 'Strong', likely: 'Likely', trust_estate: 'Trust / estate', absentee_only: 'Absentee only', no_signal: 'No investor signal' }
export const TIER_DEFINITION: Record<string, string> = {
  strong: 'Entity owner AND (out-of-state tax mailing OR ≥ 2 properties at the same mailing address), OR a non-entity owner with out-of-state tax mailing AND ≥ 3 properties at the mailing address.',
  likely: 'Entity owner alone, OR out-of-state tax mailing with 2 properties at the mailing address, OR a non-entity owner whose only signal is ≥ 3 properties at the same mailing address.',
  trust_estate: 'Trust / estate owner: its own class, not counted (≥ 3 stacked → Likely; with out-of-state mailing → Strong).',
  absentee_only: 'Individual with out-of-state tax mailing, no stack: not counted.',
  no_signal: 'Individual, in-state mailing, no stack (or resident-owner evidence): not an investor.',
}
const EVIDENCE: Record<string, string> = {
  entity_owner: 'Entity owner', trust_owner: 'Trust owner', out_of_state_mailing: 'Out-of-state tax mailing',
  mailing_stack_2: '2 properties at the mailing address', mailing_stack_3_plus: '3+ properties at the mailing address', resident_owner_contact: 'Resident-owner contact',
}
export const OWNER_SUFFIX = ' · current owner of record'

export interface BuyerDisplay {
  /** The full label, verbatim from the API (e.g. "Company (name not on record) · current owner of record"). */
  text: string
  lead: string
  suffix: string | null
  basis: BuyerBasis | null
  tooltip: string | null
  inferred: { text: string; investor: boolean; tooltip: string } | null
}

/** Pure: a resolver row → what every surface prints. `fallback` when there is no row. */
export function describeBuyerOfRecord(row: SaleOwnerRow | null | undefined, fallback = 'Buyer not on record'): BuyerDisplay {
  const b = row?.buyer_of_record
  if (!b) return { text: fallback, lead: fallback, suffix: null, basis: null, tooltip: null, inferred: null }
  const link = row?.owner_link
  const observed = link?.owner_observed_on ? `Owner observed ${String(link.owner_observed_on).slice(0, 10)}.` : null
  const inf = row?.inferred
  const inferred = inf && inf.investor ? {
    text: `Inferred investor · ${TIER_SHORT[inf.tier] ?? inf.tier}`,
    investor: true,
    tooltip: [inf.label, TIER_DEFINITION[inf.tier], inf.evidence?.length ? `Evidence: ${inf.evidence.map((e) => EVIDENCE[e] ?? e.replace(/_/g, ' ')).join(', ')}.` : null, 'Inferred from the current owner of record, not the deed.'].filter(Boolean).join(' '),
  } : null
  if (b.basis === 'current_owner_of_record') {
    const text = b.label
    const hasSuffix = text.endsWith(OWNER_SUFFIX)
    return { text, lead: hasSuffix ? text.slice(0, -OWNER_SUFFIX.length) : (b.short ?? text), suffix: hasSuffix ? OWNER_SUFFIX.slice(3) : null, basis: b.basis,
      tooltip: [link?.explanation ?? null, observed].filter(Boolean).join(' ') || null, inferred }
  }
  if (b.basis === 'not_on_record') return { text: b.label || 'Buyer not on record', lead: b.label || 'Buyer not on record', suffix: null, basis: b.basis, tooltip: link?.explanation ?? null, inferred: null }
  return { text: b.label, lead: b.label, suffix: null, basis: b.basis, tooltip: null, inferred }
}
