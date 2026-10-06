/**
 * Command Wall feed + live-event model (§12–§14, §25, §45, §66, §67). Pure.
 *
 * The client keeps the newest events by id (the server re-sends an updated
 * aggregate under the same id), bounded, and derives:
 *   - feed rows (newest first, noise collapsed, sends grouped),
 *   - map pulses (P0/P1 geographic events only, each pulses ONCE on arrival),
 *   - the top-right capsule (the newest P0/P1 in the last 90 s),
 *   - per-market activity for glow (sends + replies over 30 min).
 */
import type { WallEvent } from './wall-types'

export const MAX_EVENTS = 240
export const PULSE_WINDOW_MS = 90_000
export const CAPSULE_MS = 90_000
export const ACTIVITY_WINDOW_MS = 30 * 60_000

export interface WallEventsState { byId: Map<string, WallEvent>; epoch: string | null; head: number }

export function emptyEvents(): WallEventsState {
  return { byId: new Map(), epoch: null, head: 0 }
}

/** Applies one /events reply. Returns the new state + the ids that are NEW or UPDATED. */
export function applyEventsReply(state: WallEventsState, reply: { epoch: string; reset: boolean; head: number; events: WallEvent[] }): { state: WallEventsState; arrived: WallEvent[] } {
  const byId = reply.reset || reply.epoch !== state.epoch ? new Map<string, WallEvent>() : new Map(state.byId)
  const arrived: WallEvent[] = []
  for (const ev of reply.events) {
    const prev = byId.get(ev.id)
    if (!prev || prev.seq !== ev.seq) arrived.push(ev)
    byId.set(ev.id, ev)
  }
  if (byId.size > MAX_EVENTS) {
    const sorted = [...byId.values()].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, MAX_EVENTS)
    byId.clear()
    for (const ev of sorted) byId.set(ev.id, ev)
  }
  return { state: { byId, epoch: reply.epoch, head: reply.head }, arrived }
}

export interface FeedRow { id: string; time: string; title: string; place: string | null; detail: string | null; priority: number; tone: WallEvent['tone']; at: number }

const KIND_TITLE: Record<string, string> = {
  reply: 'SELLER REPLY', interest: 'INTERESTED', asking_price: 'ASKING PRICE', offer: 'OFFER', counter: 'COUNTER', deal: 'DEAL', stage: 'STAGE', campaign: 'CAMPAIGN', signal: 'SIGNAL', sends: 'OUTBOUND', opt_out: 'OPT-OUTS',
}

export function placeLabel(ev: WallEvent): string | null {
  const g = ev.geo
  if (!g) return null
  const market = g.market_name ? String(g.market_name).replace(/,\s*[A-Z]{2}$/, '') : null
  return [market, g.zip || null].filter(Boolean).join(' · ') || null
}

export function clock(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(11, 19)
  }
}

