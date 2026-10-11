/**
 * THREAD REPLY STATE for the alert list (read-only enrichment).
 *
 * An inbox alert ("Hot lead", "Seller waiting on review", …) is stale once the
 * conversation has been answered. The list endpoint attaches the thread's
 * latest outbound time to every inbox row so the client can expire the alert
 * (visibility only — nothing here writes, and no lead state changes), plus the
 * seller's display name from their own messages (the monogram on the card; the
 * alert titles only carry the phone).
 *
 * Two indexed reads per list (message_events (thread_key, created_at desc)),
 * the outbound one bounded by the oldest alert in the page. A failed read leaves
 * the rows as they were: the alert keeps its other expiry rules.
 */

const clean = (v) => String(v ?? '').trim()
const THREAD_TYPES = new Set(['thread', 'seller_thread', 'seller'])
const MAX_ROWS = 2000

/** The thread an alert row is about, or null. */
export function threadKeyOfRow(row) {
  if (!row || clean(row.domain) !== 'inbox') return null
  if (!THREAD_TYPES.has(clean(row.source_entity_type))) return null
  return clean(row.source_entity_id) || clean(row.participant_id) || null
}

/** Pure: rows + outbound message rows (+ named inbound rows) → rows with `thread_last_outbound_at` / `seller_display_name` (inbox rows only). */
export function applyThreadReplyState(rows = [], outbound = [], named = []) {
  const names = new Map()
  for (const m of named) {
    const tk = clean(m?.thread_key)
    const name = clean(m?.seller_display_name)
    if (tk && name && !names.has(tk)) names.set(tk, name)
  }
  const latest = new Map()
  for (const m of outbound) {
    const tk = clean(m?.thread_key)
    const t = Date.parse(m?.created_at || '')
    if (!tk || !Number.isFinite(t)) continue
    if (!latest.has(tk) || latest.get(tk) < t) latest.set(tk, t)
  }
  return rows.map((r) => {
    const tk = threadKeyOfRow(r)
    if (!tk) return r
    const t = latest.get(tk)
    return { ...r, thread_last_outbound_at: Number.isFinite(t) ? new Date(t).toISOString() : null, seller_display_name: names.get(tk) || r.seller_display_name || null }
  })
}

/** Attach the reply state with one read. Never throws. */
export async function attachThreadReplyState(rows = [], { db } = {}) {
  const keys = [...new Set(rows.map(threadKeyOfRow).filter(Boolean))]
  if (!keys.length || !db) return rows
  const since = rows.map((r) => clean(r.created_at)).filter((v) => Number.isFinite(Date.parse(v))).sort()[0]
  const read = async (q) => {
    try {
      const { data, error } = await q
      return error || !Array.isArray(data) ? null : data
    } catch { return null }
  }
  let out = null
  let named = null
  try {
    let oq = db.from('message_events').select('thread_key, created_at').eq('direction', 'outbound').in('thread_key', keys)
    if (since) oq = oq.gte('created_at', since)
    const nq = db.from('message_events').select('thread_key, seller_display_name').eq('direction', 'inbound').in('thread_key', keys).not('seller_display_name', 'is', null)
    ;[out, named] = await Promise.all([
      read(oq.order('created_at', { ascending: false }).limit(MAX_ROWS)),
      read(nq.order('created_at', { ascending: false }).limit(Math.min(MAX_ROWS, keys.length * 4))),
    ])
  } catch {
    return rows
  }
  if (!out && !named) return rows
  return applyThreadReplyState(rows, out || [], named || [])
}
