/**
 * COMMAND WALL — the ONE shared event tick (§24, §56).
 *
 * Every display polls GET /api/wall/events?after=<seq>; none of them causes a
 * database read of its own. A single process-wide tick (single-flight, at most
 * once per TICK_MS no matter how many displays ask) reads:
 *   1. notification_story_inputs rows since the cursor (indexed occurred_at), and
 *   2. send_queue rows sent since the cursor (indexed sent_at, two columns),
 *   3. geography for NEW property ids only (cached),
 * folds them into the bounded event log and returns. Idle displays cost a Map
 * scan, not a query. With no display connected, nothing runs at all.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { createWallEventLog, wallEventFromInput, foldAggregates, aggregateToEvent, SEND_BUCKET_MS, OPT_OUT_BUCKET_MS } from './wall-projection.js'
import { createWallGeo } from './wall-geo.js'

export const TICK_MS = 15_000
export const COLD_START_MS = 2 * 3600_000
export const INPUT_OVERLAP_MS = 10 * 60_000 // the projector lands rows late; dedupe absorbs the overlap
export const SEND_OVERLAP_MS = 3 * 60_000
export const PROJECTOR_CHECK_MS = 60_000
const INPUT_PAGE = 300
const SEND_PAGE = 1000

const iso = (ms) => new Date(ms).toISOString()

export function createWallFeed({ db = defaultSupabase, now = () => Date.now(), geo = null, tickMs = TICK_MS, epoch = `e${Date.now().toString(36)}` } = {}) {
  const log = createWallEventLog({ now })
  const geoKit = geo || createWallGeo(db, { now })
  const seenInputs = new Map() // input_id -> occurred ms
  const sendAggs = new Map()
  const optOutAggs = new Map()
  let inputCursor = null
  let sendCursor = null
  let lastTick = 0
  let pending = null
  let lastProjectorCheck = 0
  let skipOverlap = false
  const status = { inputs: 'unknown', sends: 'unknown', projector_at: null, last_ok_at: null, last_error: null, queries: 0, ticks: 0 }

  async function readInputs(sinceMs) {
    status.queries += 1
    const { data, error } = await db
      .from('notification_story_inputs')
      .select('input_id, kind, occurred_at, payload')
      .gt('occurred_at', iso(sinceMs))
      .order('occurred_at', { ascending: true })
      .limit(INPUT_PAGE)
    if (error) throw Object.assign(new Error(error.message), { source: 'inputs' })
    return data || []
  }

  async function readSends(sinceMs) {
    status.queries += 1
    const { data, error } = await db
      .from('send_queue')
      .select('id, sent_at, market, campaign_id')
      .gt('sent_at', iso(sinceMs))
      .order('sent_at', { ascending: true })
      .limit(SEND_PAGE)
    if (error) throw Object.assign(new Error(error.message), { source: 'sends' })
    return data || []
  }

  async function checkProjector(t) {
    if (t - lastProjectorCheck < PROJECTOR_CHECK_MS) return
    lastProjectorCheck = t
    status.queries += 1
    const { data } = await db.from('notification_story_projector').select('projected_at').eq('id', 'stories').limit(1)
    status.projector_at = data?.[0]?.projected_at || status.projector_at
  }

  async function tick() {
    const t = now()
    status.ticks += 1
    const coldFloor = t - COLD_START_MS
    const inputSince = Math.max(coldFloor, (inputCursor ?? coldFloor) - (skipOverlap ? 0 : INPUT_OVERLAP_MS))
    const sendSince = Math.max(coldFloor, (sendCursor ?? coldFloor) - SEND_OVERLAP_MS)
    const [inputsRes, sendsRes] = await Promise.allSettled([readInputs(inputSince), readSends(sendSince)])
    await checkProjector(t).catch(() => {})

    const inputs = inputsRes.status === 'fulfilled' ? inputsRes.value.filter((r) => !seenInputs.has(r.input_id)) : []
    // a full page of already-seen rows inside the overlap would pin the cursor: read past it next time
    skipOverlap = inputsRes.status === 'fulfilled' && inputsRes.value.length >= INPUT_PAGE && inputs.length === 0
    const sends = sendsRes.status === 'fulfilled' ? sendsRes.value : []
    status.inputs = inputsRes.status === 'fulfilled' ? 'ok' : 'unavailable'
    status.sends = sendsRes.status === 'fulfilled' ? 'ok' : 'unavailable'
    if (inputsRes.status === 'rejected' || sendsRes.status === 'rejected') status.last_error = (inputsRes.reason || sendsRes.reason)?.message?.slice(0, 160) || 'read_failed'

    const refs = [
      ...inputs.map((r) => ({ property_id: r.payload?.property_id || null, market: r.payload?.market || null, market_id: r.payload?.market_id || null })),
      ...sends.map((s) => ({ property_id: null, market: s.market || null })),
    ]
    const geoFor = refs.length ? await geoKit.resolver(refs) : () => null

    const optOutRows = []
    for (const r of inputs) {
      seenInputs.set(r.input_id, Date.parse(r.occurred_at) || t)
      const ev = wallEventFromInput(r, geoFor)
      if (!ev) continue
      if (ev.kind === 'opt_out') {
        optOutRows.push({ id: ev.id, at: Date.parse(ev.occurred_at), market_id: ev.geo?.market_id || null, market_name: ev.geo?.market_name || null, geo: ev.geo ? { ...ev.geo, lat: null, lng: null, zip_lat: null, zip_lng: null, zip: null } : null })
        continue
      }
      log.upsert(ev)
    }
    if (inputsRes.status === 'fulfilled' && inputsRes.value.length) {
      inputCursor = Math.max(inputCursor ?? 0, ...inputsRes.value.map((r) => Date.parse(r.occurred_at) || 0))
    } else if (inputsRes.status === 'fulfilled' && inputCursor === null) inputCursor = t

    const sendRows = sends.map((s) => {
      const g = geoFor({ market: s.market })
      // aggregates are market-level by construction: never a property position
      const mg = g ? { market_id: g.market_id, market_name: g.market_name || s.market || null, market_lat: g.market_lat, market_lng: g.market_lng } : (s.market ? { market_id: null, market_name: s.market } : null)
      return { id: s.id, at: Date.parse(s.sent_at), market_id: mg?.market_id || null, market_name: mg?.market_name || null, campaign_id: s.campaign_id || null, geo: mg }
    })
    const touchedSend = new Set()
    foldAggregates(sendAggs, sendRows, { kind: 'sends', label: 'Outbound', bucketMs: SEND_BUCKET_MS, priority: 3, tone: 'cyan' })
    for (const r of sendRows) touchedSend.add(`sends:${r.market_id || String(r.market_name || '').toLowerCase() || 'unattributed'}:${Math.floor(r.at / SEND_BUCKET_MS) * SEND_BUCKET_MS}`)
    for (const id of touchedSend) if (sendAggs.has(id)) log.upsert(aggregateToEvent(sendAggs.get(id)))
    if (sendsRes.status === 'fulfilled' && sends.length) sendCursor = Math.max(sendCursor ?? 0, ...sends.map((s) => Date.parse(s.sent_at) || 0))
    else if (sendsRes.status === 'fulfilled' && sendCursor === null) sendCursor = t

    if (optOutRows.length) {
      foldAggregates(optOutAggs, optOutRows, { kind: 'opt_out', label: 'Opt-outs', bucketMs: OPT_OUT_BUCKET_MS, priority: 3, tone: 'neutral' })
      for (const agg of optOutAggs.values()) log.upsert(aggregateToEvent(agg))
    }

    // bounded memory: drop aggregates and seen ids older than the log horizon
    const horizon = t - COLD_START_MS - INPUT_OVERLAP_MS
    for (const [id, at] of seenInputs) if (at < horizon) seenInputs.delete(id)
    for (const m of [sendAggs, optOutAggs]) for (const [id, a] of m) if (a.bucket_start < horizon) m.delete(id)
    log.prune()
    if (status.inputs === 'ok' && status.sends === 'ok') { status.last_ok_at = iso(t); status.last_error = null }
    lastTick = t
  }

  async function ensureFresh() {
    if (now() - lastTick < tickMs) return
    if (!pending) pending = tick().catch((e) => { status.last_error = String(e?.message || e).slice(0, 160); lastTick = now() }).finally(() => { pending = null })
    await pending
  }

  return {
    epoch,
    async read(afterSeq = 0, { limit = 250 } = {}) {
      await ensureFresh()
      const head = log.head()
      // a cursor from another process lifetime (restart / deploy) → resend the window
      const after = Number.isFinite(afterSeq) && afterSeq >= 0 && afterSeq <= head ? afterSeq : 0
      return { epoch, head, events: log.after(after, limit), status: feedStatus() }
    },
    recent: (sinceMs) => log.recent(sinceMs),
    /** Freshness without triggering a tick. */
    statusNow: () => feedStatus(),
    geo: geoKit,
    _tick: tick,
    _status: () => ({ ...status, log_size: log.size(), seen: seenInputs.size, aggregates: sendAggs.size + optOutAggs.size }),
  }

  function feedStatus() {
    const t = now()
    const lastOk = status.last_ok_at ? Date.parse(status.last_ok_at) : null
    return {
      state: status.inputs === 'ok' && status.sends === 'ok' ? 'live' : status.inputs === 'unknown' ? 'starting' : 'degraded',
      inputs: status.inputs,
      sends: status.sends,
      last_ok_at: status.last_ok_at,
      stale_ms: lastOk ? t - lastOk : null,
      projector_at: status.projector_at,
      projector_lag_ms: status.projector_at ? Math.max(0, t - Date.parse(status.projector_at)) : null,
      tick_ms: tickMs,
    }
  }
}

let shared = null
export function wallFeed() {
  if (!shared) shared = createWallFeed()
  return shared
}
export function _setWallFeedForTests(feed) { shared = feed }
