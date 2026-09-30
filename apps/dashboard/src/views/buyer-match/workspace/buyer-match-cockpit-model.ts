/**
 * BUYER MATCH · COCKPIT MODEL — pure reads of the server's evidence for the
 * desktop disposition cockpit. Nothing here scores, tiers or invents: every
 * word is a 1:1 reading of a model verdict, every receipt is a recorded
 * purchase (the workspace's located window rows, and the buyer's linked
 * purchases from the Entity Graph read model), and no party name is copied.
 */
import type { BuyerMatchWorkspace, MatchedBuyer, WindowTransaction } from '../../../domain/buyer-match/buyer-match-workspace-api'
import type { BuyerProfile } from '../../../domain/entity-graph/entity-graph-intel-api'

export type Tone = 'good' | 'mid' | 'bad' | 'unk'
export type Dim = 'type' | 'price' | 'market' | 'recency' | 'size'

export const DIM_LABEL: Record<Dim, string> = { type: 'Property type', price: 'Price', market: 'Geography', recency: 'Recency', size: 'Size' }
const DIM_SHORT: Record<Dim, string> = { type: 'Type', price: 'Price', market: 'Market', recency: 'Recency', size: 'Size' }

/** The model's verdict for each dimension, as the server returned it. */
export function verdictOf(b: MatchedBuyer, dim: Dim): string {
  if (dim === 'type') return b.fit.type
  if (dim === 'price') return b.fit.price.verdict
  if (dim === 'market') return b.fit.market
  if (dim === 'recency') return b.fit.recency
  return b.fit.size.verdict
}

/** Verdict → the strength word shown beside the finding. A dictionary, not a score. */
const WORDS: Record<Dim, Record<string, [string, Tone]>> = {
  type: { dominant: ['Strong evidence', 'good'], present: ['Match', 'good'], absent: ['No match', 'bad'], unknown: ['No evidence', 'unk'] },
  price: { inside: ['Match', 'good'], near: ['Close', 'mid'], outside: ['Outside', 'bad'], unknown: ['No evidence', 'unk'] },
  market: { strong: ['Strong evidence', 'good'], present: ['Match', 'good'], county: ['County only', 'mid'], none: ['No evidence', 'unk'] },
  recency: { active: ['Current', 'good'], recent: ['Recent', 'good'], slowing: ['Slowing', 'mid'], stale: ['Stale', 'bad'], unknown: ['No evidence', 'unk'] },
  size: { inside: ['Match', 'good'], near: ['Close', 'mid'], outside: ['Outside', 'bad'], unknown: ['No evidence', 'unk'] },
}

export function strength(dim: Dim, verdict: string): { word: string; tone: Tone } {
  const hit = WORDS[dim][verdict]
  return hit ? { word: hit[0], tone: hit[1] } : { word: 'No evidence', tone: 'unk' }
}

export const DIMS: Dim[] = ['type', 'price', 'market', 'recency', 'size']

/** The five row indicators: filled when the evidence passed, hollow otherwise. */
export function fitIndicators(b: MatchedBuyer): Array<{ dim: Dim; label: string; tone: Tone; word: string }> {
  return DIMS.map((dim) => {
    const s = strength(dim, verdictOf(b, dim))
    return { dim, label: DIM_SHORT[dim], tone: s.tone, word: s.word }
  })
}

