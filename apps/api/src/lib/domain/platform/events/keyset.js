/**
 * KEYSET — exact paging over many ledgers.
 *
 * Every event has a key (occurred_at desc, event_id desc). A page asks each
 * adapter for events strictly older than the cursor; each adapter answers with
 * its newest events plus `complete_above`: the key at or above which its
 * answer is complete (null = it read everything down to `since`). The merge
 * only emits events at or above the HIGHEST of those keys, so no page can skip
 * an event an adapter has not read yet (no gaps) and the cursor is the last
 * emitted key (no duplicates).
 */
import { canonicalTime } from './envelope.js'

export const keyOf = (e) => ({ t: e.occurred_at, id: e.event_id })
/** >0 when a is newer than b. */
export function cmpKey(a, b) {
  if (a.t !== b.t) return a.t > b.t ? 1 : -1
  if (a.id === b.id) return 0
  return a.id > b.id ? 1 : -1
}
export const maxKey = (a, b) => (!a ? b : !b ? a : cmpKey(a, b) >= 0 ? a : b)

export function encodeCursor(k) {
  return Buffer.from(JSON.stringify({ t: k.t, id: k.id }), 'utf8').toString('base64url')
}
export function decodeCursor(token) {
  if (!token) return null
  try {
    const o = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'))
    const t = canonicalTime(o?.t)
    return t && typeof o.id === 'string' ? { t, id: o.id } : null
  } catch { return null }
}

/**
 * One bounded, exactly-ordered read of a ledger table.
 *   build()   fresh query with the adapter's own filters (no order/range)
 *   toId(row) the row's event_id (prefix + row id) — ordering within a table by
 *             id equals ordering by event_id because the prefix is constant
 * Rows come back newest first, strictly below the cursor and at/after `since`.
 */
export async function readKeyed(build, { timeCol = 'created_at', idCol = 'id', toId, cursor = null, since = null, until = null, limit = 60 }) {
  const want = Math.max(1, limit) + 1
  let qy = build()
  if (since) qy = qy.gte(timeCol, since)
  if (cursor) qy = qy.lte(timeCol, cursor.t)
  else if (until) qy = qy.lt(timeCol, until)
  const { data, error } = await qy.order(timeCol, { ascending: false }).order(idCol, { ascending: false }).range(0, want - 1)
  if (error) throw Object.assign(new Error(error.message || 'read_failed'), { code: error.code })
  const raw = data || []
  const keyed = raw.map((r) => ({ row: r, key: { t: canonicalTime(r[timeCol]), id: toId(r) } })).filter((x) => x.key.t)
  const rows = cursor ? keyed.filter((x) => cmpKey(x.key, cursor) < 0) : keyed
  return { rows, complete_above: raw.length >= want && keyed.length ? keyed[keyed.length - 1].key : null }
}

/** Merge adapter answers into one page. */
export function mergePage(results, { limit, cursor = null }) {
  let horizon = null
  for (const r of results) horizon = maxKey(horizon, r.complete_above || null)
  const seen = new Set()
  const all = []
  for (const r of results) {
    for (const e of r.events || []) {
      const k = keyOf(e)
      if (cursor && cmpKey(k, cursor) >= 0) continue
      if (horizon && cmpKey(k, horizon) < 0) continue
      if (seen.has(e.event_id)) continue
      seen.add(e.event_id)
      all.push(e)
    }
  }
  all.sort((a, b) => cmpKey(keyOf(b), keyOf(a)))
  const page = all.slice(0, limit)
  const more = all.length > limit || Boolean(horizon)
  const last = page.length ? keyOf(page[page.length - 1]) : horizon
  return { events: page, next_cursor: more && last ? encodeCursor(last) : null }
}
