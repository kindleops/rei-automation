/**
 * Shared adapter vocabulary. An adapter turns ONE runtime's own ledger rows into
 * observed runs: { run: RunRow, events: NormalizedEvent[] }. It never writes and
 * never re-labels a business record; a missing source is reported, not zeroed.
 */
import { event } from '../core.js'

export const clean = (v) => String(v ?? '').trim()
export const lower = (v) => clean(v).toLowerCase()

export const STATUS_LABEL = Object.freeze({
  running: 'Running', waiting: 'Waiting', held: 'Held by policy', needs_you: 'Needs you', failed: 'Failed', completed: 'Completed', cancelled: 'Cancelled',
})

export const subject = (kind, id, name = null, address = null, href = null) => ({ kind, id: id ? String(id) : null, name: name || null, address: address || null, href: href || null })

export function runRow({ run_id, workflow_key, version = null, started_at = null, finished_at = null, subject: s, trigger = null, status, status_label = null, current_node = null, final_node = null, human = false, result = null, reason = null }) {
  const a = Date.parse(started_at)
  const b = Date.parse(finished_at)
  return {
    run_id: String(run_id),
    workflow_key,
    version,
    started_at,
    finished_at,
    duration_ms: Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null,
    subject: s,
    trigger,
    status,
    status_label: status_label || STATUS_LABEL[status] || status,
    current_node,
    final_node,
    human: Boolean(human),
    result,
    reason,
  }
}

/** Build a node event with a monotonic sequence so same-millisecond steps keep their order. */
export function nodeEvents(workflow_key, run_id, source_runtime) {
  let seq = 0
  const out = []
  const push = (node_key, status, at, { id = null, reason = null, label = null, type = null, duration_ms = null, ref = null } = {}) => {
    const ev = event({ id: id || `${run_id}:${node_key}:${seq}`, workflow_key, run_id, node_key, event_type: type || typeFor(status), status, at, duration_ms, reason, label, source_runtime, source_ref: ref })
    ev._seq = seq++
    out.push(ev)
    return ev
  }
  return { push, events: out }
}

const typeFor = (status) => ({ failed: 'node_failed', blocked: 'node_held', held: 'node_held', needs_review: 'approval_requested', human: 'approval_requested', waiting: 'wait_started', skipped: 'node_skipped' }[status] || 'node_completed')

/** Strip the private sequence before a payload leaves the server. */
export const publicEvents = (events) => events.map(({ _seq, ...e }) => e)

export const inPeriod = (at, since, until = null) => {
  const t = Date.parse(at)
  return Number.isFinite(t) && t >= Date.parse(since) && (!until || t <= Date.parse(until))
}

/** A read that fails is surfaced as degraded, never as "nothing happened". */
export async function safe(q, degraded, source) {
  const { data, error } = await q
  if (error) { degraded.push(source); return [] }
  return data || []
}

export const missingTable = (e) => e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message || ''))

export const topCounts = (obj, n = 3) => Object.entries(obj || {}).filter(([, v]) => Number(v) > 0).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, n)

/**
 * Seller identity for display: name from inbox_thread_state.seller_display_name,
 * address from properties (property_address_full). Bounded; a failed read
 * degrades to ids, never to invented names.
 */
export async function sellerNames(db, threadKeys = [], propertyIds = [], degraded = []) {
  const tks = [...new Set(threadKeys.filter(Boolean).map(String))].slice(0, 500)
  const threads = tks.length ? await safe(db.from('inbox_thread_state').select('thread_key, seller_display_name, property_id, lifecycle_stage').in('thread_key', tks), degraded, 'inbox_thread_state') : []
  const threadProp = new Map(threads.map((t) => [t.thread_key, t.property_id || null]))
  const pids = [...new Set([...propertyIds.filter(Boolean).map(String), ...[...threadProp.values()].filter(Boolean).map(String)])].slice(0, 800)
  const props = pids.length ? await safe(db.from('properties').select('property_id, property_address_full, property_address').in('property_id', pids), degraded, 'properties') : []
  const addr = new Map(props.map((p) => [String(p.property_id), p.property_address_full || p.property_address || null]))
  const byThread = new Map(threads.map((t) => [t.thread_key, t]))
  return {
    name: (tk) => byThread.get(tk)?.seller_display_name || null,
    stage: (tk) => byThread.get(tk)?.lifecycle_stage || null,
    address: (tk, pid) => (pid ? addr.get(String(pid)) : null) || (threadProp.get(tk) ? addr.get(String(threadProp.get(tk))) : null) || null,
  }
}

/**
 * PostgREST caps every response at its max-rows (1000 in production) whatever
 * .limit() asks for — so a bigger window is read page by page with .range().
 * `build` must return a fresh, fully-filtered query WITHOUT .limit().
 */
export async function paged(build, { limit = 1000, page = 1000, degraded = [], source = 'query' } = {}) {
  const out = []
  for (let from = 0; from < limit; from += page) {
    const to = Math.min(limit, from + page) - 1
    const { data, error } = await build().range(from, to)
    if (error) { degraded.push(source); break }
    out.push(...(data || []))
    if (!data || data.length < to - from + 1) break
  }
  return out
}

/**
 * `.in(col, ids)` over many ids, chunked AND paged. A chunk of executions can
 * own more child rows than PostgREST's max-rows (1000): a single `.limit()`
 * would silently drop the rest (40% of 7-day seller steps were lost that way),
 * so every chunk is read page by page in a stable order.
 */
export async function inChunksPaged(db, table, cols, col, ids, degraded = [], { chunk = 40, extra = (q) => q, order = 'id', perChunk = 5000 } = {}) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))]
  const out = []
  for (let i = 0; i < list.length; i += chunk) {
    const part = list.slice(i, i + chunk)
    out.push(...await paged(() => extra(db.from(table).select(cols).in(col, part)).order(order, { ascending: true }), { limit: perChunk, degraded, source: table }))
  }
  return out
}

/**
 * Test traffic never counts as operations: internal test / canary handsets
 * (lib/config/internal-phones.js) and the queue's proof lanes are excluded
 * from every operational read here.
 */
export const TEST_QUEUE_SOURCES = Object.freeze(new Set(['internal_canary', 'inbox_lock_certification', 'queue_limited_cap_proof']))
export const testPhoneList = (set) => `(${[...set].map((p) => `"${p}"`).join(',')})`

/** A count that tolerates both PostgREST (count, head) and plain row reads; null when the read failed. */
export async function countOf(q, degraded = [], source = 'count') {
  const { count, data, error } = await q
  if (error) { degraded.push(source); return null }
  return Number.isFinite(count) ? count : (data || []).length
}

/**
 * Cheap registry stats from timestamps only (one narrow column, paged) — the
 * registry must not hydrate every run of every runtime just to count them.
 */
export async function timestampSummary(build, { now, dayStart, degraded = [], source, failed = null }) {
  const rows = await paged(build, { limit: 6000, degraded, source })
  const DAY = 24 * 3600e3
  const at = (r) => r.at || r.created_at || r.started_at
  const sorted = rows.map(at).filter(Boolean).sort()
  return {
    runs_today: sorted.filter((t) => String(t) >= dayStart).length,
    runs_24h: sorted.filter((t) => Date.parse(t) > now - DAY).length,
    runs_7d: sorted.length,
    failed_24h: failed ? rows.filter((r) => failed(r) && Date.parse(at(r)) > now - DAY).length : 0,
    last_run_at: sorted[sorted.length - 1] || null,
  }
}
