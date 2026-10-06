/**
 * COMMAND WALL — the wall projection of the EXISTING event universe (§24, §25, §64, §66).
 *
 * Sources (no competing event pipeline):
 *   - notification_story_inputs: the Notification Center projector's working
 *     copy of Machine Feed envelopes (listPlatformEvents, STORY_EVENT_TYPES) and
 *     notification_events rows. The Worker already projects it every 30 s.
 *   - send_queue sent rows: the only complete record of outbound volume (the
 *     story inputs keep message.sent for conversational sends only), folded into
 *     per-market 2-minute aggregates exactly like the Machine Feed's
 *     campaign.batch_sent does per campaign.
 *
 * Wall events are built from a CLOSED vocabulary: kind, priority, tone and a
 * fixed label. Nothing from a source row's free text (summary, title, message
 * body, seller label, address, phone) is ever copied into a wall event.
 *
 * Priority (§66): P0 critical system · P1 reply/interest/offer/deal · P2
 * campaign, stage or sender state · P3 bulk sends / opt-outs (aggregated).
 */

export const SEND_BUCKET_MS = 2 * 60_000
export const OPT_OUT_BUCKET_MS = 10 * 60_000

/** Intents that make a reply an "interested" reply (war-room POSITIVE_INTENTS minus ownership-only). */
export const INTEREST_INTENTS = new Set(['seller_interested', 'asking_price_provided', 'asks_offer', 'price_anchor', 'price_interest'])

/** Envelope type → wall kind/priority/tone/label. Anything absent is not wall-worthy. */
export const ENVELOPE_RULES = Object.freeze({
  'seller.replied': { kind: 'reply', priority: 1, tone: 'cyan', label: 'Seller reply' },
  'seller.call_request': { kind: 'reply', priority: 1, tone: 'cyan', label: 'Call requested' },
  'seller.emoji_reply': { kind: 'reply', priority: 2, tone: 'neutral', label: 'Seller reply' },
  'seller.reaction': { kind: 'reply', priority: 2, tone: 'neutral', label: 'Seller reaction' },
  'seller.language_request': { kind: 'reply', priority: 2, tone: 'neutral', label: 'Seller reply' },
  'seller.wrong_person': { kind: 'reply', priority: 3, tone: 'neutral', label: 'Wrong person' },
  'seller.hostile': { kind: 'reply', priority: 3, tone: 'neutral', label: 'Seller reply' },
  'seller.opted_out': { kind: 'opt_out', priority: 3, tone: 'neutral', label: 'Opt-outs' },
  'fact.captured': { kind: 'asking_price', priority: 1, tone: 'gold', label: 'Asking price captured' },
  'offer.generated': { kind: 'offer', priority: 1, tone: 'gold', label: 'Offer set' },
  'offer.countered': { kind: 'counter', priority: 1, tone: 'gold', label: 'Seller countered' },
  'deal.opened': { kind: 'deal', priority: 1, tone: 'green', label: 'Deal opened' },
  'deal.status_changed': { kind: 'stage', priority: 2, tone: 'violet', label: 'Deal status changed' },
  'stage.advanced': { kind: 'stage', priority: 2, tone: 'violet', label: 'Stage advanced' },
  'campaign.completed': { kind: 'campaign', priority: 2, tone: 'green', label: 'Campaign completed' },
  'campaign.resumed': { kind: 'campaign', priority: 2, tone: 'cyan', label: 'Campaign resumed' },
  'campaign.paused': { kind: 'campaign', priority: 2, tone: 'neutral', label: 'Campaign paused' },
  'campaign.blocked': { kind: 'campaign', priority: 2, tone: 'gold', label: 'Campaign blocked' },
  'campaign.stalled': { kind: 'campaign', priority: 2, tone: 'gold', label: 'Campaign needs operator' },
  'campaign.failed': { kind: 'campaign', priority: 0, tone: 'red', label: 'Campaign failed' },
})

/** Signal rules (Signal Center) → wall label. Display only (§44). */
export const SIGNAL_LABELS = Object.freeze([
  [/queue[._]stall/i, 'Queue stalled'],
  [/reply[._]backlog|new_replies_backlog/i, 'Replies backlog'],
  [/delivery[._](degraded|rate)/i, 'Delivery degraded'],
  [/content[._]filter/i, 'Content filter spike'],
  [/opt[._]?out/i, 'Opt-out spike'],
  [/execution[._]exception/i, 'Campaign exception'],
])

export function signalLabel(ruleKey) {
  const k = String(ruleKey || '')
  for (const [re, label] of SIGNAL_LABELS) if (re.test(k)) return label
  return 'System attention'
}

const SEVERITY_PRIORITY = { critical: 0, warning: 2, attention: 2, info: 3 }
const SEVERITY_TONE = { critical: 'red', warning: 'gold', attention: 'gold', info: 'neutral' }

