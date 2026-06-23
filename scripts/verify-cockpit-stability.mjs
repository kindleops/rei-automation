#!/usr/bin/env node
/**
 * Cockpit stability verification script.
 * Run: node scripts/verify-cockpit-stability.mjs
 * Requires API running on http://localhost:3000 with OPS_DASHBOARD_SECRET set.
 */

const BASE = process.env.API_URL || 'http://localhost:3000'
const SECRET = process.env.OPS_DASHBOARD_SECRET || 'cf19bd6d9bed109c1e77c6735ebf5d196a8f04f88d8274efbd2900defe134477'
const HEADERS = { 'x-ops-dashboard-secret': SECRET, 'Content-Type': 'application/json' }

let passed = 0
let failed = 0
const failures = []

function ok(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    const msg = `${label}${detail ? `: ${detail}` : ''}`
    console.error(`  ✗ ${msg}`)
    failures.push(msg)
    failed++
  }
}

async function get(path) {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: HEADERS })
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { return { ok: false, _raw: text.slice(0, 300), _status: res.status } }
    return { ...parsed, _status: res.status }
  } catch (err) {
    return { ok: false, _error: String(err) }
  }
}

// ── A. Counts endpoint ────────────────────────────────────────────────────────
console.log('\nA. Counts endpoint')
const counts = await get('/api/cockpit/inbox/counts')
ok('HTTP 200', counts._status === 200, `status=${counts._status}`)
ok('ok:true', counts.ok === true)
ok('root counts object', counts.counts && typeof counts.counts === 'object')
ok('data.counts object', counts.data?.counts && typeof counts.data.counts === 'object')
const totalAll = counts.counts?.all ?? counts.data?.counts?.all ?? 0
ok('all count > 0', totalAll > 0, `got ${totalAll}`)

// ── B. Bucket contract — each filter returns only matching rows ───────────────
const SPECIFIC_FILTERS = ['new_replies', 'priority', 'cold', 'dead', 'suppressed']
const ALL_FILTERS = ['all', ...SPECIFIC_FILTERS]

for (const filter of ALL_FILTERS) {
  console.log(`\nB. Bucket contract: filter=${filter}`)
  const res = await get(`/api/cockpit/inbox/live?filter=${filter}&limit=20`)
  ok(`[${filter}] HTTP 200`, res._status === 200, `status=${res._status}`)
  ok(`[${filter}] ok:true`, res.ok === true)
  ok(`[${filter}] threads array`, Array.isArray(res.threads), `type=${typeof res.threads}`)

  const threads = res.threads ?? []

  if (SPECIFIC_FILTERS.includes(filter) && threads.length > 0) {
    const BUCKET_MATCH = {
      priority: (r) => r.inbox_bucket === 'priority',
      new_replies: (r) => r.inbox_bucket === 'new_replies',
      cold: (r) => r.inbox_bucket === 'cold',
      dead: (r) => r.inbox_bucket === 'dead' || r.universal_status === 'dead' || r.wrong_number || r.not_interested,
      suppressed: (r) => r.inbox_bucket === 'suppressed' || r.opt_out,
    }
    const matchFn = BUCKET_MATCH[filter]
    const mismatched = threads.filter(r => !matchFn(r))
    ok(`[${filter}] 0 rows with wrong bucket`,
      mismatched.length === 0,
      `${mismatched.length}/${threads.length} mismatched: ${JSON.stringify(mismatched.slice(0,2).map(r => ({ tk: r.thread_key, bucket: r.inbox_bucket })))}`)

    if (filter === 'cold') {
      const terminal = threads.filter(r => r.inbox_bucket === 'dead' || r.inbox_bucket === 'suppressed' || r.opt_out || r.wrong_number || r.not_interested)
      ok('[cold] excludes dead/suppressed/terminal rows', terminal.length === 0, `${terminal.length} terminal rows`)
    }
  }

  ok(`[${filter}] requested_filter echoed`, threads.every(r => !r.requested_filter || r.requested_filter === filter))
}

// ── C. Deal context / rich data on first rows ────────────────────────────────
console.log('\nC. Deal context / rich data')
const allRes = await get('/api/cockpit/inbox/live?filter=all&limit=25')
const rows = allRes.threads ?? []
ok('rows returned', rows.length > 0, `got ${rows.length}`)

let richRows = 0
for (const r of rows) {
  const hasAddress = Boolean(r.property_address_full || r.property_address)
  const hasOwner = Boolean(r.owner_name || r.seller_display_name || r.display_name)
  const hasPhone = Boolean(r.seller_phone || r.best_phone || r.phone)
  if (hasAddress && hasOwner && hasPhone) richRows++
}
ok('≥70% of rows have address+owner+phone', richRows / rows.length >= 0.7,
  `${richRows}/${rows.length} rows fully populated`)

// Sample first row with a property_id — verify nested blobs exist
const withProperty = rows.find(r => r.property_id)
if (withProperty) {
  ok('property_data blob present when property_id set', Boolean(withProperty.property_data),
    `thread_key=${withProperty.thread_key}`)
}
const withContext = rows.find(r => r.master_owner_id || r.prospect_id)
if (withContext) {
  ok('master_owner_data or prospect_data present when owner/prospect ids set',
    Boolean(withContext.master_owner_data || withContext.prospect_data),
    `thread_key=${withContext.thread_key}`)
}

