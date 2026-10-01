/**
 * CAMPAIGN SENDS adapter — send_queue (the owner of the send result), AGGREGATED:
 * one campaign.batch_sent per campaign per 10-minute bucket (floor of sent_at).
 *
 * A batch is only emitted when every one of its rows was read: the read covers
 * the bucket that holds the cursor from its top, and a batch whose bucket the
 * read did not finish is held back (complete_above stops the page above it), so
 * paging never shows the same batch twice or with a partial count. A single
 * bucket larger than the read cap is shown as a lower bound (partial: true) —
 * never silently cut.
 */
import { canonicalTime, envelope, links, refs } from '../envelope.js'
import { cmpKey } from '../keyset.js'
import { CAMPAIGN_SEND_SOURCES } from './messages.js'

export const BUCKET_MS = 10 * 60e3
const PAGE = 1000
const CAP = 6000
const floorB = (ms) => Math.floor(ms / BUCKET_MS) * BUCKET_MS
const isoOf = (ms) => canonicalTime(ms)

/** Pure: rows of ONE bucket of ONE campaign → envelope. */
export function batchEvent(campaignId, bucketMs, rows, { name = null, partial = false } = {}) {
  const at = rows.map((r) => canonicalTime(r.sent_at)).filter(Boolean).sort()
  if (!at.length) return null
  const status = (r) => String(r.queue_status || '').toLowerCase()
  const delivered = rows.filter((r) => status(r) === 'delivered' || (r.delivered_at && !status(r).startsWith('failed'))).length
  const failed = rows.filter((r) => status(r).startsWith('failed') || status(r) === 'undelivered').length
  const count = rows.length
  const label = name || 'Campaign'
  return envelope({
    event_id: `cs:${campaignId}:${new Date(bucketMs).toISOString()}`,
    occurred_at: at[at.length - 1],
    source_system: 'campaign',
    event_type: 'campaign.batch_sent',
    severity: failed > 0 ? 'attention' : 'info',
    actor: { kind: 'automation', label: 'Campaign feeder' },
    entity_refs: [refs.campaign(campaignId, name)],
    campaign_id: campaignId,
    market: rows.find((r) => r.market)?.market || null,
    summary: `${label} · ${partial ? '≥' : ''}${count.toLocaleString('en-US')} sent${delivered ? ` · ${delivered} delivered` : ''}${failed ? ` · ${failed} failed` : ''}`,
    details: { count, delivered, failed, in_flight: Math.max(0, count - delivered - failed), bucket_start: new Date(bucketMs).toISOString(), bucket_end: new Date(bucketMs + BUCKET_MS).toISOString(), first_at: at[0], last_at: at[at.length - 1], partial, count_is_lower_bound: partial },
    deep_link: links.campaign(campaignId),
    provenance: { table: 'send_queue', row_id: `${campaignId}@${new Date(bucketMs).toISOString()}`, adapter: 'campaign_sends', ledger: 'aggregate: campaign × 10-minute bucket of sent_at' },
  })
}

/**
 * Pure: bucket rows (newest first) into batches and decide what is complete.
 * `exhausted` = the read reached `since` (nothing older left to read).
 */
export function bucketize(rows, { exhausted, upperMs, names = new Map(), cursor = null, sinceIso = null }) {
  const groups = new Map()
  let oldest = null
  for (const r of rows) {
    const t = Date.parse(r.sent_at)
    if (!Number.isFinite(t)) continue
    const b = floorB(t)
    oldest = oldest === null ? b : Math.min(oldest, b)
    const k = `${r.campaign_id}|${b}`
    if (!groups.has(k)) groups.set(k, { cid: String(r.campaign_id), b, rows: [] })
    groups.get(k).rows.push(r)
  }
  // nothing past the bucket the read stopped in can be trusted unless the read was exhausted
  const crossed = oldest !== null && oldest + BUCKET_MS < upperMs
  let complete_above = null
  let partialBucket = null
  if (!exhausted && oldest !== null) {
    if (crossed) complete_above = { t: isoOf(oldest + BUCKET_MS), id: '' }
    else { partialBucket = oldest; complete_above = { t: isoOf(oldest), id: '' } }
  }
  const events = []
  for (const g of groups.values()) {
    const partial = partialBucket !== null && g.b === partialBucket
    if (!exhausted && !partial && g.b <= oldest) continue
    const e = batchEvent(g.cid, g.b, g.rows, { name: names.get(g.cid) || null, partial })
    if (!e) continue
    if (cursor && cmpKey({ t: e.occurred_at, id: e.event_id }, cursor) >= 0) continue
    if (sinceIso && e.occurred_at < sinceIso) continue
    events.push(e)
  }
  return { events, complete_above, partial_bucket: partialBucket }
}

async function readFrom(db, scope, upperMs) {
  const { subject, cursor } = scope
  const lowerIso = scope.since ? new Date(floorB(Date.parse(scope.since))).toISOString() : null
  const rows = []
  let exhausted = false
  for (let from = 0; from < CAP; from += PAGE) {
    let qy = db.from('send_queue').select('id, campaign_id, sent_at, delivered_at, queue_status, source, market')
      .not('sent_at', 'is', null).not('campaign_id', 'is', null).in('source', CAMPAIGN_SEND_SOURCES)
      .lt('sent_at', new Date(upperMs).toISOString())
    if (subject?.campaign_id) qy = qy.eq('campaign_id', subject.campaign_id)
    if (lowerIso) qy = qy.gte('sent_at', lowerIso)
    const { data, error } = await qy.order('sent_at', { ascending: false }).order('id', { ascending: false }).range(from, from + PAGE - 1)
    if (error) throw Object.assign(new Error(error.message || 'send_queue_failed'), { code: error.code })
    rows.push(...(data || []))
    if (!data || data.length < PAGE) { exhausted = true; break }
    // stop once enough whole batches are in hand
    if (bucketize(rows, { exhausted: false, upperMs, cursor, sinceIso: scope.since }).events.length > scope.limit) break
  }
  const cids = [...new Set(rows.map((r) => String(r.campaign_id)))]
  const names = new Map()
  for (let i = 0; i < cids.length; i += 200) {
    const { data } = await db.from('campaigns').select('id, name').in('id', cids.slice(i, i + 200))
    for (const c of data || []) names.set(String(c.id), c.name)
  }
  return bucketize(rows, { exhausted, upperMs, names, cursor, sinceIso: scope.since })
}

export const campaignSendsAdapter = {
  name: 'campaign_sends',
  table: 'send_queue',
  systems: ['campaign'],
  types: ['campaign.batch_sent'],
  supports: (subject) => !subject || subject.type === 'campaign',

  async read(scope, { db, now }) {
    const { cursor } = scope
    const upperMs = cursor ? floorB(Date.parse(cursor.t)) + BUCKET_MS : scope.until ? Date.parse(scope.until) : now + 1000
    const first = await readFrom(db, scope, upperMs)
    // a bucket bigger than the read cap was already shown (as a lower bound) on an earlier page:
    // continue below it instead of re-reading it forever
    if (cursor && first.partial_bucket !== null && first.partial_bucket === floorB(Date.parse(cursor.t)) && !first.events.length) {
      return readFrom(db, scope, first.partial_bucket)
    }
    return first
  },
}