const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Pure: one story-input row → a wall event (or null). `geoFor` resolves geography. */
export function wallEventFromInput(row, geoFor = () => null) {
  if (!row || !row.payload) return null
  if (row.kind === 'notification') return wallEventFromNotification(row, geoFor)
  const e = row.payload
  const type = clean(e.event_type)
  const rule = ENVELOPE_RULES[type]
  if (!rule) return null
  const occurred = e.occurred_at || row.occurred_at
  if (!occurred) return null
  let { kind, priority, tone, label } = rule
  const intent = clean(e.details?.intent).toLowerCase() || null
  if (kind === 'reply' && rule.priority === 1 && intent && INTEREST_INTENTS.has(intent)) {
    kind = 'interest'
    tone = 'green'
    label = 'Interested seller'
  }
  if (type === 'fact.captured') {
    // Only an asking price is a wall event; other captured facts stay in the Machine Feed.
    // pipeline adapter: details.history_type 'asking_price_changed' (movementFromHistory)
    const field = clean(e.details?.history_type || e.details?.field || e.details?.kind).toLowerCase()
    if (!/asking/.test(field)) return null
  }
  const ev = {
    id: `in:${row.input_id}`,
    source_type: type,
    kind,
    priority,
    tone,
    label,
    occurred_at: occurred,
    count: 1,
    intent: kind === 'reply' || kind === 'interest' ? intent : null,
    geo: geoFor({ property_id: e.property_id || null, market: e.market || null }),
  }
  if (e.campaign_id) ev.campaign = { id: clean(e.campaign_id) }
  const amount = num(e.details?.amount ?? e.details?.new_value ?? e.details?.offer_amount ?? e.details?.price)
  if ((kind === 'asking_price' || kind === 'offer' || kind === 'counter') && amount && amount > 1000 && amount < 1e9) ev.amount = Math.round(amount)
  return ev
}

function wallEventFromNotification(row, geoFor) {
  const n = row.payload
  const type = clean(n.event_type)
  // Only Signal Center conditions reach the wall; inbox notifications duplicate
  // the reply events and carry phone numbers in their titles.
  if (!/^signal[_.]/i.test(type)) return null
  const severity = ['critical', 'warning', 'attention', 'info'].includes(clean(n.severity)) ? clean(n.severity) : 'warning'
  const ruleKey = type.replace(/^signal[_.]/i, '')
  return {
    id: `nt:${row.input_id}`,
    source_type: type,
    kind: 'signal',
    priority: SEVERITY_PRIORITY[severity] ?? 2,
    tone: SEVERITY_TONE[severity] ?? 'gold',
    label: signalLabel(ruleKey),
    occurred_at: n.created_at || row.occurred_at,
    count: 1,
    signal: { rule_key: ruleKey, severity },
    geo: n.property_id || n.market_id ? geoFor({ property_id: n.property_id || null, market: null, market_id: n.market_id || null }) : null,
  }
}

const bucketStart = (ms, size) => Math.floor(ms / size) * size

/**
 * Folds rows into per-market time-bucket aggregates (§25). `rows` items carry
 * { id, at (ms), market_id, market_name, geo }. Returns Map<aggId, aggregate>
 * with DISTINCT row counts, so overlapping reads never double count.
 */
export function foldAggregates(existing, rows, { kind, label, bucketMs, priority = 3, tone = 'cyan' }) {
  const out = existing || new Map()
  for (const r of rows) {
    if (!r || !Number.isFinite(r.at)) continue
    const mk = r.market_id || clean(r.market_name).toLowerCase() || 'unattributed'
    const b = bucketStart(r.at, bucketMs)
    const id = `${kind}:${mk}:${b}`
    let agg = out.get(id)
    if (!agg) {
      agg = { id, kind, priority, tone, label, bucket_start: b, window_ms: bucketMs, members: new Set(), occurred_at: new Date(r.at).toISOString(), geo: r.geo || null, campaigns: new Set() }
      out.set(id, agg)
    }
    agg.members.add(r.id)
    if (r.campaign_id) agg.campaigns.add(r.campaign_id)
    if (r.at > Date.parse(agg.occurred_at)) agg.occurred_at = new Date(r.at).toISOString()
    if (!agg.geo && r.geo) agg.geo = r.geo
  }
  return out
}

export function aggregateToEvent(agg) {
  return {
    id: agg.id,
    source_type: agg.kind,
    kind: agg.kind,
    priority: agg.priority,
    tone: agg.tone,
    label: agg.label,
    occurred_at: agg.occurred_at,
    count: agg.members.size,
    window_ms: agg.window_ms,
    geo: agg.geo,
    campaign: agg.campaigns.size === 1 ? { id: [...agg.campaigns][0] } : null,
  }
}

/**
 * The server's bounded event log. Every insert or aggregate update gets a new
 * monotonic seq; clients ask for `after=<seq>` and upsert by id.
 */
export function createWallEventLog({ maxAgeMs = 6 * 3600_000, maxEvents = 1500, now = () => Date.now() } = {}) {
  let seq = 0
  const byId = new Map()
  const signature = (ev) => `${ev.count}|${ev.occurred_at}|${ev.label}`
  return {
    upsert(ev) {
      const prev = byId.get(ev.id)
      if (prev && signature(prev) === signature(ev)) return false
      seq += 1
      byId.delete(ev.id)
      byId.set(ev.id, { ...ev, seq })
      return true
    },
    prune() {
      const cutoff = now() - maxAgeMs
      for (const [id, ev] of byId) if (Date.parse(ev.occurred_at) < cutoff) byId.delete(id)
      while (byId.size > maxEvents) byId.delete(byId.keys().next().value)
    },
    after(afterSeq, limit = 250) {
      const list = []
      for (const ev of byId.values()) if (ev.seq > afterSeq) list.push(ev)
      list.sort((a, b) => a.seq - b.seq)
      return list.length > limit ? list.slice(list.length - limit) : list
    },
    recent(sinceMs) {
      const out = []
      for (const ev of byId.values()) if (Date.parse(ev.occurred_at) >= sinceMs) out.push(ev)
      return out
    },
    head: () => seq,
    size: () => byId.size,
  }
}