const joinList = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`)

/**
 * One sentence, built only from the evidence flags that passed. No flags →
 * no sentence (never filler). Numbers stay in the figures; the only numbers
 * here are the window's own definitions (radius, 90 days, 12 months).
 */
export function thesis(b: MatchedBuyer, w: BuyerMatchWorkspace): string | null {
  if (b.tier === 'excluded') return b.exclusions.length ? `${b.exclusions.map((e) => e.label).join('. ')}.` : null
  const noun = w.subject.familyLabel.toLowerCase()
  const parts: string[] = []
  const sized = b.fit.size.verdict === 'inside'
  if (b.fit.type === 'dominant') parts.push(`focused on ${noun}${sized ? ' in this size range' : ''}`)
  else if (b.fit.type === 'present') parts.push(`buying ${noun} among other types${sized ? ', in this size range' : ''}`)
  else if (sized) parts.push('buying in this size range')
  if (b.fit.market === 'strong') parts.push(`repeatedly buying within ${w.query.radiusMiles} mi`)
  else if (b.fit.market === 'present') parts.push(`buying within ${w.query.radiusMiles} mi`)
  else if (b.fit.market === 'county' && w.subject.county) parts.push(`active in ${w.subject.county} County`)
  if (b.fit.price.verdict === 'inside') parts.push('paying inside this deal’s window')
  else if (b.fit.price.verdict === 'near') parts.push('paying close to this deal’s window')
  if (b.fit.recency === 'active') parts.push('active in the last 90 days')
  else if (b.fit.recency === 'recent') parts.push('active in the last 12 months')
  if (!parts.length) return null
  const archetype = b.behavior.archetype && b.behavior.archetype !== 'Inactive buyer' ? b.behavior.archetype : null
  const lead = archetype ?? (b.kind === 'person' ? 'Individual buyer' : 'Buyer')
  return `${lead} — ${joinList(parts)}.`
}

/* ── receipts: every mark on the map, scatter and timeline ────────────── */

export type Receipt = {
  key: string
  txnId: string
  date: string | null
  price: number | null
  nominal: boolean
  docType: string | null
  cash: boolean | null
  address: string | null
  city: string | null
  zip: string | null
  family: string | null
  /** null when the purchase's type isn't in the read */
  sameFamily: boolean | null
  beds: number | null
  baths: number | null
  sqft: number | null
  yearBuilt: number | null
  lat: number | null
  lng: number | null
  miles: number | null
  /** inside the workspace's radius/window read */
  inWindow: boolean
  propertyId: string | null
  /** the property is in our universe (Entity Graph can open it); null = not known yet */
  inUniverse: boolean | null
}

export type ReceiptSet = {
  receipts: Receipt[]
  /** the model's count of recorded purchases */
  recorded: number
  /** receipts with a location in this read */
  mapped: number
  /** receipts without one */
  unmapped: number
  /** the buyer's purchase list came back shorter than the recorded count */
  listCapped: boolean
  /** the linked-purchase list has arrived (before it, only the window rows are known) */
  complete: boolean
}

const R_EARTH_MI = 3958.8
export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(bLat - aLat)
  const dLng = rad(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function fromWindow(r: WindowTransaction, linked: BuyerProfile['purchases'][number] | null): Receipt {
  return {
    key: `t:${r.txnId ?? `${r.lat},${r.lng},${r.date}`}`,
    txnId: String(r.txnId ?? ''),
    date: r.date,
    price: r.price,
    nominal: r.nominal,
    docType: r.docType ?? linked?.docType ?? null,
    cash: r.cash ?? linked?.cash ?? null,
    address: r.address,
    city: r.city,
    zip: r.zip,
    family: r.family,
    sameFamily: r.sameFamily,
    beds: r.beds,
    baths: r.baths,
    sqft: r.sqft,
    yearBuilt: r.yearBuilt,
    lat: r.lat,
    lng: r.lng,
    miles: r.miles,
    inWindow: true,
    propertyId: r.propertyId,
    inUniverse: linked ? Boolean(linked.inUniverse) : null,
  }
}

function fromLinked(p: BuyerProfile['purchases'][number], subject: { lat: number | null; lng: number | null }): Receipt {
  const located = finite(p.lat) && finite(p.lng)
  const miles = located && finite(subject.lat) && finite(subject.lng) ? Math.round(haversineMiles(subject.lat, subject.lng, p.lat as number, p.lng as number) * 100) / 100 : null
  return {
    key: `p:${p.id}`,
    txnId: String(p.id),
    date: p.date,
    price: finite(p.price) && p.price > 0 ? p.price : null,
    nominal: false,
    docType: p.docType ?? null,
    cash: p.cash ?? null,
    address: p.address ?? null,
    city: p.city ?? null,
    zip: null,
    family: p.propertyType ?? null,
    sameFamily: null,
    beds: null,
    baths: null,
    sqft: null,
    yearBuilt: null,
    lat: located ? (p.lat as number) : null,
    lng: located ? (p.lng as number) : null,
    miles,
    inWindow: false,
    propertyId: p.inUniverse ? p.propertyId : null,
    inUniverse: Boolean(p.inUniverse),
  }
}

/**
 * The buyer's receipts: its linked purchases (Entity Graph read model, newest
 * first) enriched with the located window row for the same transaction, plus
 * any window row the list didn't reach. Only transaction facts are copied —
 * never the seller, lender or other party fields the linked list carries.
 */
export function buildReceipts(b: MatchedBuyer, w: BuyerMatchWorkspace, profile: BuyerProfile | null): ReceiptSet {
  const windowRows = (w.transactions?.rows ?? []).filter((r) => r.buyerId === b.id)
  const byTxn = new Map(windowRows.map((r) => [String(r.txnId), r]))
  const seen = new Set<string>()
  const receipts: Receipt[] = []
  for (const p of profile?.purchases ?? []) {
    const k = String(p.id)
    if (seen.has(k)) continue
    seen.add(k)
    const row = byTxn.get(k)
    receipts.push(row ? fromWindow(row, p) : fromLinked(p, w.subject))
  }
  for (const r of windowRows) if (!seen.has(String(r.txnId))) receipts.push(fromWindow(r, null))
  receipts.sort((x, y) => String(y.date ?? '').localeCompare(String(x.date ?? '')) || y.txnId.localeCompare(x.txnId))
  const mapped = receipts.filter((r) => r.lat !== null && r.lng !== null).length
  return {
    receipts,
    recorded: b.activity.acquisitions,
    mapped,
    unmapped: receipts.length - mapped,
    listCapped: Boolean(profile) && receipts.length < b.activity.acquisitions && (profile?.purchases.length ?? 0) >= 60,
    complete: Boolean(profile),
  }
}

/** Holdings the model links to the buyer (owned in our universe + observed portfolio). */
export type Holding = { key: string; propertyId: string; address: string | null; lat: number | null; lng: number | null; miles: number | null; value: number | null; propertyType: string | null; basis: string }
const BASIS_LABEL: Record<string, string> = { registry: 'registry match', individual_key: 'owner identity match', name: 'owner-name match' }
export function holdingsOf(profile: BuyerProfile | null, subject: { lat: number | null; lng: number | null }): Holding[] {
  if (!profile) return []
  const dist = (lat: number | null, lng: number | null) => (finite(lat) && finite(lng) && finite(subject.lat) && finite(subject.lng) ? Math.round(haversineMiles(subject.lat, subject.lng, lat, lng) * 100) / 100 : null)
  const out: Holding[] = []
  const seen = new Set<string>()
  for (const o of profile.owned) {
    if (seen.has(o.propertyId)) continue
    seen.add(o.propertyId)
    out.push({ key: `o:${o.propertyId}`, propertyId: o.propertyId, address: o.address, lat: o.lat, lng: o.lng, miles: dist(o.lat, o.lng), value: o.value, propertyType: o.propertyType, basis: `Owns · ${BASIS_LABEL[o.evidence.basis] ?? o.evidence.basis}` })
  }
  for (const o of profile.portfolio) {
    if (seen.has(o.propertyId)) continue
    seen.add(o.propertyId)
    out.push({ key: `f:${o.propertyId}`, propertyId: o.propertyId, address: o.address, lat: o.lat, lng: o.lng, miles: dist(o.lat, o.lng), value: o.value, propertyType: o.propertyType, basis: 'Observed portfolio' })
  }
  return out
}

/* ── small readers ────────────────────────────────────────────────────── */

const SHORT_FAMILY: Record<string, string> = {
  'single family': 'SFR', 'small multifamily': 'MF 2–4', 'multifamily 2–4': 'MF 2–4', multifamily: 'Multifamily', 'apartments 5+': 'MF 5+',
  condo: 'Condo', land: 'Land', commercial: 'Commercial', 'mobile home': 'Mobile home',
}
export const shortFamily = (label: string | null | undefined) => (label ? SHORT_FAMILY[label.toLowerCase()] ?? label : null)

/** "4637 Brinkley St, Houston, Tx 77051" → "4637 Brinkley St" */
export const street = (address: string | null | undefined) => (address ? address.split(',')[0].trim() : null)

export const daysFrom = (iso: string | null | undefined, now = Date.now()): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 86_400_000)) : null
}

/** 40 → "40d", 95 → "3mo", 800 → "2.2y" */
export const ageShort = (days: number | null | undefined): string | null => {
  if (days === null || days === undefined) return null
  if (days < 45) return `${Math.round(days)}d`
  if (days < 730) return `${Math.round(days / 30.4)}mo`
  return `${(days / 365).toFixed(1)}y`
}

/**
 * The buyer model's as-of date. Every buyer's `daysSince` is counted to the
 * same date (the W8C run), so last + daysSince recovers it; receipt ages are
 * read against it so "40d" in a figure and "40d ago" on a receipt agree.
 */
export function modelAsOf(w: BuyerMatchWorkspace): number | null {
  for (const b of [...w.buyers, ...w.excluded]) {
    const t = b.activity.last ? Date.parse(`${b.activity.last.slice(0, 10)}T00:00:00Z`) : NaN
    if (Number.isFinite(t) && b.activity.daysSince !== null) return t + b.activity.daysSince * 86_400_000
  }
  return null
}

export const asOfLabel = (ms: number | null) => (ms === null ? null : new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }))

/** Offset of a point from the subject in miles (east, north) — equirectangular, fine at a county scale. */
export function offsetMiles(subject: { lat: number; lng: number }, lat: number, lng: number): { east: number; north: number } {
  return { east: (lng - subject.lng) * 69.172 * Math.cos((subject.lat * Math.PI) / 180), north: (lat - subject.lat) * 69.0 }
}