// ── D. Pagination — page 1/2 no duplicate thread_keys ─────────────────────────
console.log('\nD. Pagination')
const p1 = await get('/api/cockpit/inbox/live?filter=all&limit=5')
ok('page1 ok', p1.ok === true)
ok('page1 has 5 rows', (p1.threads ?? []).length === 5, `got ${(p1.threads ?? []).length}`)
ok('pagination object', p1.pagination && typeof p1.pagination === 'object')
ok('has_more flag', p1.pagination?.has_more === true)
const cursor = p1.pagination?.next_cursor
ok('next_cursor is non-empty string', typeof cursor === 'string' && cursor.length > 0, `cursor=${cursor}`)

if (cursor) {
  const p2 = await get(`/api/cockpit/inbox/live?filter=all&limit=5&cursor=${encodeURIComponent(cursor)}`)
  ok('page2 ok', p2.ok === true)
  ok('page2 has rows', (p2.threads ?? []).length > 0)
  const p1keys = new Set((p1.threads ?? []).map(r => r.thread_key))
  const dupes = (p2.threads ?? []).filter(r => p1keys.has(r.thread_key))
  ok('no page1/page2 duplicate thread_keys', dupes.length === 0,
    `dupes: ${JSON.stringify(dupes.map(r => r.thread_key))}`)
}

// ── E. Messages endpoint ──────────────────────────────────────────────────────
console.log('\nE. Messages endpoint')
const sampleKey = rows[0]?.thread_key
if (sampleKey) {
  const msgs = await get(`/api/cockpit/inbox/threads/${encodeURIComponent(sampleKey)}/messages?limit=200`)
  ok('[messages] HTTP 200', msgs._status === 200, `status=${msgs._status}`)
  ok('[messages] ok:true', msgs.ok === true)
  ok('[messages] root messages array', Array.isArray(msgs.messages), `type=${typeof msgs.messages}`)
  ok('[messages] root pagination object', msgs.pagination && typeof msgs.pagination === 'object')
  ok('[messages] diagnostics.messages array', Array.isArray(msgs.diagnostics?.messages))
  ok('[messages] thread_key echoed', msgs.thread_key === sampleKey, `got=${msgs.thread_key}`)
  const wrongThread = (msgs.messages ?? []).filter(m => m.thread_key && m.thread_key !== sampleKey)
  ok('[messages] all messages belong to requested thread_key', wrongThread.length === 0,
    `${wrongThread.length} foreign-thread messages`)
} else {
  console.log('  (E skipped — no rows returned from all filter)')
}

// ── F. Phone identity ──────────────────────────────────────────────────────────
console.log('\nF. Phone identity')
const e164Re = /^\+\d{7,15}$/
let phoneChecked = 0
for (const r of rows.slice(0, 10)) {
  const tk = r.thread_key
  if (!e164Re.test(tk)) continue
  phoneChecked++
  ok(`[${tk}] seller_phone matches thread_key`,
    r.seller_phone === tk || r.best_phone === tk || r.phone === tk,
    `seller_phone=${r.seller_phone}`)
  if (r.our_number) {
    ok(`[${tk}] our_number !== seller_phone`, r.our_number !== r.seller_phone,
      `our=${r.our_number}`)
  }
}
if (phoneChecked === 0) console.log('  (F skipped — no E.164 thread_keys in sample)')

// ── G. Ops metrics endpoint ───────────────────────────────────────────────────
console.log('\nG. Ops metrics endpoint')
const metrics = await get('/api/cockpit/ops/metrics?window=today')
ok('[metrics] HTTP 200', metrics._status === 200, `status=${metrics._status}`)
ok('[metrics] ok:true', metrics.ok === true)
ok('[metrics] diagnostics object', metrics.diagnostics && typeof metrics.diagnostics === 'object')
ok('[metrics] sent_count present', typeof metrics.diagnostics?.sent_count === 'number')
ok('[metrics] no HTML body', !String(metrics._raw ?? '').startsWith('<!DOCTYPE'))

// ── H. Pipeline counts ────────────────────────────────────────────────────────
console.log('\nH. Pipeline / deal-context counts')
const pipeline = await get('/api/cockpit/deal-context/counts')
ok('[pipeline] HTTP ok', pipeline._status && pipeline._status < 500, `status=${pipeline._status}`)
// A 404 means the endpoint isn't wired yet; just warn
if (pipeline._status === 404) {
  console.log('  (H: /api/cockpit/deal-context/counts not found — endpoint may not be implemented yet)')
} else {
  ok('[pipeline] ok:true or data present', pipeline.ok === true || Boolean(pipeline.data || pipeline.counts))
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failures.length > 0) {
  console.log('\nFailed assertions:')
  failures.forEach(f => console.log(`  • ${f}`))
}
if (failed > 0) process.exit(1)
console.log('All assertions passed.')