const fmtK = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n / 1000)}K`)

const shortMarket = (ev: WallEvent) => (ev.geo?.market_name ? String(ev.geo.market_name).replace(/,\s*[A-Z]{2}$/, '') : 'Unattributed')

/**
 * Feed rows: newest first. Bulk sends from the same 2-minute window become ONE
 * row across markets ("OUTBOUND · Dallas 3 · Houston 3 · 7 sent"), so routine
 * volume never buries a seller reply; low-signal replies stay off the wall.
 */
export function feedRows(state: WallEventsState, { limit = 12, timeZone }: { limit?: number; timeZone?: string } = {}): FeedRow[] {
  const all = [...state.byId.values()].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
  // the server keys a send aggregate as sends:<market>:<bucketStartMs> — group on that bucket
  const bucketOf = (ev: WallEvent) => { const b = Number(ev.id.split(':').pop()); return Number.isFinite(b) ? b : Math.floor(Date.parse(ev.occurred_at) / (ev.window_ms || 120_000)) * (ev.window_ms || 120_000) }
  const list: WallEvent[] = []
  const sendGroups = new Map<number, WallEvent[]>()
  for (const ev of all) {
    if (ev.kind !== 'sends') { list.push(ev); continue }
    const bucket = bucketOf(ev)
    const g = sendGroups.get(bucket)
    if (g) g.push(ev)
    else { sendGroups.set(bucket, [ev]); list.push(ev) }
  }
  const rows: FeedRow[] = []
  for (const ev of list) {
    if (rows.length >= limit) break
    const at = Date.parse(ev.occurred_at)
    if (ev.kind === 'sends') {
      const byMarket = new Map<string, number>()
      for (const x of sendGroups.get(bucketOf(ev)) || [ev]) byMarket.set(shortMarket(x), (byMarket.get(shortMarket(x)) || 0) + x.count)
      const parts = [...byMarket.entries()].sort((a, b) => b[1] - a[1])
      const total = parts.reduce((s, [, n]) => s + n, 0)
      const detail = parts.length === 1 ? parts[0][0] : parts.slice(0, 3).map(([m, n]) => `${m} ${n}`).join(' · ') + (parts.length > 3 ? ` · +${parts.length - 3}` : '')
      rows.push({ id: `sends-group:${bucketOf(ev)}`, time: clock(at, timeZone), title: 'OUTBOUND', place: `${total} sent`, detail, priority: 3, tone: 'cyan', at })
      continue
    }
    // low-signal replies (wrong person, hostile) stay off the wall feed
    if (ev.kind === 'reply' && ev.priority >= 3) continue
    let detail: string | null = null
    if (ev.kind === 'opt_out') detail = `${ev.count}`
    else if (ev.amount && Number.isFinite(ev.amount)) detail = fmtK(ev.amount)
    else if (ev.kind !== 'signal' && ev.label && KIND_TITLE[ev.kind] && ev.label.toUpperCase() !== KIND_TITLE[ev.kind]) detail = ev.label
    rows.push({ id: ev.id, time: clock(at, timeZone), title: ev.kind === 'signal' ? ev.label.toUpperCase() : KIND_TITLE[ev.kind] || ev.label.toUpperCase(), place: placeLabel(ev), detail, priority: ev.priority, tone: ev.tone, at })
  }
  return rows
}

/** Events that should pulse now: P0/P1 with usable geography, arrived within the pulse window. */
export function pulseCandidates(arrived: WallEvent[], now: number): WallEvent[] {
  return arrived.filter((ev) => ev.priority <= 1 && ev.kind !== 'campaign' && ev.geo && Number.isFinite(ev.geo.lat) && Number.isFinite(ev.geo.lng) && now - Date.parse(ev.occurred_at) <= PULSE_WINDOW_MS * 4)
}

export function capsuleEvent(state: WallEventsState, now: number): WallEvent | null {
  let best: WallEvent | null = null
  for (const ev of state.byId.values()) {
    if (ev.priority > 1) continue
    const at = Date.parse(ev.occurred_at)
    if (now - at > CAPSULE_MS) continue
    if (!best || ev.priority < best.priority || (ev.priority === best.priority && at > Date.parse(best.occurred_at))) best = ev
  }
  return best
}

export interface MarketActivity { marketId: string; sends: number; replies: number; highValue: number; lastAt: number }

export function marketActivity(state: WallEventsState, now: number): Map<string, MarketActivity> {
  const out = new Map<string, MarketActivity>()
  for (const ev of state.byId.values()) {
    const at = Date.parse(ev.occurred_at)
    if (now - at > ACTIVITY_WINDOW_MS) continue
    const id = ev.geo?.market_id
    if (!id) continue
    const m = out.get(id) || { marketId: id, sends: 0, replies: 0, highValue: 0, lastAt: 0 }
    if (ev.kind === 'sends') m.sends += ev.count
    else if (ev.kind === 'reply' || ev.kind === 'interest') m.replies += 1
    if (ev.priority <= 1) m.highValue += 1
    m.lastAt = Math.max(m.lastAt, at)
    out.set(id, m)
  }
  return out
}

/** Acquisition Pulse funnel (§18) from REAL events in the client's window — labelled with that window. */
export function pulseFunnel(state: WallEventsState, now: number, windowMs = 6 * 3600_000) {
  const f = { replies: 0, interested: 0, asking: 0, offers: 0, deals: 0 }
  for (const ev of state.byId.values()) {
    if (now - Date.parse(ev.occurred_at) > windowMs) continue
    if (ev.kind === 'reply') f.replies += 1
    else if (ev.kind === 'interest') { f.replies += 1; f.interested += 1 }
    else if (ev.kind === 'asking_price') f.asking += 1
    else if (ev.kind === 'offer' || ev.kind === 'counter') f.offers += 1
    else if (ev.kind === 'deal') f.deals += 1
  }
  return f
}

/** Quiet moment for a version reload: nothing P0/P1 in the last 2 minutes. */
export function isQuietMoment(state: WallEventsState, now: number, quietMs = 120_000): boolean {
  for (const ev of state.byId.values()) if (ev.priority <= 1 && now - Date.parse(ev.occurred_at) < quietMs) return false
  return true
}

/** Time since the last operational (P0–P2) event — drives OLED idle dimming. */
export function idleMs(state: WallEventsState, now: number): number {
  let last = 0
  for (const ev of state.byId.values()) if (ev.priority <= 2) last = Math.max(last, Date.parse(ev.occurred_at))
  return last ? now - last : Number.POSITIVE_INFINITY
}
